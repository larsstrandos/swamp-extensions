import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing";
import { behavior, evaluateHealth } from "../extensions/behaviors/vpp.ts";
import type { Runner } from "../extensions/behaviors/_lib/vppctl.ts";

const fx = (name: string) => Deno.readTextFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));

/** Fake vppctl: answers from fixtures, keyed by the command (last argv word). */
function fakeRunner(overrides: Record<string, string> = {}): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((argv: string[]) => {
    calls.push(argv);
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
};

Deno.test("health writes all resources and reports ok on a fresh node", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  const runner = fakeRunner();
  // deno-lint-ignore no-explicit-any
  await behavior.methods.health.execute({ _runner: runner }, context as any);
  const written = getWrittenResources();
  assertEquals(written.map((w) => w.name).sort(), ["errors", "health", "interfaces", "lcp", "version"]);
  const health = written.find((w) => w.name === "health")!.data;
  assertEquals(health.status, "ok");
  assertEquals(health.lcpPairs, 3);
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

Deno.test("evaluateHealth flags low buffers, full heap and rising errors, ignores benign af-packet", () => {
  const f = evaluateHealth({
    interfaces: { node: "n", collectedAt: "t", count: 0, interfaces: [] },
    lcp: { settings: {}, pairs: [] },
    errors: {
      node: "n",
      collectedAt: "t",
      previousAt: "p",
      counters: [
        { node: "af-packet-input", reason: "timed out block", severity: "error", count: 9, delta: 9 },
        { node: "ip4-input", reason: "ip4 ttl <= 1", severity: "error", count: 5, delta: 5 },
      ],
    },
    buffers: [{ name: "default-numa-0", numa: 0, total: 1000, avail: 50, cached: 0, used: 950 }],
    heap: { totalBytes: 100, usedBytes: 95 },
  });
  assertEquals(f.map((x) => `${x.level}:${x.check}`), [
    "critical:buffers",
    "critical:heap",
    "warning:error-counters",
  ]);
});

Deno.test("health still works when linux-cp is not loaded", async () => {
  const { context, getWrittenResources } = createModelTestContext({ globalArgs });
  const runner = fakeRunner({ "show lcp": "show: unknown input `lcp'" });
  // deno-lint-ignore no-explicit-any
  await behavior.methods.health.execute({ _runner: runner }, context as any);
  const written = getWrittenResources();
  assertEquals(written.some((w) => w.name === "lcp"), false);
  const health = written.find((w) => w.name === "health")!.data as {
    status: string;
    findings: { check: string }[];
  };
  assertEquals(health.status, "ok");
  assertEquals(health.findings.some((f) => f.check === "lcp"), true);
});
