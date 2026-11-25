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

SSH uses your agent or `~/.ssh/config`. The extension needs no secrets.

## Methods

| Method | Runs | Stores |
| --- | --- | --- |
| `health` | version, interface, interface addr, lcp, errors, buffers, memory main-heap, threads | all of the below plus `health` with `status` and `findings` |
| `interfaces` | `show interface`, `show interface addr`, `show hardware-interfaces brief`, `show lcp` | per interface: admin and link state, link speed, MTU, addresses with table id, counters, counter deltas, linux-cp name |
| `lcp` | `show lcp` | linux-cp settings and pairs (with netns) |
| `tables` | `show ip table`, `show ip6 table` | VRF tables |
| `fib` | `show ip[6] fib table N [prefix]` | prefixes with paths (`via`, `glean`, `receive`, `drop`) and packet counters; `summary=true` for prefix-length counts only |
| `neighbors` | `show ip neighbors [if]` | ARP/ND entries |
| `errors` | `show errors` | error counters with deltas since the previous run |
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

## What runs on your machine

The behavior spawns exactly one process per call: `vppctl`, `docker`/`podman
exec ... vppctl`, or `ssh ... vppctl`. Before anything is spawned, the command
is checked to be a `show ...` command, so the extension cannot change VPP
state. For SSH it uses `BatchMode=yes` (it never prompts) and quotes the remote
command.

## Development

```bash
~/.swamp/deno/deno test --allow-read test/
```

Fixtures in `test/fixtures` are real VPP 26.10 output.
