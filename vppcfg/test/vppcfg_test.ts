import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing";
import { behavior } from "../extensions/behaviors/vppcfg.ts";
import {
  compareBird,
  lineDiff,
  parseBirdProtocols,
  riskyCommands,
  sha256,
  vppcfgCommands,
} from "../extensions/behaviors/_lib/analyze.ts";
import type { Runner } from "../extensions/behaviors/_lib/node.ts";

const CONFIG = "/etc/vpp/vppcfg.yaml";
const BOOT = "/etc/vpp/config/vppcfg.vpp";

const YAML_OLD = `interfaces:
  TenGigabitEthernet1/0/0:
    mtu: 9214
    lcp: "e0"
`;
const YAML_NEW = `interfaces:
  TenGigabitEthernet1/0/0:
    description: "unused, no link"
    mtu: 9214
    lcp: "e0"
    state: down
`;

const BIRD_UP = `BIRD 2.19.2 ready.
Name       Proto      Table      State  Since         Info
device1    Device     ---        up     2026-11-20 12:00:00
rs1        BGP        ---        up     2026-11-20 12:00:05  Established
rs2        BGP        ---        start  2026-11-20 12:00:05  Passive
`;
const BIRD_RS1_DOWN = BIRD_UP.replace(
  "rs1        BGP        ---        up     2026-11-20 12:00:05  Established",
  "rs1        BGP        ---        start  2026-11-25 14:00:00  Active        Socket: Connection refused",
);

const render = (yaml: string) =>
  "comment { vppcfg create }\n" +
  (yaml.includes("state: down") ? "" : "set interface state TenGigabitEthernet1/0/0 up\n") +
  "lcp create TenGigabitEthernet1/0/0 host-if e0\n";

/**
 * Fake node: a file system, a running VPP that holds the last applied YAML,
 * and BIRD outputs handed out in order.
 */
function fakeNode(opts: {
  applyFails?: boolean;
  renderFailsAfterApply?: boolean;
  bird?: string[];
  running?: string;
  // running VPP drifts after the first plan (someone changed it)
  driftAfterPlans?: number;
} = {}) {
  const files = new Map<string, string>([[CONFIG, YAML_OLD], [BOOT, render(YAML_OLD)]]);
  let running = opts.running ?? YAML_OLD;
  let plans = 0;
  const bird = [...(opts.bird ?? [BIRD_UP, BIRD_UP])];
  const calls: string[][] = [];
  const runner: Runner = (argv, _signal, stdin) => {
    calls.push(argv);
    // docker exec -i lab sudo -n <cmd...>
    const cmd = argv.slice(argv.indexOf("-n") + 1);
    const ok = (stdout = "") => Promise.resolve({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string, code = 1) => Promise.resolve({ code, stdout: "", stderr });
    const [c, ...rest] = cmd;
    const last = rest[rest.length - 1];
    switch (c) {
      case "cat":
        return files.has(last) ? ok(files.get(last)) : fail(`cat: ${last}: No such file or directory`);
      case "tee":
        files.set(last, stdin ?? "");
        return ok(stdin);
      case "rm":
        files.delete(last);
        return ok();
      case "cp":
      case "install": {
        const from = rest[rest.length - 2];
        if (!files.has(from)) return fail(`${c}: cannot stat '${from}'`);
        files.set(last, files.get(from)!);
        return ok();
      }
      case "vppcfg": {
        const f = files.get(last) ?? "";
        if (rest[0] === "check") return f.includes("INVALID") ? fail("[ERROR] invalid", 255) : ok();
        if (rest[0] === "plan" && rest[1] === "--novpp") {
          if (opts.renderFailsAfterApply && running !== YAML_OLD) return fail("[ERROR] render failed", 1);
          return ok(render(f));
        }
        if (rest[0] === "plan") {
          plans++;
          if (opts.driftAfterPlans !== undefined && plans > opts.driftAfterPlans) running = "drifted";
          if (f === running) return ok("");
          return ok(
            "comment { vppcfg sync: 1 CLI statement(s) follow }\n" +
              (running === "drifted" ? "set interface mtu packet 1500 TenGigabitEthernet1/0/0\n" : "") +
              (f.includes("state: down") ? "set interface state TenGigabitEthernet1/0/0 down\n" : "set interface state TenGigabitEthernet1/0/0 up\n"),
          );
        }
        if (rest[0] === "apply") {
          if (opts.applyFails) return fail("[ERROR] apply failed", 1);
          running = f;
          return ok();
        }
        return fail("unknown vppcfg");
      }
      case "birdc":
        return ok(bird.shift() ?? BIRD_UP);
      default:
        return fail(`unexpected ${c}`);
    }
  };
  return { files, runner, calls, running: () => running };
}

const globalArgs = {
  transport: "docker" as const,
  container: "lab",
  containerRuntime: "docker" as const,
  sudo: true,
  sshOptions: [],
  timeoutSeconds: 5,
  vppcfg: "vppcfg",
  vppcfgConfig: CONFIG,
  vppcfgBootFile: BOOT,
  birdc: "birdc",
};

async function repoWith(yaml: string): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/pe01.yaml`, yaml);
  return dir;
}

// deno-lint-ignore no-explicit-any
type AnyCtx = any;
const noSleep = () => Promise.resolve();

async function planned(n: ReturnType<typeof fakeNode>, repoDir: string) {
  const t = createModelTestContext({ globalArgs, repoDir });
  await behavior.methods.plan.execute({ file: "pe01.yaml", _runner: n.runner }, t.context as AnyCtx);
  const plan = t.getWrittenResources()[0].data;
  return { t, plan };
}

Deno.test("plan: diff, commands, risky lines, boot change; live files untouched, staging removed", async () => {
  const n = fakeNode();
  const repoDir = await repoWith(YAML_NEW);
  const { plan } = await planned(n, repoDir);
  assertEquals(plan.valid, true);
  assertEquals(plan.source, "local:pe01.yaml");
  assertEquals(plan.yamlSha256, await sha256(YAML_NEW));
  assertEquals(plan.commands, ["set interface state TenGigabitEthernet1/0/0 down"]);
  assertEquals((plan.risky as { reason: string }[])[0].reason, "takes an interface down");
  assertEquals((plan.yamlDiff as string[]).filter((l) => /^[+-]/.test(l)), [
    '+    description: "unused, no link"',
    "+    state: down",
  ]);
  assertEquals(plan.bootDiff, ["-set interface state TenGigabitEthernet1/0/0 up"]);
  assertEquals(plan.noop, false);
  assertEquals(n.files.get(CONFIG), YAML_OLD);
  assertEquals([...n.files.keys()].filter((k) => k.startsWith("/tmp/")), []);
});

Deno.test("plan: current YAML in sync is a noop", async () => {
  const n = fakeNode();
  const t = createModelTestContext({ globalArgs });
  await behavior.methods.plan.execute({ _runner: n.runner }, t.context as AnyCtx);
  const plan = t.getWrittenResources()[0].data;
  assertEquals([plan.source, plan.noop, plan.commands], ["current", true, []]);
});

Deno.test("plan: invalid YAML is recorded and fails the method", async () => {
  const n = fakeNode();
  const repoDir = await repoWith("INVALID\n");
  const t = createModelTestContext({ globalArgs, repoDir });
  await assertRejects(
    () => behavior.methods.plan.execute({ file: "pe01.yaml", _runner: n.runner }, t.context as AnyCtx),
    Error,
    "vppcfg check failed",
  );
  assertEquals(t.getWrittenResources()[0].data.valid, false);
});

Deno.test("apply: refuses a different file, a missing plan, and risky lines without allowRisky", async () => {
  const n = fakeNode();
  const repoDir = await repoWith(YAML_NEW);
  const sha = await sha256(YAML_NEW);
  const bare = createModelTestContext({ globalArgs, repoDir });
  await assertRejects(
    () =>
      behavior.methods.apply.execute(
        { file: "pe01.yaml", expectSha256: "0".repeat(64), allowRisky: true, settleSeconds: 0, _runner: n.runner },
        bare.context as AnyCtx,
      ),
    Error,
    "no valid plan",
  );
  const { plan } = await planned(n, repoDir);
  const withPlan = createModelTestContext({ globalArgs, repoDir, storedResources: { plan } });
  await assertRejects(
    () =>
      behavior.methods.apply.execute(
        { file: "pe01.yaml", expectSha256: "0".repeat(64), allowRisky: true, settleSeconds: 0, _runner: n.runner },
        withPlan.context as AnyCtx,
      ),
    Error,
    "approved plan is for",
  );
  // a different file than the planned one, without expectSha256
  await Deno.writeTextFile(`${repoDir}/other.yaml`, YAML_OLD + "# edited after approval\n");
  await assertRejects(
    () =>
      behavior.methods.apply.execute(
        { file: "other.yaml", allowRisky: true, settleSeconds: 0, _runner: n.runner },
        withPlan.context as AnyCtx,
      ),
    Error,
    "approved plan is for",
  );
  const t = createModelTestContext({ globalArgs, repoDir, storedResources: { plan } });
  await assertRejects(
    () =>
      behavior.methods.apply.execute(
        { file: "pe01.yaml", expectSha256: sha, allowRisky: false, settleSeconds: 0, _runner: n.runner },
        t.context as AnyCtx,
      ),
    Error,
    "allowRisky",
  );
  assertEquals(n.files.get(CONFIG), YAML_OLD);
  assertEquals(n.running(), YAML_OLD);
});

Deno.test("apply: happy path backs up, installs, applies, re-renders the boot file, checks BIRD", async () => {
  const n = fakeNode();
  const repoDir = await repoWith(YAML_NEW);
  const { plan } = await planned(n, repoDir);
  const t = createModelTestContext({ globalArgs, repoDir, storedResources: { plan } });
  await behavior.methods.apply.execute(
    {
      file: "pe01.yaml",
      expectSha256: plan.yamlSha256 as string,
      allowRisky: true,
      settleSeconds: 15,
      _runner: n.runner,
      _sleep: noSleep,
    },
    t.context as AnyCtx,
  );
  const applied = t.getWrittenResources()[0].data as {
    status: string;
    backups: { config: string; bootFile: string };
    residualPlan: string[];
    bootFileUpdated: boolean;
    bird: { checked: boolean; lost: string[] };
  };
  assertEquals(applied.status, "applied");
  assertEquals(n.running(), YAML_NEW);
  assertEquals(n.files.get(CONFIG), YAML_NEW);
  assertEquals(n.files.get(BOOT), render(YAML_NEW));
  assertEquals(n.files.get(applied.backups.config), YAML_OLD);
  assertEquals(n.files.get(applied.backups.bootFile), render(YAML_OLD));
  assertEquals(applied.residualPlan, []);
  assertEquals(applied.bootFileUpdated, true);
  assertEquals([applied.bird.checked, applied.bird.lost], [true, []]);
  assertEquals([...n.files.keys()].filter((k) => k.startsWith("/tmp/")), []);
});

Deno.test("apply: refuses when the running VPP changed after the plan", async () => {
  const n = fakeNode({ driftAfterPlans: 1 });
  const repoDir = await repoWith(YAML_NEW);
  const { plan } = await planned(n, repoDir);
  const t = createModelTestContext({ globalArgs, repoDir, storedResources: { plan } });
  await assertRejects(
    () =>
      behavior.methods.apply.execute(
        { file: "pe01.yaml", expectSha256: plan.yamlSha256 as string, allowRisky: true, settleSeconds: 0, _runner: n.runner },
        t.context as AnyCtx,
      ),
    Error,
    "changed since the plan",
  );
  assertEquals(n.files.get(CONFIG), YAML_OLD);
});

Deno.test("apply: a failed vppcfg apply restores the YAML and records the failure", async () => {
  const n = fakeNode({ applyFails: true });
  const repoDir = await repoWith(YAML_NEW);
  const { plan } = await planned(n, repoDir);
  const t = createModelTestContext({ globalArgs, repoDir, storedResources: { plan } });
  await assertRejects(
    () =>
      behavior.methods.apply.execute(
        { file: "pe01.yaml", expectSha256: plan.yamlSha256 as string, allowRisky: true, settleSeconds: 0, _runner: n.runner },
        t.context as AnyCtx,
      ),
    Error,
    "restored",
  );
  assertEquals(n.files.get(CONFIG), YAML_OLD);
  assertEquals(n.files.get(BOOT), render(YAML_OLD));
  assertEquals(t.getWrittenResources()[0].data.status, "failed");
});

Deno.test("apply: BIRD sessions lost after apply are reported", async () => {
  const n = fakeNode({ bird: [BIRD_UP, BIRD_RS1_DOWN] });
  const repoDir = await repoWith(YAML_NEW);
  const { plan } = await planned(n, repoDir);
  const t = createModelTestContext({ globalArgs, repoDir, storedResources: { plan } });
  await behavior.methods.apply.execute(
    { file: "pe01.yaml", expectSha256: plan.yamlSha256 as string, allowRisky: true, settleSeconds: 1, _runner: n.runner, _sleep: noSleep },
    t.context as AnyCtx,
  );
  const applied = t.getWrittenResources()[0].data as { bird: { lost: string[]; changes: { name: string; proto: string; before?: string; after?: string; lost: boolean }[] } };
  assertEquals(applied.bird.lost, ["rs1"]);
  assertEquals(applied.bird.changes, [{ name: "rs1", proto: "BGP", before: "up Established", after: "start Active", lost: true }]);
});

Deno.test("fetch: saves locally and refuses to overwrite by default", async () => {
  const n = fakeNode();
  const repoDir = await Deno.makeTempDir();
  const t = createModelTestContext({ globalArgs, repoDir });
  await behavior.methods.fetch.execute({ saveTo: "pe01.yaml", overwrite: false, _runner: n.runner }, t.context as AnyCtx);
  assertEquals(await Deno.readTextFile(`${repoDir}/pe01.yaml`), YAML_OLD);
  assertEquals(t.getWrittenResources()[0].data.sha256, await sha256(YAML_OLD));
  await assertRejects(() =>
    behavior.methods.fetch.execute({ saveTo: "pe01.yaml", overwrite: false, _runner: n.runner }, t.context as AnyCtx)
  );
});

Deno.test("analyze helpers", () => {
  assertEquals(vppcfgCommands("comment { x }\n\nlcp delete A.1\r\n"), ["lcp delete A.1"]);
  assertEquals(riskyCommands(["lcp delete A.1", "set interface mtu packet 9000 A", "delete sub A.1"]).map((r) => r.command), [
    "lcp delete A.1",
    "delete sub A.1",
  ]);
  assertEquals(lineDiff("a\nb\nc\n", "a\nc\nd\n", 0), ["-b", "...", "+d"]);
  const p = parseBirdProtocols(BIRD_UP);
  assertEquals(p.map((x) => [x.name, x.state, x.info]), [["device1", "up", ""], ["rs1", "up", "Established"], ["rs2", "start", "Passive"]]);
  assertEquals(compareBird(p, p), []);
  assert(compareBird(p, p.slice(1))[0].lost);
});

Deno.test("method argument names never collide with global argument names", () => {
  const globals = new Set(Object.keys(behavior.globalArguments.shape));
  assert(globals.has("vppcfg"));
  for (const [name, m] of Object.entries(behavior.methods)) {
    // deno-lint-ignore no-explicit-any
    const keys = Object.keys((m.arguments as any).shape ?? {});
    assertEquals(keys.filter((k) => globals.has(k)), [], `method ${name}`);
  }
});

Deno.test("apply: a failure after vppcfg apply still records the live change", async () => {
  const n = fakeNode({ renderFailsAfterApply: true });
  const repoDir = await repoWith(YAML_NEW);
  const { plan } = await planned(n, repoDir);
  const t = createModelTestContext({ globalArgs, repoDir, storedResources: { plan } });
  await assertRejects(
    () =>
      behavior.methods.apply.execute(
        { file: "pe01.yaml", allowRisky: true, settleSeconds: 0, _runner: n.runner, _sleep: noSleep },
        t.context as AnyCtx,
      ),
    Error,
    "vppcfg apply succeeded",
  );
  const applied = t.getWrittenResources()[0].data as { status: string; bootFileUpdated: boolean; error: string };
  assertEquals([applied.status, applied.bootFileUpdated], ["failed", false]);
  assert(applied.error.includes("re-render"));
  assertEquals(n.running(), YAML_NEW);
});
