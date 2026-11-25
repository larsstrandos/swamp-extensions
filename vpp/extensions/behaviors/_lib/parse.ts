/**
 * Parsers for `vppctl show ...` text output.
 *
 * VPP's CLI output is meant for humans and changes between releases, so every
 * parser here is lenient: lines it does not understand are skipped rather than
 * treated as errors. Verified against VPP 26.10.
 *
 * @module
 */

/** Remove ANSI colour escapes (vppctl colours some tables) and CRLF line ends. */
export function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n");
}

/** Parsed `show version`. */
export interface VppVersion {
  /** Version string, e.g. `v26.10-release`. */
  version: string;
  /** Build host, when present. */
  buildHost?: string;
  /** Build date, when present. */
  buildDate?: string;
  /** The raw first line. */
  raw: string;
}

/** Parse `show version`. */
export function parseVersion(text: string): VppVersion {
  const raw = stripAnsi(text).trim().split("\n")[0] ?? "";
  const m = raw.match(/^vpp\s+(\S+)(?:\s+built by \S+ on (\S+) at (\S+))?/);
  return {
    version: m?.[1] ?? raw,
    buildHost: m?.[2],
    buildDate: m?.[3],
    raw,
  };
}

/** One interface address from `show interface addr`. */
export interface InterfaceAddress {
  /** Address with prefix length, e.g. `192.0.2.0/31`. */
  address: string;
  /** `ip4` or `ip6`. */
  family: "ip4" | "ip6";
  /** VPP table id (0 when VPP does not print one). */
  tableId: number;
}

/** One interface from `show interface` merged with `show interface addr`. */
export interface VppInterface {
  /** Interface name, e.g. `GigabitEthernet3/0/0` or `tap4096`. */
  name: string;
  /** sw_if_index. */
  index: number;
  /** Admin state. */
  adminUp: boolean;
  /** MTU as L3/IP4/IP6/MPLS. */
  mtu: { l3: number; ip4: number; ip6: number; mpls: number };
  /** Non-zero counters, e.g. `{"rx packets": 56, drops: 12}`. */
  counters: Record<string, number>;
  /** Configured L3 addresses. */
  addresses: InterfaceAddress[];
  /** Interface this one borrows its address from (`unnumbered, use X`). */
  unnumberedFrom?: string;
}

/** Parse `show interface`. Addresses are filled in by {@link mergeAddresses}. */
export function parseInterfaces(text: string): VppInterface[] {
  const out: VppInterface[] = [];
  let cur: VppInterface | undefined;
  for (const line of stripAnsi(text).split("\n")) {
    if (/^\s*Name\s+Idx\s+State/.test(line) || line.trim() === "") continue;
    const head = line.match(
      /^(\S+)\s+(\d+)\s+(up|down|dn)\s+(\d+)\/(\d+)\/(\d+)\/(\d+)(?:\s+(.+?)\s+(\d+))?\s*$/,
    );
    if (head) {
      cur = {
        name: head[1],
        index: Number(head[2]),
        adminUp: head[3] === "up",
        mtu: {
          l3: Number(head[4]),
          ip4: Number(head[5]),
          ip6: Number(head[6]),
          mpls: Number(head[7]),
        },
        counters: {},
        addresses: [],
      };
      if (head[8] !== undefined) cur.counters[head[8]] = Number(head[9]);
      out.push(cur);
      continue;
    }
    const counter = line.match(/^\s+(\S.*?)\s+(\d+)\s*$/);
    if (counter && cur) cur.counters[counter[1]] = Number(counter[2]);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Parse `show interface addr` into name → addresses. */
export function parseInterfaceAddresses(
  text: string,
): Map<string, { addresses: InterfaceAddress[]; unnumberedFrom?: string }> {
  const out = new Map<
    string,
    { addresses: InterfaceAddress[]; unnumberedFrom?: string }
  >();
  let cur:
    | { addresses: InterfaceAddress[]; unnumberedFrom?: string }
    | undefined;
  for (const line of stripAnsi(text).split("\n")) {
    const head = line.match(/^(\S+)\s+\((?:up|dn|down)\):\s*$/);
    if (head) {
      cur = { addresses: [] };
      out.set(head[1], cur);
      continue;
    }
    if (!cur) continue;
    const l3 = line.match(
      /^\s+L3\s+(\S+)(?:\s+(ip4|ip6))?(?:\s+table-id\s+(\d+))?/,
    );
    if (l3) {
      cur.addresses.push({
        address: l3[1],
        family: l3[2] === "ip6" || l3[1].includes(":") ? "ip6" : "ip4",
        tableId: l3[3] !== undefined ? Number(l3[3]) : 0,
      });
      continue;
    }
    const un = line.match(/unnumbered,\s+use\s+(\S+)/);
    if (un) cur.unnumberedFrom = un[1];
  }
  return out;
}

/** Fill in addresses from {@link parseInterfaceAddresses}. */
export function mergeAddresses(
  ifaces: VppInterface[],
  addrs: ReturnType<typeof parseInterfaceAddresses>,
): VppInterface[] {
  return ifaces.map((i) => {
    const a = addrs.get(i.name);
    if (!a) return i;
    return {
      ...i,
      addresses: a.addresses,
      ...(a.unnumberedFrom ? { unnumberedFrom: a.unnumberedFrom } : {}),
    };
  });
}

/** One linux-cp interface pair. */
export interface LcpPair {
  /** Pair index. */
  index: number;
  /** VPP physical/sub interface. */
  phy: string;
  /** VPP side of the TAP/TUN, e.g. `tap4096`. */
  host: string;
  /** Linux interface name. */
  linuxName: string;
  /** Linux ifindex. */
  linuxIfIndex: number;
  /** `tap` or `tun`. */
  type: string;
  /** Network namespace, when the pair lives outside the default one. */
  netns?: string;
}

/** Parsed `show lcp`. */
export interface LcpState {
  /** Global linux-cp settings, e.g. `{"lcp-sync": "off"}`. */
  settings: Record<string, string>;
  /** Interface pairs. */
  pairs: LcpPair[];
}

/** Parse `show lcp`. */
export function parseLcp(text: string): LcpState {
  const settings: Record<string, string> = {};
  const pairs: LcpPair[] = [];
  for (const line of stripAnsi(text).split("\n")) {
    const pair = line.match(
      /^itf-pair:\s+\[(\d+)\]\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+type\s+(\S+)(?:\s+netns\s+(\S+))?/,
    );
    if (pair) {
      pairs.push({
        index: Number(pair[1]),
        phy: pair[2],
        host: pair[3],
        linuxName: pair[4],
        linuxIfIndex: Number(pair[5]),
        type: pair[6],
        ...(pair[7] ? { netns: pair[7] } : {}),
      });
      continue;
    }
    const setting = line.match(/^lcp\s+(.+?)\s+(\S+)\s*$/);
    if (setting) settings[setting[1]] = setting[2].replace(/^'|'$/g, "");
  }
  return { settings, pairs };
}

/** One FIB table from `show ip table` / `show ip6 table`. */
export interface FibTable {
  /** Internal fib index. */
  fibIndex: number;
  /** User-facing table id (the one you configure). */
  tableId: number;
  /** Table name, e.g. `ipv4-VRF:100`. */
  name: string;
  /** IPv6 per-interface link-local table. */
  linkLocal: boolean;
}

/** Parse `show ip table` or `show ip6 table`. */
export function parseTables(text: string): FibTable[] {
  const out: FibTable[] = [];
  for (const line of stripAnsi(text).split("\n")) {
    const m = line.match(/^\[(\d+)\]\s+table_id:(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    out.push({
      fibIndex: Number(m[1]),
      tableId: Number(m[2]),
      name: m[3],
      linkLocal: m[3].startsWith("IP6-link-local"),
    });
  }
  return out;
}

/** One forwarding path of a FIB entry. */
export interface FibPath {
  /**
   * `via` (adjacency to a next hop), `glean` (connected subnet), `receive`
   * (local address), `drop`, `lookup` (into another table) or `other`.
   */
  kind: "via" | "glean" | "receive" | "drop" | "lookup" | "other";
  /** Next hop address for `via`. */
  nextHop?: string;
  /** Outgoing (or receiving) interface. */
  interface?: string;
  /** The DPO text, for `other` and for anything not captured above. */
  raw: string;
}

/** One prefix in a FIB table. */
export interface FibEntry {
  /** Prefix, e.g. `10.0.0.0/24`. */
  prefix: string;
  /** Forwarding packets counted on the load-balance object. */
  packets: number;
  /** Forwarding bytes counted on the load-balance object. */
  bytes: number;
  /** Paths (buckets) of the load-balance. */
  paths: FibPath[];
}

/** Parsed `show ip[6] fib table N`. */
export interface Fib {
  /** Header name, e.g. `ipv4-VRF:100`. */
  name?: string;
  /** Internal fib index from the header. */
  fibIndex?: number;
  /** Entries in output order. */
  entries: FibEntry[];
}

const PREFIX_RE = /^([0-9a-fA-F:.]+\/\d+)\s*$/;

function parsePath(dpo: string): FibPath {
  let m = dpo.match(/^ipv[46] via (\S+) (\S+?):/);
  if (m) return { kind: "via", nextHop: m[1], interface: m[2], raw: dpo };
  m = dpo.match(/^ipv[46]-glean: \[[^\]]*\] (\S+?):/);
  if (m) return { kind: "glean", interface: m[1], raw: dpo };
  m = dpo.match(/^dpo-receive: \S+ on (\S+)/);
  if (m) return { kind: "receive", interface: m[1], raw: dpo };
  if (/^dpo-drop\b/.test(dpo)) return { kind: "drop", raw: dpo };
  if (/^dst-address,|lookup/.test(dpo)) return { kind: "lookup", raw: dpo };
  return { kind: "other", raw: dpo };
}

/** Parse `show ip fib table N` / `show ip6 fib table N` (default, non-detail). */
export function parseFib(text: string): Fib {
  const fib: Fib = { entries: [] };
  let cur: FibEntry | undefined;
  for (const line of stripAnsi(text).split("\n")) {
    const header = line.match(/^(ipv[46]-\S+?), fib_index:(\d+)/);
    if (header) {
      fib.name = header[1];
      fib.fibIndex = Number(header[2]);
      continue;
    }
    const prefix = line.match(PREFIX_RE);
    if (prefix) {
      cur = { prefix: prefix[1], packets: 0, bytes: 0, paths: [] };
      fib.entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const lb = line.match(/dpo-load-balance: .*?to:\[(\d+):(\d+)\]/);
    if (lb) {
      cur.packets = Number(lb[1]);
      cur.bytes = Number(lb[2]);
      continue;
    }
    const bucket = line.match(/^\s+\[\d+\]\s+\[@\d+\]:\s+(.+?)\s*$/);
    if (bucket) cur.paths.push(parsePath(bucket[1]));
  }
  return fib;
}

/** Parse `show ip[6] fib table N summary` into prefix length → count. */
export function parseFibSummary(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  let inTable = false;
  for (const line of stripAnsi(text).split("\n")) {
    if (/Prefix length\s+Count/.test(line)) {
      inTable = true;
      continue;
    }
    const m = inTable && line.match(/^\s+(\d+)\s+(\d+)\s*$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** One row of `show errors`. */
export interface ErrorCounter {
  /** Graph node, e.g. `ip6-input`. */
  node: string;
  /** Reason (VPP truncates it to ~35 characters). */
  reason: string;
  /** `error`, `warn`, `info` or `unknown`. */
  severity: string;
  /** Counter value. */
  count: number;
}

/** Parse `show errors`. Rows with the same node+reason (per-thread) are summed. */
export function parseErrors(text: string): ErrorCounter[] {
  const byKey = new Map<string, ErrorCounter>();
  for (const line of stripAnsi(text).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s+(\S+)\s*$/);
    if (!m) continue;
    const key = `${m[2]}\u0000${m[3]}`;
    const prev = byKey.get(key);
    if (prev) prev.count += Number(m[1]);
    else {
      byKey.set(key, {
        node: m[2],
        reason: m[3],
        severity: m[4],
        count: Number(m[1]),
      });
    }
  }
  return [...byKey.values()];
}

/** One buffer pool from `show buffers`. */
export interface BufferPool {
  /** Pool name. */
  name: string;
  /** NUMA node. */
  numa: number;
  /** Total buffers. */
  total: number;
  /** Available buffers. */
  avail: number;
  /** Cached buffers. */
  cached: number;
  /** Used buffers. */
  used: number;
}

/** Parse `show buffers`. */
export function parseBuffers(text: string): BufferPool[] {
  const out: BufferPool[] = [];
  for (const line of stripAnsi(text).split("\n")) {
    const m = line.match(
      /^(\S+)\s+\d+\s+(\d+)\s+\d+\s+\d+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/,
    );
    if (!m) continue;
    out.push({
      name: m[1],
      numa: Number(m[2]),
      total: Number(m[3]),
      avail: Number(m[4]),
      cached: Number(m[5]),
      used: Number(m[6]),
    });
  }
  return out;
}

const UNITS: Record<string, number> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

function bytes(n: string, unit: string): number {
  return Math.round(Number(n) * (UNITS[unit.toUpperCase()] ?? 1));
}

/** Parse the `total/used/free` line of `show memory main-heap`. */
export function parseHeap(
  text: string,
): { totalBytes: number; usedBytes: number; freeBytes: number } | undefined {
  const m = stripAnsi(text).match(
    /total:\s*([\d.]+)([KMGT]?),\s*used:\s*([\d.]+)([KMGT]?),\s*free:\s*([\d.]+)([KMGT]?)/i,
  );
  if (!m) return undefined;
  return {
    totalBytes: bytes(m[1], m[2]),
    usedBytes: bytes(m[3], m[4]),
    freeBytes: bytes(m[5], m[6]),
  };
}

/** One thread from `show threads`. */
export interface VppThread {
  /** Thread id. */
  id: number;
  /** Thread name, e.g. `vpp_main` or `vpp_wk_0`. */
  name: string;
  /** Pinned CPU, when shown. */
  cpu?: number;
}

/** Parse `show threads`. */
export function parseThreads(text: string): VppThread[] {
  const out: VppThread[] = [];
  for (const line of stripAnsi(text).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(?:\S+\s+)?(\d+)\s+(\d+)/);
    if (!m) continue;
    out.push({ id: Number(m[1]), name: m[2], cpu: Number(m[4]) });
  }
  return out;
}

/** One entry of `show ip neighbors`. */
export interface Neighbor {
  /** Neighbor IP address. */
  ip: string;
  /** `ip4` or `ip6`. */
  family: "ip4" | "ip6";
  /** MAC address. */
  mac: string;
  /** Interface. */
  interface: string;
  /** Flags: D dynamic, S static, N no-fib-entry. */
  flags: string;
  /** Seconds since last refresh. */
  ageSeconds: number;
}

/** Parse `show ip neighbors`. */
export function parseNeighbors(text: string): Neighbor[] {
  const out: Neighbor[] = [];
  for (const line of stripAnsi(text).split("\n")) {
    const m = line.match(
      /^\s*([\d.]+)\s+([0-9a-fA-F:.]+)\s+([A-Z]*)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+(\S+)\s*$/,
    );
    if (!m) continue;
    out.push({
      ageSeconds: Number(m[1]),
      ip: m[2],
      family: m[2].includes(":") ? "ip6" : "ip4",
      flags: m[3],
      mac: m[4],
      interface: m[5],
    });
  }
  return out;
}
