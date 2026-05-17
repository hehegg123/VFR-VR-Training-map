from __future__ import annotations

import csv
import math
import struct
import zipfile
from collections import defaultdict
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import Polygon


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DATA_ROOT = PROTOTYPE_ROOT / "reference-data"
OUTPUT_ROOT = PROTOTYPE_ROOT / "outputs"
NASR_DIR = REFERENCE_DATA_ROOT / "faa" / "28DaySubscription_Effective_2026-04-16"
ZIP_PATH = NASR_DIR / "CSV_Data" / "16_Apr_2026_CSV.zip"
CLASS_SHP = NASR_DIR / "Additional_Data" / "Shape_Files" / "Class_Airspace.shp"
CLASS_DBF = NASR_DIR / "Additional_Data" / "Shape_Files" / "Class_Airspace.dbf"
OUTPUT_DIR = OUTPUT_ROOT / "indy" / "base"


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


def dms_text_to_decimal(value: str) -> float:
    value = value.strip()
    if not value:
        raise ValueError("Empty DMS value")
    hemi = value[-1]
    body = value[:-1]
    deg, minute, second = body.split("-")
    decimal = float(deg) + float(minute) / 60.0 + float(second) / 3600.0
    if hemi in {"S", "W"}:
        decimal *= -1
    return decimal


def read_csv_from_zip(name: str) -> list[dict[str, str]]:
    with zipfile.ZipFile(ZIP_PATH) as archive:
        with archive.open(name) as handle:
            reader = csv.DictReader(line.decode("utf-8-sig") for line in handle)
            return list(reader)


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
            length = desc[16]
            fields.append((name, length))

        rows: list[dict[str, str]] = []
        for _ in range(num_records):
            record = handle.read(record_len)
            if not record or record[0:1] == b"*":
                continue
            pos = 1
            row: dict[str, str] = {}
            for name, length in fields:
                raw = record[pos : pos + length]
                pos += length
                row[name] = raw.decode("latin1", errors="ignore").strip()
            rows.append(row)
        return rows


def read_polygon_shapefile(path: Path) -> list[dict[str, object]]:
    polygons: list[dict[str, object]] = []
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
            if shape_type == 0:
                polygons.append({"bbox": None, "parts": []})
                continue
            if shape_type not in {5, 15, 25}:
                polygons.append({"bbox": None, "parts": []})
                continue

            xmin, ymin, xmax, ymax, num_parts, num_points = struct.unpack(
                "<4d2i", content[4:44]
            )
            parts_idx = list(struct.unpack(f"<{num_parts}i", content[44 : 44 + 4 * num_parts]))
            points_offset = 44 + 4 * num_parts
            coords = []
            for idx in range(num_points):
                start = points_offset + idx * 16
                x, y = struct.unpack("<2d", content[start : start + 16])
                coords.append((x, y))

            parts: list[list[tuple[float, float]]] = []
            for idx, start_idx in enumerate(parts_idx):
                end_idx = parts_idx[idx + 1] if idx + 1 < len(parts_idx) else num_points
                parts.append(coords[start_idx:end_idx])

            polygons.append({"bbox": (xmin, xmax, ymin, ymax), "parts": parts})
    return polygons


def setup_axes(ax, region: tuple[float, float, float, float], title: str) -> None:
    left, right, bottom, top = region
    ax.set_title(title, fontsize=16, pad=10)
    ax.set_xlim(left, right)
    ax.set_ylim(bottom, top)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.set_aspect("equal", adjustable="box")
    ax.grid(color="#d4d4d8", linewidth=0.6, alpha=0.6)


def load_center_airport() -> dict[str, str]:
    for row in read_csv_from_zip("APT_BASE.csv"):
        if row["ARPT_ID"] == "IND" and row["SITE_TYPE_CODE"] == "A":
            return row
    raise RuntimeError("Could not find IND airport in APT_BASE.csv")


def build_feature_sets(radius_nm: float = 90.0) -> dict[str, object]:
    center = load_center_airport()
    center_lat = float(center["LAT_DECIMAL"])
    center_lon = float(center["LONG_DECIMAL"])
    region = bbox_from_radius(center_lat, center_lon, radius_nm)

    airports = []
    for row in read_csv_from_zip("APT_BASE.csv"):
        if row["SITE_TYPE_CODE"] != "A":
            continue
        if row["FACILITY_USE_CODE"] != "PU" or row["ARPT_STATUS"] != "O":
            continue
        lat = float(row["LAT_DECIMAL"])
        lon = float(row["LONG_DECIMAL"])
        if haversine_nm(center_lat, center_lon, lat, lon) <= radius_nm:
            row["lat"] = lat
            row["lon"] = lon
            airports.append(row)

    navaids = []
    nav_lookup: dict[str, tuple[float, float]] = {}
    for row in read_csv_from_zip("NAV_BASE.csv"):
        if not row["LAT_DECIMAL"] or not row["LONG_DECIMAL"]:
            continue
        lat = float(row["LAT_DECIMAL"])
        lon = float(row["LONG_DECIMAL"])
        nav_lookup[row["NAV_ID"]] = (lat, lon)
        if row["PUBLIC_USE_FLAG"] != "Y":
            continue
        if not row["NAV_STATUS"].startswith("OPERATIONAL"):
            continue
        if haversine_nm(center_lat, center_lon, lat, lon) <= radius_nm:
            row["lat"] = lat
            row["lon"] = lon
            navaids.append(row)

    fix_lookup: dict[str, tuple[float, float]] = {}
    all_fixes: dict[str, dict[str, str]] = {}
    for row in read_csv_from_zip("FIX_BASE.csv"):
        lat = float(row["LAT_DECIMAL"])
        lon = float(row["LONG_DECIMAL"])
        fix_lookup[row["FIX_ID"]] = (lat, lon)
        row["lat"] = lat
        row["lon"] = lon
        all_fixes[row["FIX_ID"]] = row

    airway_segments = []
    airway_fix_ids: set[str] = set()
    airway_labels: defaultdict[str, list[tuple[float, float]]] = defaultdict(list)
    for row in read_csv_from_zip("AWY_SEG_ALT.csv"):
        airway_id = row["AWY_ID"]
        if not airway_id.startswith("V"):
            continue
        from_id = row["FROM_POINT"]
        to_id = row["TO_POINT"]
        from_coord = fix_lookup.get(from_id) or nav_lookup.get(from_id)
        to_coord = fix_lookup.get(to_id) or nav_lookup.get(to_id)
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
                "from_id": from_id,
                "to_id": to_id,
                "from": from_coord,
                "to": to_coord,
            }
        )
        airway_labels[airway_id].append(
            ((from_coord[1] + to_coord[1]) / 2.0, (from_coord[0] + to_coord[0]) / 2.0)
        )
        if from_id in fix_lookup and haversine_nm(center_lat, center_lon, *fix_lookup[from_id]) <= radius_nm:
            airway_fix_ids.add(from_id)
        if to_id in fix_lookup and haversine_nm(center_lat, center_lon, *fix_lookup[to_id]) <= radius_nm:
            airway_fix_ids.add(to_id)

    intersections = []
    for fix_id in sorted(airway_fix_ids):
        row = dict(all_fixes[fix_id])
        intersections.append(row)

    maa_base_by_id = {row["MAA_ID"]: row for row in read_csv_from_zip("MAA_BASE.csv")}
    maa_shapes = defaultdict(list)
    for row in read_csv_from_zip("MAA_SHP.csv"):
        maa_shapes[row["MAA_ID"]].append(
            (int(row["POINT_SEQ"]), dms_text_to_decimal(row["LONGITUDE"]), dms_text_to_decimal(row["LATITUDE"]))
        )

    maa_polygons = []
    for maa_id, points in maa_shapes.items():
        ordered = [(lon, lat) for _seq, lon, lat in sorted(points)]
        lons = [p[0] for p in ordered]
        lats = [p[1] for p in ordered]
        if bbox_intersects(min(lons), max(lons), min(lats), max(lats), region):
            maa_polygons.append(
                {
                    "attrs": maa_base_by_id.get(maa_id, {}),
                    "parts": [ordered],
                }
            )

    class_airspace_attrs = read_dbf_records(CLASS_DBF)
    class_airspace_shapes = read_polygon_shapefile(CLASS_SHP)
    class_airspaces = []
    for attrs, shape in zip(class_airspace_attrs, class_airspace_shapes):
        bbox = shape["bbox"]
        if not bbox:
            continue
        xmin, xmax, ymin, ymax = bbox
        if bbox_intersects(xmin, xmax, ymin, ymax, region):
            class_airspaces.append({"attrs": attrs, "parts": shape["parts"]})

    return {
        "center": center,
        "center_lat": center_lat,
        "center_lon": center_lon,
        "radius_nm": radius_nm,
        "region": region,
        "airports": airports,
        "navaids": navaids,
        "intersections": intersections,
        "airway_segments": airway_segments,
        "airway_labels": airway_labels,
        "maa_polygons": maa_polygons,
        "class_airspaces": class_airspaces,
    }


def draw_class_airspaces(ax, features: dict[str, object]) -> None:
    colors = {
        "CLASS_C": ("#f59e0b", 0.10, 1.8),
        "CLASS_D": ("#ef4444", 0.08, 1.5),
        "CLASS_E2": ("#3b82f6", 0.03, 1.2),
        "CLASS_E3": ("#2563eb", 0.03, 1.1),
        "CLASS_E4": ("#60a5fa", 0.03, 1.1),
        "CLASS_E5": ("#93c5fd", 0.02, 1.0),
    }
    label_drawn = 0
    for record in features["class_airspaces"]:
        attrs = record["attrs"]
        type_code = attrs.get("TYPE_CODE", "")
        edge, alpha, width = colors.get(type_code, ("#64748b", 0.02, 0.9))
        for part in record["parts"]:
            if len(part) < 3:
                continue
            patch = Polygon(part, closed=True, facecolor=edge, edgecolor=edge, linewidth=width, alpha=alpha)
            ax.add_patch(patch)
        if label_drawn < 12 and type_code in {"CLASS_C", "CLASS_D"}:
            xs = [pt[0] for part in record["parts"] for pt in part]
            ys = [pt[1] for part in record["parts"] for pt in part]
            ax.text(
                sum(xs) / len(xs),
                sum(ys) / len(ys),
                attrs.get("IDENT", "").replace(" AIRP", ""),
                fontsize=7,
                color=edge,
                ha="center",
                va="center",
            )
            label_drawn += 1

    for record in features["maa_polygons"]:
        attrs = record["attrs"]
        for part in record["parts"]:
            patch = Polygon(
                part,
                closed=True,
                facecolor="none",
                edgecolor="#16a34a",
                linewidth=1.2,
                linestyle="--",
                alpha=0.9,
            )
            ax.add_patch(patch)
        xs = [pt[0] for part in record["parts"] for pt in part]
        ys = [pt[1] for part in record["parts"] for pt in part]
        ax.text(
            sum(xs) / len(xs),
            sum(ys) / len(ys),
            attrs.get("MAA_TYPE_NAME", "MAA"),
            fontsize=6,
            color="#166534",
            ha="center",
            va="center",
        )


def draw_victor_airways(ax, features: dict[str, object]) -> None:
    for seg in features["airway_segments"]:
        x = [seg["from"][1], seg["to"][1]]
        y = [seg["from"][0], seg["to"][0]]
        ax.plot(x, y, color="#92400e", linewidth=1.5, alpha=0.8)

    for airway_id, points in sorted(features["airway_labels"].items()):
        mid = points[len(points) // 2]
        ax.text(mid[0], mid[1], airway_id, fontsize=7, color="#78350f", ha="center", va="center")


def draw_intersections(ax, features: dict[str, object], label_limit: int = 85) -> None:
    xs = [row["lon"] for row in features["intersections"]]
    ys = [row["lat"] for row in features["intersections"]]
    ax.scatter(xs, ys, marker="x", s=18, linewidths=0.8, color="#2563eb", alpha=0.9)
    for idx, row in enumerate(features["intersections"]):
        if idx >= label_limit:
            break
        ax.text(row["lon"] + 0.01, row["lat"] + 0.01, row["FIX_ID"], fontsize=6, color="#1d4ed8")


def draw_airports(ax, features: dict[str, object]) -> None:
    for row in features["airports"]:
        marker = "s" if row["TWR_TYPE_CODE"] != "NON-ATCT" else "o"
        size = 40 if row["ARPT_ID"] == "IND" else 18
        color = "#111827" if row["ARPT_ID"] == "IND" else "#374151"
        ax.scatter([row["lon"]], [row["lat"]], marker=marker, s=size, color=color, alpha=0.95)
        ax.text(row["lon"] + 0.01, row["lat"] + 0.01, row["ARPT_ID"], fontsize=6, color=color)


def draw_navaids(ax, features: dict[str, object]) -> None:
    for row in features["navaids"]:
        marker = "^" if "VOR" in row["NAV_TYPE"] or "TACAN" in row["NAV_TYPE"] else "D"
        color = "#0f766e" if marker == "^" else "#115e59"
        ax.scatter([row["lon"]], [row["lat"]], marker=marker, s=35, color=color, alpha=0.95)
        ax.text(row["lon"] + 0.012, row["lat"] + 0.012, row["NAV_ID"], fontsize=6, color=color)


def draw_map_placeholder(ax, features: dict[str, object]) -> None:
    left, right, bottom, top = features["region"]
    ax.fill([left, right, right, left], [bottom, bottom, top, top], color="#f8fafc")
    ax.scatter([features["center_lon"]], [features["center_lat"]], marker="*", s=120, color="#111827")
    ax.text(
        features["center_lon"],
        features["center_lat"] + 0.08,
        "KIND / Indianapolis Intl",
        fontsize=10,
        color="#111827",
        ha="center",
    )
    ax.text(
        (left + right) / 2,
        bottom + 0.18,
        "Placeholder only: NASR includes vector aviation data, but not the FAA VFR chart raster.\n"
        "For the paper-style Map layer, add the Indianapolis-area FAA digital Visual Chart.",
        fontsize=10,
        color="#475569",
        ha="center",
        va="bottom",
    )


def render_layer(title: str, filename: str, region: tuple[float, float, float, float], draw_fn) -> None:
    fig, ax = plt.subplots(figsize=(12, 10), dpi=180)
    setup_axes(ax, region, title)
    draw_fn(ax)
    fig.tight_layout()
    fig.savefig(OUTPUT_DIR / filename, bbox_inches="tight")
    plt.close(fig)


def write_summary(features: dict[str, object]) -> None:
    lines = [
        f"Center airport: {features['center']['ARPT_ID']} {features['center']['ARPT_NAME']}",
        f"Radius (NM): {features['radius_nm']}",
        f"Airports: {len(features['airports'])}",
        f"NAVAIDs: {len(features['navaids'])}",
        f"Intersections used by Victor airways: {len(features['intersections'])}",
        f"Victor airway segments: {len(features['airway_segments'])}",
        f"Class airspace polygons intersecting region: {len(features['class_airspaces'])}",
        f"Misc activity polygons intersecting region: {len(features['maa_polygons'])}",
    ]
    (OUTPUT_DIR / "indy_layer_summary.txt").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    features = build_feature_sets(radius_nm=90.0)
    region = features["region"]

    render_layer(
        "Indianapolis Placeholder Map Layer",
        "01_map_placeholder.png",
        region,
        lambda ax: draw_map_placeholder(ax, features),
    )
    render_layer(
        "Indianapolis Airspaces",
        "02_airspaces.png",
        region,
        lambda ax: draw_class_airspaces(ax, features),
    )
    render_layer(
        "Indianapolis Victor Airways",
        "03_victors.png",
        region,
        lambda ax: draw_victor_airways(ax, features),
    )
    render_layer(
        "Indianapolis Intersections",
        "04_intersections.png",
        region,
        lambda ax: draw_intersections(ax, features),
    )
    render_layer(
        "Indianapolis Airports",
        "05_airports.png",
        region,
        lambda ax: draw_airports(ax, features),
    )
    render_layer(
        "Indianapolis NAVAIDs",
        "06_navaids.png",
        region,
        lambda ax: draw_navaids(ax, features),
    )

    def draw_composite(ax):
        draw_class_airspaces(ax, features)
        draw_victor_airways(ax, features)
        draw_intersections(ax, features, label_limit=45)
        draw_airports(ax, features)
        draw_navaids(ax, features)

    render_layer(
        "Indianapolis Composite Training Layers",
        "07_composite.png",
        region,
        draw_composite,
    )
    write_summary(features)


if __name__ == "__main__":
    main()
