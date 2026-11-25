# @lstrandos/vppcfg

Change [vppcfg](https://git.ipng.ch/ipng/vppcfg)-managed [fd.io VPP](https://fd.io)
nodes the safe way, as a swamp behavior and workflow:

1. **plan** a YAML against the running VPP: the YAML diff, the commands
   `vppcfg apply` would run, which of them are risky, and how the boot file
   would change. Nothing on the node changes (a staging file in `/tmp`).
2. **approve**: the `@lstrandos/vppcfg-change` workflow refuses risky plans
   unless `allowRisky`, then waits for a person.
3. **apply** exactly the approved plan: same SHA-256, same commands on a fresh
   re-plan. It backs up the YAML and the boot file, installs the YAML, runs
   `vppcfg apply`, re-renders the boot file VPP execs at startup, and compares
   `birdc show protocols` before and after. If `vppcfg apply` fails, the YAML
   is restored.
4. **verify**: no BIRD protocol went down, vppcfg plans nothing more, the boot
   file is current, and optionally `@lstrandos/vpp` health.

The YAML comes from a local file: a git repository of node configs, or a copy
downloaded with `fetch` and edited.

It depends on [`@lstrandos/vpp`](https://github.com/larsstrandos/swamp-extensions/tree/main/vpp) (read-only
diagnostics; the workflow can run its `health` at the end).

## Why the boot file matters

VPP nodes configured with vppcfg typically boot from a CLI file rendered from
the YAML (`vppcfg plan --novpp -o /etc/vpp/config/vppcfg.vpp`, exec'd from
`startup.conf`). Applying a YAML at runtime without re-rendering that file
leaves the next boot on the old configuration. This extension always
re-renders it.

A related trap it helps with: a sub-interface without `lcp:` in the YAML can
still have a Linux interface at runtime (made by `lcp-auto-subint` when the
VLAN was added), but not after a reboot, because the boot render creates
sub-interfaces before their parents' linux-cp pairs. `plan` shows such a pair
as `lcp delete` (risky); the fix is an explicit `lcp:` in the YAML.

## Install

```bash
swamp extension pull @lstrandos/vppcfg
```

## Create a node

```bash
swamp behavior create @lstrandos/vppcfg/node pe01-cfg \
  --global-arg transport=ssh --global-arg host=admin@pe01.example.net
```

| Global argument | Default | Meaning |
| --- | --- | --- |
| `transport` | `ssh` | `local`, `docker` or `ssh` |
| `host` | | SSH destination (required for `ssh`) |
| `container` | | Container name (required for `docker`) |
| `containerRuntime` | `docker` | `docker` or `podman` |
| `sudo` | `true` | Run commands through `sudo -n` |
| `sshOptions` | `[]` | Extra ssh arguments (e.g. ControlMaster, `-J`) |
| `timeoutSeconds` | `120` | Timeout per remote command |
| `vppcfg` | `vppcfg` | vppcfg binary on the node |
| `vppcfgConfig` | `/etc/vpp/vppcfg.yaml` | the YAML on the node |
| `vppcfgBootFile` | `/etc/vpp/config/vppcfg.vpp` | the boot render on the node |
| `birdc` | `birdc` | `""` turns the BIRD check off |

SSH uses your agent or `~/.ssh/config`; the extension needs no secrets.

## Change a node

```bash
# get the current YAML to edit (or edit it in your config repo)
swamp behavior run pe01-cfg fetch --input saveTo=cfg/pe01.yaml
$EDITOR cfg/pe01.yaml

# plan → (risky?) → approval → apply → verify
echo '{"node":"pe01-cfg","file":"cfg/pe01.yaml","vppNode":"pe01"}' \
  | swamp workflow run @lstrandos/vppcfg-change --stdin

# review the plan, then approve (or reject) the suspended run
swamp data query 'modelName == "pe01-cfg" && name == "plan"' --select content --json \
  | jq '.results[0] | {yamlDiff, commands, risky, bootDiff}'
swamp workflow approve @lstrandos/vppcfg-change approve --resume
```

Workflow inputs: `node`, `file` (required); `allowRisky` (default `false`),
`settleSeconds` before the second BIRD snapshot (default `15`), `vppNode` for
`@lstrandos/vpp` health afterwards (default `""`: skip).

Risky commands are `lcp delete`, `delete ...`, address removal, interfaces
going down, unnumbered removal and table moves.

## Methods

| Method | Changes the node | What it does |
| --- | --- | --- |
| `fetch` | no | Read the YAML; `saveTo` writes it locally |
| `plan` | no (staging file in `/tmp`) | `file`, `remoteFile`, or the current YAML: `vppcfg check`, `plan`, `plan --novpp`; stores `yamlDiff`, `commands`, `risky`, `bootDiff`, `noop` |
| `apply` | **yes** | `expectSha256` (the plan's `yamlSha256`), `allowRisky`, `settleSeconds`; refuses a different file, a missing plan, a changed VPP or unapproved risky lines |
| `routing` | no | `birdc show protocols`, parsed |

`applied` data is kept as an audit trail (status, commands, backups, residual
plan, boot file, BIRD changes).

### Roll back

`apply` leaves `<yaml>.bak-swamp-<timestamp>` and `<boot>.bak-swamp-<timestamp>`.
To go back, plan and apply the backup:

```bash
swamp behavior run pe01-cfg plan --input remoteFile=/etc/vpp/vppcfg.yaml.bak-swamp-20261125T141114
swamp behavior run pe01-cfg apply --input remoteFile=/etc/vpp/vppcfg.yaml.bak-swamp-20261125T141114 \
  --input expectSha256=<plan's yamlSha256> --input allowRisky=true
```

## What runs on the node

Only these, wrapped in `sudo -n` and the transport: `cat` of the YAML, boot
file or a given YAML path; `tee`/`rm` of staging files under `/tmp`; `cp -p`
(backups) and `install -o root -g root -m 0644` of the YAML and boot file;
`vppcfg check|plan|plan --novpp|apply`; `birdc show protocols`. Paths must be
absolute without shell metacharacters.

## Development

```bash
~/.swamp/deno/deno test --allow-read --allow-write test/
```

`test/lab/` builds a VPP 26.06 + vppcfg + BIRD container that boots like a
vppcfg router, for end-to-end tests of `apply`.
