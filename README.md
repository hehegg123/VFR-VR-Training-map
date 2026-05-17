# FAA Prototype Workspace

This repository is organized around the runnable St. Louis prototype under [`prototype/`](./prototype). The VR viewer, the 2D review app, shared browser modules, rebuild tools, and the staged runtime data all live there.

## Canonical Structure

```text
prototype/
  babylon-vr-faa-map/   # VR viewer, launch scripts, runtime data
  faa-2d-map/           # 2D linked review companion
  shared/               # shared browser modules for linking and section loading
  tools/                # Python rebuild/export scripts
  reference-data/       # local-only FAA source datasets and GeoTIFF inputs
  outputs/              # generated analysis/export artifacts
  research/             # notes, debug imagery, and non-runtime scratch work
```

## Run After Cloning

The safest run path is to use the included launcher from the project root:

```powershell
cd .\prototype\babylon-vr-faa-map
powershell -ExecutionPolicy Bypass -File .\scripts\launch_stlouis_linked_review.ps1
```

That serves the `prototype/` folder on `http://localhost:4173` and opens:

- `http://localhost:4173/babylon-vr-faa-map/?section=stlouis`
- `http://localhost:4173/faa-2d-map/?section=stlouis`

For VR-only desktop review:

```powershell
cd .\prototype\babylon-vr-faa-map
powershell -ExecutionPolicy Bypass -File .\scripts\launch_stlouis_prototype.ps1
```

For HTTPS or headset review, use:

- `prototype\babylon-vr-faa-map\scripts\launch_stlouis_linked_review_https.ps1`
- `prototype\babylon-vr-faa-map\scripts\launch_stlouis_hmd_demo.ps1`

## Rebuild Assets

The checked-in runtime data under `prototype/babylon-vr-faa-map/data/` is enough to run the prototype after cloning. Rebuilding those assets requires local FAA source datasets and the St. Louis GeoTIFF under `prototype/reference-data/`.

Rebuild command:

```powershell
py -3 .\prototype\babylon-vr-faa-map\tools\build_section_assets.py
```

## Notes

- `prototype/reference-data/`, `prototype/outputs/`, and `prototype/research/` are for local source material and working artifacts; they are ignored for repository cleanliness by default.
- Legacy root-level copies from the earlier flat workspace layout are also ignored so the repo can focus on the canonical `prototype/` structure.
