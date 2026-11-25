# @lstrandos/vpp

Read-only diagnostics for [fd.io VPP](https://fd.io) nodes, as a swamp behavior.
Each node is one `@lstrandos/vpp/node` behavior, reached with `vppctl`:

- on the local host,
- inside a container (`docker exec` / `podman exec`), or
- over SSH (key auth, optional `sudo -n`, jump hosts via `sshOptions`).

Methods run only `show` commands. They parse the output into typed data and
store it, so it can be queried with CEL and compared between runs (counter
deltas). Tested against VPP 26.10 (lab, linux-cp/linux-nl) and 26.06 (an edge
router with DPDK, workers and linux-cp in a netns).

The extension also ships the `vpp-diagnostics` skill. It tells an agent which
method to use for which question and lists the known linux-cp/VRF/Bird pitfalls.

## Install

```bash
swamp extension pull @lstrandos/vpp
```

## Create a node

```bash
# VPP in a container
swamp behavior create @lstrandos/vpp/node lab \
  --global-arg transport=docker --global-arg container=vpp1

# VPP on a router over SSH
swamp behavior create @lstrandos/vpp/node pe01 \
  --global-arg transport=ssh --global-arg host=root@pe01.example.net \
  --global-arg 'sshOptions=["-J","bastion.example.net"]'
```

| Global argument | Default | Meaning |
| --- | --- | --- |
| `transport` | `local` | `local`, `docker` or `ssh` |
| `host` | | SSH destination (required for `ssh`) |
| `container` | | Container name (required for `docker`) |
| `containerRuntime` | `docker` | `docker` or `podman` |
| `socket` | `/run/vpp/cli.sock` | CLI socket passed to `vppctl -s` |
| `sudo` | `false` | Run vppctl through `sudo -n` |
| `sshOptions` | `[]` | Extra ssh arguments |
| `vppctl` | `vppctl` | vppctl path on the node |
| `timeoutSeconds` | `30` | Timeout per vppctl call |
| `vppcfg` | `vppcfg` | vppcfg binary on the node |
| `vppcfgConfig` | `/etc/vpp/vppcfg.yaml` | vppcfg YAML on the node |
| `vppcfgBootFile` | `/etc/vpp/config/vppcfg.vpp` | CLI file rendered from the YAML that VPP execs at boot |

SSH uses your agent or `~/.ssh/config`. The extension needs no secrets.

## Methods

| Method | Runs | Stores |
| --- | --- | --- |
| `health` | version, interface, interface addr, hardware-interfaces, lcp, errors, buffers, memory main-heap, threads, and the `vppcfg` check | all of the below plus `health` with `status` and `findings` |
| `interfaces` | `show interface`, `show interface addr`, `show hardware-interfaces brief`, `show lcp` | per interface: admin and link state, link speed, MTU, addresses with table id, counters, counter deltas, linux-cp name |
| `lcp` | `show lcp` | linux-cp settings and pairs (with netns) |
| `tables` | `show ip table`, `show ip6 table` | VRF tables |
| `fib` | `show ip[6] fib table N [prefix]` | prefixes with paths (`via`, `glean`, `receive`, `drop`) and packet counters; with `prefix=` the longest match and its `sources` (e.g. `lcp-rt-dynamic`: installed from Linux/BIRD); `summary=true` for prefix-length counts only (automatic above `maxEntries`) |
| `neighbors` | `show ip neighbors [if]` | ARP/ND entries |
| `errors` | `show errors` | error counters with deltas since the previous run |
| `vppcfg` | `vppcfg plan`, `vppcfg plan --novpp`, `cat <boot file>` | drift between the running VPP and the YAML (what `vppcfg apply` would do), and between the boot file and the YAML |
| `show` | any `show ...` | raw output |

```bash
swamp behavior run lab health
swamp data query 'modelName == "lab" && name == "health"' --select content --json \
  | jq '.results[0] | {status, findings}'

swamp behavior run lab fib --input table=100 --input prefix=198.51.100.0/24
swamp behavior run lab fib --input family=ip6 --input table=100 --input summary=true
swamp behavior run lab show --input command="show bond details"
```

`health` reports:

- **critical**: a buffer pool below 10 % free, or the main heap above 90 % used
- **warning**:
  - a buffer pool below 25 % free, or the main heap above 80 %
  - an admin-up interface whose link is down
  - an admin-down interface that still has addresses (admin down without
    addresses counts as deliberately unused and is not reported)
  - rising rx/tx errors or rx-miss
  - rising error counters (see below)
  - on vppcfg nodes: the running VPP differs from the YAML (`vppcfg-drift`),
    the boot file is not the render of the YAML (`vppcfg-boot`), or a
    sub-interface's linux-cp pair exists only because `lcp-auto-subint` made it
    at runtime (`vppcfg-sub-lcp`: `vppcfg apply` would delete it, and it is
    missing after a reboot)
- **info**: linux-cp interfaces in non-default tables (the Linux side must be in
  the matching VRF, because lcp-sync does not sync table changes), or the
  linux-cp plugin not being loaded

Error counters are compared with the previous run and fall into four classes:

| Class | Examples | Reported when |
| --- | --- | --- |
| benign | `no error`, af-packet block counters, `interface is down` | never (link state covers the last one) |
| noisy | TTL expiry, ND/ARP from IXP peers, unknown LLC | ≥ 100/s (a loop or an attack) |
| severe | `dpdk tx failure`, no buffers, MTU exceeded, rx miss | any increase |
| other | everything else with severity `error`/`warn` | ≥ `minErrorRate` per second (default 1) |

```bash
swamp behavior run pe01 health --input minErrorRate=5
```

## All nodes at once: the `@lstrandos/vpp-health` workflow

The extension ships a workflow that runs `health` on a list of nodes in
parallel and then asserts per node:

| Step | Severity | Fails when |
| --- | --- | --- |
| `reachable-<node>` | high | `health` did not produce fresh data in this run (node unreachable, method failed), or the node is `critical` |
| `ok-<node>` | medium | the node is not `ok` (any warning) |

An unreachable node does not stop the others; old data from an earlier run
never counts as a pass.

```bash
echo '{"nodes":["pe01","pe02"]}' | swamp workflow run @lstrandos/vpp-health --stdin

# fail only on unreachable or critical nodes (e.g. for cron or CI)
echo '{"nodes":["pe01","pe02"]}' | swamp workflow run @lstrandos/vpp-health --stdin --fail-on high
```

The exit code is non-zero when the run fails. Optional input: `minErrorRate`
(passed to `health`).

## vppcfg nodes

On a node managed by [vppcfg](https://git.ipng.ch/ipng/vppcfg), `vppcfg` (and
`health`) compare three things: the YAML, the running VPP, and the boot file
VPP execs at startup. Nodes without vppcfg or without the YAML are skipped
quietly; `health --input checkVppcfg=false` turns the check off. `vppcfg plan`
needs access to the VPP API socket, so such nodes usually need `sudo=true`.

```bash
swamp behavior run pe01 vppcfg
swamp data query 'modelName == "pe01" && name == "vppcfg"' --select content --json \
  | jq '.results[0] | {running, boot}'
```

## What runs on your machine

The behavior spawns one process per call: `vppctl`, `vppcfg plan` (with or
without `--novpp`, both read-only) or `cat` of the vppcfg boot file, directly,
through `docker`/`podman exec`, or through `ssh`. vppctl commands are checked
to be `show ...` commands before anything is spawned, so the extension cannot
change VPP state. For SSH it uses `BatchMode=yes` (it never prompts) and quotes the remote
command.

## Development

```bash
~/.swamp/deno/deno test --allow-read test/
```

Fixtures in `test/fixtures` are real VPP 26.10 output.
