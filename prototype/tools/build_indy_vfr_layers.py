from __future__ import annotations

import csv
import io
import math
import struct
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path

import fitz
import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon
from scipy import ndimage


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DATA_ROOT = PROTOTYPE_ROOT / "reference-data"
OUTPUT_ROOT = PROTOTYPE_ROOT / "outputs"
NASR_DIR = REFERENCE_DATA_ROOT / "faa" / "28DaySubscription_Effective_2026-04-16"
ZIP_PATH = NASR_DIR / "CSV_Data" / "16_Apr_2026_CSV.zip"
CLASS_SHP = NASR_DIR / "Additional_Data" / "Shape_Files" / "Class_Airspace.shp"
CLASS_DBF = NASR_DIR / "Additional_Data" / "Shape_Files" / "Class_Airspace.dbf"
SAA_ZIP = NASR_DIR / "Additional_Data" / "AIXM" / "SAA-AIXM_5_Schema" / "SaaSubscriberFile.zip"
CHART_PDF = REFERENCE_DATA_ROOT / "stlouis" / "St_Louis.pdf"
OUTPUT_DIR = OUTPUT_ROOT / "indy" / "vfr"


SECTIONAL_EXTENTS = {
    "lon_left": -91.5,
    "lon_right": -84.5,
    "lat_bottom": 36.5,
    "lat_top": 40.5,
}
# Pixel-space bounding box of the main St. Louis sectional frame
# in the 1.5x rendered PDF page.
SECTIONAL_FRAME = {
    "left": 1142,
    "top": 0,
    "right": 6456,
    "bottom": 4038,
}

RADIUS_NM = 55.0

NS = {
    "aixm": "http://www.aixm.aero/schema/5.0",
    "gml": "http://www.opengis.net/gml/3.2",
}


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_nm = 3440.065
    lat1r = math.radians(lat1)
    lon1r = math.radians(lon1)
    lat2r = math.radians(lat2)
    lon2r = math.radians(lon2)
    dlat = lat2r - lat1r
    dlon = lon2r - lon1r
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1r) * math.cos(lat2r) * math.sin(dlon / 2) ** 2
    )
    return 2 * radius_nm * math.asin(min(1, math.sqrt(a)))


def bbox_from_radius(lat: float, lon: float, radius_nm: float) -> tuple[float, float, float, float]:
    lat_delta = radius_nm / 60.0
    lon_delta = radius_nm / (60.0 * math.cos(math.radians(lat)))
    return (lon - lon_delta, lon + lon_delta, lat - lat_delta, lat + lat_delta)


def bbox_intersects(
    left: float,
    right: float,
    bottom: float,
    top: float,
    region: tuple[float, float, float, float],
) -> bool:
    r_left, r_right, r_bottom, r_top = region
    return not (right < r_left or left > r_right or top < r_bottom or bottom > r_top)


def read_csv_from_zip(name: str) -> list[dict[str, str]]:
    with zipfile.ZipFile(ZIP_PATH) as archive:
        with archive.open(name) as handle:
            return list(csv.DictReader(line.decode("utf-8-sig") for line in handle))


def read_dbf_records(path: Path) -> list[dict[str, str]]:
    with path.open("rb") as handle:
        header = handle.read(32)
        num_records = struct.unpack("<I", header[4:8])[0]
        record_len = struct.unpack("<H", header[10:12])[0]
        fields: list[tuple[str, int]] = []
        while True:
            desc = handle.read(32)
            if not desc or desc[0] == 0x0D:
                break
            name = desc[:11].split(b"\x00", 1)[0].decode("ascii", errors="ignore").strip()
            fields.append((name, desc[16]))

        rows: list[dict[str, str]] = []
        for _ in range(num_records):
            record = handle.read(record_len)
            if not record or record[0:1] == b"*":
                continue
            pos = 1
            row: dict[str, str] = {}
            for name, length in fields:
                row[name] = record[pos : pos + length].decode("latin1", errors="ignore").strip()
                pos += length
            rows.append(row)
        return rows


def read_polygon_shapefile(path: Path) -> list[dict[str, object]]:
    shapes: list[dict[str, object]] = []
    with path.open("rb") as handle:
        _ = handle.read(100)
        while True:
            record_header = handle.read(8)
            if len(record_header) < 8:
                break
            _record_number, content_length_words = struct.unpack(">2i", record_header)
            content = handle.read(content_length_words * 2)
            if len(content) < 4:
                continue
            shape_type = struct.unpack("<i", content[:4])[0]
            if shape_type not in {5, 15, 25}:
                shapes.append({"bbox": None, "parts": []})
                continue
            xmin, ymin, xmax, ymax, num_parts, num_points = struct.unpack(
                "<4d2i", content[4:44]
            )
            parts_idx = list(struct.unpack(f"<{num_parts}i", content[44 : 44 + 4 * num_parts]))
            points_offset = 44 + 4 * num_parts
            points = []
            for idx in range(num_points):
                start = points_offset + idx * 16
                x, y = struct.unpack("<2d", content[start : start + 16])
                points.append((x, y))
            parts = []
            for idx, start_idx in enumerate(parts_idx):
                end_idx = parts_idx[idx + 1] if idx + 1 < len(parts_idx) else num_points
                parts.append(points[start_idx:end_idx])
            shapes.append({"bbox": (xmin, xmax, ymin, ymax), "parts": parts})
    return shapes


def load_center_airport() -> dict[str, str]:
    for row in read_csv_from_zip("APT_BASE.csv"):
        if row["ARPT_ID"] == "IND" and row["SITE_TYPE_CODE"] == "A":
            return row
    raise RuntimeError("KIND / IND not found in APT_BASE.csv")


def region_to_pdf_pixels(region: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    lon_left = SECTIONAL_EXTENTS["lon_left"]
    lon_right = SECTIONAL_EXTENTS["lon_right"]
    lat_bottom = SECTIONAL_EXTENTS["lat_bottom"]
    lat_top = SECTIONAL_EXTENTS["lat_top"]
    frame = SECTIONAL_FRAME
    left, right, bottom, top = region
    top = min(top, lat_top)
    bottom = max(bottom, lat_bottom)
    left = max(left, lon_left)
    right = min(right, lon_right)

    x0 = int(frame["left"] + (left - lon_left) / (lon_right - lon_left) * (frame["right"] - frame["left"]))
    x1 = int(frame["left"] + (right - lon_left) / (lon_right - lon_left) * (frame["right"] - frame["left"]))
    y0 = int(frame["top"] + (lat_top - top) / (lat_top - lat_bottom) * (frame["bottom"] - frame["top"]))
    y1 = int(frame["top"] + (lat_top - bottom) / (lat_top - lat_bottom) * (frame["bottom"] - frame["top"]))
    return x0, y0, x1, y1


def load_chart_background(region: tuple[float, float, float, float]) -> np.ndarray:
    render_path = OUTPUT_DIR / "_st_louis_full.png"
    if not render_path.exists():
        pdf = fitz.open(CHART_PDF)
        page = pdf[0]
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        pix.save(render_path)
    with plt.rc_context():
        image = plt.imread(render_path)
    x0, y0, x1, y1 = region_to_pdf_pixels(region)
    return image[y0:y1, x0:x1]


def approx_region_xy(
    region: tuple[float, float, float, float],
    width: int,
    height: int,
    lon: float,
    lat: float,
) -> tuple[float, float]:
    left, right, bottom, top = region
    x = (lon - left) / (right - left) * (width - 1)
    y = (top - lat) / (top - bottom) * (height - 1)
    return x, y


def detect_chart_components(image: np.ndarray) -> list[dict[str, float]]:
    rgb = np.clip(image[..., :3], 0, 1).astype(np.float32)
    r = rgb[..., 0]
    g = rgb[..., 1]
    b = rgb[..., 2]
    mx = np.maximum.reduce([r, g, b])
    mn = np.minimum.reduce([r, g, b])
    delta = mx - mn

    hue = np.zeros_like(mx)
    mask = delta > 1e-6
    idx = mask & (mx == r)
    hue[idx] = ((g[idx] - b[idx]) / delta[idx]) % 6
    idx = mask & (mx == g)
    hue[idx] = ((b[idx] - r[idx]) / delta[idx]) + 2
    idx = mask & (mx == b)
    hue[idx] = ((r[idx] - g[idx]) / delta[idx]) + 4
    hue /= 6.0
    saturation = np.where(mx <= 1e-6, 0.0, delta / mx)
    value = mx

    blue_mask = (hue > 0.48) & (hue < 0.64) & (saturation > 0.22) & (value > 0.25)
    magenta_mask = ((hue > 0.82) | (hue < 0.03)) & (saturation > 0.18) & (value > 0.25)
    combined = blue_mask | magenta_mask

    labels, _ = ndimage.label(combined)
    slices = ndimage.find_objects(labels)
    components: list[dict[str, float]] = []
    for index, slc in enumerate(slices, start=1):
        if slc is None:
            continue
        ys, xs = np.where(labels[slc] == index)
        area = len(xs)
        if area < 6 or area > 2000:
            continue
        x0, x1 = slc[1].start, slc[1].stop
        y0, y1 = slc[0].start, slc[0].stop
        width = x1 - x0
        height = y1 - y0
        if width > 120 or height > 120:
            continue
        cx = x0 + xs.mean()
        cy = y0 + ys.mean()
        comp_mask = labels[slc] == index
        components.append(
            {
                "cx": float(cx),
                "cy": float(cy),
                "area": float(area),
                "blue_frac": float(blue_mask[slc][comp_mask].mean()),
                "magenta_frac": float(magenta_mask[slc][comp_mask].mean()),
            }
        )
    return components


def calibrate_chart_transform(
    image: np.ndarray,
    region: tuple[float, float, float, float],
    airports: list[dict[str, object]],
) -> dict[str, object]:
    height, width = image.shape[:2]
    components = detect_chart_components(image)
    matches: list[dict[str, float | str]] = []

    for row in airports:
        arpt_id = row["ARPT_ID"]
        if len(arpt_id) > 4:
            continue
        px, py = approx_region_xy(region, width, height, row["lon"], row["lat"])
        expect_blue = row["TWR_TYPE_CODE"] != "NON-ATCT"
        best = None
        for comp in components:
            dx = comp["cx"] - px
            dy = comp["cy"] - py
            dist = math.hypot(dx, dy)
            if dist > 35:
                continue
            if expect_blue and comp["blue_frac"] < 0.15:
                continue
            if (not expect_blue) and comp["magenta_frac"] < 0.12:
                continue
            score = dist + max(0.0, 10.0 - comp["area"]) * 0.3
            if best is None or score < best["score"]:
                best = {
                    "score": score,
                    "cx": comp["cx"],
                    "cy": comp["cy"],
                }
        if best is None:
            continue
        matches.append(
            {
                "id": arpt_id,
                "lon": float(row["lon"]),
                "lat": float(row["lat"]),
                "x": float(best["cx"]),
                "y": float(best["cy"]),
                "seed_error": float(math.hypot(best["cx"] - px, best["cy"] - py)),
            }
        )

    reliable = [match for match in matches if match["seed_error"] <= 22.0]
    if len(reliable) < 8:
        raise RuntimeError("Not enough airport control points to calibrate the chart transform")

    matrix = np.array([[match["lon"], match["lat"], 1.0] for match in reliable], dtype=float)
    target_x = np.array([match["x"] for match in reliable], dtype=float)
    target_y = np.array([match["y"] for match in reliable], dtype=float)
    coef_x, *_ = np.linalg.lstsq(matrix, target_x, rcond=None)
    coef_y, *_ = np.linalg.lstsq(matrix, target_y, rcond=None)

    return {
        "coef_x": coef_x,
        "coef_y": coef_y,
        "control_points": reliable,
        "all_matches": matches,
    }


def lonlat_to_chart_xy(features: dict[str, object], lon: float, lat: float) -> tuple[float, float]:
    transform = features["chart_transform"]
    coef_x = transform["coef_x"]
    coef_y = transform["coef_y"]
    x = coef_x[0] * lon + coef_x[1] * lat + coef_x[2]
    y = coef_y[0] * lon + coef_y[1] * lat + coef_y[2]
    return float(x), float(y)


def inside_chart(features: dict[str, object], x: float, y: float, margin: float = 0.0) -> bool:
    height, width = features["background"].shape[:2]
    return -margin <= x <= width + margin and -margin <= y <= height + margin


def lighten_background(image: np.ndarray, factor: float = 0.68) -> np.ndarray:
    rgb = image[..., :3].astype(np.float32)
    light = rgb * (1 - factor) + 255.0 * factor
    if image.shape[-1] == 4:
        alpha = image[..., 3:]
        return np.concatenate([light, alpha], axis=-1).astype(np.uint8)
    return light.astype(np.uint8)


def parse_saa_polygons(region: tuple[float, float, float, float]) -> list[dict[str, object]]:
    polygons: list[dict[str, object]] = []
    with zipfile.ZipFile(SAA_ZIP) as outer:
        inner_bytes = outer.read("Saa_Sub_File.zip")
    with zipfile.ZipFile(io.BytesIO(inner_bytes)) as inner:
        for name in inner.namelist():
            if not name.lower().endswith(".xml"):
                continue
            root = ET.fromstring(inner.read(name))
            airspace = root.find(".//aixm:Airspace", NS)
            if airspace is None:
                continue
            designator = airspace.findtext(".//aixm:designator", default="", namespaces=NS)
            display_name = airspace.findtext(".//aixm:name", default=name.replace(".xml", ""), namespaces=NS)

            parts: list[list[tuple[float, float]]] = []
            for ring in airspace.findall(".//gml:LinearRing", NS):
                coords = []
                for pos in ring.findall(".//gml:pos", NS):
                    lon_str, lat_str = pos.text.split()
                    coords.append((float(lon_str), float(lat_str)))
                if len(coords) >= 3:
                    xs = [pt[0] for pt in coords]
                    ys = [pt[1] for pt in coords]
                    if bbox_intersects(min(xs), max(xs), min(ys), max(ys), region):
                        parts.append(coords)
            if parts:
                polygons.append({"name": display_name, "designator": designator, "parts": parts})
    return polygons


def build_features(radius_nm: float = RADIUS_NM) -> dict[str, object]:
    center = load_center_airport()
    center_lat = float(center["LAT_DECIMAL"])
    center_lon = float(center["LONG_DECIMAL"])
    region = bbox_from_radius(center_lat, center_lon, radius_nm)
    region = (
        max(region[0], SECTIONAL_EXTENTS["lon_left"]),
        min(region[1], SECTIONAL_EXTENTS["lon_right"]),
        max(region[2], SECTIONAL_EXTENTS["lat_bottom"]),
        min(region[3], SECTIONAL_EXTENTS["lat_top"]),
    )

    background = load_chart_background(region)
    light_bg = lighten_background(background)

    airports = []
    for row in read_csv_from_zip("APT_BASE.csv"):
        if row["SITE_TYPE_CODE"] != "A" or row["FACILITY_USE_CODE"] != "PU" or row["ARPT_STATUS"] != "O":
            continue
        lat = float(row["LAT_DECIMAL"])
        lon = float(row["LONG_DECIMAL"])
        if haversine_nm(center_lat, center_lon, lat, lon) <= radius_nm:
            row["lat"] = lat
            row["lon"] = lon
            airports.append(row)

    chart_transform = calibrate_chart_transform(background, region, airports)

    nav_lookup: dict[str, tuple[float, float]] = {}
    navaids = []
    for row in read_csv_from_zip("NAV_BASE.csv"):
        if not row["LAT_DECIMAL"] or not row["LONG_DECIMAL"]:
            continue
        lat = float(row["LAT_DECIMAL"])
        lon = float(row["LONG_DECIMAL"])
        nav_lookup[row["NAV_ID"]] = (lat, lon)
        if row["PUBLIC_USE_FLAG"] != "Y" or not row["NAV_STATUS"].startswith("OPERATIONAL"):
            continue
        if haversine_nm(center_lat, center_lon, lat, lon) <= radius_nm:
            row["lat"] = lat
            row["lon"] = lon
            navaids.append(row)

    charting = defaultdict(set)
    for row in read_csv_from_zip("FIX_CHRT.csv"):
        charting[row["FIX_ID"]].add(row["CHARTING_TYPE_DESC"])

    fix_lookup: dict[str, tuple[float, float]] = {}
    fix_rows: dict[str, dict[str, object]] = {}
    for row in read_csv_from_zip("FIX_BASE.csv"):
        lat = float(row["LAT_DECIMAL"])
        lon = float(row["LONG_DECIMAL"])
        row["lat"] = lat
        row["lon"] = lon
        row["charting_types"] = charting.get(row["FIX_ID"], set())
        fix_lookup[row["FIX_ID"]] = (lat, lon)
        fix_rows[row["FIX_ID"]] = row

    airway_segments = []
    airway_label_points: defaultdict[str, list[tuple[float, float]]] = defaultdict(list)
    airway_fix_ids = set()
    for row in read_csv_from_zip("AWY_SEG_ALT.csv"):
        airway_id = row["AWY_ID"]
        if not airway_id.startswith("V"):
            continue
        from_coord = fix_lookup.get(row["FROM_POINT"]) or nav_lookup.get(row["FROM_POINT"])
        to_coord = fix_lookup.get(row["TO_POINT"]) or nav_lookup.get(row["TO_POINT"])
        if not from_coord or not to_coord:
            continue
        seg_left = min(from_coord[1], to_coord[1])
        seg_right = max(from_coord[1], to_coord[1])
        seg_bottom = min(from_coord[0], to_coord[0])
        seg_top = max(from_coord[0], to_coord[0])
        if not bbox_intersects(seg_left, seg_right, seg_bottom, seg_top, region):
            continue
        airway_segments.append(
            {
                "airway_id": airway_id,
                "from_id": row["FROM_POINT"],
                "to_id": row["TO_POINT"],
                "from": from_coord,
                "to": to_coord,
            }
        )
        airway_label_points[airway_id].append(
            ((from_coord[1] + to_coord[1]) / 2.0, (from_coord[0] + to_coord[0]) / 2.0)
        )
        if row["FROM_POINT"] in fix_lookup:
            airway_fix_ids.add(row["FROM_POINT"])
        if row["TO_POINT"] in fix_lookup:
            airway_fix_ids.add(row["TO_POINT"])

    intersections = [
        fix_rows[fix_id]
        for fix_id in sorted(airway_fix_ids)
        if bbox_intersects(
            fix_rows[fix_id]["lon"],
            fix_rows[fix_id]["lon"],
            fix_rows[fix_id]["lat"],
            fix_rows[fix_id]["lat"],
            region,
        )
    ]

    class_attrs = read_dbf_records(CLASS_DBF)
    class_shapes = read_polygon_shapefile(CLASS_SHP)
    class_airspaces = []
    for attrs, shape in zip(class_attrs, class_shapes):
        bbox = shape["bbox"]
        if not bbox:
            continue
        xmin, xmax, ymin, ymax = bbox
        if bbox_intersects(xmin, xmax, ymin, ymax, region):
            class_airspaces.append({"attrs": attrs, "parts": shape["parts"]})

    maa_base = {row["MAA_ID"]: row for row in read_csv_from_zip("MAA_BASE.csv")}
    maa_shapes = defaultdict(list)
    for row in read_csv_from_zip("MAA_SHP.csv"):
        lat = dms_to_decimal(row["LATITUDE"])
        lon = dms_to_decimal(row["LONGITUDE"])
        maa_shapes[row["MAA_ID"]].append((int(row["POINT_SEQ"]), lon, lat))

    aerobatic = []
    for maa_id, points in maa_shapes.items():
        ordered = [(lon, lat) for _, lon, lat in sorted(points)]
        xs = [pt[0] for pt in ordered]
        ys = [pt[1] for pt in ordered]
        if bbox_intersects(min(xs), max(xs), min(ys), max(ys), region):
            aerobatic.append({"attrs": maa_base.get(maa_id, {}), "parts": [ordered]})

    special_activity = parse_saa_polygons(region)

    return {
        "center": center,
        "center_lat": center_lat,
        "center_lon": center_lon,
        "region": region,
        "radius_nm": radius_nm,
        "background": background,
        "light_bg": light_bg,
        "chart_transform": chart_transform,
        "airports": airports,
        "navaids": navaids,
        "intersections": intersections,
        "airway_segments": airway_segments,
        "airway_label_points": airway_label_points,
        "class_airspaces": class_airspaces,
        "aerobatic": aerobatic,
        "special_activity": special_activity,
    }


def dms_to_decimal(value: str) -> float:
    hemi = value[-1]
    deg, minute, second = value[:-1].split("-")
    decimal = float(deg) + float(minute) / 60.0 + float(second) / 3600.0
    return -decimal if hemi in {"S", "W"} else decimal


def setup_axes(ax, features: dict[str, object], title: str) -> None:
    height, width = features["background"].shape[:2]
    ax.set_title(title, fontsize=16, pad=8)
    ax.set_xlim(0, width)
    ax.set_ylim(height, 0)
    ax.set_aspect("equal", adjustable="box")
    ax.set_axis_off()


def add_background(ax, features: dict[str, object], faded: bool = False) -> None:
    image = features["light_bg"] if faded else features["background"]
    ax.imshow(image, origin="upper")


def label(ax, x: float, y: float, text: str, color: str, size: int = 7, ha: str = "left") -> None:
    ax.text(
        x,
        y,
        text,
        fontsize=size,
        color=color,
        ha=ha,
        va="center",
        clip_on=True,
        path_effects=[pe.withStroke(linewidth=2.0, foreground="white", alpha=0.9)],
    )


def draw_airspaces(ax, features: dict[str, object]) -> None:
    class_styles = {
        "CLASS_B": {"edge": "#1d4ed8", "fill": "#93c5fd", "alpha": 0.12, "lw": 1.6, "ls": "-"},
        "CLASS_C": {"edge": "#8b1e6d", "fill": "#f9a8d4", "alpha": 0.12, "lw": 1.5, "ls": "-"},
        "CLASS_D": {"edge": "#1d4ed8", "fill": "#bfdbfe", "alpha": 0.08, "lw": 1.3, "ls": (0, (6, 4))},
        "CLASS_E2": {"edge": "#8b1e6d", "fill": None, "alpha": 0.0, "lw": 1.0, "ls": (0, (5, 3))},
        "CLASS_E3": {"edge": "#8b1e6d", "fill": None, "alpha": 0.0, "lw": 0.9, "ls": (0, (3, 3))},
        "CLASS_E4": {"edge": "#8b1e6d", "fill": None, "alpha": 0.0, "lw": 0.9, "ls": (0, (3, 3))},
        "CLASS_E5": {"edge": "#8b1e6d", "fill": "#fbcfe8", "alpha": 0.04, "lw": 0.7, "ls": "-"},
    }

    for record in features["class_airspaces"]:
        attrs = record["attrs"]
        style = class_styles.get(attrs.get("TYPE_CODE"), None)
        if style is None:
            continue
        for part in record["parts"]:
            if len(part) < 3:
                continue
            pixel_part = [lonlat_to_chart_xy(features, lon, lat) for lon, lat in part]
            poly = Polygon(
                pixel_part,
                closed=True,
                facecolor=style["fill"] if style["fill"] else "none",
                edgecolor=style["edge"],
                linewidth=style["lw"],
                linestyle=style["ls"],
                alpha=style["alpha"] if style["fill"] else 0.9,
            )
            ax.add_patch(poly)

    for record in features["special_activity"]:
        for part in record["parts"]:
            pixel_part = [lonlat_to_chart_xy(features, lon, lat) for lon, lat in part]
            poly = Polygon(
                pixel_part,
                closed=True,
                facecolor="#a21caf",
                edgecolor="#7e22ce",
                linewidth=1.0,
                linestyle=(0, (2, 2)),
                alpha=0.08,
            )
            ax.add_patch(poly)
        pixels = [lonlat_to_chart_xy(features, lon, lat) for part in record["parts"] for lon, lat in part]
        xs = [pt[0] for pt in pixels]
        ys = [pt[1] for pt in pixels]
        label(ax, sum(xs) / len(xs), sum(ys) / len(ys), record["designator"] or record["name"], "#7e22ce", size=6, ha="center")

    for record in features["aerobatic"]:
        for part in record["parts"]:
            pixel_part = [lonlat_to_chart_xy(features, lon, lat) for lon, lat in part]
            poly = Polygon(
                pixel_part,
                closed=True,
                facecolor="none",
                edgecolor="#be123c",
                linewidth=1.0,
                linestyle=(0, (4, 3)),
                alpha=0.85,
            )
            ax.add_patch(poly)
        pixels = [lonlat_to_chart_xy(features, lon, lat) for part in record["parts"] for lon, lat in part]
        xs = [pt[0] for pt in pixels]
        ys = [pt[1] for pt in pixels]
        label(
            ax,
            sum(xs) / len(xs),
            sum(ys) / len(ys),
            record["attrs"].get("MAA_TYPE_NAME", "AEROBATIC"),
            "#9f1239",
            size=6,
            ha="center",
        )


def draw_victors(ax, features: dict[str, object]) -> None:
    for seg in features["airway_segments"]:
        start = lonlat_to_chart_xy(features, seg["from"][1], seg["from"][0])
        end = lonlat_to_chart_xy(features, seg["to"][1], seg["to"][0])
        xs = [start[0], end[0]]
        ys = [start[1], end[1]]
        ax.plot(
            xs,
            ys,
            color="#0f4c81",
            linewidth=1.2,
            alpha=0.9,
            path_effects=[pe.withStroke(linewidth=2.6, foreground="white", alpha=0.7)],
        )
    for airway_id, points in sorted(features["airway_label_points"].items()):
        mid = points[len(points) // 2]
        x, y = lonlat_to_chart_xy(features, mid[0], mid[1])
        label(ax, x, y, airway_id, "#0f4c81", size=7, ha="center")


def draw_intersections(ax, features: dict[str, object]) -> None:
    ordered = sorted(
        features["intersections"],
        key=lambda r: (
            "SECTIONAL" not in r["charting_types"],
            "ENROUTE LOW" not in r["charting_types"],
            r["FIX_ID"],
        ),
    )
    for idx, row in enumerate(ordered):
        x, y = lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not inside_chart(features, x, y, margin=24):
            continue
        ax.scatter(
            [x],
            [y],
            marker="x",
            s=22,
            linewidths=0.9,
            color="#0f4c81",
            alpha=0.9,
        )
        if idx < 40:
            label(ax, x + 7, y - 5, row["FIX_ID"], "#0f4c81", size=6)


def draw_airports(ax, features: dict[str, object]) -> None:
    for row in features["airports"]:
        x, y = lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not inside_chart(features, x, y, margin=24):
            continue
        towered = row["TWR_TYPE_CODE"] != "NON-ATCT"
        edge = "#1d4ed8" if towered else "#8b1e6d"
        face = "white"
        size = 45 if row["ARPT_ID"] == "IND" else 26
        ax.scatter(
            [x],
            [y],
            marker="o",
            s=size,
            facecolors=face,
            edgecolors=edge,
            linewidths=1.5,
            zorder=5,
        )
        if row["ARPT_ID"] == "IND":
            ax.scatter([x], [y], marker="+", s=100, color=edge, linewidths=1.4, zorder=6)
        if towered or row["ARPT_ID"] in {"IND", "EYE", "UMP", "MQJ", "TYQ", "HFY"}:
            label(ax, x + 8, y - 8, row["ARPT_ID"], edge, size=7)


def draw_navaids(ax, features: dict[str, object]) -> None:
    for row in features["navaids"]:
        x, y = lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not inside_chart(features, x, y, margin=24):
            continue
        nav_type = row["NAV_TYPE"]
        if "VOR" in nav_type or "TACAN" in nav_type:
            marker = "h"
            edge = "#0f4c81"
            face = "white"
        else:
            marker = "D"
            edge = "#0f4c81"
            face = "#dbeafe"
        ax.scatter(
            [x],
            [y],
            marker=marker,
            s=38,
            facecolors=face,
            edgecolors=edge,
            linewidths=1.1,
            zorder=5,
        )
        label(ax, x + 8, y - 6, row["NAV_ID"], edge, size=6)


def render_image(features: dict[str, object], filename: str, title: str, draw_fn=None, faded: bool = False) -> None:
    fig, ax = plt.subplots(figsize=(12, 10), dpi=180)
    setup_axes(ax, features, title)
    add_background(ax, features, faded=faded)
    if draw_fn:
        draw_fn(ax, features)
    fig.tight_layout()
    fig.savefig(OUTPUT_DIR / filename, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def write_summary(features: dict[str, object]) -> None:
    control_points = features["chart_transform"]["control_points"]
    lines = [
        f"Center airport: {features['center']['ARPT_ID']} {features['center']['ARPT_NAME']}",
        f"Radius (NM): {features['radius_nm']}",
        f"Region bbox: {features['region']}",
        f"Airports: {len(features['airports'])}",
        f"NAVAIDs: {len(features['navaids'])}",
        f"Intersections: {len(features['intersections'])}",
        f"Victor airway segments: {len(features['airway_segments'])}",
        f"Class airspaces: {len(features['class_airspaces'])}",
        f"Special activity polygons: {len(features['special_activity'])}",
        f"Aerobatic polygons: {len(features['aerobatic'])}",
        f"Airport control points used for alignment: {len(control_points)}",
        "Note: chart-to-coordinate alignment is now calibrated against airport symbols visible on the sectional crop.",
    ]
    (OUTPUT_DIR / "indy_vfr_summary.txt").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    features = build_features()

    render_image(features, "01_map_chart.png", "Indianapolis VFR Chart Crop")
    render_image(features, "02_airspaces_vfr.png", "Indianapolis Airspaces (VFR Style)", draw_airspaces, faded=True)
    render_image(features, "03_victors_vfr.png", "Indianapolis Victor Airways (VFR Palette)", draw_victors, faded=True)
    render_image(features, "04_intersections_vfr.png", "Indianapolis Intersections (VFR Palette)", draw_intersections, faded=True)
    render_image(features, "05_airports_vfr.png", "Indianapolis Airports (VFR Palette)", draw_airports, faded=True)
    render_image(features, "06_navaids_vfr.png", "Indianapolis NAVAIDs (VFR Palette)", draw_navaids, faded=True)

    def composite(ax, feats):
        draw_airspaces(ax, feats)
        draw_victors(ax, feats)
        draw_intersections(ax, feats)
        draw_airports(ax, feats)
        draw_navaids(ax, feats)

    render_image(features, "07_composite_vfr.png", "Indianapolis Composite Layers on VFR Chart", composite, faded=False)
    write_summary(features)


if __name__ == "__main__":
    main()
