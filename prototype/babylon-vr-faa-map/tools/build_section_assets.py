from __future__ import annotations

import json
import math
import os
import shutil
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon
from PIL import Image


PROTOTYPE_ROOT = Path(__file__).resolve().parents[2]
APP_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = APP_ROOT / "data"
SECTIONS_ROOT = DATA_ROOT / "sections"
TOOLS_ROOT = PROTOTYPE_ROOT / "tools"
TRAINING_TASK_SETS_ROOT = PROTOTYPE_ROOT / "training" / "task-sets"
TRAINING_EVENT_SETS_ROOT = PROTOTYPE_ROOT / "training" / "event-sets"

sys.path.insert(0, str(TOOLS_ROOT))

import build_stlouis_airports_layer as stl_airports
import build_stlouis_airspaces_layer as stl_airspace
import build_stlouis_intersections_layer as stl_intersections
import build_stlouis_navaids_layer as stl_navaids
import build_stlouis_victors_layer as stl_victors
import stlouis_geotiff as stl_geo
import build_daytona_airports_layer as day_airports
import build_daytona_airspaces_layer as day_airspace
import build_daytona_intersections_layer as day_intersections
import build_daytona_navaids_layer as day_navaids
import build_daytona_victors_layer as day_victors
import daytona_geotiff as day_geo
from airspace_asset_contract import assert_valid_airspace_payloads, assert_valid_staged_section, stage_airspace_label_row
from event_set_contract import stage_section_event_sets
from task_set_contract import collect_staged_selection_ids, stage_section_task_sets

STL_AIRPORTS_MODULE = stl_airports
STL_AIRSPACE_MODULE = stl_airspace
STL_INTERSECTIONS_MODULE = stl_intersections
STL_NAVAIDS_MODULE = stl_navaids
STL_VICTORS_MODULE = stl_victors
STL_GEO_MODULE = stl_geo

DAY_AIRPORTS_MODULE = day_airports
DAY_AIRSPACE_MODULE = day_airspace
DAY_INTERSECTIONS_MODULE = day_intersections
DAY_NAVAIDS_MODULE = day_navaids
DAY_VICTORS_MODULE = day_victors
DAY_GEO_MODULE = day_geo


VECTOR_OVERLAY_SCHEMA = "babylon-vector-overlay-v1"
LABEL_SCHEMA = "babylon-vr-labels-v1"
MANIFEST_SCHEMA = "babylon-faa-section-v2"

BASE_TILE_SIZE = 1024
BASE_PYRAMID_MIN_WIDTH = 1844


def bind_builder_modules(
    airports_module,
    airspace_module,
    intersections_module,
    navaids_module,
    victors_module,
    geo_module,
) -> None:
    global stl_airports, stl_airspace, stl_intersections, stl_navaids, stl_victors, stl_geo
    stl_airports = airports_module
    stl_airspace = airspace_module
    stl_intersections = intersections_module
    stl_navaids = navaids_module
    stl_victors = victors_module
    stl_geo = geo_module


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def is_relative_to_path(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def new_base_raster_root(section_root: Path) -> Path:
    resolved_section_root = section_root.resolve()
    if not is_relative_to_path(resolved_section_root, SECTIONS_ROOT.resolve()):
        raise RuntimeError(f"Refusing to create base tiles outside section data root: {resolved_section_root}")
    version = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return section_root / "rasters" / f"base-{version}"


def save_image_atomic(image: Image.Image, path: Path, **save_options: Any) -> None:
    ensure_dir(path.parent)
    if not path.exists():
        image.save(path, **save_options)
        return

    temp_path = path.with_name(f"{path.stem}.{os.getpid()}.tmp{path.suffix}")
    try:
        image.save(temp_path, **save_options)
        os.replace(temp_path, path)
    finally:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass


def base_raster_dir_from_pyramid(section_root: Path, base_pyramid: dict[str, Any]) -> Path:
    for level in base_pyramid.get("levels", []):
        for tile in level.get("tiles", []):
            tile_url = tile.get("url")
            if isinstance(tile_url, str) and tile_url.startswith("rasters/"):
                tile_path = (section_root / tile_url).resolve()
                return tile_path.parents[1]
    raise RuntimeError("Base tile pyramid did not include any raster tile URLs.")


def is_complete_base_raster_generation(path: Path) -> bool:
    return (
        path.is_dir()
        and path.name.startswith("base-")
        and any(path.rglob("*.webp"))
        and not any(path.rglob("*.tmp"))
    )


def cleanup_old_base_raster_generations(
    section_root: Path,
    active_base_root: Path,
    *,
    keep_previous_complete: int = 1,
) -> list[Path]:
    rasters_root = (section_root / "rasters").resolve()
    resolved_section_root = section_root.resolve()
    resolved_active_root = active_base_root.resolve()
    if not is_relative_to_path(rasters_root, resolved_section_root):
        raise RuntimeError(f"Refusing to clean raster tiles outside section root: {rasters_root}")
    if not is_relative_to_path(resolved_active_root, rasters_root):
        raise RuntimeError(f"Refusing to preserve active raster root outside rasters root: {resolved_active_root}")

    candidates = [
        path
        for path in rasters_root.iterdir()
        if path.is_dir() and (path.name == "base" or path.name.startswith("base-"))
    ]
    previous_complete = [
        path.resolve()
        for path in sorted(candidates, key=lambda item: item.name, reverse=True)
        if path.resolve() != resolved_active_root and is_complete_base_raster_generation(path)
    ][:keep_previous_complete]
    keep_roots = {resolved_active_root, *previous_complete}

    removed: list[Path] = []
    for path in candidates:
        resolved_path = path.resolve()
        if resolved_path in keep_roots:
            continue
        if not is_relative_to_path(resolved_path, rasters_root):
            raise RuntimeError(f"Refusing to delete raster path outside rasters root: {resolved_path}")
        shutil.rmtree(resolved_path)
        removed.append(path)
    return removed


def write_json(path: Path, payload: object) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.size


def save_png_array(path: Path, array: np.ndarray, target_width: int | None = None) -> tuple[int, int]:
    ensure_dir(path.parent)
    image = Image.fromarray((np.clip(array, 0, 1) * 255).astype(np.uint8))
    if target_width and image.width != target_width:
        target_height = round(image.height * target_width / image.width)
        image = image.resize((target_width, target_height), Image.Resampling.LANCZOS)
    image.save(path)
    return image.size


def render_transparent_layer(
    output_path: Path,
    width_px: int,
    height_px: int,
    draw_fn,
) -> tuple[int, int]:
    ensure_dir(output_path.parent)
    dpi = 256
    fig = plt.figure(figsize=(width_px / dpi, height_px / dpi), dpi=dpi)
    fig.patch.set_alpha(0)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, width_px)
    ax.set_ylim(height_px, 0)
    ax.set_aspect("equal", adjustable="box")
    ax.set_axis_off()
    ax.patch.set_alpha(0)
    draw_fn(ax)
    fig.savefig(output_path, transparent=True, pad_inches=0)
    plt.close(fig)

    with Image.open(output_path) as rendered:
        if rendered.size != (width_px, height_px):
            rendered.resize((width_px, height_px), Image.Resampling.LANCZOS).save(output_path)

    return image_size(output_path)


def compact_number(value: float, digits: int = 3) -> float:
    return round(float(value), digits)


def compact_point(x: float, y: float, digits: int = 3) -> list[float]:
    return [compact_number(x, digits), compact_number(y, digits)]


def scale_xy(scale_x: float, scale_y: float, x: float, y: float) -> tuple[float, float]:
    return float(x * scale_x), float(y * scale_y)


def regular_polygon_points(
    center_x: float,
    center_y: float,
    radius_px: float,
    sides: int,
    orientation_deg: float = 0.0,
) -> list[tuple[float, float]]:
    orientation = math.radians(orientation_deg)
    return [
        (
            center_x + math.cos(orientation + (2 * math.pi * index / sides)) * radius_px,
            center_y + math.sin(orientation + (2 * math.pi * index / sides)) * radius_px,
        )
        for index in range(sides)
    ]


def square_points(center_x: float, center_y: float, half_px: float) -> list[tuple[float, float]]:
    return [
        (center_x - half_px, center_y - half_px),
        (center_x + half_px, center_y - half_px),
        (center_x + half_px, center_y + half_px),
        (center_x - half_px, center_y + half_px),
    ]


def polygon_centroid(parts: list[list[tuple[float, float]]]) -> tuple[float, float]:
    points = [point for part in parts for point in part]
    lon = sum(point[0] for point in points) / len(points)
    lat = sum(point[1] for point in points) / len(points)
    return lon, lat


def build_vector_payload(width: int, height: int, layer_id: str, description: str) -> dict[str, Any]:
    return {
        "schema": VECTOR_OVERLAY_SCHEMA,
        "layerId": layer_id,
        "description": description,
        "coordinateSpace": {
            "kind": "chart-pixels",
            "width": width,
            "height": height,
        },
        "primitives": {
            "polygons": [],
            "strokes": [],
            "circles": [],
            "markers": [],
            "runwayBars": [],
        },
        "interactionRegions": [],
        "stats": {},
    }


def add_polygon(
    payload: dict[str, Any],
    primitive_id: str,
    points: list[list[float]],
    *,
    fill: str | None = None,
    fill_alpha: float = 0.0,
    stroke: str | None = None,
    stroke_width_px: float = 0.0,
    stroke_alpha: float = 1.0,
    dash_pattern_px: list[float] | None = None,
) -> None:
    if len(points) < 3:
        return
    polygon: dict[str, Any] = {
        "id": primitive_id,
        "points": points,
    }
    if fill:
        polygon["fill"] = fill
        polygon["fillAlpha"] = compact_number(fill_alpha)
    if stroke:
        polygon["stroke"] = stroke
        polygon["strokeWidthPx"] = compact_number(stroke_width_px)
        polygon["strokeAlpha"] = compact_number(stroke_alpha)
    if dash_pattern_px:
        polygon["dashPatternPx"] = [compact_number(value) for value in dash_pattern_px]
    payload["primitives"]["polygons"].append(polygon)


def add_stroke(
    payload: dict[str, Any],
    primitive_id: str,
    points: list[list[float]],
    *,
    color: str,
    width_px: float,
    alpha: float = 1.0,
    closed: bool = False,
    dash_pattern_px: list[float] | None = None,
    halo_color: str | None = None,
    halo_width_px: float | None = None,
    halo_alpha: float | None = None,
) -> None:
    if len(points) < 2:
        return
    stroke: dict[str, Any] = {
        "id": primitive_id,
        "points": points,
        "color": color,
        "widthPx": compact_number(width_px),
        "alpha": compact_number(alpha),
        "closed": closed,
    }
    if dash_pattern_px:
        stroke["dashPatternPx"] = [compact_number(value) for value in dash_pattern_px]
    if halo_color and halo_width_px:
        stroke["haloColor"] = halo_color
        stroke["haloWidthPx"] = compact_number(halo_width_px)
        stroke["haloAlpha"] = compact_number(halo_alpha if halo_alpha is not None else alpha)
    payload["primitives"]["strokes"].append(stroke)


def add_circle(
    payload: dict[str, Any],
    primitive_id: str,
    center: list[float],
    *,
    radius_px: float,
    fill: str | None = None,
    stroke: str | None = None,
    stroke_width_px: float = 0.0,
    alpha: float = 1.0,
) -> None:
    payload["primitives"]["circles"].append(
        {
            "id": primitive_id,
            "center": center,
            "radiusPx": compact_number(radius_px),
            "fill": fill,
            "stroke": stroke,
            "strokeWidthPx": compact_number(stroke_width_px),
            "alpha": compact_number(alpha),
        }
    )


def add_marker(
    payload: dict[str, Any],
    primitive_id: str,
    center: list[float],
    *,
    symbol: str,
    size_px: float,
    width_px: float,
    color: str,
    alpha: float = 1.0,
) -> None:
    payload["primitives"]["markers"].append(
        {
            "id": primitive_id,
            "center": center,
            "symbol": symbol,
            "sizePx": compact_number(size_px),
            "widthPx": compact_number(width_px),
            "color": color,
            "alpha": compact_number(alpha),
        }
    )


def add_runway_bar(
    payload: dict[str, Any],
    primitive_id: str,
    center: list[float],
    *,
    length_px: float,
    width_px: float,
    angle_deg: float,
    fill: str,
    alpha: float = 1.0,
    halo_color: str | None = None,
    halo_padding_px: float = 0.0,
) -> None:
    payload["primitives"]["runwayBars"].append(
        {
            "id": primitive_id,
            "center": center,
            "lengthPx": compact_number(length_px),
            "widthPx": compact_number(width_px),
            "angleDeg": compact_number(angle_deg),
            "fill": fill,
            "alpha": compact_number(alpha),
            "haloColor": halo_color,
            "haloPaddingPx": compact_number(halo_padding_px),
        }
    )


def simplify_points(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    if len(points) < 3 or tolerance <= 0:
        return points

    stripped = points[:]
    if len(stripped) > 1 and distance_between(stripped[0], stripped[-1]) <= 1e-6:
        stripped = stripped[:-1]

    if len(stripped) < 3:
        return stripped

    simplified = rdp(stripped, tolerance)
    if len(simplified) < 3:
        return stripped
    return simplified


def distance_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def perpendicular_distance(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    if start == end:
        return distance_between(point, start)
    numerator = abs(
        (end[1] - start[1]) * point[0]
        - (end[0] - start[0]) * point[1]
        + end[0] * start[1]
        - end[1] * start[0]
    )
    denominator = math.hypot(end[1] - start[1], end[0] - start[0])
    return numerator / max(denominator, 1e-9)


def rdp(points: list[tuple[float, float]], epsilon: float) -> list[tuple[float, float]]:
    if len(points) <= 2:
        return points

    max_distance = 0.0
    index = 0
    for i in range(1, len(points) - 1):
        distance = perpendicular_distance(points[i], points[0], points[-1])
        if distance > max_distance:
            max_distance = distance
            index = i

    if max_distance > epsilon:
        left = rdp(points[: index + 1], epsilon)
        right = rdp(points[index:], epsilon)
        return left[:-1] + right
    return [points[0], points[-1]]


def build_pyramid_level_sizes(width_px: int, height_px: int) -> list[tuple[int, int]]:
    sizes = [(width_px, height_px)]
    while sizes[0][0] > BASE_PYRAMID_MIN_WIDTH:
        prev_width, prev_height = sizes[0]
        next_width = max(BASE_PYRAMID_MIN_WIDTH, round(prev_width / 2))
        next_height = max(1, round(prev_height * next_width / prev_width))
        if next_width == prev_width:
            break
        sizes.insert(0, (next_width, next_height))
        if next_width <= BASE_PYRAMID_MIN_WIDTH:
            break
    return sizes


def build_stlouis_base_pyramid(section_root: Path) -> tuple[dict[str, Any], int, int, float, float]:
    rasters_root = new_base_raster_root(section_root)
    ensure_dir(rasters_root)

    display_background = stl_geo.load_chart_background(stl_airspace.FULL_REGION)
    display_height, display_width = display_background.shape[:2]
    full_crop_box = stl_geo.full_resolution_crop_box(stl_airspace.FULL_REGION)

    Image.MAX_IMAGE_PIXELS = None
    with Image.open(stl_geo.GEOTIFF_PATH) as image:
        cropped = image.convert("RGB").crop(full_crop_box)
        native_width, native_height = cropped.size
        level_sizes = build_pyramid_level_sizes(native_width, native_height)
        levels: list[dict[str, Any]] = []

        for level_index, (level_width, level_height) in enumerate(level_sizes):
            level_image = cropped if (level_width, level_height) == cropped.size else cropped.resize(
                (level_width, level_height),
                Image.Resampling.LANCZOS,
            )
            cols = math.ceil(level_width / BASE_TILE_SIZE)
            rows = math.ceil(level_height / BASE_TILE_SIZE)
            level_dir = rasters_root / f"z{level_index}"
            ensure_dir(level_dir)
            tiles: list[dict[str, Any]] = []

            for row in range(rows):
                for col in range(cols):
                    tile_x0 = col * BASE_TILE_SIZE
                    tile_y0 = row * BASE_TILE_SIZE
                    tile_x1 = min(level_width, tile_x0 + BASE_TILE_SIZE)
                    tile_y1 = min(level_height, tile_y0 + BASE_TILE_SIZE)
                    tile = level_image.crop((tile_x0, tile_y0, tile_x1, tile_y1))
                    tile_path = level_dir / f"tile_{col}_{row}.webp"
                    save_image_atomic(tile, tile_path, format="WEBP", lossless=True, method=6)

                    source_x0 = round((tile_x0 / level_width) * native_width)
                    source_y0 = round((tile_y0 / level_height) * native_height)
                    source_x1 = round((tile_x1 / level_width) * native_width)
                    source_y1 = round((tile_y1 / level_height) * native_height)
                    tiles.append(
                        {
                            "id": f"z{level_index}-{col}-{row}",
                            "url": str(tile_path.relative_to(section_root)).replace("\\", "/"),
                            "sourceRect": [
                                source_x0,
                                source_y0,
                                source_x1 - source_x0,
                                source_y1 - source_y0,
                            ],
                            "col": col,
                            "row": row,
                        }
                    )

            levels.append(
                {
                    "id": f"z{level_index}",
                    "widthPx": level_width,
                    "heightPx": level_height,
                    "cols": cols,
                    "rows": rows,
                    "tiles": tiles,
                }
            )

    pyramid = {
        "kind": "tile-pyramid-v1",
        "tileSizePx": BASE_TILE_SIZE,
        "fullWidthPx": native_width,
        "fullHeightPx": native_height,
        "levels": levels,
    }
    scale_x = native_width / float(display_width)
    scale_y = native_height / float(display_height)
    return pyramid, native_width, native_height, scale_x, scale_y


def build_stlouis_airport_labels(features: dict[str, object], scale_x: float, scale_y: float) -> dict[str, object]:
    items = []
    ordered = sorted(
        features["airports"],
        key=lambda row: (
            not row["towered"],
            -(row["longest_runway_ft"] or 0),
            row["ARPT_ID"],
        ),
    )
    for row in ordered[:110]:
        x, y = stl_airspace.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl_airspace.inside_chart(features, x, y, margin=24):
            continue
        sx, sy = scale_xy(scale_x, scale_y, x, y)
        lines = [row["ARPT_ID"]]
        if row["towered"] or row["longest_runway_ft"] >= 5000:
            lines.append(row["display_name"])
        items.append(
            {
                "id": row["ARPT_ID"],
                "x": compact_number(sx),
                "y": compact_number(sy),
                "lines": lines,
                "style": "airport-major" if row["towered"] else "airport-minor",
                "priority": 1.0 if row["towered"] else 0.7,
            }
        )
    return {"schema": LABEL_SCHEMA, "items": items}


def build_stlouis_intersection_labels(features: dict[str, object], scale_x: float, scale_y: float) -> dict[str, object]:
    items = []
    ordered = sorted(
        features["intersections"],
        key=lambda row: (
            not row["used_by_victor"],
            "SECTIONAL" not in row["charting_types"],
            row["fix_id"],
        ),
    )
    for row in ordered[:180]:
        x, y = stl_airspace.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl_airspace.inside_chart(features, x, y, margin=24):
            continue
        sx, sy = scale_xy(scale_x, scale_y, x, y)
        items.append(
            {
                "id": row["fix_id"],
                "x": compact_number(sx),
                "y": compact_number(sy),
                "lines": [row["fix_id"]],
                "style": "intersection-major" if row["used_by_victor"] else "intersection-minor",
                "priority": 0.9 if row["used_by_victor"] else 0.5,
            }
        )
    return {"schema": LABEL_SCHEMA, "items": items}


def build_stlouis_navaid_labels(features: dict[str, object], scale_x: float, scale_y: float) -> dict[str, object]:
    items = []
    for row in stl_navaids.compute_navaid_label_layout(features):
        sx, sy = scale_xy(scale_x, scale_y, row["x"], row["y"])
        items.append(
            {
                "id": row["id"],
                "navaidType": row["navaid_type"],
                "x": compact_number(sx),
                "y": compact_number(sy),
                "lines": row["lines"],
                "style": row["style"],
                "priority": row["priority"],
            }
        )

    items.sort(key=lambda row: row["priority"], reverse=True)
    return {"schema": LABEL_SCHEMA, "items": items[:95]}


def build_stlouis_victor_labels(features: dict[str, object], scale_x: float, scale_y: float) -> dict[str, object]:
    items = []
    for row in stl_victors.compute_airway_label_layout(features):
        sx, sy = scale_xy(scale_x, scale_y, row["x"], row["y"])
        items.append(
            {
                "id": row["airway_id"],
                "x": compact_number(sx),
                "y": compact_number(sy),
                "lines": [row["airway_id"], f"{row['visible_start']}-{row['visible_end']}"],
                "style": "victor-airway",
                "priority": row["priority"],
            }
        )
    return {"schema": LABEL_SCHEMA, "items": items}


def build_stlouis_airspace_labels(features: dict[str, object], scale_x: float, scale_y: float) -> dict[str, object]:
    items = [
        stage_airspace_label_row(row, scale_x, scale_y)
        for row in stl_airspace.compute_airspace_label_layout(features)
    ]
    items.sort(key=lambda row: row["priority"], reverse=True)
    class_e_ranked = sorted(
        (
            item for item in items
            if item.get("labelGroup") == "airfield" and item.get("airspaceType") in {"CLASS_E3", "CLASS_E5"}
        ),
        key=lambda item: (
            item.get("connector", False),
            item["priority"],
        ),
        reverse=True,
    )
    core_class_e_ids = {item["id"] for item in class_e_ranked if item["detailTier"] == "core"}

    return {
        "schema": LABEL_SCHEMA,
        "items": items,
        "stats": {
            "totalItems": len(items),
            "classEDetailItems": len(class_e_ranked),
            "coreClassEDetailItems": len(core_class_e_ids),
            "extendedClassEDetailItems": max(0, len(class_e_ranked) - len(core_class_e_ids)),
        },
    }


def build_stlouis_airspace_overlay(
    features: dict[str, object],
    width: int,
    height: int,
    scale_x: float,
    scale_y: float,
) -> dict[str, Any]:
    payload = build_vector_payload(width, height, "airspace", "Vector airspace outlines and fills for VR rendering.")

    fill_count = 0
    stroke_count = 0

    for record_index, record in enumerate(features["class_airspaces"]):
        attrs = record["attrs"]
        type_code = attrs.get("TYPE_CODE")
        style = stl_airspace.class_airspace_chart_style(attrs)
        if not style:
            continue
        for part_index, part in enumerate(stl_airspace.projected_visible_parts(features, record)):
            raw_points = [
                scale_xy(scale_x, scale_y, x, y)
                for x, y in part
            ]
            simplified = simplify_points(raw_points, tolerance=0.75)
            points = [compact_point(x, y, digits=2) for x, y in simplified]
            primitive_base = f"class-{type_code}-{record_index}-{part_index}"
            if style.get("renderMode") == "stroke":
                dash_pattern = None
                linestyle = style.get("ls")
                if linestyle == (0, (6, 4)):
                    dash_pattern = [9.0, 6.0]
                elif linestyle == (0, (5, 4)):
                    dash_pattern = [7.0, 5.0]
                add_stroke(
                    payload,
                    primitive_base,
                    points,
                    color=style["edge"],
                    width_px=float(style["lw"]) * 1.2,
                    alpha=0.95,
                    closed=True,
                    dash_pattern_px=dash_pattern,
                )
                stroke_count += 1
                continue

            add_polygon(
                payload,
                primitive_base,
                points,
                fill=style.get("fill"),
                fill_alpha=float(style.get("alpha", 0.0)),
                stroke=style["edge"],
                stroke_width_px=float(style["lw"]) * 1.25,
                stroke_alpha=0.94,
            )
            if style.get("fill"):
                fill_count += 1
            if style.get("edge"):
                stroke_count += 1

    for record_index, record in enumerate(features["special_activity"]):
        for part_index, part in enumerate(stl_airspace.projected_visible_parts(features, record, cache_key="_projected_visible_parts_special")):
            raw_points = [
                scale_xy(scale_x, scale_y, x, y)
                for x, y in part
            ]
            simplified = simplify_points(raw_points, tolerance=0.75)
            points = [compact_point(x, y, digits=2) for x, y in simplified]
            primitive_base = f"special-{record_index}-{part_index}"
            add_polygon(
                payload,
                primitive_base,
                points,
                fill="#a855f7",
                fill_alpha=0.08,
                stroke="#7e22ce",
                stroke_width_px=1.2,
                stroke_alpha=0.95,
                dash_pattern_px=[4.0, 4.0],
            )
            fill_count += 1
            stroke_count += 1

    for record_index, record in enumerate(features["aerobatic"]):
        for part_index, part in enumerate(stl_airspace.projected_visible_parts(features, record, cache_key="_projected_visible_parts_aerobatic")):
            raw_points = [
                scale_xy(scale_x, scale_y, x, y)
                for x, y in part
            ]
            simplified = simplify_points(raw_points, tolerance=0.75)
            points = [compact_point(x, y, digits=2) for x, y in simplified]
            add_polygon(
                payload,
                f"aerobatic-{record_index}-{part_index}",
                points,
                stroke="#be123c",
                stroke_width_px=1.2,
                stroke_alpha=0.9,
                dash_pattern_px=[8.0, 6.0],
            )
            stroke_count += 1

    interaction_regions = []
    for region in stl_airspace.build_airspace_selection_regions(features):
        scaled_parts = []
        for part in region["parts"]:
            scaled = [compact_point(*scale_xy(scale_x, scale_y, x, y), digits=2) for x, y in simplify_points(part, tolerance=0.75)]
            if len(scaled) >= 3:
                scaled_parts.append(scaled)
        if not scaled_parts:
            continue
        anchor_x, anchor_y = scale_xy(scale_x, scale_y, region["anchorX"], region["anchorY"])
        region_payload = {
            "id": region["id"],
            "kind": region["kind"],
            "airspaceType": region["airspaceType"],
            "familyKey": region["familyKey"],
            "priority": compact_number(region["priority"]),
            "anchor": compact_point(anchor_x, anchor_y, digits=2),
            "parts": scaled_parts,
        }
        if region.get("floorFt") is not None and region.get("proxyCeilingFt") is not None:
            region_payload["floorFt"] = int(region["floorFt"])
            region_payload["proxyCeilingFt"] = int(region["proxyCeilingFt"])
            region_payload["openEndedCeiling"] = bool(region.get("openEndedCeiling", False))
            region_payload["altitudeSource"] = region.get("altitudeSource", "attrs")
            if region.get("ceilingFt") is not None:
                region_payload["ceilingFt"] = int(region["ceilingFt"])
        interaction_regions.append(region_payload)
    payload["interactionRegions"] = interaction_regions

    payload["stats"] = {
        "polygons": len(payload["primitives"]["polygons"]),
        "strokes": stroke_count,
        "classAirspaceGroups": len(features["class_airspaces"]),
        "specialActivityGroups": len(features["special_activity"]),
        "aerobaticGroups": len(features["aerobatic"]),
        "interactionRegions": len(interaction_regions),
    }
    return payload


def build_stlouis_airport_runway_bars(
    features: dict[str, object],
    row: dict[str, object],
    scale_x: float,
    scale_y: float,
) -> list[dict[str, float]]:
    runway_ends = row["runway_end_points"]
    airport_center = stl_airspace.lonlat_to_chart_xy(features, row["lon"], row["lat"])
    qualifying = sorted(row["qualifying_runways"], key=lambda r: (-r["length_ft"], r["rwy_id"]))
    if not qualifying:
        return []

    target_max = 18.0 + min(12.0, max(0.0, (row["longest_hard_ft"] - 1500) / 900.0))
    lengths: list[float] = []
    usable: list[tuple[dict[str, object], tuple[float, float], tuple[float, float], float, float, float]] = []
    max_runway_length_ft = max((runway["length_ft"] for runway in qualifying[:4]), default=1)

    for runway in qualifying[:4]:
        ends = runway_ends.get((row["ARPT_ID"], runway["rwy_id"]), [])
        if len(ends) < 2:
            continue
        p1 = stl_airspace.lonlat_to_chart_xy(features, ends[0]["lon"], ends[0]["lat"])
        p2 = stl_airspace.lonlat_to_chart_xy(features, ends[1]["lon"], ends[1]["lat"])
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        pixel_len = max((dx * dx + dy * dy) ** 0.5, 1e-6)
        usable.append((runway, p1, p2, dx, dy, pixel_len))
        lengths.append(pixel_len)

    if not usable:
        return []

    scale = target_max / max(lengths)
    bars: list[dict[str, float]] = []
    for runway, p1, p2, dx, dy, _pixel_len in usable:
        mid_x = (p1[0] + p2[0]) / 2.0
        mid_y = (p1[1] + p2[1]) / 2.0
        center_x = airport_center[0] + (mid_x - airport_center[0]) * scale
        center_y = airport_center[1] + (mid_y - airport_center[1]) * scale
        angle_deg = math.degrees(math.atan2(dy, dx))
        length_ratio = runway["length_ft"] / max_runway_length_ft if max_runway_length_ft else 1.0
        length_px = max(8.5, target_max * (0.55 + 0.45 * length_ratio))
        width_px = 2.4 if runway["width_ft"] < 75 else 3.0 if runway["width_ft"] < 120 else 3.8
        sx, sy = scale_xy(scale_x, scale_y, center_x, center_y)
        bars.append(
            {
                "center_x": sx,
                "center_y": sy,
                "length_px": length_px * scale_x,
                "width_px": width_px * scale_y,
                "angle_deg": angle_deg,
            }
        )
    return bars


def build_stlouis_airports_overlay(
    features: dict[str, object],
    width: int,
    height: int,
    scale_x: float,
    scale_y: float,
) -> dict[str, Any]:
    payload = build_vector_payload(width, height, "airports", "Vector airport symbols and runway bars for VR rendering.")
    circle_count = 0
    bar_count = 0

    for row in features["airports"]:
        x, y = stl_airspace.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl_airspace.inside_chart(features, x, y, margin=20):
            continue
        sx, sy = scale_xy(scale_x, scale_y, x, y)
        center = compact_point(sx, sy)
        color = "#1d4ed8" if row["towered"] else "#8b1e6d"

        if row["layout_eligible"]:
            bars = build_stlouis_airport_runway_bars(features, row, scale_x, scale_y)
            if bars:
                for bar_index, bar in enumerate(bars):
                    add_runway_bar(
                        payload,
                        f"{row['ARPT_ID']}-bar-{bar_index}",
                        compact_point(bar["center_x"], bar["center_y"]),
                        length_px=bar["length_px"],
                        width_px=bar["width_px"],
                        angle_deg=bar["angle_deg"],
                        fill=color,
                        halo_color="#ffffff",
                        halo_padding_px=1.0 * scale_x,
                    )
                    bar_count += 1
                continue

        radius_px = 4.6 if row["towered"] else 3.9
        add_circle(
            payload,
            row["ARPT_ID"],
            center,
            radius_px=radius_px * scale_x,
            fill="#ffffff",
            stroke=color,
            stroke_width_px=1.2 * scale_x,
            alpha=1.0,
        )
        circle_count += 1

    payload["stats"] = {
        "airportSymbols": circle_count,
        "runwayBars": bar_count,
        "airports": len(features["airports"]),
    }
    return payload


def build_stlouis_intersections_overlay(
    features: dict[str, object],
    width: int,
    height: int,
    scale_x: float,
    scale_y: float,
) -> dict[str, Any]:
    payload = build_vector_payload(width, height, "intersections", "Vector fix markers for VR rendering.")
    marker_count = 0

    ordered = sorted(
        features["intersections"],
        key=lambda row: (
            not row["used_by_victor"],
            "SECTIONAL" not in row["charting_types"],
            row["fix_id"],
        ),
    )
    for row in ordered:
        x, y = stl_airspace.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl_airspace.inside_chart(features, x, y, margin=24):
            continue
        sx, sy = scale_xy(scale_x, scale_y, x, y)
        add_marker(
            payload,
            row["fix_id"],
            compact_point(sx, sy),
            symbol="x" if row["used_by_victor"] else "plus",
            size_px=(5.4 if row["used_by_victor"] else 4.0) * scale_x,
            width_px=(1.0 if row["used_by_victor"] else 0.8) * scale_x,
            color="#0f4c81" if row["used_by_victor"] else "#1d4ed8",
            alpha=0.95,
        )
        marker_count += 1

    payload["stats"] = {
        "markers": marker_count,
        "intersections": len(features["intersections"]),
    }
    return payload


def build_stlouis_navaids_overlay(
    features: dict[str, object],
    width: int,
    height: int,
    scale_x: float,
    scale_y: float,
) -> dict[str, Any]:
    payload = build_vector_payload(width, height, "navaids", "Vector navaid symbols for VR rendering.")
    type_counts: defaultdict[str, int] = defaultdict(int)

    for row in features["navaids"]:
        x, y = stl_airspace.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl_airspace.inside_chart(features, x, y, margin=20):
            continue

        sx, sy = scale_xy(scale_x, scale_y, x, y)
        color = stl_navaids.symbol_color(row)
        nav_type = row["nav_type"]
        radius = stl_navaids.base_radius(row) * scale_x
        dot_radius = 1.35 * scale_x

        def shape_points(points: list[tuple[float, float]]) -> list[list[float]]:
            return [compact_point(px, py, digits=2) for px, py in points]

        if nav_type in {"VOR", "VOR/DME", "VORTAC"}:
            hex_points = shape_points(regular_polygon_points(sx, sy, radius, 6, 30))
            add_polygon(
                payload,
                f"{row['nav_id']}-outer",
                hex_points,
                fill="#ffffff",
                fill_alpha=1.0,
                stroke=color,
                stroke_width_px=1.15 * scale_x,
                stroke_alpha=1.0,
            )
            if nav_type == "VOR":
                add_circle(
                    payload,
                    f"{row['nav_id']}-dot",
                    compact_point(sx, sy),
                    radius_px=dot_radius,
                    fill=color,
                    alpha=1.0,
                )
            elif nav_type == "VOR/DME":
                add_polygon(
                    payload,
                    f"{row['nav_id']}-inner",
                    shape_points(square_points(sx, sy, 1.65 * scale_x)),
                    fill=color,
                    fill_alpha=1.0,
                )
            else:
                add_polygon(
                    payload,
                    f"{row['nav_id']}-inner",
                    shape_points(regular_polygon_points(sx, sy, 2.1 * scale_x, 3, 90)),
                    fill=color,
                    fill_alpha=1.0,
                )
        elif nav_type == "TACAN":
            add_polygon(
                payload,
                f"{row['nav_id']}-outer",
                shape_points(regular_polygon_points(sx, sy, radius, 3, 90)),
                fill="#ffffff",
                fill_alpha=1.0,
                stroke=color,
                stroke_width_px=1.05 * scale_x,
                stroke_alpha=1.0,
            )
            add_circle(
                payload,
                f"{row['nav_id']}-dot",
                compact_point(sx, sy),
                radius_px=1.2 * scale_x,
                fill=color,
                alpha=1.0,
            )
        elif nav_type == "NDB":
            add_circle(
                payload,
                f"{row['nav_id']}-outer",
                compact_point(sx, sy),
                radius_px=radius,
                fill="#ffffff",
                stroke=color,
                stroke_width_px=1.05 * scale_x,
                alpha=1.0,
            )
            add_circle(
                payload,
                f"{row['nav_id']}-dot",
                compact_point(sx, sy),
                radius_px=1.4 * scale_x,
                fill=color,
                alpha=1.0,
            )
        else:
            add_polygon(
                payload,
                f"{row['nav_id']}-outer",
                shape_points(square_points(sx, sy, (radius - 0.6 * scale_x))),
                fill="#ffffff",
                fill_alpha=1.0,
                stroke=color,
                stroke_width_px=1.0 * scale_x,
                stroke_alpha=1.0,
            )
            add_circle(
                payload,
                f"{row['nav_id']}-dot",
                compact_point(sx, sy),
                radius_px=1.1 * scale_x,
                fill=color,
                alpha=1.0,
            )

        type_counts[nav_type] += 1

    payload["stats"] = {
        "navaids": sum(type_counts.values()),
        "byType": dict(sorted(type_counts.items())),
        "polygons": len(payload["primitives"]["polygons"]),
        "circles": len(payload["primitives"]["circles"]),
    }
    return payload


def build_stlouis_victors_overlay(
    features: dict[str, object],
    width: int,
    height: int,
    scale_x: float,
    scale_y: float,
) -> dict[str, Any]:
    payload = build_vector_payload(width, height, "victors", "Vector Victor airway network for VR rendering.")
    node_seen: set[str] = set()
    stroke_count = 0

    for seg in features["airway_segments"]:
        start = seg["visible_start_xy"]
        end = seg["visible_end_xy"]
        sx0, sy0 = scale_xy(scale_x, scale_y, *start)
        sx1, sy1 = scale_xy(scale_x, scale_y, *end)
        add_stroke(
            payload,
            f"{seg['airway_id']}-{seg['point_seq']}",
            [compact_point(sx0, sy0), compact_point(sx1, sy1)],
            color="#0f4c81",
            width_px=1.4 * scale_x,
            alpha=0.96,
            halo_color="#ffffff",
            halo_width_px=2.8 * scale_x,
            halo_alpha=0.78,
        )
        stroke_count += 1

        chart_nodes = []
        if seg.get("from_inside_chart"):
            chart_nodes.append((seg["from_id"], *scale_xy(scale_x, scale_y, *seg["chart_start"])))
        if seg.get("to_inside_chart"):
            chart_nodes.append((seg["to_id"], *scale_xy(scale_x, scale_y, *seg["chart_end"])))

        for point_id, sx, sy in chart_nodes:
            node_key = f"{point_id}:{compact_number(sx, 1)}:{compact_number(sy, 1)}"
            if node_key in node_seen:
                continue
            node_seen.add(node_key)
            add_circle(
                payload,
                f"node-{node_key}",
                compact_point(sx, sy),
                radius_px=2.2 * scale_x,
                fill="#ffffff",
                stroke="#0f4c81",
                stroke_width_px=0.75 * scale_x,
                alpha=0.96,
            )

    payload["stats"] = {
        "strokes": stroke_count,
        "nodes": len(node_seen),
        "segments": len(features["airway_segments"]),
        "airways": len(features["airway_labels"]),
    }
    return payload


def build_bound_section(
    *,
    section_id: str,
    title: str,
    description: str,
    chart_source: str,
) -> dict[str, object]:
    section_root = SECTIONS_ROOT / section_id
    asset_version = datetime.now(timezone.utc).isoformat()
    ensure_dir(section_root / "rasters")
    ensure_dir(section_root / "labels")
    ensure_dir(section_root / "overlays")

    base_pyramid, pixel_width, pixel_height, scale_x, scale_y = build_stlouis_base_pyramid(section_root)

    airspace_features = stl_airspace.build_features()
    airports_features = stl_airports.build_features()
    intersections_features = stl_intersections.build_features()
    navaids_features = stl_navaids.build_features()
    victors_features = stl_victors.build_features()

    airspace_overlay = build_stlouis_airspace_overlay(airspace_features, pixel_width, pixel_height, scale_x, scale_y)
    airports_overlay = build_stlouis_airports_overlay(airports_features, pixel_width, pixel_height, scale_x, scale_y)
    intersections_overlay = build_stlouis_intersections_overlay(intersections_features, pixel_width, pixel_height, scale_x, scale_y)
    navaids_overlay = build_stlouis_navaids_overlay(navaids_features, pixel_width, pixel_height, scale_x, scale_y)
    victors_overlay = build_stlouis_victors_overlay(victors_features, pixel_width, pixel_height, scale_x, scale_y)

    airspace_labels = build_stlouis_airspace_labels(airspace_features, scale_x, scale_y)
    airport_labels = build_stlouis_airport_labels(airports_features, scale_x, scale_y)
    intersection_labels = build_stlouis_intersection_labels(intersections_features, scale_x, scale_y)
    navaid_labels = build_stlouis_navaid_labels(navaids_features, scale_x, scale_y)
    victor_labels = build_stlouis_victor_labels(victors_features, scale_x, scale_y)

    assert_valid_airspace_payloads(
        section_id,
        airspace_labels,
        airspace_overlay,
        pixel_width,
        pixel_height,
    )

    write_json(section_root / "overlays" / "airspace.vector.json", airspace_overlay)
    write_json(section_root / "overlays" / "airports.vector.json", airports_overlay)
    write_json(section_root / "overlays" / "intersections.vector.json", intersections_overlay)
    write_json(section_root / "overlays" / "navaids.vector.json", navaids_overlay)
    write_json(section_root / "overlays" / "victors.vector.json", victors_overlay)

    write_json(section_root / "labels" / "airspace.json", airspace_labels)
    write_json(section_root / "labels" / "airports.json", airport_labels)
    write_json(section_root / "labels" / "intersections.json", intersection_labels)
    write_json(section_root / "labels" / "navaids.json", navaid_labels)
    write_json(section_root / "labels" / "victors.json", victor_labels)


    manifest = {
        "schema": MANIFEST_SCHEMA,
        "id": section_id,
        "title": title,
        "description": description,
        "quality": "primary",
        "assetVersion": asset_version,
        "chart": {
            "pixelWidth": pixel_width,
            "pixelHeight": pixel_height,
            "lonLatBbox": list(stl_airspace.FULL_REGION),
            "source": chart_source,
            "resolutionStrategy": "full-resolution GeoTIFF crop with multi-scale tile pyramid plus zoom-safe world-geometry overlays",
        },
        "world": {"widthUnits": 12.5},
        "layers": [
            {"id": "base", "title": "Base Map", "renderMode": "raster-pyramid", "tilePyramid": base_pyramid, "defaultVisible": True, "defaultLabels": False},
            {
                "id": "airspace",
                "title": "Airspace",
                "renderMode": "vector",
                "overlayData": "overlays/airspace.vector.json",
                "labelData": "labels/airspace.json",
                "defaultVisible": False,
                "defaultLabels": False,
                "altitudeVolume": {
                    "enabledByDefault": False,
                    "worldUnitsPerFoot": 0.00008,
                    "openEndedCeilingFt": stl_airspace.OPEN_ENDED_PROXY_CEILING_FT,
                    "minThicknessWorldUnits": 0.06,
                },
                "polygonStrokeMerge": True,
                "strokeRenderMode": "lines",
            },
            {"id": "airports", "title": "Airports", "renderMode": "vector", "overlayData": "overlays/airports.vector.json", "labelData": "labels/airports.json", "defaultVisible": False, "defaultLabels": False, "materialMode": "opaque"},
            {"id": "navaids", "title": "Navaids", "renderMode": "vector", "overlayData": "overlays/navaids.vector.json", "labelData": "labels/navaids.json", "defaultVisible": False, "defaultLabels": False, "materialMode": "opaque", "polygonStrokeMerge": True},
            {"id": "intersections", "title": "Intersections", "renderMode": "vector", "overlayData": "overlays/intersections.vector.json", "labelData": "labels/intersections.json", "defaultVisible": False, "defaultLabels": False},
            {"id": "victors", "title": "Victor Airways", "renderMode": "vector", "overlayData": "overlays/victors.vector.json", "labelData": "labels/victors.json", "defaultVisible": False, "defaultLabels": False, "strokePresentation": "tube", "strokeSegmentMerge": False},
        ],
    }

    layer_ids = {layer["id"] for layer in manifest["layers"]}
    selection_ids_by_layer = collect_staged_selection_ids(
        section_root=section_root,
        layers=manifest["layers"],
    )
    manifest["training"] = {
        "taskSets": stage_section_task_sets(
            training_root=TRAINING_TASK_SETS_ROOT,
            section_root=section_root,
            section_id=section_id,
            layer_ids=layer_ids,
            selection_ids_by_layer=selection_ids_by_layer,
        ),
        "eventSets": stage_section_event_sets(
            training_root=TRAINING_EVENT_SETS_ROOT,
            section_root=section_root,
            section_id=section_id,
            layer_ids=layer_ids,
            selection_ids_by_layer=selection_ids_by_layer,
        ),
    }

    write_json(section_root / "manifest.json", manifest)
    assert_valid_staged_section(section_root)
    removed_raster_roots = cleanup_old_base_raster_generations(
        section_root,
        base_raster_dir_from_pyramid(section_root, base_pyramid),
    )
    if removed_raster_roots:
        removed_names = ", ".join(path.name for path in removed_raster_roots)
        print(f"Removed stale {section_id} base raster generation(s): {removed_names}")
    return {
        "id": manifest["id"],
        "title": manifest["title"],
        "manifest": f"./sections/{manifest['id']}/manifest.json",
        "quality": manifest["quality"],
    }


def build_daytona_section() -> dict[str, object]:
    bind_builder_modules(
        DAY_AIRPORTS_MODULE,
        DAY_AIRSPACE_MODULE,
        DAY_INTERSECTIONS_MODULE,
        DAY_NAVAIDS_MODULE,
        DAY_VICTORS_MODULE,
        DAY_GEO_MODULE,
    )
    return build_bound_section(
        section_id="daytona",
        title="Daytona Beach Area",
        description="Jacksonville sectional crop covering the Daytona Beach / Orlando / Tampa review area.",
        chart_source="Jacksonville SEC.tif",
    )


def build_stlouis_section() -> dict[str, object]:
    bind_builder_modules(
        STL_AIRPORTS_MODULE,
        STL_AIRSPACE_MODULE,
        STL_INTERSECTIONS_MODULE,
        STL_NAVAIDS_MODULE,
        STL_VICTORS_MODULE,
        STL_GEO_MODULE,
    )
    return build_bound_section(
        section_id="stlouis",
        title="St. Louis Sectional",
        description="GeoTIFF-backed primary section with vector overlays and VR-native labels.",
        chart_source="St Louis SEC.tif",
    )


def main() -> None:
    ensure_dir(SECTIONS_ROOT)
    sections = [build_daytona_section(), build_stlouis_section()]
    write_json(
        DATA_ROOT / "index.json",
        {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sections": sections,
        },
    )
    print(f"Generated {len(sections)} section manifests in {DATA_ROOT}")


if __name__ == "__main__":
    main()
