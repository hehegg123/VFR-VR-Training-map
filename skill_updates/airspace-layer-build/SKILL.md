---
name: airspace-layer-build
description: Build or refine sectional-style FAA airspace layers aligned to FAA chart imagery using NASR, AIXM, and GeoTIFF georeferencing. Use when Codex needs to create an airspaces layer from an FAA sectional GeoTIFF or equivalent chart source, render Class B/C/D/E and special-use airspace, add airport-linked airspace labels, distinguish Class E floors such as 700 AGL vs 1200 AGL, or declutter overlapping airspace text.
---

# Airspace Layer Build

Build the airspace layer from FAA data first, then align it to the chart with a shared transform.

## Repository source of truth

- Prefer `prototype/tools/build_daytona_airspaces_layer.py` when adapting the airspace implementation for a new section.
- Use `prototype/tools/build_stlouis_airspaces_layer.py` as a second corrected reference.
- Do not copy the root-level `build_stlouis_airspaces_layer.py`; it is retained only for legacy standalone imports.
- `compute_airspace_label_layout()` owns final label placement and explicit label metadata.
- `build_airspace_selection_regions()` owns matching interaction IDs, family metadata, geometry, and altitude bounds.
- `prototype/babylon-vr-faa-map/tools/build_section_assets.py` stages both outputs without re-anchoring labels.
- `prototype/babylon-vr-faa-map/tools/airspace_asset_contract.py` defines the build contract and validator.

## Inputs

- Prefer an FAA sectional `GeoTIFF` with its companion world file and metadata.
- Use a PDF or plain chart image only as a fallback when no georeferenced raster exists.
- Use the FAA 28-day NASR subscription for airport and airspace metadata.
- Use the `Class_Airspace` shapefile and DBF for class airspace geometry.
- Use the FAA special activity airspace AIXM zip for MOAs and restricted areas.
- Use `MAA_BASE.csv` and `MAA_SHP.csv` for aerobatic areas when needed.

## Workflow

### 1. Build chart alignment

- If a sectional `GeoTIFF` is available, treat it as the source of truth.
- Read the raster size plus world-file and GeoTIFF projection metadata.
- Build one shared lon/lat-to-chart-pixel transform and reuse it across all layer builders.
- If the chart is not georeferenced, fall back to airport-symbol control-point fitting against `APT_BASE.csv`.
- Keep the transform logic in one helper so every layer lands on the same chart coordinates.

### 2. Load geometry

- Load class airspace polygons from the `Class_Airspace` shapefile.
- Load MOA and restricted-area polygons from the SAA AIXM feed.
- Load aerobatic polygons from `MAA_BASE.csv` and `MAA_SHP.csv`.
- Filter all geometries to the chart extent before rendering.

### 3. Link airports to airspace

- Start with `CLS_ARSP.csv` to attach airport IDs, service hours, and class flags.
- Use `APT_BASE.csv` for airport names and coordinates.
- Match class polygons to airports by class flag plus nearest airport to polygon centroid.
- Add a geometry fallback for Class E. Some airports sit inside `CLASS_E5` polygons but have no useful `CLS_ARSP.csv` row. If an airport point falls inside a Class E polygon, still create an airspace label group for it.

### 4. Render styles

- Render Class B with solid blue shelves and a light blue fill.
- Render Class C with solid magenta shelves and a light magenta fill.
- Render Class D with dashed blue outlines.
- Render surface Class E with dashed magenta outlines.
- Render broad Class E areas lightly so the chart remains readable.
- Render special-use airspace in purple and aerobatic areas with a red dashed outline.

### 5. Label the layer

- Add airport-linked callouts for Class B, C, D, and E airfields.
- Include airport name, airport ID, airspace class, and service-hours text when available.
- Add floor/ceiling shelf labels only for meaningful Class B and Class C subareas.
- Do not emit Class D or Class E2 shelf/detail labels or shelf interaction regions. Their primary airfield label and altitude volume provide the relevant context.
- Treat `700 AGL` and `1200 AGL` as Class E floors, not as separate airport-owned fields.
- For broad `CLASS_E5` coverage, summarize the floors inside the airport callout instead of stamping `700+` or `1200+` on every ring.
- Label MOAs and restricted areas from the AIXM `designator` and `name`.

### 6. Emit interaction metadata

Every generated label must explicitly include `id`, `selectionId`, `labelGroup`, `detailTier`, `familyKey`, `airspaceType`, `placementMode`, and the final placed `x/y`. Callouts must also include connector and anchor metadata.

- Primary family labels use `labelGroup=airfield` and `detailTier=core`.
- Class B/C subareas use `labelGroup=shelf` and `detailTier=detail`.
- Special-use labels use `labelGroup=special` and `detailTier=core`.
- A label's `selectionId` must equal its selectable interaction-region `id`.
- Label and region `familyKey` and `airspaceType` values must match exactly.
- B/C shelf families must have one primary airfield label.
- Do not leave required metadata for runtime or staging inference.
- Preserve collision-aware final label coordinates through staging. Never replace them with an airport point or polygon centroid.

## Decluttering rules

- Use collision-aware text placement.
- Try multiple radial offsets around each anchor point.
- Score candidates by overlap, chart-edge penalty, and displacement.
- Keep higher-priority labels first: Class B, then C, then D, then E, then special-use.
- Allow lower-priority shelf labels to be skipped if they cannot fit cleanly.
- Inspect the transparent output first. It reveals overlap problems faster than the chart overlay.

## Validation

- Verify known airports that are easy to miss, especially Class E airports without `CLS_ARSP.csv` joins.
- Check cases like `MQJ` and `GEZ`: they are inside broad Class E polygons and should still receive labels through geometry fallback.
- Confirm whether a Class E floor is `700 AGL` or `1200 AGL` from the polygon attributes, not from airport naming.
- If using a GeoTIFF workflow, spot-check a known anchor such as `IND` to confirm the transform is landing correctly on the chart.
- Review both a transparent layer and a chart overlay before finishing.
- Run the shared staged validator:

```powershell
py -3 .\prototype\babylon-vr-faa-map\tools\validate_section_airspace_assets.py --section <section-id>
```

- Treat validator failures as builder defects. Fix and regenerate; do not patch generated JSON.
- Confirm no duplicate label/region IDs, missing metadata, invalid coordinates, orphaned pairs, `selectionId`/`familyKey` mismatches, D/E2 shelf details, or B/C shelves without primary labels.
- Confirm altitude mode can hide shelf labels while preserving the primary family label, and that linked VR/desktop selection uses the same IDs.

## Outputs

- Save a chart-frame image.
- Save a transparent airspace layer.
- Save a chart overlay.
- Save a short summary with alignment stats and feature counts.
- Stage a validated `labels/airspace.json` and `overlays/airspace.vector.json` pair through `build_section_assets.py`.

## Common pitfalls

- Do not let each layer fit its own transform independently.
- Do not assume every airport has a matching `CLS_ARSP.csv` record.
- Do not treat `1200 AGL` Class E as a named airfield area.
- Do not flood the chart with repeated Class E floor text when a single airport callout communicates the same information more clearly.
- Do not trust a PDF-only transform when a GeoTIFF is available.
- Do not maintain another divergent copy of the Daytona/St. Louis label metadata contract.
