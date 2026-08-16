# FAA Prototype Workspace

This repository is organized around the runnable FAA prototype under [`prototype/`](./prototype). The VR viewer, the 2D review app, shared browser modules, rebuild tools, and the staged runtime data all live there.

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


That one-click launcher:

- starts the linked-review session over HTTPS
- opens a lightweight local operator page
- shows the LAN VR URL for the headset browser
- shows the LAN desktop/2D companion URL
- gives you a `Stop Session` button

The checked-in runtime data is enough to launch immediately after cloning.
That includes the staged Daytona and St. Louis runtime assets under `prototype/babylon-vr-faa-map/data/sections/`.

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

The checked-in runtime data under `prototype/babylon-vr-faa-map/data/` is enough to run the prototype after cloning. Rebuilding those assets requires local FAA source datasets and the source chart GeoTIFFs under `prototype/reference-data/`.

Rebuild command:

```powershell
py -3 .\prototype\babylon-vr-faa-map\tools\build_section_assets.py
```

## VR controls

![VR controller controls showing teleport, view rotation, panel toggle, map selection, and map grabbing](prototype/babylon-vr-faa-map/docs/images/vr-controller-controls.png)

The diagram shows the current left- and right-controller mappings used by the VR application.

Current VR controls:

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

Current default section behavior:

- The prototype now opens into the `Daytona Beach Area` section by default.
- `St. Louis Sectional` remains available from the in-app section selector.

Current behavior notes:

- The panel uses Babylon XR pointer interaction, so exact controller button names can vary slightly by headset/browser.
- If a controller does not expose a squeeze component, the manipulator falls back to trigger-style grab input where available.
- The initial VR pose is set so the user starts in front of the map and can look down over it.
- For HMD/WebXR use, the headset browser must trust the generated dev certificate if it does not already.

## Instruction sets for researchers

Instruction sets are editable JSON files under `prototype/training/task-sets/<section-id>/`. To add one:

1. Create `<task-set-id>.json` using schema `faa-vr-task-set-v1`. Define the matching `id`, `sectionId`, title, and one or more manual-completion tasks.
2. Give each task an ID, title, instructions, optional recommended layer IDs, and optional targets containing a staged `layerId` and `selectionId`.
3. Run `py -3 .\prototype\babylon-vr-faa-map\tools\stage_task_sets.py <section-id>` to validate and stage task files without rebuilding map rasters. A full `build_section_assets.py` run performs the same task-set validation and staging as part of a section rebuild.
4. Launch the prototype and open the 2D companion. Choose the map section, choose the task set from `Instruction Set`, and start a linked session using the same Session ID as the VR app. The VR wrist panel then exposes its `Instructions` tab for reviewing and manually completing tasks.
5. Before a new participant, select `Reset Task Session` in the 2D companion. This disposes the old VR task session and starts the selected task set from its first task with no completed tasks.

Task progress and the research event log are held in memory only. Reloading the page starts a new session; no participant progress is written to browser storage. Logged events include task-set loading, instruction-tab opening, task views, previous navigation, task completion, task-set completion, and session clearing, with section and linked-session context when available. During a running page session, researchers can inspect or export a snapshot from the browser console with `faaInstructionResearch.getEvents()`.

## Notes

- `prototype/reference-data/`, `prototype/outputs/`, and `prototype/research/` are for local source material and working artifacts; they are ignored for repository cleanliness by default.
- Legacy root-level copies from the earlier flat workspace layout are also ignored so the repo can focus on the canonical `prototype/` structure.
