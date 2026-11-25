---
name: vpp-diagnostics
description: >
  Diagnose fd.io VPP nodes with the @lstrandos/vpp/node swamp behavior instead of
  ad-hoc vppctl. Use when checking VPP health, interfaces, linux-cp (lcp) pairs,
  VRF/FIB tables, routes, next hops, ARP/ND neighbors or error counters, or when
  traffic through VPP is dropped, a route is missing, or a linux-cp/Bird setup
  misbehaves. Triggers on "vpp", "vppctl", "linux-cp", "lcp", "fib", "vpp vrf",
  "show errors", "is vpp healthy", "why is vpp dropping".
---

# VPP diagnostics

Every VPP node is one swamp behavior of type `@lstrandos/vpp/node`. Methods only
run `show` commands. They parse the output and store it, so results can be
queried, compared with the previous run (counter deltas) and reused without
running vppctl again.

## 1. Find or create the node

```bash
swamp behavior list --json | jq -r '.results[] | select(.type=="@lstrandos/vpp/node") | .name'
```

If the node is missing, create it with one of these transports:

```bash
# container (docker or podman)
swamp behavior create @lstrandos/vpp/node lab \
  --global-arg transport=docker --global-arg container=vpp1
# SSH (key auth, BatchMode); sudo when vppctl needs root
swamp behavior create @lstrandos/vpp/node pe01 \
  --global-arg transport=ssh --global-arg host=root@pe01.example.net
# on this host
swamp behavior create @lstrandos/vpp/node local --global-arg transport=local
```

Other global arguments: `socket` (default `/run/vpp/cli.sock`), `sudo`,
`sshOptions` (JSON list, e.g. `["-J","bastion"]`), `containerRuntime`,
`timeoutSeconds`.

## 2. Start with `health`

```bash
swamp behavior run <node> health
swamp data query 'modelName == "<node>" && name == "health"' --select content --json \
  | jq '.results[0] | {status, findings}'
```

`health` collects version, interfaces (with link state), lcp, errors, buffers,
heap and threads in one call, and on vppcfg nodes also checks the YAML against
the running VPP and the boot file (`vppcfg-*` findings; see
[references/vppcfg.md](references/vppcfg.md)). It stores each of them and writes `findings`
(critical / warning / info). Counter findings compare against the previous run,
so on a node that has never been checked, run `health` twice, at least 10–30 s
apart, before drawing conclusions from counters.

Error counters are filtered before they become findings: harmless ones (`no
error`, `interface is down`) are never reported; edge-router noise (TTL expiry,
ND/ARP from IXP peers, LLC) only at ≥ 100/s; lost-traffic counters (tx failure,
no buffers, MTU exceeded, rx miss) on any increase; everything else from
`minErrorRate` (default 1/s, `--input minErrorRate=N`). To see all counters,
including the filtered ones, read the `errors` data, which has a `delta` per
counter.

For several nodes at once, run the workflow instead of one `health` per node:

```bash
echo '{"nodes":["pe01","pe02"]}' | swamp workflow run @lstrandos/vpp-health --stdin --json \
  | jq '[.jobs[].steps[] | {name, status}]'
```

`reachable-<node>` fails when a node could not be checked or is critical,
`ok-<node>` when it has warnings. Then read that node's `health` data.

## 3. Pick the method for the question

| Question | Method | Data name |
| --- | --- | --- |
| Is the node OK at all? | `health` | `health` |
| Which interfaces, link state, addresses, tables, Linux names? | `interfaces` | `interfaces` |
| Which linux-cp pairs, in which netns, is lcp-sync on? | `lcp` | `lcp` |
| Which VRFs exist? | `tables` | `tables` |
| How does VPP forward prefix X in table T, and who installed it? | `fib --input table=T --input prefix=X` (longest match; `sources` shows e.g. `lcp-rt-dynamic` = from Linux/BIRD) | `fib-ip4-T-<prefix>` |
| How big is a table? (use this for full tables) | `fib --input table=T --input summary=true` | `fib-ip4-T` |
| Is the next hop resolved (ARP/ND)? | `neighbors [--input interface=I]` | `neighbors` |
| What is VPP dropping, and is it rising? | `errors` (run twice, check `delta`) | `errors` |
| Does the node run what its vppcfg YAML says, now and after a reboot? | `vppcfg` | `vppcfg` |
| Anything else | `show --input command="show ..."` | `show-<slug>` |

For IPv6, add `--input family=ip6` to `fib`.

Read stored data before you run anything again. The data is versioned, so the
latest `interfaces` from a `health` run a minute ago is still valid:

```bash
swamp data query 'modelName == "<node>" && name == "interfaces"' --select content --json \
  | jq '.results[0].interfaces[] | select(.addresses != []) | {name, lcpLinuxName, addresses}'
```

## 4. Typical chains

- **Traffic to prefix P is lost:** `fib` with `prefix=P` in the right table →
  if the path is `drop`, the route is missing (check Bird and `lcp`); if it is
  `via NH IF`, run `neighbors` for `IF` → if `NH` is missing there, it is an
  ARP/ND problem; otherwise run `errors` twice and look at the rising counters
  on the `IF` / `ip4-input` / `ip6-input` nodes.
- **A Linux interface (e.g. a VLAN) is missing, or vppcfg wants to delete a
  pair:** the node is probably managed by vppcfg; read
  [references/vppcfg.md](references/vppcfg.md) before changing anything.
- **Route is in Linux/Bird but not in VPP:** `lcp` (is there a pair for that
  interface? is linux-nl loaded?) → `interfaces` (is the VPP interface in the
  same table as the Linux VRF?). See
  [references/linux-cp-vrf.md](references/linux-cp-vrf.md).
- **After a change:** `health` before, make the change, `health` after; diff
  the two versions: `swamp data versions <node> health` lists them, and
  `swamp data query 'modelName == "<node>" && name == "health" && version == N' --select content`
  reads an older one.

## Rules

- Do not run vppctl by hand when a method covers the question. Use `show` for
  everything else, so the output is stored too.
- The methods never change VPP. If the fix needs a change, tell the user the
  exact change and why, and let them run it or confirm it. On a node managed
  by vppcfg (`/etc/vpp/vppcfg.yaml` exists), the change belongs in the YAML,
  not in `vppctl`: follow the procedure in
  [references/vppcfg.md](references/vppcfg.md), or it is lost at the next
  boot.
- Several nodes: use the `@lstrandos/vpp-health` workflow (above), or run
  them in parallel, one `swamp behavior run` per node (each node is its own
  behavior, so they do not share a lock).
- Large FIBs (full BGP tables): use `summary=true` or `prefix=`. Without them,
  `fib` refuses tables larger than `maxEntries` (default 5000) and stores only
  the summary.
