/**
 * Runs commands on a vppcfg-managed VPP node: locally, inside a container or
 * over SSH, optionally through `sudo -n`. Only the fixed commands in
 * {@link Node} are ever run.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Absolute path without shell metacharacters. */
export const SAFE_PATH = /^\/[A-Za-z0-9_.\/-]+$/;

/** Connection settings and file locations for one node (global arguments). */
export const NodeArgsSchema = z.object({
  transport: z.enum(["local", "docker", "ssh"]).default("ssh").describe(
    "How to reach the node: on this host, with `<runtime> exec`, or over SSH",
  ),
  host: z.string().optional().describe(
    "SSH destination (user@host or an ssh_config alias); required for ssh",
  ),
  container: z.string().optional().describe(
    "Container name or id; required for docker",
  ),
  containerRuntime: z.enum(["docker", "podman"]).default("docker").describe(
    "Container CLI used with transport docker",
  ),
  sudo: z.boolean().default(true).describe(
    "Run commands through `sudo -n` (vppcfg needs the VPP API socket, and installing the YAML needs root)",
  ),
  sshOptions: z.array(z.string()).default([]).describe(
    'Extra ssh arguments, e.g. ["-J", "bastion"]',
  ),
  timeoutSeconds: z.number().int().positive().default(120).describe(
    "Timeout for each remote command",
  ),
  vppcfg: z.string().regex(/^[A-Za-z0-9_.\/-]+$/).default("vppcfg").describe(
    "vppcfg binary on the node",
  ),
  vppcfgConfig: z.string().regex(SAFE_PATH).default("/etc/vpp/vppcfg.yaml")
    .describe("vppcfg YAML on the node"),
  vppcfgBootFile: z.string().regex(SAFE_PATH).default(
    "/etc/vpp/config/vppcfg.vpp",
  ).describe(
    "CLI file VPP execs at boot, rendered from the YAML with vppcfg plan --novpp",
  ),
  birdc: z.string().default("birdc").describe(
    'birdc command on the node; set to "" to skip the BIRD before/after check',
  ),
}).superRefine((v, ctx) => {
  if (v.transport === "ssh" && !v.host) {
    ctx.addIssue({
      code: "custom",
      path: ["host"],
      message: "host is required for transport ssh",
    });
  }
  if (v.transport === "docker" && !v.container) {
    ctx.addIssue({
      code: "custom",
      path: ["container"],
      message: "container is required for transport docker",
    });
  }
});

/** Parsed node settings. */
export type NodeArgs = z.infer<typeof NodeArgsSchema>;

/** Result of one process run. */
export interface ProcResult {
  /** Exit code. */
  code: number;
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
}

/** Runs an argv vector, optionally feeding stdin. Injected in tests. */
export type Runner = (
  argv: string[],
  signal: AbortSignal,
  stdin?: string,
) => Promise<ProcResult>;

/** Default runner: spawns the process with Deno.Command. */
export const denoRunner: Runner = async (argv, signal, stdin) => {
  // argv is built by wrapArgv around one of the fixed commands of Node:
  // cat, tee, cp, install, rm of the vppcfg files, vppcfg check/plan/apply,
  // and birdc show protocols.
  // swamp-quality-ignore deno-command
  const child = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const out = await child.output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
};

/** POSIX single-quote a word for a remote shell. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_\-./=:@%+,]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Wrap a command for the node's transport (and sudo). */
export function wrapArgv(node: NodeArgs, command: string[]): string[] {
  const inner = [...(node.sudo ? ["sudo", "-n"] : []), ...command];
  switch (node.transport) {
    case "local":
      return inner;
    case "docker":
      return [node.containerRuntime, "exec", "-i", node.container!, ...inner];
    case "ssh":
      return [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        ...node.sshOptions,
        node.host!,
        "--",
        inner.map(shellQuote).join(" "),
      ];
  }
}

/** Human-readable target, for logs and errors. */
export function describeNode(node: NodeArgs): string {
  switch (node.transport) {
    case "local":
      return "local";
    case "docker":
      return `${node.containerRuntime}:${node.container}`;
    case "ssh":
      return `ssh:${node.host}`;
  }
}

function lastLine(s: string): string {
  return s.trim().split("\n").filter((l) => l.trim()).pop()?.trim().slice(
    0,
    400,
  ) ?? "";
}

/** The fixed set of commands this extension runs on a node. */
export class Node {
  /** Bind to one node; `runner` is replaceable for tests. */
  constructor(
    readonly args: NodeArgs,
    readonly signal: AbortSignal,
    readonly runner: Runner = denoRunner,
  ) {}

  private async run(
    command: string[],
    stdin?: string,
  ): Promise<ProcResult> {
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(this.args.timeoutSeconds * 1000),
    ]);
    const argv = wrapArgv(this.args, command);
    try {
      return await this.runner(argv, signal, stdin);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(`${argv[0]} not found on this host`);
      }
      if (signal.aborted && !this.signal.aborted) {
        throw new Error(
          `"${command.join(" ")}" on ${
            describeNode(this.args)
          } timed out after ${this.args.timeoutSeconds}s`,
        );
      }
      throw err;
    }
  }

  /** Run and require exit 0; returns stdout. */
  private async must(command: string[], stdin?: string): Promise<string> {
    const r = await this.run(command, stdin);
    if (r.code !== 0) {
      throw new Error(
        `"${command.join(" ")}" on ${
          describeNode(this.args)
        } failed (exit ${r.code}): ${lastLine(r.stderr || r.stdout)}`,
      );
    }
    return r.stdout;
  }

  private path(p: string): string {
    if (!SAFE_PATH.test(p)) throw new Error(`refusing path "${p}"`);
    return p;
  }

  /** Read a file. */
  read(path: string): Promise<string> {
    return this.must(["cat", "--", this.path(path)]);
  }

  /** Write a staging file under /tmp (never the live config). */
  async stage(path: string, content: string): Promise<void> {
    if (!path.startsWith("/tmp/")) throw new Error(`refusing to stage ${path}`);
    await this.must(["tee", "--", this.path(path)], content).then(() => {});
  }

  /** Remove a staging file under /tmp. */
  async unstage(path: string): Promise<void> {
    if (!path.startsWith("/tmp/")) {
      throw new Error(`refusing to remove ${path}`);
    }
    await this.run(["rm", "-f", "--", this.path(path)]);
  }

  /** Copy preserving mode and owner (used for backups). */
  async backup(from: string, to: string): Promise<void> {
    await this.must(["cp", "-p", "--", this.path(from), this.path(to)]);
  }

  /** Install a file as root:root 0644 (atomic rename by install). */
  async install(from: string, to: string): Promise<void> {
    await this.must([
      "install",
      "-o",
      "root",
      "-g",
      "root",
      "-m",
      "0644",
      "--",
      this.path(from),
      this.path(to),
    ]);
  }

  /** `vppcfg check -c <file>` (no VPP). */
  async check(file: string): Promise<ProcResult> {
    return await this.run([this.args.vppcfg, "check", "-c", this.path(file)]);
  }

  /** `vppcfg plan -c <file>` against the running VPP (read-only). */
  plan(file: string): Promise<string> {
    return this.must([this.args.vppcfg, "plan", "-c", this.path(file)]);
  }

  /** `vppcfg plan --novpp -c <file>`: the boot render (no VPP). */
  render(file: string): Promise<string> {
    return this.must([
      this.args.vppcfg,
      "plan",
      "--novpp",
      "-c",
      this.path(file),
    ]);
  }

  /** `vppcfg apply -c <file>`: changes the running VPP. */
  async apply(file: string): Promise<ProcResult> {
    return await this.run([this.args.vppcfg, "apply", "-c", this.path(file)]);
  }

  /** `birdc show protocols`, or undefined when BIRD checking is off. */
  async birdProtocols(): Promise<string | undefined> {
    if (!this.args.birdc) return undefined;
    return await this.must([this.args.birdc, "show", "protocols"]);
  }
}
