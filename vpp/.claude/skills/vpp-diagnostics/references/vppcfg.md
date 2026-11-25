# Nodes managed by vppcfg

Many VPP nodes are configured with [vppcfg](https://git.ipng.ch/ipng/vppcfg): a
YAML file (usually `/etc/vpp/vppcfg.yaml`) describes the desired state, and
vppcfg turns it into VPP CLI. On such a node the YAML is the source of truth.
Find out how the node boots before you suggest any change.

## How the configuration gets into VPP

- **At runtime:** `vppcfg plan -c <yaml>` compares the YAML with the running
  VPP and prints the CLI needed to converge (read-only). `vppcfg apply`
  executes that plan.
- **At boot:** `startup.conf` has `unix { exec <file> }`, often a
  `bootstrap.vpp` that execs `head.vpp`, then `vppcfg.vpp`, then `tail.vpp`.
  `vppcfg.vpp` is rendered from the YAML with
  `vppcfg plan --novpp -c <yaml> -o <file>`. Nothing re-renders it on its own,
  so it can be older than the YAML.

So a change made with `vppctl` alone is lost at the next boot. A YAML change
that is applied but not re-rendered is lost at the next boot too.

## Before suggesting a change

1. `sudo vppcfg plan -c /etc/vpp/vppcfg.yaml` must be **empty**. If it is not,
   the running VPP has drifted from the YAML, and `apply` would also execute
   those lines. Read them; `lcp delete` or `delete sub` lines usually mean the
   YAML is missing something that is in use (see below).
2. Render the boot file (`plan --novpp -o /tmp/x`) and diff it with the
   `vppcfg.vpp` on disk. If they differ, the node does not boot into what the
   YAML says.

## The safe change procedure

1. Back up the YAML and `vppcfg.vpp`.
2. Edit a copy, then run `vppcfg check -c <copy>` and `vppcfg plan -c <copy>`.
   The plan must contain exactly the intended lines; stop otherwise.
3. Record the routing state (`birdc show protocols`).
4. Install the YAML and run `vppcfg apply`. Afterwards `plan` must be empty.
5. Re-render `vppcfg.vpp` and diff it against the backup.
6. Compare the routing state, then run `health`.

## Sub-interfaces need an explicit `lcp:`

With `lcp-auto-subint` on, linux-cp creates a sub-interface's Linux interface
only when the sub-interface is created **after** its parent already has a pair.

- At runtime that is the usual order, so a VLAN added with `vppcfg apply`
  gets its Linux interface (`e6.2111`) automatically, even without `lcp:` in
  the YAML.
- vppcfg's boot render creates all sub-interfaces first and the LCPs later,
  so at boot the same VLAN gets **no** Linux interface. BIRD then has no
  interface on that network, and its sessions there stay down.
- vppcfg also treats such an auto-created pair as unknown:
  `vppcfg plan` shows `lcp delete <sub>`, and `vppcfg apply` removes it from
  the running router.

Fix: give every sub-interface that Linux or BIRD uses an explicit
`lcp: "<name>"` in the YAML (e.g. `lcp: "e6.2111"`). The plan then no longer
deletes it, and the boot render creates it after the parent.

Symptom: `lcp` shows a pair for a sub-interface whose YAML entry has no
`lcp:`, and `vppcfg plan` is not empty.

Verified on VPP 26.06 and 26.10 by booting the vppcfg render both ways.

## Unused ports

A port that is admin up with no link makes `health` report `link-down`. If the
port is unused, set `state: down` (and a `description:`) in the YAML and apply
it with the procedure above. `health` does not report admin-down ports, unless
they still have addresses.
