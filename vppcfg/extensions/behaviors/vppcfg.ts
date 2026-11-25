// swamp-quality-ignore testing-completeness: tests live in test/, outside the shipped extension
/**
 * Change a vppcfg-managed VPP node the safe way: plan a YAML against the
 * running VPP, approve exactly that plan, apply it, re-render the boot file
 * and compare BIRD before and after.
 *
 * The YAML comes from a local file (for example from a git repository, or a
 * copy downloaded with `fetch` and edited), or from a file already on the node
 * (for example a backup). The node's live YAML and boot file are only written
 * by `apply`, after backups, and only when the re-planned commands are exactly
 * the approved ones.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type BirdProtocol,
  compareBird,
  lineDiff,
  parseBirdProtocols,
  riskyCommands,
  sha256,
  vppcfgCommands,
} from "./_lib/analyze.ts";
import {
  describeNode,
  Node,
  type NodeArgs,
  NodeArgsSchema,
  type Runner,
  SAFE_PATH,
} from "./_lib/node.ts";

type Handle = { name: string };

/** The parts of the method context this behavior uses. */
interface Ctx {
  globalArgs: NodeArgs;
  signal: AbortSignal;
  repoDir: string;
  logger: { info(msg: string, ...args: unknown[]): void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Handle>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
}

/** Test hooks: a process runner and a clock. */
type Injected = { _runner?: Runner; _sleep?: (ms: number) => Promise<void> };

const now = () => new Date().toISOString();

function node(args: Injected, ctx: Ctx): Node {
  return new Node(ctx.globalArgs, ctx.signal, args._runner);
}

// ---------------------------------------------------------------- schemas

const Collected = { node: z.string(), collectedAt: z.string() };

const RiskySchema = z.object({ command: z.string(), reason: z.string() });

const YamlSchema = z.object({
  ...Collected,
  config: z.string(),
  sha256: z.string(),
  content: z.string(),
  savedTo: z.string().optional(),
});

const PlanSchema = z.object({
  ...Collected,
  /** Where the YAML came from: `local:<path>`, `node:<path>` or `current`. */
  source: z.string(),
  yamlSha256: z.string(),
  currentSha256: z.string(),
  /** Line diff of the node's current YAML against the planned one. */
  yamlDiff: z.array(z.string()),
  valid: z.boolean(),
  checkOutput: z.string().optional(),
  /** What `vppcfg apply` would run now. */
  commands: z.array(z.string()),
  risky: z.array(RiskySchema),
  /** Line diff of the boot file's commands against the new render. */
  bootDiff: z.array(z.string()),
  /** Nothing would change: same YAML, empty plan, boot file current. */
  noop: z.boolean(),
});

type PlanData = z.infer<typeof PlanSchema>;

const BirdChangeSchema = z.object({
  name: z.string(),
  proto: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  lost: z.boolean(),
});

const AppliedSchema = z.object({
  ...Collected,
  status: z.enum(["applied", "failed"]),
  error: z.string().optional(),
  source: z.string(),
  yamlSha256: z.string(),
  commands: z.array(z.string()),
  backups: z.object({ config: z.string(), bootFile: z.string() }),
  /** `vppcfg plan` after apply; should be empty. */
  residualPlan: z.array(z.string()),
  bootFileUpdated: z.boolean(),
  bird: z.object({
    checked: z.boolean(),
    settleSeconds: z.number(),
    changes: z.array(BirdChangeSchema),
    /** Protocols that were up before and are not now. */
    lost: z.array(z.string()),
  }),
});

const RoutingSchema = z.object({
  ...Collected,
  protocols: z.array(z.object({
    name: z.string(),
    proto: z.string(),
    state: z.string(),
    info: z.string(),
  })),
  up: z.number(),
  total: z.number(),
});

// ---------------------------------------------------------------- sources

const SourceArgs = {
  file: z.string().optional().describe(
    "Local YAML file to plan/apply (relative to the swamp repo, or absolute)",
  ),
  remoteFile: z.string().regex(SAFE_PATH).optional().describe(
    "YAML already on the node to plan/apply instead, e.g. a backup",
  ),
};

interface Source {
  label: string;
  content: string;
}

async function loadSource(
  args: { file?: string; remoteFile?: string },
  ctx: Ctx,
  n: Node,
): Promise<Source> {
  if (args.file && args.remoteFile) {
    throw new Error("give file or remoteFile, not both");
  }
  if (args.file) {
    const p = args.file.startsWith("/")
      ? args.file
      : `${ctx.repoDir}/${args.file}`;
    return { label: `local:${args.file}`, content: await Deno.readTextFile(p) };
  }
  if (args.remoteFile) {
    return {
      label: `node:${args.remoteFile}`,
      content: await n.read(args.remoteFile),
    };
  }
  return {
    label: "current",
    content: await n.read(ctx.globalArgs.vppcfgConfig),
  };
}

function stagePath(sha: string, ext: string): string {
  return `/tmp/swamp-vppcfg-${sha.slice(0, 16)}.${ext}`;
}

async function planSource(src: Source, ctx: Ctx, n: Node): Promise<PlanData> {
  const g = ctx.globalArgs;
  const yamlSha256 = await sha256(src.content);
  const current = await n.read(g.vppcfgConfig);
  const currentSha256 = await sha256(current);
  const staged = stagePath(yamlSha256, "yaml");
  const base = {
    node: describeNode(g),
    collectedAt: now(),
    source: src.label,
    yamlSha256,
    currentSha256,
    yamlDiff: lineDiff(current, src.content),
  };
  await n.stage(staged, src.content);
  try {
    const check = await n.check(staged);
    if (check.code !== 0) {
      return {
        ...base,
        valid: false,
        checkOutput: (check.stderr || check.stdout).trim().slice(-4000),
        commands: [],
        risky: [],
        bootDiff: [],
        noop: false,
      };
    }
    const [plan, render, boot] = await Promise.all([
      n.plan(staged),
      n.render(staged),
      n.read(g.vppcfgBootFile).catch(() => ""),
    ]);
    const commands = vppcfgCommands(plan);
    const bootDiff = lineDiff(
      vppcfgCommands(boot).join("\n"),
      vppcfgCommands(render).join("\n"),
    ).filter((l) => l.startsWith("+") || l.startsWith("-"));
    return {
      ...base,
      valid: true,
      commands,
      risky: riskyCommands(commands),
      bootDiff,
      noop: commands.length === 0 && yamlSha256 === currentSha256 &&
        bootDiff.length === 0,
    };
  } finally {
    await n.unstage(staged);
  }
}

// ---------------------------------------------------------------- behavior

const FetchArgs = z.object({
  saveTo: z.string().optional().describe(
    "Also write the YAML to this local file (relative to the swamp repo, or absolute), e.g. to edit it",
  ),
  overwrite: z.boolean().default(false).describe("Allow replacing saveTo"),
});

const PlanArgs = z.object(SourceArgs);

const ApplyArgs = z.object({
  ...SourceArgs,
  expectSha256: z.string().regex(/^[0-9a-f]{64}$/).optional().describe(
    "SHA-256 of the YAML that was approved; defaults to the latest plan's yamlSha256. The YAML must hash to the planned one either way",
  ),
  allowRisky: z.boolean().default(false).describe(
    "Allow plans that delete, remove addresses, take interfaces down or move tables",
  ),
  settleSeconds: z.number().int().min(0).default(15).describe(
    "Wait this long after apply before the second BIRD snapshot",
  ),
});

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** vppcfg change behavior. */
export const behavior = {
  type: "@lstrandos/vppcfg/node",
  version: "2026.11.25.1",
  description:
    "Plan, approve and apply vppcfg YAML on a VPP node, with backups, a re-rendered boot file and a BIRD before/after check",
  globalArguments: NodeArgsSchema,
  resources: {
    yaml: {
      description: "The node's vppcfg YAML",
      schema: YamlSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    plan: {
      description: "What applying a YAML would do",
      schema: PlanSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    applied: {
      description: "Result of an apply (audit trail)",
      schema: AppliedSchema,
      lifetime: "infinite",
      garbageCollection: 200,
    },
    routing: {
      description: "birdc show protocols",
      schema: RoutingSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    fetch: {
      description:
        "Read the node's vppcfg YAML (and optionally save it locally for editing)",
      kind: "read",
      arguments: FetchArgs,
      execute: async (args: z.infer<typeof FetchArgs> & Injected, ctx: Ctx) => {
        const g = ctx.globalArgs;
        const content = await node(args, ctx).read(g.vppcfgConfig);
        let savedTo: string | undefined;
        if (args.saveTo) {
          const p = args.saveTo.startsWith("/")
            ? args.saveTo
            : `${ctx.repoDir}/${args.saveTo}`;
          await Deno.writeTextFile(p, content, { createNew: !args.overwrite });
          savedTo = args.saveTo;
        }
        return {
          dataHandles: [
            await ctx.writeResource("yaml", "yaml", {
              node: describeNode(g),
              collectedAt: now(),
              config: g.vppcfgConfig,
              sha256: await sha256(content),
              content,
              ...(savedTo ? { savedTo } : {}),
            }),
          ],
        };
      },
    },
    plan: {
      description:
        "Check a YAML (local file, file on the node, or the current one) and plan it against the running VPP; shows the YAML diff, the commands, risky commands and the boot-file change. Changes nothing (uses a staging file in /tmp)",
      arguments: PlanArgs,
      execute: async (args: z.infer<typeof PlanArgs> & Injected, ctx: Ctx) => {
        const n = node(args, ctx);
        const data = await planSource(await loadSource(args, ctx, n), ctx, n);
        const handle = await ctx.writeResource("plan", "plan", data);
        if (!data.valid) {
          throw new Error(`vppcfg check failed:\n${data.checkOutput}`);
        }
        ctx.logger.info(
          "plan: {n} command(s), {r} risky, YAML {d} changed line(s), boot file {b} changed line(s)",
          {
            n: data.commands.length,
            r: data.risky.length,
            d: data.yamlDiff.filter((l) => /^[+-]/.test(l)).length,
            b: data.bootDiff.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    apply: {
      description:
        "Apply the approved YAML: require the same SHA-256 and the same plan as approved, back up the YAML and boot file, install the YAML, vppcfg apply, re-render the boot file, and compare BIRD before/after. Restores the YAML if vppcfg apply fails",
      arguments: ApplyArgs,
      execute: async (args: z.infer<typeof ApplyArgs> & Injected, ctx: Ctx) => {
        const g = ctx.globalArgs;
        const n = node(args, ctx);
        const sleep = args._sleep ??
          ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const src = await loadSource(args, ctx, n);
        const sha = await sha256(src.content);
        const approved = (await ctx.readResource?.("plan")) as PlanData | null;
        if (!approved || !approved.valid) {
          throw new Error(
            "no valid plan on this node; run plan first and approve it",
          );
        }
        const expected = args.expectSha256 ?? approved.yamlSha256;
        if (sha !== expected || approved.yamlSha256 !== expected) {
          throw new Error(
            `the YAML (${src.label}) has SHA-256 ${sha}, but the approved plan is for ${expected}; plan it again`,
          );
        }
        const replan = await planSource(src, ctx, n);
        if (!sameList(replan.commands, approved.commands)) {
          throw new Error(
            `the running VPP changed since the plan: it would now run ${replan.commands.length} command(s) instead of the approved ${approved.commands.length}; plan and approve again`,
          );
        }
        if (replan.risky.length && !args.allowRisky) {
          throw new Error(
            `refusing risky commands without allowRisky: ${
              replan.risky.map((r) => r.command).join("; ")
            }`,
          );
        }

        const birdBefore = await n.birdProtocols();
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(
          /\..*$/,
          "",
        );
        const backups = {
          config: `${g.vppcfgConfig}.bak-swamp-${stamp}`,
          bootFile: `${g.vppcfgBootFile}.bak-swamp-${stamp}`,
        };
        await n.backup(g.vppcfgConfig, backups.config);
        await n.backup(g.vppcfgBootFile, backups.bootFile).catch(() => {});

        const stagedYaml = stagePath(sha, "yaml");
        const stagedBoot = stagePath(sha, "vpp");
        const base = {
          node: describeNode(g),
          source: src.label,
          yamlSha256: sha,
          commands: replan.commands,
          backups,
        };
        try {
          await n.stage(stagedYaml, src.content);
          await n.install(stagedYaml, g.vppcfgConfig);
          const res = await n.apply(g.vppcfgConfig);
          if (res.code !== 0) {
            await n.install(backups.config, g.vppcfgConfig);
            const error =
              `vppcfg apply failed (exit ${res.code}); the YAML was restored from ${backups.config}. VPP may be partly changed: run plan to see. ${
                (res.stderr || res.stdout).trim().slice(-1500)
              }`;
            await ctx.writeResource("applied", "applied", {
              ...base,
              collectedAt: now(),
              status: "failed",
              error,
              residualPlan: [],
              bootFileUpdated: false,
              bird: { checked: false, settleSeconds: 0, changes: [], lost: [] },
            });
            throw new Error(error);
          }
          // vppcfg apply succeeded: from here on the change is live, so any
          // failure must still leave an audit record.
          let residualPlan: string[] = [];
          let bootFileUpdated = false;
          let bird = {
            checked: false,
            settleSeconds: 0,
            changes: [] as ReturnType<typeof compareBird>,
            lost: [] as string[],
          };
          try {
            residualPlan = vppcfgCommands(await n.plan(g.vppcfgConfig));
            const render = await n.render(g.vppcfgConfig);
            await n.stage(stagedBoot, render);
            await n.install(stagedBoot, g.vppcfgBootFile);
            bootFileUpdated = (await n.read(g.vppcfgBootFile)) === render;

            if (birdBefore !== undefined) {
              await sleep(args.settleSeconds * 1000);
              const after = await n.birdProtocols();
              const changes = compareBird(
                parseBirdProtocols(birdBefore),
                parseBirdProtocols(after ?? ""),
              );
              bird = {
                checked: true,
                settleSeconds: args.settleSeconds,
                changes,
                lost: changes.filter((c) => c.lost).map((c) => c.name),
              };
            }
            if (residualPlan.length) {
              ctx.logger.info(
                "after apply, vppcfg still plans {n} command(s)",
                {
                  n: residualPlan.length,
                },
              );
            }
            if (bird.lost.length) {
              ctx.logger.info("BIRD protocols down after apply: {lost}", {
                lost: bird.lost.join(", "),
              });
            }
          } catch (err) {
            const error =
              `vppcfg apply succeeded (VPP and ${g.vppcfgConfig} are changed), but the follow-up failed: ${
                (err as Error).message
              }. bootFileUpdated=${bootFileUpdated}; if false, re-render ${g.vppcfgBootFile} (backup: ${backups.bootFile}) before the next reboot.`;
            await ctx.writeResource("applied", "applied", {
              ...base,
              collectedAt: now(),
              status: "failed",
              error,
              residualPlan,
              bootFileUpdated,
              bird,
            });
            throw new Error(error);
          }
          return {
            dataHandles: [
              await ctx.writeResource("applied", "applied", {
                ...base,
                collectedAt: now(),
                status: "applied",
                residualPlan,
                bootFileUpdated,
                bird,
              }),
            ],
          };
        } finally {
          await n.unstage(stagedYaml);
          await n.unstage(stagedBoot);
        }
      },
    },
    routing: {
      description: "Snapshot BIRD's protocols (birdc show protocols)",
      kind: "read",
      arguments: z.object({}),
      execute: async (args: Injected, ctx: Ctx) => {
        const text = await node(args, ctx).birdProtocols();
        if (text === undefined) {
          throw new Error('birdc is set to ""; BIRD checks are off');
        }
        const protocols: BirdProtocol[] = parseBirdProtocols(text);
        return {
          dataHandles: [
            await ctx.writeResource("routing", "routing", {
              node: describeNode(ctx.globalArgs),
              collectedAt: now(),
              protocols,
              up: protocols.filter((p) => p.state === "up").length,
              total: protocols.length,
            }),
          ],
        };
      },
    },
  },
};
