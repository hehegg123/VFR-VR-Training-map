# St. Louis Vector Overlay Format

St. Louis overlays now use `babylon-vector-overlay-v1` instead of single baked transparent rasters.

## Purpose

- keep the base chart as a raster
- move overlay crispness into Babylon world geometry
- preserve a manifest-driven contract that can later be reused by future sections

## File shape

Each overlay file is JSON and lives under `data/sections/<section-id>/overlays/`.

```json
{
  "schema": "babylon-vector-overlay-v1",
  "layerId": "airspace",
  "description": "Vector airspace outlines and fills for VR rendering.",
  "coordinateSpace": {
    "kind": "chart-pixels",
    "width": 6144,
    "height": 4223
  },
  "primitives": {
    "polygons": [],
    "strokes": [],
    "circles": [],
    "markers": [],
    "runwayBars": []
  },
  "stats": {}
}
```

## Coordinate system

- all primitive coordinates are expressed in chart pixel space
- `(0, 0)` is the top-left of the staged chart image
- the Babylon runtime converts chart pixels into map-plane world coordinates using the section manifest's `chart.pixelWidth`, `chart.pixelHeight`, and `world.widthUnits`

## Primitive types

`polygons`
- flat polygon geometry with optional fill and optional outline
- fields: `id`, `points`
- optional fill fields: `fill`, `fillAlpha`
- optional stroke fields: `stroke`, `strokeWidthPx`, `strokeAlpha`, `dashPatternPx`

`strokes`
- polyline or polygon-ring outlines
- fields: `id`, `points`, `color`, `widthPx`, `alpha`, `closed`
- optional: `dashPatternPx`, `haloColor`, `haloWidthPx`, `haloAlpha`

`circles`
- point nodes and ringed airport symbols
- fields: `id`, `center`, `radiusPx`, `alpha`
- optional: `fill`, `stroke`, `strokeWidthPx`

`markers`
- simple symbolic fix markers
- fields: `id`, `center`, `symbol`, `sizePx`, `widthPx`, `color`, `alpha`
- current symbols: `plus`, `x`

`runwayBars`
- oriented airport schematic bars
- fields: `id`, `center`, `lengthPx`, `widthPx`, `angleDeg`, `fill`, `alpha`
- optional: `haloColor`, `haloPaddingPx`

## Manifest usage

Vector layers are referenced like this:

```json
{
  "id": "airspace",
  "title": "Airspace",
  "renderMode": "vector",
  "overlayData": "overlays/airspace.vector.json",
  "labelData": "labels/airspace.json"
}
```

Raster layers still use:

```json
{
  "id": "base",
  "title": "Base Map",
  "renderMode": "raster",
  "texture": "rasters/base-map.png"
}
```
