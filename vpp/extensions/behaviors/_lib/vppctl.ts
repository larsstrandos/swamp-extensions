/**
 * Runs `vppctl` on a VPP node, locally, inside a container or over SSH.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { stripAnsi } from "./parse.ts";

/** Absolute path without shell metacharacters. */
const SAFE_PATH = /^\/[A-Za-z0-9_.\/-]+$/;

/** Connection settings for one VPP node (the behavior's global arguments). */
export const NodeArgsSchema = z.object({
  transport: z.enum(["local", "docker", "ssh"]).default("local").describe(
    "How to reach vppctl: on this host, with `<runtime> exec`, or over SSH",
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
  socket: z.string().default("/run/vpp/cli.sock").describe(
    "VPP CLI socket passed to vppctl -s",
  ),
  sudo: z.boolean().default(false).describe(
    "Run vppctl through `sudo -n` (non-interactive)",
  ),
  sshOptions: z.array(z.string()).default([]).describe(
    'Extra ssh arguments, e.g. ["-J", "bastion"] or ["-p", "2222"]',
  ),
  vppctl: z.string().default("vppctl").describe("vppctl binary on the node"),
  timeoutSeconds: z.number().int().positive().default(30).describe(
    "Timeout for each vppctl call",
  ),
  vppcfg: z.string().default("vppcfg").describe(
    "vppcfg binary on the node (used read-only: plan, and plan --novpp)",
  ),
  vppcfgConfig: z.string().regex(SAFE_PATH).default("/etc/vpp/vppcfg.yaml")
    .describe("vppcfg YAML on the node"),
  vppcfgBootFile: z.string().regex(SAFE_PATH).default(
    "/etc/vpp/config/vppcfg.vpp",
  ).describe("CLI file rendered from the YAML that VPP execs at boot"),
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

/** Runs an argv vector. Injected in tests. */
export type Runner = (
  argv: string[],
  signal: AbortSignal,
) => Promise<ProcResult>;

/** Default runner: spawns the process with Deno.Command. */
export const denoRunner: Runner = async (argv, signal) => {
  // argv is built by wrapArgv: a fixed ssh/docker/sudo prefix around one of
  // the read-only commands in this module (vppctl "show ...", vppcfg plan,
  // cat of the vppcfg boot file), quoted for the remote shell.
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
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

/** Build the argv that runs one vppctl command on the node. */
export function buildArgv(node: NodeArgs, command: string): string[] {
  return wrapArgv(node, [node.vppctl, "-s", node.socket, command]);
}

/**
 * Wrap a command for the node's transport (and sudo). Only called with the
 * fixed read-only commands of this module: vppctl show, vppcfg plan, cat.
 */
export function wrapArgv(node: NodeArgs, command: string[]): string[] {
  const inner = [...(node.sudo ? ["sudo", "-n"] : []), ...command];
  switch (node.transport) {
    case "local":
      return inner;
    case "docker":
      return [node.containerRuntime, "exec", node.container!, ...inner];
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
      return `local:${node.socket}`;
    case "docker":
      return `${node.containerRuntime}:${node.container}`;
    case "ssh":
      return `ssh:${node.host}`;
  }
}

/** Only read-only commands are allowed through this extension. */
export function assertShowCommand(command: string): void {
  if (!/^\s*(show|sh)\s+\S/.test(command)) {
    throw new Error(
      `refusing "${command}": only "show ..." commands are allowed (diagnostics are read-only)`,
    );
  }
}

/** A vppctl session bound to one node. */
export class Vppctl {
  /** Create a session; `runner` is replaceable for tests. */
  constructor(
    readonly node: NodeArgs,
    readonly signal: AbortSignal,
    readonly runner: Runner = denoRunner,
  ) {}

  /** Run one `show` command and return its output with colour codes removed. */
  async show(command: string): Promise<string> {
    assertShowCommand(command);
    const res = await this.run(buildArgv(this.node, command), command);
    const stdout = stripAnsi(res.stdout);
    if (res.code !== 0) {
      throw new Error(
        `"${command}" on ${
          describeNode(this.node)
        } failed (exit ${res.code}): ${
          (res.stderr || stdout).trim().slice(0, 500)
        }`,
      );
    }
    // vppctl exits 0 on CLI parse errors; catch them here.
    const first = stdout.trimStart().split("\n")[0] ?? "";
    if (
      /^(\S.*: )?unknown input\b/.test(first) ||
      /^clib_socket_init: /.test(first)
    ) {
      throw new Error(
        `"${command}" on ${describeNode(this.node)}: ${first.trim()}`,
      );
    }
    return stdout;
  }

  /**
   * `vppcfg plan` (read-only): with `novpp`, the boot render of the YAML;
   * without, the commands that would converge the running VPP to the YAML.
   * Returns the CLI lines vppcfg prints on stdout.
   */
  async vppcfgPlan(novpp: boolean): Promise<ProcResult> {
    const label = `vppcfg plan${novpp ? " --novpp" : ""}`;
    return await this.run(
      wrapArgv(this.node, [
        this.node.vppcfg,
        "plan",
        ...(novpp ? ["--novpp"] : []),
        "-c",
        this.node.vppcfgConfig,
      ]),
      label,
    );
  }

  /** Read a file on the node (the vppcfg boot file). */
  async readFile(path: string): Promise<ProcResult> {
    if (!SAFE_PATH.test(path)) throw new Error(`refusing to read "${path}"`);
    return await this.run(
      wrapArgv(this.node, ["cat", "--", path]),
      `cat ${path}`,
    );
  }

  private async run(argv: string[], label: string): Promise<ProcResult> {
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(this.node.timeoutSeconds * 1000),
    ]);
    let res: ProcResult;
    try {
      res = await this.runner(argv, signal);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(
          `${
            argv[0]
          } not found on this host (transport ${this.node.transport})`,
        );
      }
      if (signal.aborted && !this.signal.aborted) {
        throw new Error(
          `"${label}" on ${
            describeNode(this.node)
          } timed out after ${this.node.timeoutSeconds}s`,
        );
      }
      throw err;
    }
    return res;
  }
}
