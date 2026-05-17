# Babylon VR FAA Map

This app is the VR side of the St. Louis prototype. The canonical repository layout now lives under [`prototype/`](..).

Primary run path from the project root:

```powershell
cd .\prototype\babylon-vr-faa-map
powershell -ExecutionPolicy Bypass -File .\scripts\launch_stlouis_linked_review.ps1
```

That serves the `prototype/` folder on port `4173` and opens:

- `http://localhost:4173/babylon-vr-faa-map/?section=stlouis`
- `http://localhost:4173/faa-2d-map/?section=stlouis`

To rebuild runtime assets from local FAA source data:

```powershell
py -3 .\prototype\babylon-vr-faa-map\tools\build_section_assets.py
```

See the root [README](../../README.md) for the repo structure, prerequisites, and clone-and-run instructions.
