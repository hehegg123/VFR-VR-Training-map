---
name: section-build
description: Add a new FAA chart section to the application. Use when Codex needs to ingest a new sectional or TAC source chart, define a map-face crop, create section-specific chart modules and builders, rebuild staged assets, update the shared section index, and wire the new section into the VR and 2D prototype without breaking existing sections.
---

# Section Build

Add a new chart section to the application by coordinating chart ingestion, section geometry, layer builds, staged assets, and app integration.

## Use this skill when

- The user wants a new map section added to the application.
- A new FAA sectional or TAC chart needs to become selectable in the VR/2D prototype.
- A new default section needs to replace the current default.

## Do not use this skill when

- The task only changes one layer in an existing section.
- The task only adjusts runtime interaction, labels, or styling for an already-built section.

Use the layer-build skills for single-layer work:

- `airspace-layer-build`
- `airports-layer-build`
- `intersections-layer-build`
- `navaids-layer-build`
- `victor-layer-build`

## Required section policy

- Every new section must define a chart-face crop before tiles are generated.
- Exclude all non-map chart content from the staged base map:
  - descriptive strips
  - legends
  - footer tables
  - sidebars
  - reference panels
- Prefer FAA GeoTIFF + world-file inputs over PDF-only workflows when available.

## Canonical prototype implementation

- Use `prototype/tools/build_daytona_airspaces_layer.py` as the preferred template for a new section. It has the corrected Daytona label, family, shelf, and interaction-region contract.
- Use `prototype/tools/build_stlouis_airspaces_layer.py` as the second reference for section-specific differences.
- Do not copy the root-level `build_stlouis_airspaces_layer.py`. It is a retained legacy dependency for old standalone scripts, not a prototype section template.
- `compute_airspace_label_layout()` is authoritative for final label placement and label metadata.
- `build_airspace_selection_regions()` is authoritative for selectable region IDs, families, geometry, and altitude metadata.
- `prototype/babylon-vr-faa-map/tools/build_section_assets.py` is the authoritative staging entry point. Its `build_stlouis_airspace_labels()`, `build_stlouis_airspace_overlay()`, and `build_bound_section()` functions are shared by bound section modules.
- `prototype/babylon-vr-faa-map/tools/airspace_asset_contract.py` is the authoritative metadata, staging, and validation contract.

## Required airspace contract

Every airspace label emitted by a section builder must explicitly provide:

- `id`
- `selectionId`
- `labelGroup`
- `detailTier`
- `familyKey`
- `airspaceType`
- `placementMode`
- final placed `x` and `y`
- `anchorX`, `anchorY`, and `connector` for callout placement

Do not rely on staging or runtime ID parsing to reconstruct required metadata. `selectionId` must equal the matching interaction-region `id`. The label and region must have identical `familyKey` and `airspaceType` values. The label coordinates must be the final coordinates returned by collision-aware placement, not the airport point or a newly calculated centroid.

Use these classifications:

- Primary airport-family label: `labelGroup=airfield`, `detailTier=core`, and a family-specific `familyKey`.
- Class B/C subarea label: `labelGroup=shelf`, `detailTier=detail`, and the primary label's `familyKey`.
- Special-use label: `labelGroup=special`, `detailTier=core`, with an explicit matching family on its region.

Generate meaningful Class B and Class C shelf labels and shelf interaction regions. Do not generate redundant Class D or Class E2 shelf labels or shelf interaction regions. Keep one primary airfield label for each relevant family so altitude mode can hide B/C shelf labels without removing family orientation.

## Workflow

### 1. Select and stage the chart source

- Identify the correct FAA source chart for the requested coverage.
- Prefer the GeoTIFF and world-file pair.
- Keep local source chart files under the section’s reference-data area.

### 2. Create the section chart module

- Create a new section-specific chart module modeled after the existing section pattern.
- Define:
  - chart file paths
  - display cache path
  - chart-face crop box
  - chart transform helpers
- The crop box is mandatory. Do not allow the full rendered chart image to become the default tile source when non-map panels are present.

### 3. Define the section bounds

- Set a section region that matches the intended operational footprint.
- Keep the built area no larger than needed.
- Verify the region stays inside the usable chart face.

### 4. Build the section layers

- Use or adapt the existing per-layer builders for the new section.
- Reuse the current section architecture rather than inventing a separate runtime path.
- Follow the existing layer-build workflows for:
  - airspace
  - airports
  - intersections
  - navaids
  - victors
- For airspace, copy the Daytona structure and adapt section constants/data sources; do not fork the metadata or shelf policy.

### 5. Build staged runtime assets

- Generate:
  - raster tile pyramid
  - vector overlays
  - label payloads
  - section manifest
- Ensure the staged assets live under the application’s `data/sections/<section-id>/` path.
- Preserve the builder's final label `x/y` during scaling. Staging must not substitute airport centers, polygon centroids, or inferred anchors.
- Let `build_bound_section()` run the shared airspace contract gate before it reports success.

### 6. Integrate the section into the app

- Update the shared section index so the new section appears in the section selector.
- If the new section should be the default, place it first in the index or otherwise update the runtime selection logic intentionally.
- Update launchers and docs if they currently pin a specific section in the URL.

### 7. Verify completion

- Verify the section index is served and includes the new section.
- Verify the new section manifest is served successfully.
- Verify the VR app root and 2D app root still load successfully.
- Verify the staged map no longer includes footer/sidebar descriptive strips.
- Verify existing sections remain selectable.
- Run the staged-asset validator explicitly after the build:

```powershell
py -3 .\prototype\babylon-vr-faa-map\tools\validate_section_airspace_assets.py --section <section-id>
```

- The validator must report no duplicate IDs, missing metadata, coordinate errors, orphan pairs, selection/family mismatches, D/E2 shelves, or B/C shelves without a primary family label.
- Verify a primary airfield label and its altitude volume resolve to the same `selectionId` in linked VR/desktop sessions.

## Deliverables

- New section chart module
- New or adapted section builder modules
- Staged runtime assets for the new section
- Updated section index
- Updated launcher/docs if default section behavior changed

## Common failures

- Reusing the full chart image and accidentally keeping descriptive strips or sidebars
- Building a new section without updating the shared section index
- Updating a launcher to a hard-coded section URL when the app root should determine the default
- Letting one layer use different section bounds or a different transform from the others
- Copying the obsolete root-level St. Louis airspace builder
- Replacing final placed label coordinates during staging
- Generating Class D/E2 detail shelves or B/C shelves with no primary family label
- Hand-editing staged JSON instead of fixing the builder or shared staging contract
