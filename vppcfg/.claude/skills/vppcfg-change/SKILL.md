---
name: vppcfg-change
description: >
  Change the configuration of a VPP node managed by vppcfg (/etc/vpp/vppcfg.yaml)
  with the @lstrandos/vppcfg behavior and the @lstrandos/vppcfg-change workflow:
  plan, approve, apply, verify. Use whenever an interface, address, MTU, VLAN,
  linux-cp pair or admin state on such a node should change, e.g. "admin down
  e5", "add VLAN 2111 with lcp", "change the MTU", "apply this vppcfg.yaml".
  Never change such a node with vppctl set commands.
---

# Changing a vppcfg node

On a vppcfg node the YAML is the source of truth, and VPP boots from a CLI
file rendered from it. A `vppctl set ...` change is lost at the next boot, and
the next `vppcfg apply` undoes it. Every change goes through the YAML.

## 1. Find or create the node

Each node has a `@lstrandos/vppcfg/node` behavior (and usually a
`@lstrandos/vpp/node` for diagnostics):

```bash
swamp behavior create @lstrandos/vppcfg/node pe01-cfg \
  --global-arg transport=ssh --global-arg host=admin@pe01.example.net
```

It runs commands through `sudo -n` by default (vppcfg needs the VPP API
socket; installing the YAML needs root). `birdc=""` turns off the BIRD check.

## 2. Get the YAML, edit it

If the YAML lives in a git repository, edit it there. Otherwise download it:

```bash
swamp behavior run pe01-cfg fetch --input saveTo=cfg/pe01.yaml
```

Make the smallest edit that does the job. Rules that matter:

- A sub-interface used by Linux or BIRD needs an explicit `lcp: "<name>"`,
  or it gets no Linux interface at boot (`lcp-auto-subint` only helps at
  runtime) and `vppcfg apply` deletes its pair.
- Unused ports: `state: down` plus a `description:`.

## 3. Run the workflow

```bash
echo '{"node":"pe01-cfg","file":"cfg/pe01.yaml","vppNode":"pe01"}' \
  | swamp workflow run @lstrandos/vppcfg-change --stdin
```

It plans, stops on risky commands unless `"allowRisky": true`, and then
**suspends for a person**. Show the user the plan before anyone approves:

```bash
swamp data query 'modelName == "pe01-cfg" && name == "plan"' --select content --json \
  | jq '.results[0] | {yamlDiff, commands, risky, bootDiff}'
```

The user approves (or rejects) it:

```bash
swamp workflow approve @lstrandos/vppcfg-change approve --resume
swamp workflow reject  @lstrandos/vppcfg-change approve --reason "..."
```

Do not approve on the user's behalf unless they told you to, for this
change. `allowRisky` is the user's decision too.

## 4. Read the result

```bash
swamp data query 'modelName == "pe01-cfg" && name == "applied"' --select content --json \
  | jq '.results[0] | {status, backups, residualPlan, bootFileUpdated, bird}'
```

- `bird.lost` lists BIRD protocols that were up before and are not after.
  The workflow fails on it; report it to the user at once, with the backup
  paths.
- To roll back, plan and apply the backup: `remoteFile` is the backup path
  on the node (`apply` with the same `remoteFile` and the plan's
  `yamlSha256`), or rerun the workflow with the previous YAML.

## What apply guarantees

- It applies only the YAML whose SHA-256 was planned and approved.
- It re-plans first and refuses if the running VPP changed since the plan.
- It backs up the YAML and the boot file (`*.bak-swamp-<timestamp>`) before
  anything changes, and restores the YAML if `vppcfg apply` fails.
- It re-renders the boot file from the new YAML, so the next boot matches.
