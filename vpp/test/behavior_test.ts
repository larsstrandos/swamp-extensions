import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing";
import { behavior, classifyCounter, evaluateHealth, evaluateVppcfg } from "../extensions/behaviors/vpp.ts";
import type { Runner } from "../extensions/behaviors/_lib/vppctl.ts";
import { diffBootFile } from "../extensions/behaviors/_lib/parse.ts";

const fx = (name: string) => Deno.readTextFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));

/** Fake vppctl: answers from fixtures, keyed by the command (last argv word). */
function fakeRunner(overrides: Record<string, string> = {}): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((argv: string[]) => {
    calls.push(argv);
    const joined = argv.join(" ");
    const special = /\bvppcfg plan --novpp\b/.test(joined)
      ? "vppcfg-render"
      : /\bvppcfg plan\b/.test(joined)
      ? "vppcfg-plan"
      : /\bcat -- /.test(joined)
      ? "cat"
      : undefined;
    if (special) {
      const o = overrides[special];
      return Promise.resolve(
        o === undefined
          ? { code: 1, stdout: "", stderr: "sudo: vppcfg: command not found" }
          : { code: 0, stdout: o, stderr: "" },
      );
    }
    const cmd = argv[argv.length - 1];
    if (cmd in overrides) return Promise.resolve({ code: 0, stdout: overrides[cmd], stderr: "" });
    const name = cmd.replace(/^show /, "").replaceAll(" ", "_");
    try {
      return Promise.resolve({ code: 0, stdout: fx(name), stderr: "" });
    } catch {
      return Promise.resolve({ code: 0, stdout: `show: unknown input \`${cmd}'`, stderr: "" });
    }
  }) as unknown as Runner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const globalArgs = {
  transport: "docker" as const,
  container: "lab",
  containerRuntime: "docker" as const,
  socket: "/run/vpp/cli.sock",
  sudo: false,
  sshOptions: [],
  vppctl: "vppctl",
  timeoutSeconds: 5,
  vppcfg: "vppcfg",
  vppcfgConfig: "/etc/vpp/vppcfg.yaml",
  vppcfgBootFile: "/etc/vpp/config/vppcfg.vpp",
};

Deno.test("health writes all resources and reports ok on a fresh node", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  const runner = fakeRunner();
  // deno-lint-ignore no-explicit-any
  await behavior.methods.health.execute({ minErrorRate: 1, checkVppcfg: true, _runner: runner }, context as any);
  const written = getWrittenResources();
  assertEquals(written.map((w) => w.name).sort(), ["errors", "health", "interfaces", "lcp", "version"]);
  const health = written.find((w) => w.name === "health")!.data;
  assertEquals(health.status, "ok");
  assertEquals(health.lcpPairs, 3);
  assertEquals((health.interfaces as { linkDown: number }).linkDown, 0);
  const ifs = written.find((w) => w.name === "interfaces")!.data as {
    interfaces: { name: string; lcpLinuxName?: string; lcpHostFor?: string }[];
  };
  assertEquals(ifs.interfaces.find((i) => i.name === "host-vb1")!.lcpLinuxName, "blue1");
  assertEquals(ifs.interfaces.find((i) => i.name === "tap4096")!.lcpHostFor, "host-vb1");
  assertEquals(runner.calls.every((c) => c[0] === "docker" && c[2] === "lab"), true);
});

Deno.test("errors computes deltas against the previous run", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: {
      errors: {
        node: "docker:lab",
        collectedAt: "2026-11-25T00:00:00.000Z",
        counters: [{ node: "ip6-input", reason: "ip6 source lookup miss", severity: "error", count: 1 }],
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  await behavior.methods.errors.execute({ _runner: fakeRunner() }, context as any);
  const data = getWrittenResources()[0].data as {
    previousAt: string;
    counters: { node: string; reason: string; count: number; delta: number }[];
  };
  assertEquals(data.previousAt, "2026-11-25T00:00:00.000Z");
  const c = data.counters.find((x) => x.reason === "ip6 source lookup miss")!;
  assertEquals(c.delta, c.count - 1);
});

Deno.test("fib stores summary only when the table is larger than maxEntries", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  const runner = fakeRunner();
  await behavior.methods.fib.execute(
    { family: "ip4", table: 100, summary: false, maxEntries: 3, _runner: runner },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  const w = getWrittenResources()[0];
  assertEquals(w.name, "fib-ip4-100");
  assertEquals(w.data.truncated, true);
  assertEquals((w.data.entries as unknown[]).length, 0);
  assertEquals(w.data.totalPrefixes, 16);
  assertEquals(runner.calls.length, 1);
});

Deno.test("show refuses non-show commands without running anything", async () => {
  const { context } = createModelTestContext({ globalArgs });
  const runner = fakeRunner();
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => behavior.methods.show.execute({ command: "clear interfaces", _runner: runner }, context as any),
    Error,
    "only",
  );
  assertEquals(runner.calls.length, 0);
});

Deno.test("vppctl parse errors become method errors", async () => {
  const { context } = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      behavior.methods.show.execute(
        { command: "show nonsense", _runner: fakeRunner() },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "unknown input",
  );
});

const ifaces = (interfaces: unknown[]) => ({
  node: "n",
  collectedAt: "2026-11-25T12:00:10.000Z",
  previousAt: "2026-11-25T12:00:00.000Z",
  count: interfaces.length,
  // deno-lint-ignore no-explicit-any
  interfaces: interfaces as any,
});

const errs = (counters: { node: string; reason: string; delta: number; severity?: string }[]) => ({
  node: "n",
  collectedAt: "2026-11-25T12:00:10.000Z", // 10 s after previousAt
  previousAt: "2026-11-25T12:00:00.000Z",
  counters: counters.map((c) => ({ severity: "error", count: c.delta, ...c })),
});

const quiet = { buffers: [], lcp: { settings: {}, pairs: [] } };

Deno.test("evaluateHealth flags low buffers and a full heap", () => {
  const f = evaluateHealth({
    interfaces: ifaces([]),
    lcp: { settings: {}, pairs: [] },
    errors: errs([]),
    buffers: [{ name: "default-numa-0", numa: 0, total: 1000, avail: 50, cached: 0, used: 950 }],
    heap: { totalBytes: 100, usedBytes: 95 },
  });
  assertEquals(f.map((x) => `${x.level}:${x.check}`), ["critical:buffers", "critical:heap"]);
});

Deno.test("evaluateHealth: error counters by class and rate", () => {
  const f = evaluateHealth({
    ...quiet,
    interfaces: ifaces([]),
    errors: errs([
      // benign: never
      { node: "af-packet-input", reason: "timed out block", delta: 9000 },
      { node: "dpdk-input", reason: "no error", delta: 9000 },
      { node: "TenGigabitEthernet1/0/0-output", reason: "interface is down", delta: 9000 },
      // noisy: only >= 100/s (1000 in 10 s)
      { node: "ip4-input", reason: "ip4 ttl <= 1", delta: 107 },
      { node: "ip6-icmp-input", reason: "neighbor solicitations for unknown", delta: 104 },
      { node: "ip6-input", reason: "ip6 ttl <= 1", delta: 5000 },
      // severe: any increase
      { node: "TenGigabitEthernet3/0/0-tx", reason: "Tx packet drops (dpdk tx failure)", delta: 1 },
      // normal: >= minErrorRate (1/s → 10 in 10 s)
      { node: "ip4-input", reason: "ip4 source lookup miss", delta: 9 },
      { node: "ip4-glean", reason: "address overflow drops", delta: 30 },
      // info severity: never
      { node: "arp-reply", reason: "ARP replies sent", delta: 9000, severity: "info" },
    ]),
  });
  const msgs = f.map((x) => x.message.split(":")[0] + ":" + x.message.split('"')[1]);
  assertEquals(msgs.sort(), [
    "TenGigabitEthernet3/0/0-tx:Tx packet drops (dpdk tx failure)",
    "ip4-glean:address overflow drops",
    "ip6-input:ip6 ttl <= 1",
  ]);
});

Deno.test("classifyCounter", () => {
  assertEquals(classifyCounter({ node: "dpdk-input", reason: "no error" }), "benign");
  assertEquals(classifyCounter({ node: "llc-input", reason: "unknown llc ssap/dsap" }), "noisy");
  assertEquals(classifyCounter({ node: "arp-reply", reason: "IP4 source address not local to sub" }), "noisy");
  assertEquals(classifyCounter({ node: "ip4-rewrite", reason: "MTU exceeded" }), "severe");
  assertEquals(classifyCounter({ node: "ip4-input", reason: "ip4 source lookup miss" }), "normal");
});

Deno.test("evaluateHealth: admin up + link down is one finding, its tx-error is ignored", () => {
  const f = evaluateHealth({
    ...quiet,
    interfaces: ifaces([
      {
        name: "TenGigabitEthernet1/0/0",
        index: 1,
        adminUp: true,
        linkUp: false,
        lcpLinuxName: "e0",
        mtu: { l3: 9214, ip4: 0, ip6: 0, mpls: 0 },
        counters: { "tx-error": 77766 },
        countersDelta: { "tx-error": 1 },
        addresses: [],
      },
      {
        name: "TenGigabitEthernet3/0/0",
        index: 5,
        adminUp: true,
        linkUp: true,
        mtu: { l3: 1500, ip4: 0, ip6: 0, mpls: 0 },
        counters: { "rx-miss": 10, drops: 500 },
        countersDelta: { "rx-miss": 3, drops: 213 },
        addresses: [],
      },
    ]),
    errors: errs([]),
  });
  assertEquals(f.map((x) => `${x.check}:${x.message.split(" ")[0]}`), [
    "link-down:TenGigabitEthernet1/0/0",
    "interface-errors:TenGigabitEthernet3/0/0:",
  ]);
});

Deno.test("health still works when linux-cp is not loaded", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  const runner = fakeRunner({ "show lcp": "show: unknown input `lcp'" });
  // deno-lint-ignore no-explicit-any
  await behavior.methods.health.execute({ minErrorRate: 1, checkVppcfg: true, _runner: runner }, context as any);
  const written = getWrittenResources();
  assertEquals(written.some((w) => w.name === "lcp"), false);
  const health = written.find((w) => w.name === "health")!.data as {
    status: string;
    findings: { check: string }[];
  };
  assertEquals(health.status, "ok");
  assertEquals(health.findings.some((f) => f.check === "lcp"), true);
});

Deno.test("evaluateHealth: admin-down ports are quiet unless they still have addresses", () => {
  const base = { mtu: { l3: 9214, ip4: 0, ip6: 0, mpls: 0 }, counters: {}, countersDelta: { "tx-error": 27 } };
  const f = evaluateHealth({
    buffers: [],
    lcp: {
      settings: {},
      pairs: [{ index: 0, phy: "TenGigabitEthernet1/0/0", host: "tap1", linuxName: "e0", linuxIfIndex: 5, type: "tap" }],
    },
    interfaces: ifaces([
      // unused port, admin down on purpose: nothing to report
      { ...base, name: "TenGigabitEthernet1/0/0", index: 1, adminUp: false, linkUp: false, addresses: [] },
      // admin down but still addressed: suspicious
      {
        ...base,
        name: "TenGigabitEthernet3/0/0",
        index: 5,
        adminUp: false,
        addresses: [{ address: "192.0.2.1/31", family: "ip4", tableId: 0 }],
      },
    ]),
    errors: errs([]),
  });
  assertEquals(f.map((x) => x.message), [
    "TenGigabitEthernet3/0/0 is admin down but has addresses (192.0.2.1/31)",
  ]);
});

Deno.test("upgrade chain is ascending and ends at the behavior version", () => {
  const to = behavior.upgrades.map((u) => u.toVersion);
  assertEquals([...to].sort(), to);
  assertEquals(to[to.length - 1], behavior.version);
});

// Boot render as vppcfg 1.1.6 prints it (documentation names).
const RENDER_OLD = `comment { vppcfg create: 3 CLI statement(s) follow }
create sub TenGigabitEthernet3/0/2 2111 dot1q 2111 exact-match
lcp create TenGigabitEthernet3/0/2 host-if e6
comment { vppcfg sync: 2 CLI statement(s) follow }
set interface ip address TenGigabitEthernet3/0/2.2111 192.0.2.116/24
set interface state TenGigabitEthernet3/0/2.2111 up
`;

Deno.test("vppcfg: node without vppcfg is skipped quietly; health stays ok", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  // deno-lint-ignore no-explicit-any
  await behavior.methods.health.execute({ minErrorRate: 1, checkVppcfg: true, _runner: fakeRunner() }, context as any);
  const written = getWrittenResources();
  assertEquals(written.some((w) => w.name === "vppcfg"), false);
  assertEquals((written.find((w) => w.name === "health")!.data as { status: string }).status, "ok");
});

Deno.test("vppcfg: the pe01 case (auto-subint pair not in the YAML)", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  const runner = fakeRunner({
    "vppcfg-plan": "comment { vppcfg prune: 1 CLI statement(s) follow }\nlcp delete TenGigabitEthernet3/0/2.2111\n",
    "vppcfg-render": RENDER_OLD,
    "cat": RENDER_OLD,
  });
  // deno-lint-ignore no-explicit-any
  await behavior.methods.vppcfg.execute({ _runner: runner }, context as any);
  const data = getWrittenResources()[0].data as Parameters<typeof evaluateVppcfg>[0];
  assertEquals(data.managed, true);
  assertEquals(data.running, { inSync: false, pending: ["lcp delete TenGigabitEthernet3/0/2.2111"] });
  assertEquals(data.boot?.inSync, true);
  assertEquals(evaluateVppcfg(data).map((f) => f.check), ["vppcfg-sub-lcp", "vppcfg-drift"]);
  // vppcfg commands go through the same transport, with the configured paths
  const plan = runner.calls.find((c) => c.includes("plan") && !c.includes("--novpp"))!;
  assertEquals(plan.slice(0, 3), ["docker", "exec", "lab"]);
  assertEquals(plan.slice(-4), ["vppcfg", "plan", "-c", "/etc/vpp/vppcfg.yaml"]);
});

Deno.test("vppcfg: stale boot file", async () => {
  const rendered = RENDER_OLD.replace(
    "lcp create TenGigabitEthernet3/0/2 host-if e6\n",
    "lcp create TenGigabitEthernet3/0/2 host-if e6\nlcp create TenGigabitEthernet3/0/2.2111 host-if e6.2111\n",
  );
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  await behavior.methods.vppcfg.execute(
    { _runner: fakeRunner({ "vppcfg-plan": "", "vppcfg-render": rendered, "cat": RENDER_OLD }) },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  const data = getWrittenResources()[0].data as Parameters<typeof evaluateVppcfg>[0];
  assertEquals(data.running?.inSync, true);
  assertEquals(data.boot?.missing, ["lcp create TenGigabitEthernet3/0/2.2111 host-if e6.2111"]);
  assertEquals(data.boot?.extra, []);
  const f = evaluateVppcfg(data);
  assertEquals(f.map((x) => x.check), ["vppcfg-boot"]);
});

Deno.test("diffBootFile detects order changes", () => {
  const a = "create sub X 1\nlcp create X host-if x\n";
  const b = "lcp create X host-if x\ncreate sub X 1\n";
  assertEquals(diffBootFile(a, b), { inSync: false, missing: [], extra: [], orderDiffers: true });
  assertEquals(diffBootFile("comment { a }\n" + a, a + "\n").inSync, true);
});

Deno.test("vppcfg: other plan failures are reported, not hidden", () => {
  const f = evaluateVppcfg({
    node: "n",
    collectedAt: "t",
    config: "/etc/vpp/vppcfg.yaml",
    bootFile: "/etc/vpp/config/vppcfg.vpp",
    managed: true,
    reason: "PermissionError: [Errno 13] Permission denied",
  });
  assertEquals(f.map((x) => `${x.level}:${x.check}`), ["info:vppcfg"]);
});

Deno.test("method argument names never collide with global argument names", () => {
  // swamp fills method arguments from global arguments of the same name.
  const globals = new Set(Object.keys(behavior.globalArguments.shape ?? {}));
  assertEquals(globals.has("vppcfg"), true);
  for (const [name, m] of Object.entries(behavior.methods)) {
    // deno-lint-ignore no-explicit-any
    const keys = Object.keys((m.arguments as any).shape ?? {});
    assertEquals(keys.filter((k) => globals.has(k)), [], `method ${name}`);
  }
});

Deno.test("vppcfg: a VLAN missing entirely from the YAML is drift, not a missing lcp", () => {
  const f = evaluateVppcfg({
    node: "n",
    collectedAt: "t",
    config: "/etc/vpp/vppcfg.yaml",
    bootFile: "/etc/vpp/config/vppcfg.vpp",
    managed: true,
    running: {
      inSync: false,
      pending: ["lcp delete TenGigabitEthernet3/0/2.2111", "delete sub TenGigabitEthernet3/0/2.2111"],
    },
    boot: { checked: true, inSync: true, missing: [], extra: [], orderDiffers: false },
  });
  assertEquals(f.map((x) => x.check), ["vppcfg-drift"]);
});
