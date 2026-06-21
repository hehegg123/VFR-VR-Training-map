from __future__ import annotations

import csv
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon

import build_indy_vfr_layers as base
import daytona_geotiff as geo


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DATA_ROOT = PROTOTYPE_ROOT / "reference-data"
OUTPUT_ROOT = PROTOTYPE_ROOT / "outputs"
OUTPUT_DIR = OUTPUT_ROOT / "daytona" / "airspaces"
CSV_DIR = (
    REFERENCE_DATA_ROOT
    / "faa"
    / "28DaySubscription_Effective_2026-04-16"
    / "CSV_Data"
    / "16_Apr_2026_CSV"
)

# Roughly matches the user-provided Daytona/Tampa/Orlando screenshot footprint
# while keeping the new section tighter than the full Jacksonville sectional.
FULL_REGION = (
    -83.65,
    -80.55,
    27.50,
    29.80,
)

SOFT_SURFACE_TOKENS = {
    "TURF",
    "GRASS",
    "DIRT",
    "GRVL",
    "GRAVEL",
    "WATER",
    "SAND",
    "SNOW",
    "ICE",
}

OPEN_ENDED_PROXY_CEILING_FT = 12000
MIN_PROXY_AIRSPACE_THICKNESS_FT = 1000
SURFACE_CLASS_E_TYPES = {"CLASS_E2", "CLASS_E3", "CLASS_E4"}
POSITIVE_FLOOR_CLASS_E_TYPES = {"CLASS_E5"}

def read_csv_from_dir(name: str) -> list[dict[str, str]]:
    path = CSV_DIR / name
    with path.open("r", encoding="utf-8-sig", errors="ignore") as handle:
        return list(csv.DictReader(handle))


def load_public_airports(region: tuple[float, float, float, float]) -> list[dict[str, object]]:
    class_lookup = {}
    for row in read_csv_from_dir("CLS_ARSP.csv"):
        if row["SITE_TYPE_CODE"] == "A":
            class_lookup[row["ARPT_ID"]] = row

    airports = []
    for row in read_csv_from_dir("APT_BASE.csv"):
        if row["SITE_TYPE_CODE"] != "A" or row["FACILITY_USE_CODE"] != "PU" or row["ARPT_STATUS"] != "O":
            continue
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        if base.bbox_intersects(lon, lon, lat, lat, region):
            row["lat"] = lat
            row["lon"] = lon
            row["class_info"] = class_lookup.get(row["ARPT_ID"], {})
            airports.append(row)
    return airports


def load_airspace_airports(region: tuple[float, float, float, float]) -> list[dict[str, object]]:
    class_lookup = {}
    controlled_flags = {
        "CLASS_B_AIRSPACE",
        "CLASS_C_AIRSPACE",
        "CLASS_D_AIRSPACE",
        "CLASS_E_AIRSPACE",
    }
    for row in read_csv_from_dir("CLS_ARSP.csv"):
        if row["SITE_TYPE_CODE"] != "A":
            continue
        if not any((row.get(flag) or "").strip() == "Y" for flag in controlled_flags):
            continue
        class_lookup[row["ARPT_ID"]] = row

    airports = []
    for row in read_csv_from_dir("APT_BASE.csv"):
        if row["SITE_TYPE_CODE"] != "A" or row["ARPT_STATUS"] != "O":
            continue
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        if base.bbox_intersects(lon, lon, lat, lat, region):
            row["lat"] = lat
            row["lon"] = lon
            row["class_info"] = class_lookup.get(row["ARPT_ID"], {})
            airports.append(row)
    return airports


def hydrate_airport_render_metadata(airports: list[dict[str, object]]) -> None:
    runway_metadata = load_airport_runway_metadata({row["ARPT_ID"] for row in airports})
    for row in airports:
        meta = runway_metadata.get(row["ARPT_ID"], {})
        row["runways"] = meta.get("runways", [])
        row["longest_runway_ft"] = meta.get("longest_runway_ft", 0)
        row["longest_hard_ft"] = meta.get("longest_hard_ft", 0)
        row["primary_runway_id"] = meta.get("primary_runway_id", "")
        row["faa_identifier"] = row.get("ARPT_ID", "").strip()
        row["icao_identifier"] = row.get("ICAO_ID", "").strip()


def is_hard_surface(surface: str) -> bool:
    surface = (surface or "").upper().strip()
    if not surface:
        return False
    return not any(token in surface for token in SOFT_SURFACE_TOKENS)


def load_airport_runway_metadata(airport_ids: set[str]) -> dict[str, dict[str, object]]:
    runway_rows: defaultdict[str, list[dict[str, object]]] = defaultdict(list)
    for row in read_csv_from_dir("APT_RWY.csv"):
        arpt_id = row["ARPT_ID"]
        if arpt_id not in airport_ids:
            continue
        runway_rows[arpt_id].append(
            {
                "rwy_id": row.get("RWY_ID", "").strip(),
                "length_ft": int(float(row["RWY_LEN"])) if row.get("RWY_LEN") else 0,
                "width_ft": int(float(row["RWY_WIDTH"])) if row.get("RWY_WIDTH") else 0,
                "surface": row.get("SURFACE_TYPE_CODE", "").strip(),
            }
        )

    metadata: dict[str, dict[str, object]] = {}
    for airport_id in airport_ids:
        runways = runway_rows.get(airport_id, [])
        non_heli = [runway for runway in runways if not runway["rwy_id"].startswith("H")]
        hard = [runway for runway in non_heli if is_hard_surface(runway["surface"])]
        preferred_pool = hard or non_heli or runways
        preferred = max(preferred_pool, key=lambda runway: (runway["length_ft"], runway["width_ft"], runway["rwy_id"])) if preferred_pool else None
        metadata[airport_id] = {
            "runways": runways,
            "longest_runway_ft": max((runway["length_ft"] for runway in non_heli), default=0),
            "longest_hard_ft": max((runway["length_ft"] for runway in hard), default=0),
            "primary_runway_id": preferred["rwy_id"] if preferred else "",
        }
    return metadata


def build_airport_component_matches(
    image: np.ndarray,
    region: tuple[float, float, float, float],
    airports: list[dict[str, object]],
) -> list[dict[str, float | str]]:
    components = base.detect_chart_components(image)
    height, width = image.shape[:2]
    candidates = []

    for airport_index, row in enumerate(airports):
        px, py = base.approx_region_xy(region, width, height, row["lon"], row["lat"])
        expect_blue = row["TWR_TYPE_CODE"] != "NON-ATCT"
        for component_index, comp in enumerate(components):
            dx = comp["cx"] - px
            dy = comp["cy"] - py
            dist = float((dx * dx + dy * dy) ** 0.5)
            if dist > 35.0:
                continue
            if expect_blue and comp["blue_frac"] < 0.15:
                continue
            if (not expect_blue) and comp["magenta_frac"] < 0.12:
                continue
            score = dist + max(0.0, 10.0 - comp["area"]) * 0.3
            candidates.append(
                {
                    "airport_index": airport_index,
                    "component_index": component_index,
                    "score": score,
                    "seed_error": dist,
                    "cx": comp["cx"],
                    "cy": comp["cy"],
                }
            )

    candidates.sort(key=lambda item: item["score"])
    used_airports = set()
    used_components = set()
    matches = []
    for candidate in candidates:
        airport_index = int(candidate["airport_index"])
        component_index = int(candidate["component_index"])
        if airport_index in used_airports or component_index in used_components:
            continue
        if candidate["seed_error"] > 25.0:
            continue
        row = airports[airport_index]
        matches.append(
            {
                "id": row["ARPT_ID"],
                "lon": float(row["lon"]),
                "lat": float(row["lat"]),
                "x": float(candidate["cx"]),
                "y": float(candidate["cy"]),
                "seed_error": float(candidate["seed_error"]),
            }
        )
        used_airports.add(airport_index)
        used_components.add(component_index)
    return matches


def calibrate_full_chart_transform(
    image: np.ndarray,
    region: tuple[float, float, float, float],
    airports: list[dict[str, object]],
) -> dict[str, object]:
    if geo.has_chart():
        return geo.build_chart_transform(region)
    matches = build_airport_component_matches(image, region, airports)
    if len(matches) < 30:
        raise RuntimeError(f"Only found {len(matches)} airport control points; need at least 30")

    matrix = np.array([[m["lon"], m["lat"], 1.0] for m in matches], dtype=float)
    target_x = np.array([m["x"] for m in matches], dtype=float)
    target_y = np.array([m["y"] for m in matches], dtype=float)

    coef_x, *_ = np.linalg.lstsq(matrix, target_x, rcond=None)
    coef_y, *_ = np.linalg.lstsq(matrix, target_y, rcond=None)

    refined = []
    for match in matches:
        pred_x = coef_x[0] * match["lon"] + coef_x[1] * match["lat"] + coef_x[2]
        pred_y = coef_y[0] * match["lon"] + coef_y[1] * match["lat"] + coef_y[2]
        residual = float(((pred_x - match["x"]) ** 2 + (pred_y - match["y"]) ** 2) ** 0.5)
        if residual <= 28.0:
            refined.append({**match, "residual": residual})

    matrix = np.array([[m["lon"], m["lat"], 1.0] for m in refined], dtype=float)
    target_x = np.array([m["x"] for m in refined], dtype=float)
    target_y = np.array([m["y"] for m in refined], dtype=float)
    coef_x, *_ = np.linalg.lstsq(matrix, target_x, rcond=None)
    coef_y, *_ = np.linalg.lstsq(matrix, target_y, rcond=None)

    residuals = []
    for match in refined:
        pred_x = coef_x[0] * match["lon"] + coef_x[1] * match["lat"] + coef_x[2]
        pred_y = coef_y[0] * match["lon"] + coef_y[1] * match["lat"] + coef_y[2]
        residuals.append(float(((pred_x - match["x"]) ** 2 + (pred_y - match["y"]) ** 2) ** 0.5))

    return {
        "coef_x": coef_x,
        "coef_y": coef_y,
        "control_points": refined,
        "median_residual_px": float(np.median(residuals)),
        "mean_residual_px": float(np.mean(residuals)),
        "max_residual_px": float(np.max(residuals)),
    }


def lonlat_to_chart_xy(features: dict[str, object], lon: float, lat: float) -> tuple[float, float]:
    transform = features["chart_transform"]
    if transform.get("kind") == "geotiff":
        return geo.lonlat_to_chart_xy(transform, lon, lat)
    coef_x = transform["coef_x"]
    coef_y = transform["coef_y"]
    x = coef_x[0] * lon + coef_x[1] * lat + coef_x[2]
    y = coef_y[0] * lon + coef_y[1] * lat + coef_y[2]
    return float(x), float(y)


def inside_chart(features: dict[str, object], x: float, y: float, margin: float = 0.0) -> bool:
    height, width = features["background"].shape[:2]
    return -margin <= x <= width + margin and -margin <= y <= height + margin


def clip_polygon_to_chart(
    points: list[tuple[float, float]],
    width: float,
    height: float,
) -> list[tuple[float, float]]:
    if len(points) < 3:
        return []

    ring = points[:]
    if len(ring) > 1 and abs(ring[0][0] - ring[-1][0]) <= 1e-6 and abs(ring[0][1] - ring[-1][1]) <= 1e-6:
        ring = ring[:-1]
    if len(ring) < 3:
        return []

    def clip_edge(polygon, inside_fn, intersect_fn):
        if not polygon:
            return []
        output = []
        start = polygon[-1]
        start_inside = inside_fn(start)
        for end in polygon:
            end_inside = inside_fn(end)
            if end_inside:
                if not start_inside:
                    output.append(intersect_fn(start, end))
                output.append(end)
            elif start_inside:
                output.append(intersect_fn(start, end))
            start = end
            start_inside = end_inside
        return output

    def intersect_vertical(a: tuple[float, float], b: tuple[float, float], x_value: float) -> tuple[float, float]:
        ax, ay = a
        bx, by = b
        if abs(bx - ax) <= 1e-9:
            return (x_value, ay)
        t = (x_value - ax) / (bx - ax)
        return (x_value, ay + t * (by - ay))

    def intersect_horizontal(a: tuple[float, float], b: tuple[float, float], y_value: float) -> tuple[float, float]:
        ax, ay = a
        bx, by = b
        if abs(by - ay) <= 1e-9:
            return (ax, y_value)
        t = (y_value - ay) / (by - ay)
        return (ax + t * (bx - ax), y_value)

    clipped = ring
    clipped = clip_edge(clipped, lambda point: point[0] >= 0.0, lambda a, b: intersect_vertical(a, b, 0.0))
    clipped = clip_edge(clipped, lambda point: point[0] <= width, lambda a, b: intersect_vertical(a, b, width))
    clipped = clip_edge(clipped, lambda point: point[1] >= 0.0, lambda a, b: intersect_horizontal(a, b, 0.0))
    clipped = clip_edge(clipped, lambda point: point[1] <= height, lambda a, b: intersect_horizontal(a, b, height))
    if len(clipped) < 3:
        return []
    return [(float(x), float(y)) for x, y in clipped]


def projected_visible_parts(
    features: dict[str, object],
    record: dict[str, object],
    *,
    cache_key: str = "_projected_visible_parts",
) -> list[list[tuple[float, float]]]:
    cached = record.get(cache_key)
    if cached is not None:
        return cached

    height, width = features["background"].shape[:2]
    visible_parts: list[list[tuple[float, float]]] = []
    for part in record["parts"]:
        if len(part) < 3:
            continue
        projected = [lonlat_to_chart_xy(features, lon, lat) for lon, lat in part]
        clipped = clip_polygon_to_chart(projected, width, height)
        if len(clipped) < 3:
            continue
        visible_parts.append(clipped)

    record[cache_key] = visible_parts
    return visible_parts


def projected_parts_centroid(parts: list[list[tuple[float, float]]]) -> tuple[float, float]:
    coords = [point for part in parts for point in part]
    x = sum(point[0] for point in coords) / len(coords)
    y = sum(point[1] for point in coords) / len(coords)
    return x, y


class LabelPlacer:
    def __init__(self, ax):
        self.ax = ax
        self.renderer = ax.figure.canvas.get_renderer()
        self.axes_bbox = ax.get_window_extent(renderer=self.renderer)
        self.occupied: list[tuple[float, float, float, float]] = []

    @staticmethod
    def overlap_area(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
        x0 = max(a[0], b[0])
        y0 = max(a[1], b[1])
        x1 = min(a[2], b[2])
        y1 = min(a[3], b[3])
        return max(0.0, x1 - x0) * max(0.0, y1 - y0)

    def bbox_penalty(self, bbox: tuple[float, float, float, float]) -> float:
        axbox = self.axes_bbox
        penalty = 0.0
        if bbox[0] < axbox.x0:
            penalty += (axbox.x0 - bbox[0]) * 3.0
        if bbox[1] < axbox.y0:
            penalty += (axbox.y0 - bbox[1]) * 3.0
        if bbox[2] > axbox.x1:
            penalty += (bbox[2] - axbox.x1) * 3.0
        if bbox[3] > axbox.y1:
            penalty += (bbox[3] - axbox.y1) * 3.0
        return penalty

    def text_bbox(self, text_artist) -> tuple[float, float, float, float]:
        bbox = text_artist.get_window_extent(renderer=self.renderer).expanded(1.08, 1.18)
        return (bbox.x0, bbox.y0, bbox.x1, bbox.y1)

    def score_bbox(self, bbox: tuple[float, float, float, float], dx: float, dy: float) -> float:
        overlap = sum(self.overlap_area(bbox, other) for other in self.occupied)
        return overlap * 10.0 + self.bbox_penalty(bbox) + abs(dx) * 0.2 + abs(dy) * 0.2

    def display_to_data(self, x: float, y: float, dx: float, dy: float) -> tuple[float, float]:
        disp_x, disp_y = self.ax.transData.transform((x, y))
        data_x, data_y = self.ax.transData.inverted().transform((disp_x + dx, disp_y + dy))
        return float(data_x), float(data_y)

    def place(
        self,
        x: float,
        y: float,
        text: str,
        *,
        fontsize: float,
        color: str,
        candidates: list[tuple[float, float, str, str]],
        zorder: int,
        allow_skip: bool = False,
        max_score: float | None = None,
    ) -> None:
        best_artist = None
        best_bbox = None
        best_score = None

        for dx, dy, ha, va in candidates:
            tx, ty = self.display_to_data(x, y, dx, dy)
            artist = self.ax.text(
                tx,
                ty,
                text,
                fontsize=fontsize,
                color=color,
                ha=ha,
                va=va,
                zorder=zorder,
                clip_on=True,
                path_effects=[pe.withStroke(linewidth=1.5, foreground="white", alpha=0.92)],
            )
            bbox = self.text_bbox(artist)
            score = self.score_bbox(bbox, dx, dy)
            if best_score is None or score < best_score:
                if best_artist is not None:
                    best_artist.remove()
                best_artist = artist
                best_bbox = bbox
                best_score = score
                if score <= 0.01:
                    break
            else:
                artist.remove()

        if best_bbox is not None:
            if allow_skip and max_score is not None and best_score is not None and best_score > max_score:
                if best_artist is not None:
                    best_artist.remove()
                return
            self.occupied.append(best_bbox)


class AirspaceLabelPlacer(LabelPlacer):
    def place_text(
        self,
        x: float,
        y: float,
        text: str,
        *,
        fontsize: float,
        color: str,
        candidates: list[tuple[float, float, str, str]],
        zorder: int,
        allow_skip: bool = False,
        max_score: float | None = None,
        validator=None,
        score_adjuster=None,
    ) -> dict[str, float | str] | None:
        best_artist = None
        best_bbox = None
        best_score = None
        best_ha = "center"
        best_va = "center"

        for dx, dy, ha, va in candidates:
            tx, ty = self.display_to_data(x, y, dx, dy)
            artist = self.ax.text(
                tx,
                ty,
                text,
                fontsize=fontsize,
                color=color,
                ha=ha,
                va=va,
                zorder=zorder,
                clip_on=True,
                path_effects=[pe.withStroke(linewidth=1.5, foreground="white", alpha=0.92)],
            )
            bbox = self.text_bbox(artist)
            if validator is not None and not validator(bbox, tx, ty, dx, dy, ha, va):
                artist.remove()
                continue
            score = self.score_bbox(bbox, dx, dy)
            if score_adjuster is not None:
                score += float(score_adjuster(bbox, tx, ty, dx, dy, ha, va))
            if best_score is None or score < best_score:
                if best_artist is not None:
                    best_artist.remove()
                best_artist = artist
                best_bbox = bbox
                best_score = score
                best_ha = ha
                best_va = va
                if score <= 0.01:
                    break
            else:
                artist.remove()

        if best_bbox is not None:
            if allow_skip and max_score is not None and best_score is not None and best_score > max_score:
                if best_artist is not None:
                    best_artist.remove()
                return None
            self.occupied.append(best_bbox)
            best_x, best_y = best_artist.get_position()
            return {
                "x": float(best_x),
                "y": float(best_y),
                "ha": best_ha,
                "va": best_va,
                "score": float(best_score if best_score is not None else 0.0),
            }
        return None


def polygon_area_and_centroid(points: list[tuple[float, float]]) -> tuple[float, tuple[float, float]]:
    if len(points) < 3:
        x = sum(point[0] for point in points) / max(len(points), 1)
        y = sum(point[1] for point in points) / max(len(points), 1)
        return 0.0, (x, y)

    area_twice = 0.0
    cx = 0.0
    cy = 0.0
    for index, start in enumerate(points):
        end = points[(index + 1) % len(points)]
        cross = start[0] * end[1] - end[0] * start[1]
        area_twice += cross
        cx += (start[0] + end[0]) * cross
        cy += (start[1] + end[1]) * cross

    if abs(area_twice) <= 1e-9:
        x = sum(point[0] for point in points) / len(points)
        y = sum(point[1] for point in points) / len(points)
        return 0.0, (x, y)

    area = area_twice / 2.0
    return area, (cx / (3.0 * area_twice), cy / (3.0 * area_twice))


def part_bounds(parts: list[list[tuple[float, float]]]) -> tuple[float, float, float, float]:
    coords = [point for part in parts for point in part]
    xs = [point[0] for point in coords]
    ys = [point[1] for point in coords]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_projected_ring(x: float, y: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    count = len(ring)
    for index in range(count):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % count]
        if (y1 > y) != (y2 > y):
            x_cross = (x2 - x1) * (y - y1) / ((y2 - y1) + 1e-12) + x1
            if x < x_cross:
                inside = not inside
    return inside


def point_in_projected_parts(x: float, y: float, parts: list[list[tuple[float, float]]]) -> bool:
    return any(point_in_projected_ring(x, y, part) for part in parts if len(part) >= 3)


def distance_point_to_segment(
    x: float,
    y: float,
    start: tuple[float, float],
    end: tuple[float, float],
) -> float:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    if abs(dx) <= 1e-9 and abs(dy) <= 1e-9:
        return float(((x - start[0]) ** 2 + (y - start[1]) ** 2) ** 0.5)
    t = ((x - start[0]) * dx + (y - start[1]) * dy) / (dx * dx + dy * dy)
    t = min(1.0, max(0.0, t))
    px = start[0] + t * dx
    py = start[1] + t * dy
    return float(((x - px) ** 2 + (y - py) ** 2) ** 0.5)


def signed_distance_to_parts(x: float, y: float, parts: list[list[tuple[float, float]]]) -> float:
    best = float("inf")
    for part in parts:
        if len(part) < 2:
            continue
        for index, start in enumerate(part):
            end = part[(index + 1) % len(part)]
            best = min(best, distance_point_to_segment(x, y, start, end))
    if best == float("inf"):
        return -1e6
    return best if point_in_projected_parts(x, y, parts) else -best


def largest_visible_part(
    parts: list[list[tuple[float, float]]],
    preferred: tuple[float, float] | None = None,
) -> list[tuple[float, float]]:
    if preferred is not None:
        px, py = preferred
        containing = [part for part in parts if point_in_projected_ring(px, py, part)]
        if containing:
            return max(containing, key=lambda part: abs(polygon_area_and_centroid(part)[0]))
    return max(parts, key=lambda part: abs(polygon_area_and_centroid(part)[0]))


def visual_anchor_for_part(
    part: list[tuple[float, float]],
    preferred: tuple[float, float] | None = None,
) -> tuple[float, float]:
    if len(part) < 3:
        return preferred if preferred is not None else projected_parts_centroid([part])

    min_x = min(point[0] for point in part)
    max_x = max(point[0] for point in part)
    min_y = min(point[1] for point in part)
    max_y = max(point[1] for point in part)
    width = max_x - min_x
    height = max_y - min_y
    area, centroid = polygon_area_and_centroid(part)

    candidates: list[tuple[float, float]] = []
    if preferred is not None and point_in_projected_ring(preferred[0], preferred[1], part):
        candidates.append((float(preferred[0]), float(preferred[1])))
    if point_in_projected_ring(centroid[0], centroid[1], part):
        candidates.append((float(centroid[0]), float(centroid[1])))

    grid_cols = max(6, min(14, int(width / 42.0) + 5))
    grid_rows = max(6, min(14, int(height / 42.0) + 5))
    for x in np.linspace(min_x, max_x, num=grid_cols):
        for y in np.linspace(min_y, max_y, num=grid_rows):
            if point_in_projected_ring(float(x), float(y), part):
                candidates.append((float(x), float(y)))

    if not candidates:
        return float(centroid[0]), float(centroid[1])

    bias = preferred if preferred is not None else (float(centroid[0]), float(centroid[1]))

    def score(candidate: tuple[float, float]) -> float:
        clearance = signed_distance_to_parts(candidate[0], candidate[1], [part])
        bias_distance = ((candidate[0] - bias[0]) ** 2 + (candidate[1] - bias[1]) ** 2) ** 0.5
        return clearance - bias_distance * 0.08

    best = max(candidates, key=score)
    step = max(width, height) / 5.0
    while step > 2.0:
        refined = [best]
        for dx in (-step, 0.0, step):
            for dy in (-step, 0.0, step):
                candidate = (best[0] + dx, best[1] + dy)
                if point_in_projected_ring(candidate[0], candidate[1], part):
                    refined.append(candidate)
        best = max(refined, key=score)
        step *= 0.5

    return float(best[0]), float(best[1])


def shape_aware_anchor(
    parts: list[list[tuple[float, float]]],
    preferred: tuple[float, float] | None = None,
) -> tuple[float, float]:
    if not parts:
        return preferred if preferred is not None else (0.0, 0.0)
    part = largest_visible_part(parts, preferred)
    part_preferred = preferred if preferred is not None and point_in_projected_ring(preferred[0], preferred[1], part) else None
    return visual_anchor_for_part(part, part_preferred)


def bbox_sample_points_data(ax, bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    x0, y0, x1, y1 = bbox
    xs = [x0 + (x1 - x0) * 0.18, (x0 + x1) / 2.0, x0 + (x1 - x0) * 0.82]
    ys = [y0 + (y1 - y0) * 0.18, (y0 + y1) / 2.0, y0 + (y1 - y0) * 0.82]
    points: list[tuple[float, float]] = []
    for disp_x in xs:
        for disp_y in ys:
            data_x, data_y = ax.transData.inverted().transform((disp_x, disp_y))
            points.append((float(data_x), float(data_y)))
    return points


def interior_label_validator(ax, parts: list[list[tuple[float, float]]], min_inside_ratio: float = 0.74):
    def validate(bbox, _tx, _ty, _dx, _dy, _ha, _va):
        samples = bbox_sample_points_data(ax, bbox)
        inside = sum(1 for sample_x, sample_y in samples if point_in_projected_parts(sample_x, sample_y, parts))
        center_x, center_y = samples[len(samples) // 2]
        if not point_in_projected_parts(center_x, center_y, parts):
            return False
        return (inside / len(samples)) >= min_inside_ratio

    return validate


def interior_score_adjuster(ax, parts: list[list[tuple[float, float]]]):
    def adjust(bbox, _tx, _ty, _dx, _dy, _ha, _va):
        samples = bbox_sample_points_data(ax, bbox)
        clearances = [signed_distance_to_parts(sample_x, sample_y, parts) for sample_x, sample_y in samples]
        positive = max(0.0, min(clearances))
        return -min(positive, 42.0) * 2.4

    return adjust


def callout_label_validator(ax, parts: list[list[tuple[float, float]]], min_outside_clearance: float = 8.0):
    def validate(bbox, _tx, _ty, _dx, _dy, _ha, _va):
        samples = bbox_sample_points_data(ax, bbox)
        inside = sum(1 for sample_x, sample_y in samples if point_in_projected_parts(sample_x, sample_y, parts))
        center_x, center_y = samples[len(samples) // 2]
        center_clearance = signed_distance_to_parts(center_x, center_y, parts)
        return center_clearance <= -min_outside_clearance and (inside / len(samples)) <= 0.24

    return validate


def merge_visible_parts(
    features: dict[str, object],
    entries: list[tuple[dict[str, object], dict[str, object] | None]],
) -> list[list[tuple[float, float]]]:
    parts: list[list[tuple[float, float]]] = []
    for record, _airport in entries:
        parts.extend(projected_visible_parts(features, record))
    return parts


def airport_local_visible_parts(
    features: dict[str, object],
    entries: list[tuple[dict[str, object], dict[str, object] | None]],
    airport_x: float,
    airport_y: float,
) -> list[list[tuple[float, float]]]:
    parts = merge_visible_parts(features, entries)
    if not parts:
        return parts

    containing = [part for part in parts if point_in_projected_ring(airport_x, airport_y, part)]
    if containing:
        return containing

    nearest_part = min(
        parts,
        key=lambda part: abs(signed_distance_to_parts(airport_x, airport_y, [part])),
    )
    nearest_min_x, nearest_min_y, nearest_max_x, nearest_max_y = part_bounds([nearest_part])
    nearest_center_x = (nearest_min_x + nearest_max_x) / 2.0
    nearest_center_y = (nearest_min_y + nearest_max_y) / 2.0
    associated_parts = [nearest_part]

    for part in parts:
        if part is nearest_part:
            continue
        min_x, min_y, max_x, max_y = part_bounds([part])
        center_x = (min_x + max_x) / 2.0
        center_y = (min_y + max_y) / 2.0
        center_distance = ((center_x - nearest_center_x) ** 2 + (center_y - nearest_center_y) ** 2) ** 0.5
        horizontal_gap = max(0.0, max(nearest_min_x - max_x, min_x - nearest_max_x))
        vertical_gap = max(0.0, max(nearest_min_y - max_y, min_y - nearest_max_y))
        if center_distance <= 220.0 or (horizontal_gap <= 70.0 and vertical_gap <= 70.0):
            associated_parts.append(part)

    return associated_parts


CONTROLLED_AIRSPACE_TYPES = {"CLASS_B", "CLASS_C", "CLASS_D", "CLASS_E2", "CLASS_E3", "CLASS_E4", "CLASS_E5"}
CLASS_E_TYPES = {"CLASS_E2", "CLASS_E3", "CLASS_E4", "CLASS_E5"}
AIRSPACE_TYPE_PRIORITY = {
    "CLASS_B": 0,
    "CLASS_C": 1,
    "CLASS_D": 2,
    "CLASS_E2": 3,
    "CLASS_E3": 4,
    "CLASS_E4": 5,
    "CLASS_E5": 6,
}


def build_airspace_grouped_entries(
    features: dict[str, object],
) -> list[tuple[tuple[str | None, str], list[tuple[dict[str, object], dict[str, object] | None]]]]:
    airports = features["airports"]
    grouped = defaultdict(list)
    grouped_record_ids: set[tuple[str, str, int]] = set()

    for record in features["class_airspaces"]:
        if not projected_visible_parts(features, record):
            continue
        airport = related_airport_for_airspace(record, airports)
        airport_id = airport["ARPT_ID"] if airport else None
        type_code = record["attrs"].get("TYPE_CODE", "")
        record_key = (airport_id or "", type_code, id(record))
        grouped[(airport_id, type_code)].append((record, airport))
        grouped_record_ids.add(record_key)

    for record in features["class_airspaces"]:
        if not projected_visible_parts(features, record):
            continue
        type_code = record["attrs"].get("TYPE_CODE", "")
        if type_code not in CLASS_E_TYPES:
            continue

        already_grouped = any(
            (airport_id, type_code, id(record)) in grouped_record_ids
            for airport_id in {airport["ARPT_ID"] for airport in airports}
        )
        if already_grouped:
            continue

        airport = fallback_airport_for_class_e_record(record, airports)
        if airport is None:
            continue
        airport_id = airport["ARPT_ID"]
        record_key = (airport_id, type_code, id(record))
        grouped[(airport_id, type_code)].append((record, airport))
        grouped_record_ids.add(record_key)

    return sorted(
        grouped.items(),
        key=lambda item: (
            AIRSPACE_TYPE_PRIORITY.get(item[0][1], 9),
            item[0][0] or "ZZZ",
        ),
    )


def fallback_airport_for_class_e_record(
    record: dict[str, object],
    airports: list[dict[str, object]],
) -> dict[str, object] | None:
    attrs = record["attrs"]
    type_code = attrs.get("TYPE_CODE", "")
    if type_code not in {"CLASS_E3", "CLASS_E4", "CLASS_E5"}:
        return None

    ident_text = " ".join(
        str(value or "").upper()
        for value in (attrs.get("IDENT"), attrs.get("COMM_NAME"), attrs.get("LEVEL"))
        if value
    )
    centroid_lon, centroid_lat = polygon_centroid_lonlat(record["parts"])
    candidates: list[tuple[float, int, float, dict[str, object]]] = []

    for airport in airports:
        lon = float(airport["lon"])
        lat = float(airport["lat"])
        inside = point_in_parts(lon, lat, record["parts"])

        text_score = airspace_airport_match_score(ident_text, airport)
        score = text_score
        class_info = airport.get("class_info", {})
        if class_info.get("CLASS_E_AIRSPACE") == "Y":
            score += 2.0

        distance = base.haversine_nm(centroid_lat, centroid_lon, lat, lon)
        if not inside and (text_score <= 0 or distance > 30.0):
            continue
        candidates.append((score, 1 if inside else 0, -distance, airport))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    return candidates[0][3]


def build_airspace_selection_regions(features: dict[str, object]) -> list[dict[str, object]]:
    regions: list[dict[str, object]] = []
    primary_families: set[str] = set()
    grouped_items = build_airspace_grouped_entries(features)
    grouped_map = {key: entries for key, entries in grouped_items}

    for (airport_id, type_code), entries in grouped_items:
        if type_code not in CONTROLLED_AIRSPACE_TYPES or airport_id is None:
            continue
        airport = entries[0][1]
        airport_x, airport_y = lonlat_to_chart_xy(features, airport["lon"], airport["lat"])
        if not inside_chart(features, airport_x, airport_y, margin=8):
            continue
        if type_code in {"CLASS_B", "CLASS_C"}:
            visible_parts = merge_visible_parts(features, entries)
        else:
            visible_parts = airport_local_visible_parts(features, entries, airport_x, airport_y)
        if not visible_parts:
            continue
        altitude_bounds = derive_airfield_altitude_bounds(grouped_map, airport_id, type_code, entries)
        shape_anchor = shape_aware_anchor(
            visible_parts,
            preferred=(airport_x, airport_y) if point_in_projected_parts(airport_x, airport_y, visible_parts) else None,
        )
        region = {
            "id": f"{airport_id}-{type_code}",
            "kind": "airfield",
            "airspaceType": type_code,
            "familyKey": f"{airport_id}-{type_code}",
            "priority": airfield_priority(airport, type_code, clean_hours_text(airport.get("class_info", {}).get("AIRSPACE_HRS", ""))),
            "anchorX": float(shape_anchor[0]),
            "anchorY": float(shape_anchor[1]),
            "parts": visible_parts,
        }
        if altitude_bounds is not None:
            region.update(altitude_bounds)
        regions.append(region)
        primary_families.add(region["familyKey"])

    shelf_records = sorted(
        (
            record
            for record in features["class_airspaces"]
            if projected_visible_parts(features, record)
            and record["attrs"].get("TYPE_CODE", "") in {"CLASS_B", "CLASS_C"}
        ),
        key=lambda record: (
            AIRSPACE_TYPE_PRIORITY.get(record["attrs"].get("TYPE_CODE", ""), 9),
            -abs(len("".join(record["attrs"].get("LEVEL", "")))),
        ),
    )
    for record_index, record in enumerate(shelf_records):
        visible_parts = projected_visible_parts(features, record)
        if not visible_parts:
            continue
        altitude_bounds = airspace_altitude_bounds(record["attrs"])
        type_code = record["attrs"].get("TYPE_CODE", "")
        airport = related_airport_for_airspace(record, features["airports"]) if type_code in {"CLASS_B", "CLASS_C", "CLASS_D"} else None
        family_key = airspace_family_key(airport, type_code)
        if family_key not in primary_families:
            continue
        x, y = shape_aware_anchor(visible_parts)
        if not inside_chart(features, x, y, margin=4):
            continue
        region = {
            "id": f"shelf-{type_code}-{record_index}",
            "kind": "shelf",
            "airspaceType": type_code,
            "familyKey": family_key,
            "priority": 0.55 if type_code in {"CLASS_B", "CLASS_C", "CLASS_D"} else 0.5,
            "anchorX": float(x),
            "anchorY": float(y),
            "parts": visible_parts,
        }
        if altitude_bounds is not None:
            region.update(altitude_bounds)
            region["altitudeSource"] = "record-attrs"
        regions.append(region)

    special_records = sorted(
        (record for record in features["special_activity"] if projected_visible_parts(features, record, cache_key="_projected_visible_parts_special")),
        key=lambda record: (
            0 if "R-" in (record.get("name") or "") else 1,
            0 if " MOA" in (record.get("name") or "") else 1,
            record.get("name") or "",
        ),
    )
    for record_index, record in enumerate(special_records):
        visible_parts = projected_visible_parts(features, record, cache_key="_projected_visible_parts_special")
        if not visible_parts:
            continue
        x, y = shape_aware_anchor(visible_parts)
        if not inside_chart(features, x, y, margin=6):
            continue
        regions.append(
            {
                "id": f"special-{record_index}",
                "kind": "special",
                "airspaceType": "SPECIAL",
                "familyKey": f"special-{record_index}",
                "priority": special_activity_priority(record),
                "anchorX": float(x),
                "anchorY": float(y),
                "parts": visible_parts,
            }
        )

    return regions


def alignment_for_offset(dx: float, dy: float) -> tuple[str, str]:
    if abs(dx) <= 4:
        ha = "center"
    elif dx > 0:
        ha = "left"
    else:
        ha = "right"

    if abs(dy) <= 4:
        va = "center"
    elif dy > 0:
        va = "bottom"
    else:
        va = "top"
    return ha, va


def radial_candidates(
    radii: list[int],
    directions: list[tuple[int, int]],
    include_center: bool = False,
) -> list[tuple[float, float, str, str]]:
    candidates: list[tuple[float, float, str, str]] = []
    if include_center:
        candidates.append((0.0, 0.0, "center", "center"))
    for radius in radii:
        for sx, sy in directions:
            dx = sx * radius
            dy = sy * radius
            ha, va = alignment_for_offset(dx, dy)
            candidates.append((float(dx), float(dy), ha, va))
    return candidates


def callout_candidates() -> list[tuple[float, float, str, str]]:
    return radial_candidates(
        [62, 88, 118, 152],
        [
            (1, -1),
            (1, 0),
            (1, 1),
            (-1, -1),
            (-1, 0),
            (-1, 1),
            (0, -1),
            (0, 1),
        ],
        include_center=False,
    )


def scaled_callout_candidates(
    parts: list[list[tuple[float, float]]],
    *,
    min_radius: float = 62.0,
    max_radius: float = 240.0,
    fractions: tuple[float, ...] = (0.26, 0.38, 0.52, 0.7),
) -> list[tuple[float, float, str, str]]:
    min_x, min_y, max_x, max_y = part_bounds(parts)
    span = max(max_x - min_x, max_y - min_y)
    radii = []
    for fraction in fractions:
        radii.append(int(max(min_radius, min(max_radius, span * fraction))))
    radii = sorted({radius for radius in radii if radius > 0})
    if not radii:
        return callout_candidates()
    return radial_candidates(
        radii,
        [
            (1, -1),
            (1, 0),
            (1, 1),
            (-1, -1),
            (-1, 0),
            (-1, 1),
            (0, -1),
            (0, 1),
        ],
        include_center=False,
    )


def compact_airport_name(name: str) -> str:
    text = " ".join(name.split())
    replacements = [
        ("INTERNATIONAL", "INTL"),
        ("REGIONAL", "RGNL"),
        ("MUNICIPAL", "MUNI"),
        ("COUNTY", "CO"),
        ("AIRPORT", "AP"),
        ("AIRPARK", "AP"),
        ("FIELD", "FLD"),
        ("MEMORIAL", "MEML"),
        ("UNIVERSITY", "UNIV"),
        ("SAINT", "ST"),
        ("FORT", "FT"),
        ("MOUNT", "MT"),
    ]
    for source, target in replacements:
        text = text.replace(source, target)
    return text


def airfield_runway_designator(airport: dict[str, object]) -> str:
    return str(airport.get("primary_runway_id") or "").strip()


def airspace_family_key(airport: dict[str, object] | None, type_code: str) -> str | None:
    if airport is None or type_code not in {"CLASS_B", "CLASS_C", "CLASS_D"}:
        return None
    airport_id = str(airport.get("ARPT_ID") or "").strip()
    if not airport_id:
        return None
    return f"{airport_id}-{type_code}"


def airfield_priority(airport: dict[str, object], type_code: str, hours: str) -> float:
    base_priority = {
        "CLASS_B": 1.0,
        "CLASS_C": 0.95,
        "CLASS_D": 0.9,
        "CLASS_E2": 0.83,
        "CLASS_E4": 0.72,
        "CLASS_E3": 0.58,
        "CLASS_E5": 0.54,
    }.get(type_code, 0.5)

    runway_length = int(airport.get("longest_hard_ft") or airport.get("longest_runway_ft") or 0)
    if runway_length >= 7000:
        base_priority += 0.15
    elif runway_length >= 5000:
        base_priority += 0.12
    elif runway_length >= 4000:
        base_priority += 0.09
    elif runway_length >= 3000:
        base_priority += 0.06
    elif runway_length >= 2000:
        base_priority += 0.03

    if airport.get("TWR_TYPE_CODE") != "NON-ATCT":
        base_priority += 0.04
    if hours:
        base_priority += 0.03
    if airfield_runway_designator(airport):
        base_priority += 0.015

    max_priority = 0.79 if type_code in {"CLASS_E3", "CLASS_E5"} else 0.86 if type_code == "CLASS_E4" else 1.0
    return min(base_priority, max_priority)


def load_class_airspaces(region: tuple[float, float, float, float]) -> list[dict[str, object]]:
    class_attrs = base.read_dbf_records(base.CLASS_DBF)
    class_shapes = base.read_polygon_shapefile(base.CLASS_SHP)
    airspaces = []
    for attrs, shape in zip(class_attrs, class_shapes):
        bbox = shape["bbox"]
        if not bbox:
            continue
        xmin, xmax, ymin, ymax = bbox
        if base.bbox_intersects(xmin, xmax, ymin, ymax, region):
            if should_skip_class_airspace(attrs, shape):
                continue
            airspaces.append({"attrs": attrs, "parts": shape["parts"]})
    return airspaces


def should_skip_class_airspace(attrs: dict[str, object], shape: dict[str, object]) -> bool:
    if attrs.get("TYPE_CODE") != "CLASS_E5":
        return False

    bbox = shape.get("bbox")
    ident = str(attrs.get("IDENT") or "").upper()
    if not bbox or " CLASS E5" not in ident:
        return False

    xmin, xmax, ymin, ymax = bbox
    width_deg = xmax - xmin
    height_deg = ymax - ymin

    # Drop the giant state-spanning fallback E5 polygons. After clipping they
    # create long artificial borders across the St. Louis chart that are not
    # useful local airspace boundaries in this prototype.
    return width_deg >= 3.0 or height_deg >= 3.0


def load_aerobatic_areas(region: tuple[float, float, float, float]) -> list[dict[str, object]]:
    maa_base = {row["MAA_ID"]: row for row in read_csv_from_dir("MAA_BASE.csv")}
    maa_shapes: defaultdict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for row in read_csv_from_dir("MAA_SHP.csv"):
        lat = base.dms_to_decimal(row["LATITUDE"])
        lon = base.dms_to_decimal(row["LONGITUDE"])
        maa_shapes[row["MAA_ID"]].append((int(row["POINT_SEQ"]), lon, lat))

    aerobatic = []
    for maa_id, points in maa_shapes.items():
        ordered = [(lon, lat) for _, lon, lat in sorted(points)]
        if len(ordered) < 3:
            continue
        xs = [pt[0] for pt in ordered]
        ys = [pt[1] for pt in ordered]
        if base.bbox_intersects(min(xs), max(xs), min(ys), max(ys), region):
            aerobatic.append({"attrs": maa_base.get(maa_id, {}), "parts": [ordered]})
    return aerobatic


def build_features() -> dict[str, object]:
    base.read_csv_from_zip = read_csv_from_dir
    image = geo.load_chart_background(FULL_REGION) if geo.has_chart() else base.load_chart_background(FULL_REGION)
    light_bg = base.lighten_background(image, factor=0.5)
    public_airports = load_public_airports(FULL_REGION)
    airspace_airports = load_airspace_airports(FULL_REGION)
    hydrate_airport_render_metadata(public_airports)
    hydrate_airport_render_metadata(airspace_airports)
    chart_transform = calibrate_full_chart_transform(image, FULL_REGION, public_airports)
    class_airspaces = load_class_airspaces(FULL_REGION)
    special_activity = base.parse_saa_polygons(FULL_REGION)
    aerobatic = load_aerobatic_areas(FULL_REGION)
    return {
        "region": FULL_REGION,
        "background": image,
        "light_bg": light_bg,
        "chart_transform": chart_transform,
        "airports": airspace_airports,
        "public_airports": public_airports,
        "class_airspaces": class_airspaces,
        "special_activity": special_activity,
        "aerobatic": aerobatic,
    }


def setup_axes(ax, features: dict[str, object], title: str | None = None) -> None:
    height, width = features["background"].shape[:2]
    if title:
        ax.set_title(title, fontsize=16, pad=8)
    ax.set_xlim(0, width)
    ax.set_ylim(height, 0)
    ax.set_aspect("equal", adjustable="box")
    ax.set_axis_off()
    ax.set_position([0, 0, 1, 1])


def draw_background(ax, features: dict[str, object], faded: bool = False) -> None:
    ax.imshow(features["light_bg"] if faded else features["background"], origin="upper")


def class_e_boundary_kind(attrs: dict[str, object]) -> str:
    lower_desc = str(attrs.get("LOWER_DESC") or "").strip()
    lower_uom = str(attrs.get("LOWER_UOM") or "").strip().upper()
    if lower_desc in {"", "0"}:
        return "surface"
    if lower_uom == "SFC" and not lower_desc:
        return "surface"
    if lower_desc == "700":
        return "700"
    if lower_desc == "1200":
        return "1200"
    return lower_desc or "other"


def class_airspace_chart_style(attrs: dict[str, object]) -> dict[str, object] | None:
    type_code = str(attrs.get("TYPE_CODE") or "").strip().upper()
    if type_code == "CLASS_B":
        return {"edge": "#1d4ed8", "fill": "#93c5fd", "alpha": 0.10, "lw": 1.4, "ls": "-", "renderMode": "polygon"}
    if type_code == "CLASS_C":
        return {"edge": "#8b1e6d", "fill": "#f9a8d4", "alpha": 0.10, "lw": 1.3, "ls": "-", "renderMode": "polygon"}
    if type_code == "CLASS_D":
        return {"edge": "#1d4ed8", "fill": None, "alpha": 0.0, "lw": 1.1, "ls": (0, (6, 4)), "renderMode": "stroke"}
    if not type_code.startswith("CLASS_E"):
        return None

    boundary_kind = class_e_boundary_kind(attrs)
    if boundary_kind == "surface":
        return {"edge": "#8b1e6d", "fill": None, "alpha": 0.0, "lw": 1.0, "ls": (0, (5, 4)), "renderMode": "stroke"}
    if boundary_kind == "700":
        return {
            "edge": "#d946ef",
            "fill": "#f5d0fe",
            "alpha": 0.035,
            "lw": 0.95,
            "ls": "-",
            "renderMode": "polygon",
            "halo": "#f0abfc",
            "haloAlpha": 0.18,
            "haloWidthPx": 7.5,
        }
    if boundary_kind == "1200":
        return {
            "edge": "#2563eb",
            "fill": "#bfdbfe",
            "alpha": 0.03,
            "lw": 0.9,
            "ls": "-",
            "renderMode": "polygon",
            "halo": "#93c5fd",
            "haloAlpha": 0.16,
            "haloWidthPx": 7.0,
        }
    return {"edge": "#c026d3", "fill": "#f5d0fe", "alpha": 0.025, "lw": 0.8, "ls": "-", "renderMode": "polygon"}


def draw_airspaces(ax, features: dict[str, object]) -> None:
    for record in features["class_airspaces"]:
        style = class_airspace_chart_style(record["attrs"])
        if style is None:
            continue
        for part in projected_visible_parts(features, record):
            poly = Polygon(
                part,
                closed=True,
                facecolor=style["fill"] if style["fill"] else "none",
                edgecolor=style["edge"],
                linewidth=style["lw"],
                linestyle=style["ls"],
                alpha=style["alpha"] if style["fill"] else 0.92,
            )
            ax.add_patch(poly)

    for record in features["special_activity"]:
        for part in projected_visible_parts(features, record, cache_key="_projected_visible_parts_special"):
            poly = Polygon(
                part,
                closed=True,
                facecolor="#7e22ce",
                edgecolor="#6b21a8",
                linewidth=0.8,
                linestyle=(0, (2, 2)),
                alpha=0.07,
            )
            ax.add_patch(poly)

    for record in features["aerobatic"]:
        for part in projected_visible_parts(features, record, cache_key="_projected_visible_parts_aerobatic"):
            poly = Polygon(
                part,
                closed=True,
                fill=False,
                edgecolor="#be123c",
                linewidth=0.8,
                linestyle=(0, (4, 3)),
                alpha=0.85,
            )
            ax.add_patch(poly)


def clean_hours_text(value: str) -> str:
    value = " ".join((value or "").split())
    value = value.replace("CLASS ", "").replace(" SVC ", " ")
    value = value.replace("OTHER TIMES", "OTHR")
    value = value.replace("CONTINUOUS", "CONT")
    value = value.replace("MON-FRI", "M-F")
    value = value.replace("SAT-SUN", "S-S")
    value = value.replace("MON", "MON")
    value = value.replace("TUE", "TUE")
    value = value.replace("WED", "WED")
    value = value.replace("THU", "THU")
    value = value.replace("FRI", "FRI")
    value = value.replace("SAT", "SAT")
    value = value.replace("SUN", "SUN")
    return value


def airspace_name_for_type(type_code: str) -> str:
    if type_code.startswith("CLASS_E"):
        return "Class E"
    return type_code.replace("CLASS_", "Class ").replace("_", " ")


def compact_section_level(level: str) -> str:
    text = " ".join((level or "").strip().split())
    if not text:
        return ""
    if " EXCLUDES " in text:
        text = text.split(" EXCLUDES ", 1)[0].strip()
    if text.startswith("AREA "):
        tokens = text.split()
        if len(tokens) >= 2:
            return f"AREA {tokens[1]}"
    return text


def shelf_label_lines(
    attrs: dict[str, str],
    airport: dict[str, object] | None,
) -> list[str]:
    type_code = attrs.get("TYPE_CODE", "")
    if type_code == "CLASS_E2":
        return []

    altitude = format_altitude(attrs)
    if not altitude:
        return []

    if type_code in {"CLASS_B", "CLASS_C", "CLASS_D"} and airport is not None:
        identifier = airport.get("faa_identifier") or airport.get("ARPT_ID", "")
        class_code = "B" if type_code == "CLASS_B" else "C" if type_code == "CLASS_C" else "D"
        level = compact_section_level(attrs.get("LEVEL", ""))
        title = f"{identifier} {class_code}".strip()
        if level and type_code in {"CLASS_B", "CLASS_C"}:
            title = f"{title} {level}".strip()
        return [title, altitude]

    return [altitude]


def format_altitude(attrs: dict[str, str]) -> str:
    type_code = attrs.get("TYPE_CODE", "")
    lower_desc = (attrs.get("LOWER_DESC") or "").strip()
    upper_desc = (attrs.get("UPPER_DESC") or "").strip()
    lower_uom = (attrs.get("LOWER_UOM") or "").strip()
    if not lower_desc and not upper_desc:
        return ""

    lower_text = "SFC" if lower_desc in {"", "0"} else sectional_altitude_token(lower_desc)
    if lower_uom == "SFC" and lower_desc in {"", "0"}:
        lower_text = "SFC"
    if upper_desc == "-9998" or not upper_desc:
        return lower_text if lower_text == "SFC" else f"{lower_text}+"
    return f"{lower_text}-{sectional_altitude_token(upper_desc)}"


def altitude_desc_to_feet(value: str) -> int | None:
    text = (value or "").strip().upper().replace(",", "")
    if not text or not text.lstrip("-").isdigit():
        return None
    return int(text)


def airspace_altitude_bounds(attrs: dict[str, str]) -> dict[str, object] | None:
    type_code = (attrs.get("TYPE_CODE") or "").strip().upper()
    lower_desc = (attrs.get("LOWER_DESC") or "").strip()
    upper_desc = (attrs.get("UPPER_DESC") or "").strip()
    lower_uom = (attrs.get("LOWER_UOM") or "").strip().upper()

    if lower_desc in {"", "0"}:
        floor_ft = 0
    else:
        floor_ft = altitude_desc_to_feet(lower_desc)
    if floor_ft is None:
        return None

    ceiling_ft = None if upper_desc in {"", "-9998"} else altitude_desc_to_feet(upper_desc)
    proxy_ceiling_ft = ceiling_ft if ceiling_ft is not None else max(OPEN_ENDED_PROXY_CEILING_FT, floor_ft + 3000)
    if proxy_ceiling_ft <= floor_ft:
        proxy_ceiling_ft = floor_ft + MIN_PROXY_AIRSPACE_THICKNESS_FT

    return {
        "floorFt": int(floor_ft),
        "ceilingFt": int(ceiling_ft) if ceiling_ft is not None else None,
        "proxyCeilingFt": int(proxy_ceiling_ft),
        "openEndedCeiling": ceiling_ft is None,
    }


def aggregate_airspace_altitude_bounds(
    entries: list[tuple[dict[str, object], dict[str, object] | None]],
) -> dict[str, object] | None:
    bounds = [
        airspace_altitude_bounds(record["attrs"])
        for record, _airport in entries
    ]
    bounds = [entry for entry in bounds if entry is not None]
    if not bounds:
        return None

    floor_ft = min(int(entry["floorFt"]) for entry in bounds)
    exact_ceilings = [int(entry["ceilingFt"]) for entry in bounds if entry["ceilingFt"] is not None]
    proxy_ceiling_ft = max(int(entry["proxyCeilingFt"]) for entry in bounds)
    if proxy_ceiling_ft <= floor_ft:
        proxy_ceiling_ft = floor_ft + MIN_PROXY_AIRSPACE_THICKNESS_FT

    return {
        "floorFt": floor_ft,
        "ceilingFt": max(exact_ceilings) if exact_ceilings else None,
        "proxyCeilingFt": proxy_ceiling_ft,
        "openEndedCeiling": any(bool(entry["openEndedCeiling"]) for entry in bounds),
    }


def derive_airfield_altitude_bounds(
    grouped_map: dict[tuple[str | None, str], list[tuple[dict[str, object], dict[str, object] | None]]],
    airport_id: str | None,
    type_code: str,
    entries: list[tuple[dict[str, object], dict[str, object] | None]],
) -> dict[str, object] | None:
    direct_bounds = aggregate_airspace_altitude_bounds(entries)
    if direct_bounds is None:
        return None

    if airport_id is None:
        return direct_bounds

    if type_code == "CLASS_D":
        return {
            **direct_bounds,
            "altitudeSource": "class-d-record",
        }

    if type_code in SURFACE_CLASS_E_TYPES:
        explicit_surface_ceiling = direct_bounds.get("ceilingFt")
        if explicit_surface_ceiling is not None:
            return {
                "floorFt": 0,
                "ceilingFt": int(explicit_surface_ceiling),
                "proxyCeilingFt": int(explicit_surface_ceiling),
                "openEndedCeiling": False,
                "altitudeSource": "surface-e-explicit-upper",
            }

        sibling_transition_floor = find_min_sibling_positive_floor(grouped_map, airport_id, exclude_type=type_code)
        if sibling_transition_floor is not None and sibling_transition_floor > 0:
            return {
                "floorFt": 0,
                "ceilingFt": int(sibling_transition_floor),
                "proxyCeilingFt": int(sibling_transition_floor),
                "openEndedCeiling": False,
                "altitudeSource": "surface-e-next-floor",
            }

        sibling_class_d_ceiling = find_sibling_class_d_ceiling(grouped_map, airport_id)
        if sibling_class_d_ceiling is not None and sibling_class_d_ceiling > 0:
            return {
                "floorFt": 0,
                "ceilingFt": int(sibling_class_d_ceiling),
                "proxyCeilingFt": int(sibling_class_d_ceiling),
                "openEndedCeiling": False,
                "altitudeSource": "surface-e-class-d-ceiling",
            }

        return {
            **direct_bounds,
            "altitudeSource": "surface-e-open-ended-proxy",
        }

    if type_code in POSITIVE_FLOOR_CLASS_E_TYPES:
        return {
            **direct_bounds,
            "altitudeSource": "transition-e-floor",
        }

    return direct_bounds


def find_min_sibling_positive_floor(
    grouped_map: dict[tuple[str | None, str], list[tuple[dict[str, object], dict[str, object] | None]]],
    airport_id: str,
    *,
    exclude_type: str | None = None,
) -> int | None:
    candidate_floors: list[int] = []
    for sibling_type in CLASS_E_TYPES:
        if sibling_type == exclude_type:
            continue
        sibling_entries = grouped_map.get((airport_id, sibling_type), [])
        for record, _airport in sibling_entries:
            bounds = airspace_altitude_bounds(record["attrs"])
            if not bounds:
                continue
            floor_ft = int(bounds["floorFt"])
            if floor_ft > 0:
                candidate_floors.append(floor_ft)
    return min(candidate_floors) if candidate_floors else None


def find_sibling_class_d_ceiling(
    grouped_map: dict[tuple[str | None, str], list[tuple[dict[str, object], dict[str, object] | None]]],
    airport_id: str,
) -> int | None:
    sibling_entries = grouped_map.get((airport_id, "CLASS_D"), [])
    ceilings: list[int] = []
    for record, _airport in sibling_entries:
        bounds = airspace_altitude_bounds(record["attrs"])
        if not bounds:
            continue
        ceiling_ft = bounds.get("ceilingFt")
        if ceiling_ft is not None:
            ceilings.append(int(ceiling_ft))
    return max(ceilings) if ceilings else None


def sectional_altitude_token(value: str) -> str:
    text = (value or "").strip().upper().replace(",", "")
    if not text:
        return ""
    if not text.lstrip("-").isdigit():
        return text

    altitude_ft = int(text)
    if altitude_ft <= 0:
        return text
    if altitude_ft % 100 == 0:
        return str(altitude_ft // 100)
    if altitude_ft % 50 == 0:
        return f"{altitude_ft / 100:.1f}".rstrip("0").rstrip(".")
    return text


def polygon_centroid_lonlat(parts: list[list[tuple[float, float]]]) -> tuple[float, float]:
    coords = [point for part in parts for point in part]
    lon = sum(point[0] for point in coords) / len(coords)
    lat = sum(point[1] for point in coords) / len(coords)
    return lon, lat


def point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            x_cross = (x2 - x1) * (lat - y1) / ((y2 - y1) + 1e-12) + x1
            if lon < x_cross:
                inside = not inside
    return inside


def point_in_parts(lon: float, lat: float, parts: list[list[tuple[float, float]]]) -> bool:
    return any(point_in_ring(lon, lat, part) for part in parts if len(part) >= 3)


def related_airport_for_airspace(
    record: dict[str, object],
    airports: list[dict[str, object]],
) -> dict[str, object] | None:
    attrs = record["attrs"]
    type_code = attrs.get("TYPE_CODE", "")
    if type_code in {"CLASS_E3", "CLASS_E5"}:
        # These broader Class E footprints should only bind to an airport when
        # the airport is actually inside the polygon. The later point-in-parts
        # pass handles that. Using nearest-centroid matching here over-groups
        # many unrelated regional E areas under one airport, such as LUK.
        return None

    flag_map = {
        "CLASS_B": "CLASS_B_AIRSPACE",
        "CLASS_C": "CLASS_C_AIRSPACE",
        "CLASS_D": "CLASS_D_AIRSPACE",
        "CLASS_E2": "CLASS_E_AIRSPACE",
        "CLASS_E3": "CLASS_E_AIRSPACE",
        "CLASS_E4": "CLASS_E_AIRSPACE",
        "CLASS_E5": "CLASS_E_AIRSPACE",
    }
    wanted_flag = flag_map.get(type_code)
    if not wanted_flag:
        return None

    ident_text = airspace_record_text(attrs)
    centroid_lon, centroid_lat = polygon_centroid_lonlat(record["parts"])
    candidates = []
    for airport in airports:
        class_info = airport.get("class_info", {})
        has_class_flag = class_info.get(wanted_flag) == "Y"
        score = airspace_airport_match_score(ident_text, airport)
        if not has_class_flag and not (type_code.startswith("CLASS_E") and score > 0):
            continue
        distance = base.haversine_nm(
            centroid_lat,
            centroid_lon,
            float(airport["lat"]),
            float(airport["lon"]),
        )
        candidates.append((score + (2.0 if has_class_flag else 0.0), -distance, airport))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return candidates[0][2]


def airspace_record_text(attrs: dict[str, object]) -> str:
    return " ".join(
        str(value or "").upper()
        for value in (
            attrs.get("IDENT"),
            attrs.get("NAME"),
            attrs.get("COMM_NAME"),
            attrs.get("LEVEL"),
            attrs.get("WKHR_RMK"),
        )
        if value
    )


def airspace_airport_match_score(ident_text: str, airport: dict[str, object]) -> float:
    score = 0.0
    airport_id = str(airport.get("ARPT_ID") or "").upper().strip()
    if airport_id and airport_id in ident_text:
        score += 16.0

    city = str(airport.get("CITY") or "").upper().strip()
    if city and city in ident_text:
        score += 6.0

    airport_name = str(airport.get("ARPT_NAME") or "").upper().strip()
    name_tokens = significant_airspace_name_tokens(airport_name)
    matched_tokens = sum(1 for token in name_tokens if token in ident_text)
    score += min(12.0, matched_tokens * 3.0)

    if "SHUTTLE" in ident_text and {"LAUNCH", "LANDING"} & set(name_tokens):
        score += 10.0
    if "PATRICK" in ident_text and "PATRICK" in name_tokens:
        score += 12.0
    if "CAPE CANAVERAL" in ident_text and {"CAPE", "CANAVERAL"} <= set(name_tokens):
        score += 12.0

    return score


def significant_airspace_name_tokens(name: str) -> list[str]:
    stop_words = {
        "AIR",
        "AIRPORT",
        "BASE",
        "BEACH",
        "COUNTY",
        "FIELD",
        "FLD",
        "FORCE",
        "INTL",
        "LANDING",
        "MUNI",
        "RGNL",
        "REGIONAL",
        "SPACE",
        "STATION",
        "STRIP",
        "THE",
    }
    raw = name.replace("/", " ").replace("-", " ").replace(",", " ").split()
    return [token for token in raw if len(token) >= 4 and token not in stop_words]


def compact_special_activity_label(record: dict[str, object]) -> str:
    designator = (record.get("designator") or "").strip()
    name = (record.get("name") or "").strip()
    if not name:
        return designator

    if "," in name:
        name = name.rsplit(",", 1)[0].strip()

    if " MOA" in name:
        return name

    if name.startswith("R-"):
        parts = name.split()
        head = parts[0]
        tail = " ".join(parts[1:3])
        return f"{head}\n{tail}" if tail else head

    if designator and designator not in name:
        return f"{designator}\n{name}"
    return name


def special_activity_label_lines(record: dict[str, object]) -> list[str]:
    text = compact_special_activity_label(record)
    if not text:
        return []

    if "\n" in text:
        return [line for line in text.splitlines() if line]

    if text.endswith(" MOA"):
        stem = text[:-4].strip()
        return [stem, "MOA"]

    if text.startswith("R-"):
        parts = text.split()
        if len(parts) >= 3:
            return [parts[0], " ".join(parts[1:3])]

    return [text]


def special_activity_priority(record: dict[str, object]) -> float:
    name = (record.get("name") or "").upper()
    designator = (record.get("designator") or "").upper()
    if " MOA" in name:
        return 0.8
    if name.startswith("R-") or designator.startswith("R"):
        return 0.76
    return 0.66


def summarize_group_altitudes(entries: list[tuple[dict[str, object], dict[str, object] | None]]) -> str:
    altitudes: list[str] = []
    for record, _airport in entries:
        text = format_altitude(record["attrs"])
        if text and text not in altitudes:
            altitudes.append(text)
    if not altitudes:
        return ""
    if len(altitudes) <= 3:
        return " / ".join(altitudes)
    return " / ".join(altitudes[:3]) + " ..."


def place_hybrid_airspace_label(
    placer: AirspaceLabelPlacer,
    *,
    parts: list[list[tuple[float, float]]],
    anchor_x: float,
    anchor_y: float,
    leader_x: float,
    leader_y: float,
    text_lines: list[str],
    style: str,
    priority: float,
    color: str,
    fontsize: float,
    interior_candidates: list[tuple[float, float, str, str]],
    callout_candidate_set: list[tuple[float, float, str, str]] | None = None,
    zorder: int = 8,
    interior_max_score: float = 420.0,
    callout_max_score: float = 560.0,
    min_inside_ratio: float = 0.74,
    callout_outside_clearance: float = 8.0,
) -> dict[str, object] | None:
    text = "\n".join(text_lines)
    interior = placer.place_text(
        anchor_x,
        anchor_y,
        text,
        fontsize=fontsize,
        color=color,
        candidates=interior_candidates,
        zorder=zorder,
        allow_skip=True,
        max_score=interior_max_score,
        validator=interior_label_validator(placer.ax, parts, min_inside_ratio=min_inside_ratio),
        score_adjuster=interior_score_adjuster(placer.ax, parts),
    )
    if interior is not None:
        return {
            "x": interior["x"],
            "y": interior["y"],
            "lines": text_lines,
            "style": style,
            "priority": priority,
            "color": color,
            "fontsize": fontsize,
            "ha": interior["ha"],
            "va": interior["va"],
        }

    callout = placer.place_text(
        anchor_x,
        anchor_y,
        text,
        fontsize=fontsize,
        color=color,
        candidates=callout_candidate_set or callout_candidates(),
        zorder=zorder,
        allow_skip=True,
        max_score=callout_max_score,
        validator=callout_label_validator(placer.ax, parts, min_outside_clearance=callout_outside_clearance),
    )
    if callout is not None:
        return {
            "x": callout["x"],
            "y": callout["y"],
            "lines": text_lines,
            "style": style,
            "priority": priority,
            "color": color,
            "fontsize": fontsize,
            "ha": callout["ha"],
            "va": callout["va"],
            "anchorX": leader_x,
            "anchorY": leader_y,
            "connector": True,
            "elevation": 0.05,
            "placementMode": "callout",
        }

    return None


def compute_airspace_label_layout(features: dict[str, object]) -> list[dict[str, object]]:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    try:
        ax.patch.set_alpha(0)
        setup_axes(ax, features, None)
        draw_airspaces(ax, features)
        ax.figure.canvas.draw()
        placer = AirspaceLabelPlacer(ax)
        layout: list[dict[str, object]] = []
        primary_families: set[str] = set()
        chart_center_x = features["background"].shape[1] / 2.0
        chart_center_y = features["background"].shape[0] / 2.0
        chart_half_diagonal = max(((chart_center_x ** 2 + chart_center_y ** 2) ** 0.5), 1.0)
        grouped_items = build_airspace_grouped_entries(features)
        for (airport_id, type_code), entries in grouped_items:
            if type_code not in CONTROLLED_AIRSPACE_TYPES:
                continue
            if airport_id is None:
                continue
            airport = entries[0][1]
            airport_x, airport_y = lonlat_to_chart_xy(features, airport["lon"], airport["lat"])
            if not inside_chart(features, airport_x, airport_y, margin=8):
                continue
            visible_parts = airport_local_visible_parts(features, entries, airport_x, airport_y)
            shape_anchor = shape_aware_anchor(
                visible_parts,
                preferred=(airport_x, airport_y) if point_in_projected_parts(airport_x, airport_y, visible_parts) else None,
            )
            min_x, min_y, max_x, max_y = part_bounds(visible_parts)
            class_info = airport.get("class_info", {})
            hours = clean_hours_text(class_info.get("AIRSPACE_HRS", ""))
            airspace_name = airspace_name_for_type(type_code)
            identifier = airport.get("faa_identifier") or airport_id
            runway_designator = airfield_runway_designator(airport)
            label_lines = [compact_airport_name(airport["ARPT_NAME"])]
            detail_parts = [f"FAA {identifier}"]
            if runway_designator:
                detail_parts.append(f"RWY {runway_designator}")
            label_lines.append("  ".join(detail_parts))
            label_lines.append(airspace_name)
            if hours:
                label_lines.append(hours)
            priority = airfield_priority(airport, type_code, hours)
            if type_code in {"CLASS_E3", "CLASS_E5"}:
                center_ratio = (((airport_x - chart_center_x) ** 2 + (airport_y - chart_center_y) ** 2) ** 0.5) / chart_half_diagonal
                priority += max(0.0, 0.07 * (1.0 - center_ratio))
            color = "#7c2d12" if type_code in {"CLASS_B", "CLASS_C"} else "#6b21a8"
            fontsize = 4.6 if type_code in {"CLASS_B", "CLASS_C", "CLASS_D", "CLASS_E2"} else 4.2
            style = "airspace-primary"
            placement = place_hybrid_airspace_label(
                placer,
                parts=visible_parts,
                anchor_x=shape_anchor[0],
                anchor_y=shape_anchor[1],
                leader_x=airport_x if point_in_projected_parts(airport_x, airport_y, visible_parts) else shape_anchor[0],
                leader_y=airport_y if point_in_projected_parts(airport_x, airport_y, visible_parts) else shape_anchor[1],
                text_lines=label_lines,
                style=style,
                priority=priority,
                color=color,
                fontsize=fontsize,
                interior_candidates=radial_candidates(
                    [0, 14, 24, 36, 50],
                    [(1, -1), (1, 1), (-1, -1), (-1, 1), (1, 0), (-1, 0), (0, -1), (0, 1)],
                    include_center=True,
                ),
                zorder=8,
                interior_max_score=740.0 if type_code in {"CLASS_B", "CLASS_C", "CLASS_D"} else 660.0,
                callout_max_score=620.0 if type_code in {"CLASS_B", "CLASS_C", "CLASS_D"} else 560.0,
                min_inside_ratio=0.76 if (max_x - min_x) >= 240.0 and (max_y - min_y) >= 118.0 else 0.84,
            )
            if placement is None:
                placement = {
                    "x": shape_anchor[0],
                    "y": shape_anchor[1],
                    "lines": label_lines,
                    "style": style,
                    "priority": priority,
                    "color": color,
                    "fontsize": fontsize,
                    "ha": "center",
                    "va": "center",
                }
            if placement is not None:
                placement["id"] = f"{airport_id}-{type_code}"
                placement["selectionId"] = placement["id"]
                placement["familyKey"] = placement["id"]
                placement["labelGroup"] = "airfield"
                placement["detailTier"] = "core"
                placement["airspaceType"] = type_code
                placement.setdefault("placementMode", "interior")
                layout.append(placement)
                primary_families.add(placement["familyKey"])

        shelf_records = sorted(
            (
                record
                for record in features["class_airspaces"]
                if projected_visible_parts(features, record)
                and record["attrs"].get("TYPE_CODE", "") in {"CLASS_B", "CLASS_C"}
            ),
            key=lambda record: (
                AIRSPACE_TYPE_PRIORITY.get(record["attrs"].get("TYPE_CODE", ""), 9),
                -abs(len("".join(record["attrs"].get("LEVEL", "")))),
            ),
        )
        for record_index, record in enumerate(shelf_records):
            attrs = record["attrs"]
            type_code = attrs.get("TYPE_CODE", "")
            airport = related_airport_for_airspace(record, features["airports"]) if type_code in {"CLASS_B", "CLASS_C", "CLASS_D"} else None
            family_key = airspace_family_key(airport, type_code)
            if family_key not in primary_families:
                continue
            if type_code == "CLASS_D" and airport is not None:
                # Class D areas are represented by the airport-level callout.
                # Extra small D/SFC labels imply separate shelves where the
                # FAA data only describes one airport-owned surface area.
                continue
            text_lines = shelf_label_lines(attrs, airport)
            if not text_lines:
                continue
            visible_parts = projected_visible_parts(features, record)
            x, y = shape_aware_anchor(visible_parts)
            if not inside_chart(features, x, y, margin=4):
                continue
            min_x, min_y, max_x, max_y = part_bounds(visible_parts)
            priority = 0.74 if type_code == "CLASS_B" else 0.7 if type_code == "CLASS_C" else 0.55 if type_code == "CLASS_D" else 0.5
            color = "#1d4ed8" if type_code in {"CLASS_B", "CLASS_C", "CLASS_D"} else "#8b1e6d"
            fontsize = 4.6 if type_code in {"CLASS_B", "CLASS_C"} else 5.0 if type_code in {"CLASS_D", "CLASS_E2"} else 4.3
            style = "airspace-secondary"
            placement = place_hybrid_airspace_label(
                placer,
                parts=visible_parts,
                anchor_x=x,
                anchor_y=y,
                leader_x=x,
                leader_y=y,
                text_lines=text_lines,
                style=style,
                priority=priority,
                color=color,
                fontsize=fontsize,
                interior_candidates=radial_candidates(
                    [0, 12, 20, 30, 42],
                    [(0, 0), (0, -1), (0, 1), (1, 0), (-1, 0), (1, -1), (-1, -1), (1, 1), (-1, 1)],
                    include_center=False,
                ),
                zorder=8,
                interior_max_score=360.0 if type_code in {"CLASS_B", "CLASS_C"} else 290.0,
                callout_max_score=430.0 if type_code in {"CLASS_B", "CLASS_C"} else 340.0,
                min_inside_ratio=0.8 if (max_x - min_x) >= 150.0 and (max_y - min_y) >= 58.0 else 0.88,
            )
            if placement is not None:
                placement["id"] = f"shelf-{type_code}-{record_index}"
                placement["selectionId"] = placement["id"]
                placement["familyKey"] = family_key
                placement["labelGroup"] = "shelf"
                placement["detailTier"] = "detail"
                placement["airspaceType"] = type_code
                placement.setdefault("placementMode", "interior")
                layout.append(placement)

        special_records = sorted(
            (record for record in features["special_activity"] if projected_visible_parts(features, record, cache_key="_projected_visible_parts_special")),
            key=lambda record: (
                0 if "R-" in (record.get("name") or "") else 1,
                0 if " MOA" in (record.get("name") or "") else 1,
                record.get("name") or "",
            ),
        )
        for record_index, record in enumerate(special_records):
            text_lines = special_activity_label_lines(record)
            if not text_lines:
                continue
            visible_parts = projected_visible_parts(features, record, cache_key="_projected_visible_parts_special")
            x, y = shape_aware_anchor(visible_parts)
            if not inside_chart(features, x, y, margin=6):
                continue
            min_x, min_y, max_x, max_y = part_bounds(visible_parts)
            placement = place_hybrid_airspace_label(
                placer,
                parts=visible_parts,
                anchor_x=x,
                anchor_y=y,
                leader_x=x,
                leader_y=y,
                text_lines=text_lines,
                style="airspace-secondary",
                priority=special_activity_priority(record),
                color="#6b21a8",
                fontsize=4.8,
                interior_candidates=radial_candidates(
                    [0, 14, 24, 36, 50],
                    [(0, 0), (0, -1), (0, 1), (1, 0), (-1, 0), (1, -1), (-1, -1), (1, 1), (-1, 1)],
                    include_center=False,
                ),
                callout_candidate_set=scaled_callout_candidates(
                    visible_parts,
                    min_radius=92.0,
                    max_radius=360.0,
                    fractions=(0.18, 0.28, 0.42, 0.58, 0.78),
                ),
                zorder=9,
                interior_max_score=330.0,
                callout_max_score=520.0,
                min_inside_ratio=0.8 if (max_x - min_x) >= 150.0 and (max_y - min_y) >= 60.0 else 0.9,
                callout_outside_clearance=3.0,
            )
            if placement is None and text_lines and text_lines[-1] == "MOA":
                placement = place_hybrid_airspace_label(
                    placer,
                    parts=visible_parts,
                    anchor_x=x,
                    anchor_y=y,
                    leader_x=x,
                    leader_y=y,
                    text_lines=text_lines,
                    style="airspace-secondary",
                    priority=special_activity_priority(record),
                    color="#6b21a8",
                    fontsize=4.6,
                    interior_candidates=[],
                    callout_candidate_set=scaled_callout_candidates(
                        visible_parts,
                        min_radius=140.0,
                        max_radius=520.0,
                        fractions=(0.32, 0.48, 0.68, 0.92, 1.18),
                    ),
                    zorder=9,
                    interior_max_score=0.0,
                    callout_max_score=760.0,
                    min_inside_ratio=1.0,
                    callout_outside_clearance=1.0,
                )
            if placement is not None:
                placement["id"] = f"special-{record_index}"
                placement["selectionId"] = placement["id"]
                placement["familyKey"] = placement["id"]
                placement["labelGroup"] = "special"
                placement["detailTier"] = "core"
                placement["airspaceType"] = "SPECIAL"
                placement.setdefault("placementMode", "interior")
                layout.append(placement)
        layout.sort(key=lambda item: float(item["priority"]), reverse=True)
        return layout
    finally:
        plt.close(fig)


def draw_airspace_annotations(ax, features: dict[str, object]) -> None:
    for item in compute_airspace_label_layout(features):
        ax.text(
            item["x"],
            item["y"],
            "\n".join(item["lines"]),
            fontsize=item["fontsize"],
            color=item["color"],
            ha=item["ha"],
            va=item["va"],
            zorder=8,
            clip_on=True,
            path_effects=[pe.withStroke(linewidth=1.5, foreground="white", alpha=0.92)],
        )


def render_chart_reference(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    fig.savefig(OUTPUT_DIR / "01_stlouis_chart_frame.png", pad_inches=0)
    plt.close(fig)


def render_transparent_layer(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    setup_axes(ax, features, None)
    draw_airspaces(ax, features)
    draw_airspace_annotations(ax, features)
    fig.savefig(
        OUTPUT_DIR / "02_stlouis_airspaces_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_overlay(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    draw_airspaces(ax, features)
    draw_airspace_annotations(ax, features)
    fig.savefig(OUTPUT_DIR / "03_stlouis_airspaces_overlay.png", pad_inches=0)
    plt.close(fig)


def write_summary(features: dict[str, object]) -> None:
    class_counts = Counter(record["attrs"].get("TYPE_CODE", "UNKNOWN") for record in features["class_airspaces"])
    transform = features["chart_transform"]
    lines = [
        "Chart: St. Louis Sectional",
        f"Sectional extent assumption: {features['region']}",
        f"Airport control points used: {len(transform['control_points'])}",
        f"Median alignment residual (px): {transform['median_residual_px']:.2f}",
        f"Mean alignment residual (px): {transform['mean_residual_px']:.2f}",
        f"Max alignment residual (px): {transform['max_residual_px']:.2f}",
        f"Public airports rendered: {len(features['airports'])}",
        f"Class airspace polygons/groups: {len(features['class_airspaces'])}",
        f"Special activity airspace groups: {len(features['special_activity'])}",
        f"Aerobatic area groups: {len(features['aerobatic'])}",
        "",
        "Class airspace counts by TYPE_CODE:",
    ]
    for type_code, count in sorted(class_counts.items()):
        lines.append(f"- {type_code}: {count}")
    (OUTPUT_DIR / "stlouis_airspaces_summary.txt").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    features = build_features()
    render_chart_reference(features)
    render_transparent_layer(features)
    render_overlay(features)
    write_summary(features)


if __name__ == "__main__":
    main()
