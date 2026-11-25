import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
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
  stripAnsi,
} from "../extensions/behaviors/_lib/parse.ts";
import { assertShowCommand, buildArgv, NodeArgsSchema } from "../extensions/behaviors/_lib/vppctl.ts";

const fx = (name: string) => Deno.readTextFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));

Deno.test("stripAnsi removes colours and CRLF", () => {
  assertEquals(stripAnsi("\x1b[33mID\x1b[0m a\r\nb"), "ID a\nb");
});

Deno.test("parseVersion", () => {
  const v = parseVersion(fx("version"));
  assertEquals(v.version, "v26.10-release");
  assertEquals(v.buildDate, "2026-10-28T14:34:56");
});

Deno.test("parseInterfaces + addresses", () => {
  const ifs = mergeAddresses(
    parseInterfaces(fx("interface")),
    parseInterfaceAddresses(fx("interface_addr")),
  );
  assertEquals(ifs.length, 7);
  assertEquals(ifs[0].name, "local0");
  assertEquals(ifs[0].adminUp, false);
  const vb1 = ifs.find((i) => i.name === "host-vb1")!;
  assertEquals(vb1.mtu.l3, 9000);
  assertEquals(vb1.counters["rx packets"] > 0, true);
  assertEquals(vb1.addresses, [
    { address: "192.0.2.0/31", family: "ip4", tableId: 100 },
    { address: "2001:db8:1::1/64", family: "ip6", tableId: 100 },
  ]);
  const vr1 = ifs.find((i) => i.name === "host-vr1")!;
  assertEquals(vr1.addresses[0].tableId, 200);
});

Deno.test("parseInterfaceAddresses: unnumbered and no table-id", () => {
  const a = parseInterfaceAddresses(
    "loop0 (up):\n  L3 10.0.0.1/32\nGigabitEthernet3/0/0 (up):\n  unnumbered, use loop0\n  L3 10.0.0.1/32\n",
  );
  assertEquals(a.get("loop0")!.addresses, [{ address: "10.0.0.1/32", family: "ip4", tableId: 0 }]);
  assertEquals(a.get("GigabitEthernet3/0/0")!.unnumberedFrom, "loop0");
});

Deno.test("parseLcp", () => {
  const l = parseLcp(fx("lcp"));
  assertEquals(l.settings["lcp-sync"], "off");
  assertEquals(l.settings["default netns"], "<unset>");
  assertEquals(l.pairs.length, 3);
  assertEquals(l.pairs[0], {
    index: 0,
    phy: "host-vb1",
    host: "tap4096",
    linuxName: "blue1",
    linuxIfIndex: 6,
    type: "tap",
  });
});

Deno.test("parseLcp with netns", () => {
  const l = parseLcp("itf-pair: [0] GigabitEthernet3/0/0 tap1 e0 12 type tap netns dataplane\n");
  assertEquals(l.pairs[0].netns, "dataplane");
});

Deno.test("parseTables", () => {
  const t4 = parseTables(fx("ip_table"));
  assertEquals(t4.map((t) => t.tableId), [0, 100, 200]);
  const t6 = parseTables(fx("ip6_table"));
  assertEquals(t6.filter((t) => !t.linkLocal).map((t) => t.tableId), [0, 100, 200]);
  assertEquals(t6.some((t) => t.linkLocal), true);
});

Deno.test("parseFib ip4", () => {
  const f = parseFib(fx("ip_fib_table_100"));
  assertEquals(f.name, "ipv4-VRF:100");
  assertEquals(f.fibIndex, 1);
  const byPrefix = new Map(f.entries.map((e) => [e.prefix, e]));
  assertEquals(byPrefix.get("0.0.0.0/0")!.paths[0].kind, "drop");
  const p = byPrefix.get("10.100.0.0/24")!.paths[0];
  assertEquals([p.kind, p.nextHop, p.interface], ["via", "192.0.2.1", "host-vb1"]);
  assertEquals(byPrefix.get("192.0.2.0/31")!.paths[0].kind, "glean");
  assertEquals(byPrefix.get("192.0.2.0/32")!.paths[0].kind, "receive");
  const total = Object.values(parseFibSummary(fx("ip_fib_table_100_summary"))).reduce((a, b) => a + b);
  assertEquals(f.entries.length, total);
});

Deno.test("parseFib ip6", () => {
  const f = parseFib(fx("ip6_fib_table_100"));
  assertEquals(f.name, "ipv6-VRF:100");
  const e = f.entries.find((x) => x.prefix === "2001:db8:100::/48")!;
  assertEquals(e.paths[0].nextHop, "2001:db8:1::2");
});

Deno.test("parseErrors", () => {
  const e = parseErrors(fx("errors"));
  const nd = e.find((x) => x.node === "ip6-icmp-input" && x.reason.startsWith("neighbor solicitations"))!;
  assertEquals(nd.severity, "error");
  assertEquals(e.every((x) => Number.isFinite(x.count)), true);
});

Deno.test("parseErrors sums per-thread rows", () => {
  const e = parseErrors(
    "   Count   Node   Reason   Severity\n  5  ip4-input  ip4 ttl <= 1  error\n  7  ip4-input  ip4 ttl <= 1  error\n",
  );
  assertEquals(e, [{ node: "ip4-input", reason: "ip4 ttl <= 1", severity: "error", count: 12 }]);
});

Deno.test("parseBuffers, parseHeap, parseThreads, parseNeighbors", () => {
  const b = parseBuffers(fx("buffers"));
  assertEquals(b[0].name, "default-numa-0");
  assertEquals(b[0].total, 16383);
  const h = parseHeap(fx("memory_main-heap"))!;
  assertEquals(h.totalBytes, 512 * 1024 ** 2);
  assertEquals(parseThreads(fx("threads"))[0].name, "vpp_main");
  const n = parseNeighbors(fx("ip_neighbors"));
  assertEquals(n.length, 6);
  assertEquals(n.find((x) => x.ip === "2001:db8:51::2")!.interface, "host-vb2");
});

Deno.test("buildArgv per transport", () => {
  const local = NodeArgsSchema.parse({});
  assertEquals(buildArgv(local, "show version"), ["vppctl", "-s", "/run/vpp/cli.sock", "show version"]);
  const docker = NodeArgsSchema.parse({ transport: "docker", container: "vpp1", containerRuntime: "podman" });
  assertEquals(buildArgv(docker, "show lcp").slice(0, 3), ["podman", "exec", "vpp1"]);
  const ssh = NodeArgsSchema.parse({ transport: "ssh", host: "root@pe01", sudo: true, sshOptions: ["-J", "jump"] });
  assertEquals(buildArgv(ssh, "show ip fib table 100"), [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-J", "jump", "root@pe01", "--",
    "sudo -n vppctl -s /run/vpp/cli.sock 'show ip fib table 100'",
  ]);
});

Deno.test("NodeArgsSchema requires host/container", () => {
  assertEquals(NodeArgsSchema.safeParse({ transport: "ssh" }).success, false);
  assertEquals(NodeArgsSchema.safeParse({ transport: "docker" }).success, false);
});

Deno.test("only show commands", () => {
  assertShowCommand("show version");
  assertShowCommand("sh int");
  assertThrows(() => assertShowCommand("clear errors"));
  assertThrows(() => assertShowCommand("set interface state x down"));
  assertThrows(() => assertShowCommand("showx"));
});

Deno.test("parseThreads: lcore layout (VPP 26.06)", () => {
  const t = parseThreads(
    "ID     Name                Type        LWP     Sched Policy (Priority)  lcore  Core   Socket State\r\n" +
      "0      vpp_main                        899     other (0)                0      0      0\r\n" +
      "1      vpp_wk_0            workers     964     other (0)                1      1      0\r\n" +
      "2      vpp_wk_1            workers     965     other (0)                2      2      0\r\n",
  );
  assertEquals(t, [
    { id: 0, name: "vpp_main", cpu: 0 },
    { id: 1, name: "vpp_wk_0", cpu: 1 },
    { id: 2, name: "vpp_wk_1", cpu: 2 },
  ]);
});

Deno.test("parseHardwareBrief", () => {
  const lab = parseHardwareBrief(fx("hardware-interfaces_brief"));
  assertEquals(lab.get("host-vb1"), { linkUp: true });
  const hw = parseHardwareBrief(
    "              Name                Idx   Link  Hardware\n" +
      "TenGigabitEthernet1/0/0            1    down  TenGigabitEthernet1/0/0\n" +
      "  Link speed: unknown\n  RX Queues:\n    queue thread         mode\n    0     vpp_wk_0 (1)   polling\n" +
      "TenGigabitEthernet1/0/2            3     up   TenGigabitEthernet1/0/2\n" +
      "  Link speed: 10 Gbps\n",
  );
  assertEquals(hw.get("TenGigabitEthernet1/0/0"), { linkUp: false });
  assertEquals(hw.get("TenGigabitEthernet1/0/2"), { linkUp: true, speed: "10 Gbps" });
});
