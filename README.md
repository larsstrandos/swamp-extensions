# swamp-extensions

[Swamp](https://swamp-club.com) extensions published under the `@lstrandos`
collective. Each extension lives in its own folder with its own manifest,
version and tests.

| Folder | Package | What it does |
| --- | --- | --- |
| [`vpp/`](vpp/) | `@lstrandos/vpp` | Read-only fd.io VPP diagnostics through vppctl, plus the `vpp-diagnostics` skill |
| [`vppcfg/`](vppcfg/) | `@lstrandos/vppcfg` | Plan, approve and apply vppcfg YAML with backups, boot-file re-render and a BIRD check, plus the `vppcfg-change` skill |

## Layout

```
<ext>/
├── manifest.yaml            # name, version, files to ship
├── quality.yaml             # accepted quality warnings
├── README.md, LICENSE       # shipped via additionalFiles
├── extensions/behaviors/    # TypeScript (shipped)
├── .claude/skills/<skill>/  # skills (shipped)
└── test/                    # tests and fixtures (not shipped)
reviews/                     # adversarial review reports, bound to the content hash
workflows/                   # workflows; shipped ones are named @lstrandos/... and listed in a manifest
models/                      # dev/smoke-test behavior instances (only lab is committed)
```

The repo root is a swamp repo for development. Each extension is loaded as a
local source:

```bash
swamp extension source add vpp       # also copies its skills into .claude/skills/
swamp behavior type search vpp
```

## Develop and release

```bash
export SWAMP_EXTENSION_REVIEW_DIR=$PWD/reviews
ext=vpp   # or vppcfg

~/.swamp/deno/deno test --allow-read --allow-write $ext/test/
swamp extension version --manifest $ext/manifest.yaml --json   # next CalVer
swamp extension fmt $ext/manifest.yaml --extensions-dir $ext
swamp extension quality $ext/manifest.yaml --extensions-dir $ext
swamp extension push $ext/manifest.yaml --extensions-dir $ext --dry-run --json
# write/refresh the review report at the path the dry run prints, then:
swamp extension push $ext/manifest.yaml --extensions-dir $ext --yes --json
```

`fmt`, `quality` and `push` all need `--extensions-dir`, because `source add`
puts a copy of each skill in the root `.claude/skills/`. Without the flag, the
skill exists under two roots.

## Smoke tests

`vppcfg/test/lab/` builds a VPP 26.06 + vppcfg + BIRD container that boots
like a vppcfg router; the `lab-vpp` and `lab-cfg` nodes point at it:

```bash
docker build -t vppcfg-lab:26.06 vppcfg/test/lab
docker run -d --privileged --name vppcfg-lab vppcfg-lab:26.06
swamp behavior run lab-vpp health
swamp behavior run lab-cfg plan
```

The older harness:

The `lab` node (`models/`) points at the container from the VPP + Bird VRF
harness (`./run.sh --keep`, container `vpp-bird-vrf-test`):

```bash
swamp behavior run lab health
```
