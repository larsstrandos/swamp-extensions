# swamp-extensions

[Swamp](https://swamp-club.com) extensions published under the `@lstrandos`
collective. Each extension lives in its own folder with its own manifest,
version and tests.

| Folder | Package | What it does |
| --- | --- | --- |
| [`vpp/`](vpp/) | `@lstrandos/vpp` | Read-only fd.io VPP diagnostics through vppctl, plus the `vpp-diagnostics` skill |

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
models/                      # dev/smoke-test behavior instances
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
ext=vpp

~/.swamp/deno/deno test --allow-read $ext/test/
swamp extension version --manifest $ext/manifest.yaml --json   # next CalVer
swamp extension fmt $ext/manifest.yaml
swamp extension quality $ext/manifest.yaml
swamp extension push $ext/manifest.yaml --extensions-dir $ext --dry-run --json
# write/refresh the review report at the path the dry run prints, then:
swamp extension push $ext/manifest.yaml --extensions-dir $ext --yes --json
```

`--extensions-dir` is needed because `source add` puts a copy of each skill in
the root `.claude/skills/`, so without it the skill would exist under two roots.

## Smoke tests

The `lab` node (`models/`) points at the container from the VPP + Bird VRF
harness (`./run.sh --keep`, container `vpp-bird-vrf-test`):

```bash
swamp behavior run lab health
```
