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

## Clone and run

Prerequisite for the launcher scripts:

- Install Windows Node.js LTS from [nodejs.org](https://nodejs.org/)

Recommended fresh-clone path:

```powershell
git clone https://github.com/hehegg123/VFR-VR-Training-map.git
cd .\VFR-VR-Training-map
.\launch-demo.cmd
```

If you prefer the original launcher file with spaces in its name, use:

```powershell
& ".\Launch St. Louis Demo.cmd"
```

That one-click launcher:

- starts the St. Louis linked-review session over HTTPS
- opens a lightweight local operator page
- shows the LAN VR URL for the headset browser
- shows the LAN desktop/2D companion URL
- gives you a `Stop Session` button

The checked-in runtime data is enough to launch immediately after cloning.
That includes the staged St. Louis runtime assets under `prototype/babylon-vr-faa-map/data/sections/stlouis/`.

If you want the direct non-wrapper launch paths instead:

- linked desktop review:

```powershell
cd .\prototype\babylon-vr-faa-map
powershell -ExecutionPolicy Bypass -File .\scripts\launch_stlouis_linked_review.ps1
```

- VR-only desktop review:

```powershell
cd .\prototype\babylon-vr-faa-map
powershell -ExecutionPolicy Bypass -File .\scripts\launch_stlouis_prototype.ps1
```

- HTTPS or headset review:
  - `prototype\babylon-vr-faa-map\scripts\launch_stlouis_linked_review_https.ps1`
  - `prototype\babylon-vr-faa-map\scripts\launch_stlouis_hmd_demo.ps1`

## Rebuild Assets

The checked-in runtime data under `prototype/babylon-vr-faa-map/data/` is enough to run the prototype after cloning. Rebuilding those assets requires local FAA source datasets and the St. Louis GeoTIFF under `prototype/reference-data/`.

Rebuild command:

```powershell
py -3 .\prototype\babylon-vr-faa-map\tools\build_section_assets.py
```

## VR controls

Current St. Louis VR controls:

- `Enter VR`: starts immersive VR when WebXR is available.
- `Controller ray`: point at labels or controls and press/select to interact.
- `Left forearm panel`: the in-VR control panel appears above the left front arm.
- `Thumbstick / stick click`: toggles the in-VR control panel on and off.
- `Map` toggle: shows or hides a layer.
- `Labels` toggle: shows or hides labels for a layer.
- `Altitude` toggle: for the airspace layer only, switches between flat selection and the proxy altitude-volume view.
- `One-hand squeeze / grab`: drags the map in space.
- `Two-hand squeeze / grab`: moves, scales, and rotates the map together.
- `Label selection`: labels are preferred pick targets over geometry beneath them.

Current behavior notes:

- The panel uses Babylon XR pointer interaction, so exact controller button names can vary slightly by headset/browser.
- If a controller does not expose a squeeze component, the manipulator falls back to trigger-style grab input where available.
- The initial VR pose is set so the user starts in front of the map and can look down over it.
- For HMD/WebXR use, the headset browser must trust the generated dev certificate if it does not already.

## Notes

- `prototype/reference-data/`, `prototype/outputs/`, and `prototype/research/` are for local source material and working artifacts; they are ignored for repository cleanliness by default.
- Legacy root-level copies from the earlier flat workspace layout are also ignored so the repo can focus on the canonical `prototype/` structure.
