# Babylon VR FAA Map

This app is the VR side of the FAA prototype. The canonical repository layout now lives under [`prototype/`](..).

Recommended one-click launch from the project root:

```powershell
.\Launch St. Louis Demo.cmd
```

That starts the HTTPS linked-review session, opens the local operator page, and gives you the LAN VR + desktop links plus a `Stop Session` button.

Direct run path from the project root:

```powershell
cd .\prototype\babylon-vr-faa-map
powershell -ExecutionPolicy Bypass -File .\scripts\launch_stlouis_linked_review.ps1
```

That serves the `prototype/` folder on port `4173` and opens the default Daytona section:

- `http://localhost:4173/babylon-vr-faa-map/`
- `http://localhost:4173/faa-2d-map/`

To rebuild runtime assets from local FAA source data:

```powershell
py -3 .\prototype\babylon-vr-faa-map\tools\build_section_assets.py
```

See the root [README](../../README.md) for the repo structure, clone/start flow, headset notes, and the current VR controls.
