# FAA Prototype Repo Instructions

These rules apply to work in this repository unless a task explicitly requires a narrow exception.

## Workflow Routing

- Use the `section-build` workflow for adding a new chart section to the application.
- Use the existing layer-build workflows only for changes to a single layer within an existing section:
  - `airspace-layer-build`
  - `airports-layer-build`
  - `intersections-layer-build`
  - `navaids-layer-build`
  - `victor-layer-build`

## New Section Requirements

- Every new section must define a section-specific chart module before tiles are generated.
- Prefer FAA GeoTIFF + world-file sources when available.
- The section chart module must define a `map face` crop box.
- The staged base map must exclude non-map chart content:
  - descriptive strips
  - legends
  - footer tables
  - sidebars
  - reference panels
- Do not build base tiles from the full rendered chart image when those non-map areas are present.

## Section Integration Requirements

- A new section is not complete until all required staged assets exist:
  - raster pyramid
  - overlays
  - labels
  - manifest
- The shared section index must be updated so the new section is selectable in-app.
- Default section behavior must be intentional:
  - if the new section becomes the default, launchers and docs must be updated accordingly
  - if the default does not change, preserve the existing launcher behavior

## Verification Requirements

- Verify the served section index includes the new section entry.
- Verify the new section manifest is served successfully.
- Verify the VR app root and 2D app root still load successfully.
- Verify the chart-face crop removed non-map descriptive strips before considering the section complete.
