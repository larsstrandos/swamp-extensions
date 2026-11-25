// swamp-quality-ignore testing-completeness: tests and real VPP fixtures live in test/, outside the shipped extension
/**
 * Read-only diagnostics for a VPP (fd.io) node through `vppctl`.
 *
 * One behavior instance is one VPP node, reached locally, with `docker exec` /
 * `podman exec`, or over SSH. Every method runs `show` commands only, parses the
 * output into structured data and stores it, so later runs can be compared
 * (counter deltas) and queried with CEL.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type BufferPool,
  type ErrorCounter,
  type LcpState,
  mergeAddresses,
  parseBuffers,
  parseErrors,
  parseFib,
  parseFibSummary,
  parseHardwareBrief,
  parseHeap,
  parseInterfaceAddresses,
  parseInterfaces,
  parseLcp,
  parseNeighbors,
  parseTables,
  parseThreads,
  parseVersion,
  type VppInterface,
} from "./_lib/parse.ts";
import {
  describeNode,
  type NodeArgs,
  NodeArgsSchema,
  type Runner,
  Vppctl,
} from "./_lib/vppctl.ts";

type Handle = { name: string };

/** The parts of the method context this behavior uses. */
interface Ctx {
  globalArgs: NodeArgs;
  signal: AbortSignal;
  logger: {
    info(msg: string, ...args: unknown[]): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Handle>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
}

/** Test hook: tests pass `_runner` to replace the process runner. */
type Injected = { _runner?: Runner };

function session(args: Injected, ctx: Ctx): Vppctl {
  return new Vppctl(ctx.globalArgs, ctx.signal, args._runner);
}

const now = () => new Date().toISOString();

async function previous<T>(ctx: Ctx, name: string): Promise<T | null> {
  if (!ctx.readResource) return null;
  try {
    return (await ctx.readResource(name)) as T | null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- schemas

const Collected = { node: z.string(), collectedAt: z.string() };

const VersionSchema = z.object({
  ...Collected,
  version: z.string(),
  buildHost: z.string().optional(),
  buildDate: z.string().optional(),
  raw: z.string(),
});

const AddressSchema = z.object({
  address: z.string(),
  family: z.enum(["ip4", "ip6"]),
  tableId: z.number(),
});

const InterfaceSchema = z.object({
  name: z.string(),
  index: z.number(),
  adminUp: z.boolean(),
  mtu: z.object({
    l3: z.number(),
    ip4: z.number(),
    ip6: z.number(),
    mpls: z.number(),
  }),
  counters: z.record(z.string(), z.number()),
  countersDelta: z.record(z.string(), z.number()).optional(),
  addresses: z.array(AddressSchema),
  unnumberedFrom: z.string().optional(),
  lcpLinuxName: z.string().optional(),
  lcpHostFor: z.string().optional(),
  linkUp: z.boolean().optional(),
  linkSpeed: z.string().optional(),
});

const InterfacesSchema = z.object({
  ...Collected,
  previousAt: z.string().optional(),
  count: z.number(),
  interfaces: z.array(InterfaceSchema),
});

const LcpSchema = z.object({
  ...Collected,
  settings: z.record(z.string(), z.string()),
  pairs: z.array(z.object({
    index: z.number(),
    phy: z.string(),
    host: z.string(),
    linuxName: z.string(),
    linuxIfIndex: z.number(),
    type: z.string(),
    netns: z.string().optional(),
  })),
});

const TableSchema = z.object({
  fibIndex: z.number(),
  tableId: z.number(),
  name: z.string(),
  linkLocal: z.boolean(),
});

const TablesSchema = z.object({
  ...Collected,
  ip4: z.array(TableSchema),
  ip6: z.array(TableSchema),
});

const FibSchema = z.object({
  ...Collected,
  family: z.enum(["ip4", "ip6"]),
  tableId: z.number(),
  prefixFilter: z.string().optional(),
  name: z.string().optional(),
  fibIndex: z.number().optional(),
  prefixLengthCounts: z.record(z.string(), z.number()).optional(),
  totalPrefixes: z.number(),
  truncated: z.boolean(),
  entries: z.array(z.object({
    prefix: z.string(),
    packets: z.number(),
    bytes: z.number(),
    paths: z.array(z.object({
      kind: z.enum(["via", "glean", "receive", "drop", "lookup", "other"]),
      nextHop: z.string().optional(),
      interface: z.string().optional(),
      raw: z.string(),
    })),
  })),
});

const ErrorsSchema = z.object({
  ...Collected,
  previousAt: z.string().optional(),
  counters: z.array(z.object({
    node: z.string(),
    reason: z.string(),
    severity: z.string(),
    count: z.number(),
    delta: z.number().optional(),
  })),
});

const FindingSchema = z.object({
  level: z.enum(["critical", "warning", "info"]),
  check: z.string(),
  message: z.string(),
});

const HealthSchema = z.object({
  ...Collected,
  version: z.string(),
  status: z.enum(["ok", "warning", "critical"]),
  findings: z.array(FindingSchema),
  interfaces: z.object({
    total: z.number(),
    adminUp: z.number(),
    linkDown: z.number(),
    withAddress: z.number(),
  }),
  lcpPairs: z.number(),
  threads: z.array(
    z.object({ id: z.number(), name: z.string(), cpu: z.number().optional() }),
  ),
  buffers: z.array(z.object({
    name: z.string(),
    numa: z.number(),
    total: z.number(),
    avail: z.number(),
    cached: z.number(),
    used: z.number(),
  })),
  heap: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
  })
    .optional(),
});

const NeighborsSchema = z.object({
  ...Collected,
  count: z.number(),
  neighbors: z.array(z.object({
    ip: z.string(),
    family: z.enum(["ip4", "ip6"]),
    mac: z.string(),
    interface: z.string(),
    flags: z.string(),
    ageSeconds: z.number(),
  })),
});

const OutputSchema = z.object({
  ...Collected,
  command: z.string(),
  output: z.string(),
});

// ---------------------------------------------------------------- collectors

function delta(cur: number, prev: number | undefined): number {
  if (prev === undefined) return cur;
  return cur >= prev ? cur - prev : cur; // counters were cleared
}

async function collectInterfaces(
  vpp: Vppctl,
  ctx: Ctx,
  lcp?: LcpState,
): Promise<z.infer<typeof InterfacesSchema>> {
  const [ifs, addrs, hw] = await Promise.all([
    vpp.show("show interface"),
    vpp.show("show interface addr"),
    vpp.show("show hardware-interfaces brief").catch(() => ""),
  ]);
  const links = parseHardwareBrief(hw);
  const prev = await previous<z.infer<typeof InterfacesSchema>>(
    ctx,
    "interfaces",
  );
  const prevByName = new Map(prev?.interfaces.map((i) => [i.name, i]) ?? []);
  const linuxByPhy = new Map(lcp?.pairs.map((p) => [p.phy, p.linuxName]) ?? []);
  const phyByHost = new Map(lcp?.pairs.map((p) => [p.host, p.phy]) ?? []);
  const interfaces = mergeAddresses(
    parseInterfaces(ifs),
    parseInterfaceAddresses(addrs),
  ).map(
    (i: VppInterface) => {
      const p = prevByName.get(i.name);
      const linux = linuxByPhy.get(i.name);
      const hostFor = phyByHost.get(i.name);
      const link = links.get(i.name);
      return {
        ...i,
        ...(p
          ? {
            countersDelta: Object.fromEntries(
              Object.entries(i.counters).map((
                [k, v],
              ) => [k, delta(v, p.counters[k])]),
            ),
          }
          : {}),
        ...(linux ? { lcpLinuxName: linux } : {}),
        ...(hostFor ? { lcpHostFor: hostFor } : {}),
        ...(link ? { linkUp: link.linkUp } : {}),
        ...(link?.speed ? { linkSpeed: link.speed } : {}),
      };
    },
  );
  return {
    node: describeNode(ctx.globalArgs),
    collectedAt: now(),
    ...(prev ? { previousAt: prev.collectedAt } : {}),
    count: interfaces.length,
    interfaces,
  };
}

async function collectLcp(
  vpp: Vppctl,
  ctx: Ctx,
): Promise<z.infer<typeof LcpSchema>> {
  const text = await vpp.show("show lcp");
  return {
    node: describeNode(ctx.globalArgs),
    collectedAt: now(),
    ...parseLcp(text),
  };
}

async function collectErrors(
  vpp: Vppctl,
  ctx: Ctx,
): Promise<z.infer<typeof ErrorsSchema>> {
  const counters = parseErrors(await vpp.show("show errors"));
  const prev = await previous<z.infer<typeof ErrorsSchema>>(ctx, "errors");
  const key = (c: ErrorCounter) => `${c.node}\u0000${c.reason}`;
  const prevByKey = new Map(prev?.counters.map((c) => [key(c), c.count]) ?? []);
  return {
    node: describeNode(ctx.globalArgs),
    collectedAt: now(),
    ...(prev ? { previousAt: prev.collectedAt } : {}),
    counters: counters
      .map((
        c,
      ) => (prev ? { ...c, delta: delta(c.count, prevByKey.get(key(c))) } : c))
      .sort((a, b) => b.count - a.count),
  };
}

type CounterKey = { node: string; reason: string };

/** Severity-"error" counters that are normal operation: never reported. */
const BENIGN: [RegExp, RegExp][] = [
  [/^af-packet-input$/, /^(timed out block|total received block)/],
  [/^(dpdk|ethernet|af-packet|af_xdp|rdma|avf)-input$/, /^no error/],
  [/-output$/, /^interface is down/], // reported as link-down instead
];

/**
 * Counters that are normal background noise on an edge router (traceroutes,
 * IXP peers ARPing/NSing for each other, STP/LLDP): reported only at a rate
 * that suggests a loop or an attack.
 */
const NOISY: [RegExp, RegExp][] = [
  [/^ip[46]-input$/, /ttl <= 1/],
  [/^ip6-icmp-input$/, /^neighbor solicitations (for unknown|from source)/],
  [/^arp-(reply|input)$/, /^IP4 source address not local/],
  [/^llc-input$/, /^unknown llc/],
];
const NOISY_RATE = 100;

/** Counters that mean lost traffic or exhausted resources: any increase counts. */
const SEVERE =
  /tx failure|no buffer|buffer alloc|rx miss|mtu exceeded|ring full|queue full|no free/i;

function matches(table: [RegExp, RegExp][], c: CounterKey): boolean {
  return table.some(([n, r]) => n.test(c.node) && r.test(c.reason));
}

/** How health treats a rising error counter. Exported for tests. */
export function classifyCounter(
  c: CounterKey,
): "benign" | "noisy" | "severe" | "normal" {
  if (matches(BENIGN, c)) return "benign";
  if (SEVERE.test(c.reason)) return "severe";
  if (matches(NOISY, c)) return "noisy";
  return "normal";
}

function seconds(from?: string, to?: string): number {
  const d = (Date.parse(to ?? "") - Date.parse(from ?? "")) / 1000;
  return Number.isFinite(d) && d > 0 ? d : 1; // unknown interval: rate = delta
}

/** Pure health evaluation, exported for tests. */
export function evaluateHealth(input: {
  interfaces: z.infer<typeof InterfacesSchema>;
  lcp: LcpState;
  errors: z.infer<typeof ErrorsSchema>;
  buffers: BufferPool[];
  heap?: { totalBytes: number; usedBytes: number };
  /** Report ordinary error counters rising at least this fast (per second). */
  minErrorRate?: number;
}): z.infer<typeof FindingSchema>[] {
  const f: z.infer<typeof FindingSchema>[] = [];
  const lcpPhys = new Set(input.lcp.pairs.map((p) => p.phy));

  for (const b of input.buffers) {
    const pct = b.total ? (b.avail / b.total) * 100 : 100;
    if (pct < 10) {
      f.push({
        level: "critical",
        check: "buffers",
        message: `buffer pool ${b.name}: only ${b.avail}/${b.total} (${
          pct.toFixed(1)
        }%) available`,
      });
    } else if (pct < 25) {
      f.push({
        level: "warning",
        check: "buffers",
        message: `buffer pool ${b.name}: ${b.avail}/${b.total} (${
          pct.toFixed(1)
        }%) available`,
      });
    }
  }

  if (input.heap && input.heap.totalBytes > 0) {
    const pct = (input.heap.usedBytes / input.heap.totalBytes) * 100;
    if (pct > 90) {
      f.push({
        level: "critical",
        check: "heap",
        message: `main heap ${pct.toFixed(1)}% used`,
      });
    } else if (pct > 80) {
      f.push({
        level: "warning",
        check: "heap",
        message: `main heap ${pct.toFixed(1)}% used`,
      });
    }
  }

  for (const i of input.interfaces.interfaces) {
    if (i.name === "local0") continue;
    if (!i.adminUp) {
      // Admin down is a deliberate state. It is only suspicious when the
      // interface still carries addresses (unnumbered borrows them, so skip
      // those too); its counters are not judged.
      if (i.addresses.length > 0 && !i.unnumberedFrom) {
        f.push({
          level: "warning",
          check: "interface-down",
          message: `${i.name} is admin down but has addresses (${
            i.addresses.map((x) => x.address).join(", ")
          })`,
        });
      }
      continue;
    }
    if (i.adminUp && i.linkUp === false) {
      f.push({
        level: "warning",
        check: "link-down",
        message: `${i.name} is admin up but the link is down${
          i.lcpLinuxName ? ` (Linux ${i.lcpLinuxName})` : ""
        }; admin it down if the port is unused`,
      });
      continue; // its tx-error counts "interface is down"
    }
    for (const k of ["rx-error", "tx-error", "rx-miss"]) {
      const d = i.countersDelta?.[k];
      if (d && d > 0) {
        f.push({
          level: "warning",
          check: "interface-errors",
          message: `${i.name}: ${k} +${d} since ${input.interfaces.previousAt}`,
        });
      }
    }
  }

  // VPP interfaces with L3 addresses in a non-default table that have a
  // linux-cp pair: the Linux side must be in the matching VRF, and lcp-sync
  // does not do that for you.
  if (input.lcp.settings["lcp-sync"] === "off") {
    const vrfIfs = input.interfaces.interfaces.filter((i) =>
      lcpPhys.has(i.name) && i.addresses.some((a) => a.tableId !== 0)
    );
    if (vrfIfs.length) {
      f.push({
        level: "info",
        check: "lcp-vrf",
        message: `${
          vrfIfs.map((i) => i.name).join(", ")
        } are in non-default VPP tables; check that each Linux peer interface is enslaved to the matching VRF (linux-cp does not sync table changes)`,
      });
    }
  }

  if (input.errors.previousAt) {
    const secs = seconds(input.errors.previousAt, input.errors.collectedAt);
    const minRate = input.minErrorRate ?? 1;
    const rising = input.errors.counters
      .filter((c) => (c.delta ?? 0) > 0 && c.severity !== "info")
      .map((c) => ({
        ...c,
        kind: classifyCounter(c),
        rate: (c.delta ?? 0) / secs,
      }))
      .filter((c) =>
        c.kind === "severe" ||
        (c.kind === "noisy" && c.rate >= NOISY_RATE) ||
        (c.kind === "normal" && c.rate >= minRate)
      )
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 8);
    for (const c of rising) {
      f.push({
        level: "warning",
        check: "error-counters",
        message: `${c.node}: "${c.reason}" +${c.delta} in ${
          secs.toFixed(0)
        }s (${c.rate.toFixed(1)}/s)`,
      });
    }
  }
  return f;
}

// ---------------------------------------------------------------- behavior

const NoArgs = z.object({});

const HealthArgs = z.object({
  minErrorRate: z.number().min(0).default(1).describe(
    "Report an error counter when it rises at least this many per second since the previous run (counters that mean lost traffic are always reported)",
  ),
});

const FibArgs = z.object({
  family: z.enum(["ip4", "ip6"]).default("ip4").describe("Address family"),
  table: z.number().int().min(0).default(0).describe("VPP table id"),
  prefix: z.string().optional().describe(
    "Only show this prefix (longest match), e.g. 10.0.0.0/8",
  ),
  summary: z.boolean().default(false).describe(
    "Only count prefixes per length (use this for full tables)",
  ),
  maxEntries: z.number().int().positive().default(5000).describe(
    "Store at most this many entries",
  ),
});

const ShowArgs = z.object({
  command: z.string().describe(
    'A read-only vppctl command, e.g. "show bond details"',
  ),
});

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-|-$/g,
    "",
  ).slice(0, 60);
}

/** VPP node diagnostics behavior. */
export const behavior = {
  type: "@lstrandos/vpp/node",
  version: "2026.11.25.4",
  upgrades: [
    {
      toVersion: "2026.11.25.3",
      description:
        "No global argument changes (link state, counter classification, health minErrorRate)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.25.4",
      description: "No global argument changes (admin-down interfaces)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  description:
    "Read-only VPP diagnostics through vppctl (local, container or SSH)",
  globalArguments: NodeArgsSchema,
  resources: {
    version: {
      description: "show version",
      schema: VersionSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    interfaces: {
      description: "Interfaces with addresses, counters and counter deltas",
      schema: InterfacesSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    lcp: {
      description: "linux-cp settings and interface pairs",
      schema: LcpSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    tables: {
      description: "IPv4 and IPv6 FIB tables",
      schema: TablesSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    fib: {
      description: "One FIB table, parsed",
      schema: FibSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    errors: {
      description: "Error counters with deltas since the previous run",
      schema: ErrorsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    health: {
      description: "Health summary and findings",
      schema: HealthSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    neighbors: {
      description: "ARP and IPv6 ND neighbor table",
      schema: NeighborsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    output: {
      description: "Raw output of an arbitrary show command",
      schema: OutputSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    version: {
      description: "Read the VPP version",
      kind: "read",
      arguments: NoArgs,
      execute: async (args: Injected, ctx: Ctx) => {
        const v = parseVersion(await session(args, ctx).show("show version"));
        return {
          dataHandles: [
            await ctx.writeResource("version", "version", {
              node: describeNode(ctx.globalArgs),
              collectedAt: now(),
              ...v,
            }),
          ],
        };
      },
    },
    interfaces: {
      description:
        "List interfaces with admin state, MTU, addresses (with table id), counters, counter deltas since the last run and linux-cp names",
      kind: "read",
      arguments: NoArgs,
      execute: async (args: Injected, ctx: Ctx) => {
        const vpp = session(args, ctx);
        const lcp = await collectLcp(vpp, ctx).catch((err: Error) => {
          ctx.logger.info(
            "linux-cp not available, skipping lcp names: {error}",
            {
              error: err.message,
            },
          );
          return undefined;
        });
        const data = await collectInterfaces(vpp, ctx, lcp);
        return {
          dataHandles: [
            await ctx.writeResource("interfaces", "interfaces", data),
          ],
        };
      },
    },
    lcp: {
      description: "Read linux-cp settings and interface pairs (show lcp)",
      kind: "read",
      arguments: NoArgs,
      execute: async (args: Injected, ctx: Ctx) => {
        const data = await collectLcp(session(args, ctx), ctx);
        return { dataHandles: [await ctx.writeResource("lcp", "lcp", data)] };
      },
    },
    tables: {
      description: "List IPv4 and IPv6 FIB tables (VRFs)",
      kind: "read",
      arguments: NoArgs,
      execute: async (args: Injected, ctx: Ctx) => {
        const vpp = session(args, ctx);
        const [ip4, ip6] = await Promise.all([
          vpp.show("show ip table"),
          vpp.show("show ip6 table"),
        ]);
        return {
          dataHandles: [
            await ctx.writeResource("tables", "tables", {
              node: describeNode(ctx.globalArgs),
              collectedAt: now(),
              ip4: parseTables(ip4),
              ip6: parseTables(ip6),
            }),
          ],
        };
      },
    },
    fib: {
      description:
        "Read one FIB table (prefixes, next hops, per-prefix packet counters), or only prefix-length counts with summary=true",
      kind: "read",
      arguments: FibArgs,
      execute: async (args: z.infer<typeof FibArgs> & Injected, ctx: Ctx) => {
        const vpp = session(args, ctx);
        const ip = args.family === "ip4" ? "ip" : "ip6";
        const base = `show ${ip} fib table ${args.table}`;
        const summaryText = await vpp.show(`${base} summary`);
        const counts = parseFibSummary(summaryText);
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        let fib = parseFib(summaryText);
        let truncated = false;
        if (!args.summary) {
          if (!args.prefix && total > args.maxEntries) {
            ctx.logger.info(
              "table {table} has {total} prefixes, more than maxEntries {max}; storing summary only",
              { table: args.table, total, max: args.maxEntries },
            );
            truncated = true;
          } else {
            const full = parseFib(
              await vpp.show(args.prefix ? `${base} ${args.prefix}` : base),
            );
            truncated = full.entries.length > args.maxEntries;
            fib = { ...full, entries: full.entries.slice(0, args.maxEntries) };
          }
        }
        const name = `fib-${args.family}-${args.table}${
          args.prefix ? "-" + slug(args.prefix) : ""
        }`;
        return {
          dataHandles: [
            await ctx.writeResource("fib", name, {
              node: describeNode(ctx.globalArgs),
              collectedAt: now(),
              family: args.family,
              tableId: args.table,
              ...(args.prefix ? { prefixFilter: args.prefix } : {}),
              ...(fib.name ? { name: fib.name } : {}),
              ...(fib.fibIndex !== undefined ? { fibIndex: fib.fibIndex } : {}),
              prefixLengthCounts: counts,
              totalPrefixes: total,
              truncated,
              entries: fib.entries,
            }),
          ],
        };
      },
    },
    errors: {
      description:
        "Read error counters (show errors) with deltas since the previous run",
      kind: "read",
      arguments: NoArgs,
      execute: async (args: Injected, ctx: Ctx) => {
        const data = await collectErrors(session(args, ctx), ctx);
        return {
          dataHandles: [await ctx.writeResource("errors", "errors", data)],
        };
      },
    },
    health: {
      description:
        "Collect version, interfaces, linux-cp, errors, buffers, heap and threads in one go and write a health summary with findings",
      kind: "read",
      arguments: HealthArgs,
      execute: async (
        args: z.infer<typeof HealthArgs> & Injected,
        ctx: Ctx,
      ) => {
        const vpp = session(args, ctx);
        const node = describeNode(ctx.globalArgs);
        const [versionText, buffersText, heapText, threadsText] = await Promise
          .all([
            vpp.show("show version"),
            vpp.show("show buffers"),
            vpp.show("show memory main-heap"),
            vpp.show("show threads"),
          ]);
        let lcpLoaded = true;
        const lcp = await collectLcp(vpp, ctx).catch((err: Error) => {
          ctx.logger.info("linux-cp not available: {error}", {
            error: err.message,
          });
          lcpLoaded = false;
          return { node, collectedAt: now(), settings: {}, pairs: [] };
        });
        const interfaces = await collectInterfaces(vpp, ctx, lcp);
        const errors = await collectErrors(vpp, ctx);
        const buffers = parseBuffers(buffersText);
        const heap = parseHeap(heapText);
        const version = parseVersion(versionText);
        const findings = evaluateHealth({
          interfaces,
          lcp,
          errors,
          buffers,
          heap,
          minErrorRate: args.minErrorRate ?? 1,
        });
        if (!lcpLoaded) {
          findings.push({
            level: "info",
            check: "lcp",
            message:
              "linux-cp plugin not loaded (show lcp failed); no Linux interface mapping",
          });
        }
        const status = findings.some((x) => x.level === "critical")
          ? "critical"
          : findings.some((x) => x.level === "warning")
          ? "warning"
          : "ok";
        for (const x of findings) {
          ctx.logger.info("[{level}] {check}: {message}", x);
        }
        const handles = [
          await ctx.writeResource("version", "version", {
            node,
            collectedAt: now(),
            ...version,
          }),
          ...(lcpLoaded ? [await ctx.writeResource("lcp", "lcp", lcp)] : []),
          await ctx.writeResource("interfaces", "interfaces", interfaces),
          await ctx.writeResource("errors", "errors", errors),
          await ctx.writeResource("health", "health", {
            node,
            collectedAt: now(),
            version: version.version,
            status,
            findings,
            interfaces: {
              total: interfaces.count,
              adminUp: interfaces.interfaces.filter((i) => i.adminUp).length,
              linkDown: interfaces.interfaces.filter((i) =>
                i.adminUp && i.linkUp === false
              )
                .length,
              withAddress: interfaces.interfaces.filter((i) =>
                i.addresses.length
              ).length,
            },
            lcpPairs: lcp.pairs.length,
            threads: parseThreads(threadsText),
            buffers,
            ...(heap ? { heap } : {}),
          }),
        ];
        return { dataHandles: handles };
      },
    },
    neighbors: {
      description:
        "Read the ARP/ND neighbor table (show ip neighbors), optionally for one interface",
      kind: "read",
      arguments: z.object({
        interface: z.string().optional().describe("Only this interface"),
      }),
      execute: async (args: { interface?: string } & Injected, ctx: Ctx) => {
        const cmd = args.interface
          ? `show ip neighbors ${args.interface}`
          : "show ip neighbors";
        const neighbors = parseNeighbors(await session(args, ctx).show(cmd));
        return {
          dataHandles: [
            await ctx.writeResource(
              "neighbors",
              args.interface
                ? `neighbors-${slug(args.interface)}`
                : "neighbors",
              {
                node: describeNode(ctx.globalArgs),
                collectedAt: now(),
                count: neighbors.length,
                neighbors,
              },
            ),
          ],
        };
      },
    },
    show: {
      description:
        'Run any read-only "show ..." command and store the raw output (for anything the parsed methods do not cover)',
      kind: "read",
      arguments: ShowArgs,
      execute: async (args: z.infer<typeof ShowArgs> & Injected, ctx: Ctx) => {
        const output = await session(args, ctx).show(args.command);
        return {
          dataHandles: [
            await ctx.writeResource(
              "output",
              `show-${slug(args.command.replace(/^\s*sh(ow)?\s+/, ""))}`,
              {
                node: describeNode(ctx.globalArgs),
                collectedAt: now(),
                command: args.command,
                output,
              },
            ),
          ],
        };
      },
    },
  },
};
