from __future__ import annotations

import csv
import math
from collections import defaultdict
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon

import build_indy_vfr_layers as base


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DATA_ROOT = PROTOTYPE_ROOT / "reference-data"
OUTPUT_ROOT = PROTOTYPE_ROOT / "outputs"
OUTPUT_DIR = OUTPUT_ROOT / "indy" / "screenshot"
CSV_DIR = (
    REFERENCE_DATA_ROOT
    / "faa"
    / "28DaySubscription_Effective_2026-04-16"
    / "CSV_Data"
    / "16_Apr_2026_CSV"
)

# Derived from the visible Indianapolis anchors in the screenshot:
# Indianapolis, IND, Eagle Creek Park, Lawrence, Cumberland, and Geist.
SCREENSHOT_REGION = (-86.330, -85.940, 39.630, 39.928)
SCREENSHOT_LABEL = "Indianapolis Screenshot AOI"
PINNING_CLUES = (
    "Indianapolis",
    "Indianapolis Intl (IND)",
    "Eagle Creek Park",
    "Lawrence",
    "Cumberland",
    "Geist",
)

CITY_CENTER = (-86.1581, 39.7684)
AIRPORT_LABEL_IDS = {"IND", "EYE", "7L8"}
FIX_PRIORITY = {"AARIN", "ZAVNE"}


def read_csv_from_dir(name: str) -> list[dict[str, str]]:
    path = CSV_DIR / name
    with path.open("r", encoding="utf-8-sig", errors="ignore") as handle:
        return list(csv.DictReader(handle))


def lonlat_in_region(
    lon: float,
    lat: float,
    region: tuple[float, float, float, float],
    margin_deg: float = 0.0,
) -> bool:
    left, right, bottom, top = region
    return (
        left - margin_deg <= lon <= right + margin_deg
        and bottom - margin_deg <= lat <= top + margin_deg
    )


def region_units(region: tuple[float, float, float, float]) -> tuple[float, float]:
    left, right, bottom, top = region
    mid_lat = (bottom + top) / 2.0
    width = (right - left) * math.cos(math.radians(mid_lat))
    height = top - bottom
    return width, height


def project_xy(
    region: tuple[float, float, float, float],
    lon: float,
    lat: float,
) -> tuple[float, float]:
    left, right, bottom, top = region
    mid_lat = (bottom + top) / 2.0
    x = (lon - left) * math.cos(math.radians(mid_lat))
    y = lat - bottom
    return x, y


def point_list_xy(
    region: tuple[float, float, float, float],
    coords: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    return [project_xy(region, lon, lat) for lon, lat in coords]


def load_airport_rows(
    region: tuple[float, float, float, float],
) -> tuple[list[dict[str, object]], dict[str, list[tuple[tuple[float, float], tuple[float, float]]]]]:
    airports = []
    airport_lookup: dict[str, dict[str, object]] = {}
    for row in read_csv_from_dir("APT_BASE.csv"):
        if row["SITE_TYPE_CODE"] != "A" or row["FACILITY_USE_CODE"] != "PU" or row["ARPT_STATUS"] != "O":
            continue
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        if lonlat_in_region(lon, lat, region):
            row["lat"] = lat
            row["lon"] = lon
            airports.append(row)
            airport_lookup[row["ARPT_ID"]] = row

    runway_endpoints: defaultdict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    for row in read_csv_from_dir("APT_RWY_END.csv"):
        airport_id = row["ARPT_ID"]
        if airport_id not in airport_lookup:
            continue
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        runway_endpoints[(airport_id, row["RWY_ID"])].append((lon, lat))

    runway_segments: defaultdict[str, list[tuple[tuple[float, float], tuple[float, float]]]] = defaultdict(list)
    for (airport_id, _rwy_id), points in runway_endpoints.items():
        if len(points) >= 2:
            runway_segments[airport_id].append((points[0], points[1]))

    return airports, runway_segments


def load_navaids(region: tuple[float, float, float, float]) -> list[dict[str, object]]:
    rows = []
    for row in read_csv_from_dir("NAV_BASE.csv"):
        if row["PUBLIC_USE_FLAG"] != "Y" or not row["NAV_STATUS"].startswith("OPERATIONAL"):
            continue
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        if lonlat_in_region(lon, lat, region):
            row["lat"] = lat
            row["lon"] = lon
            rows.append(row)
    return rows


def load_intersections_and_victors(
    region: tuple[float, float, float, float],
) -> tuple[list[dict[str, object]], list[dict[str, object]], dict[str, tuple[float, float]]]:
    charting = defaultdict(set)
    for row in read_csv_from_dir("FIX_CHRT.csv"):
        charting[row["FIX_ID"]].add(row["CHARTING_TYPE_DESC"])

    fix_lookup: dict[str, tuple[float, float]] = {}
    fix_rows: dict[str, dict[str, object]] = {}
    for row in read_csv_from_dir("FIX_BASE.csv"):
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        row["lat"] = lat
        row["lon"] = lon
        row["charting_types"] = charting.get(row["FIX_ID"], set())
        fix_lookup[row["FIX_ID"]] = (lat, lon)
        fix_rows[row["FIX_ID"]] = row

    nav_lookup: dict[str, tuple[float, float]] = {}
    for row in read_csv_from_dir("NAV_BASE.csv"):
        try:
            nav_lookup[row["NAV_ID"]] = (
                float(row["LAT_DECIMAL"]),
                float(row["LONG_DECIMAL"]),
            )
        except ValueError:
            continue

    airway_segments = []
    airway_label_points: defaultdict[str, list[tuple[float, float]]] = defaultdict(list)
    fix_ids = set()
    for row in read_csv_from_dir("AWY_SEG_ALT.csv"):
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
        if not base.bbox_intersects(seg_left, seg_right, seg_bottom, seg_top, region):
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
        for fix_id in (row["FROM_POINT"], row["TO_POINT"]):
            if fix_id not in fix_rows:
                continue
            fix_row = fix_rows[fix_id]
            chart_types = fix_row["charting_types"]
            if lonlat_in_region(fix_row["lon"], fix_row["lat"], region) and (
                {"SECTIONAL", "CONTROLLER", "CONTROLLER LOW", "ENROUTE LOW"} & chart_types
                or fix_id in FIX_PRIORITY
            ):
                fix_ids.add(fix_id)

    intersections = [fix_rows[fix_id] for fix_id in sorted(fix_ids)]
    return intersections, airway_segments, airway_label_points


def load_airspaces(region: tuple[float, float, float, float]) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    class_attrs = base.read_dbf_records(base.CLASS_DBF)
    class_shapes = base.read_polygon_shapefile(base.CLASS_SHP)
    class_airspaces = []
    for attrs, shape in zip(class_attrs, class_shapes):
        bbox = shape["bbox"]
        if not bbox:
            continue
        xmin, xmax, ymin, ymax = bbox
        if base.bbox_intersects(xmin, xmax, ymin, ymax, region):
            class_airspaces.append({"attrs": attrs, "parts": shape["parts"]})

    maa_base = {row["MAA_ID"]: row for row in read_csv_from_dir("MAA_BASE.csv")}
    maa_shapes: defaultdict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for row in read_csv_from_dir("MAA_SHP.csv"):
        lat = base.dms_to_decimal(row["LATITUDE"])
        lon = base.dms_to_decimal(row["LONGITUDE"])
        maa_shapes[row["MAA_ID"]].append((int(row["POINT_SEQ"]), lon, lat))

    aerobatic = []
    for maa_id, points in maa_shapes.items():
        ordered = [(lon, lat) for _, lon, lat in sorted(points)]
        xs = [pt[0] for pt in ordered]
        ys = [pt[1] for pt in ordered]
        if ordered and base.bbox_intersects(min(xs), max(xs), min(ys), max(ys), region):
            aerobatic.append({"attrs": maa_base.get(maa_id, {}), "parts": [ordered]})

    special_activity = base.parse_saa_polygons(region)
    return class_airspaces, aerobatic, special_activity


def build_features() -> dict[str, object]:
    base.read_csv_from_zip = read_csv_from_dir
    region = SCREENSHOT_REGION

    airports, runway_segments = load_airport_rows(region)
    navaids = load_navaids(region)
    intersections, airway_segments, airway_label_points = load_intersections_and_victors(region)
    class_airspaces, aerobatic, special_activity = load_airspaces(region)

    return {
        "label": SCREENSHOT_LABEL,
        "region": region,
        "pinning_clues": PINNING_CLUES,
        "airports": airports,
        "runway_segments": runway_segments,
        "navaids": navaids,
        "intersections": intersections,
        "airway_segments": airway_segments,
        "airway_label_points": airway_label_points,
        "class_airspaces": class_airspaces,
        "aerobatic": aerobatic,
        "special_activity": special_activity,
    }


def setup_axes(ax, features: dict[str, object], title: str) -> None:
    region = features["region"]
    width, height = region_units(region)
    ax.set_title(title, fontsize=16, pad=10)
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.set_aspect("equal", adjustable="box")
    ax.set_axis_off()


def label(ax, x: float, y: float, text: str, color: str, size: int = 8, ha: str = "left") -> None:
    ax.text(
        x,
        y,
        text,
        fontsize=size,
        color=color,
        ha=ha,
        va="center",
        clip_on=True,
        path_effects=[pe.withStroke(linewidth=2.0, foreground="white", alpha=0.92)],
    )


def draw_reference_base(
    ax,
    features: dict[str, object],
    show_heading: bool = True,
    show_note: bool = False,
) -> None:
    region = features["region"]
    width, height = region_units(region)
    ax.set_facecolor("#f7f2e8")

    grid_color = "#ddd6c5"
    left, right, bottom, top = region
    lon = math.floor(left * 20) / 20.0
    while lon <= right + 1e-9:
        x, _ = project_xy(region, lon, bottom)
        ax.plot([x, x], [0, height], color=grid_color, linewidth=0.5, alpha=0.8, zorder=0)
        lon += 0.05

    lat = math.floor(bottom * 20) / 20.0
    while lat <= top + 1e-9:
        _, y = project_xy(region, left, lat)
        ax.plot([0, width], [y, y], color=grid_color, linewidth=0.5, alpha=0.8, zorder=0)
        lat += 0.05

    border = Polygon(
        [(0, 0), (width, 0), (width, height), (0, height)],
        closed=True,
        fill=False,
        edgecolor="#dc2626",
        linewidth=1.8,
        linestyle=(0, (3, 2)),
        zorder=10,
    )
    ax.add_patch(border)

    city_x, city_y = project_xy(region, CITY_CENTER[0], CITY_CENTER[1])
    ax.scatter([city_x], [city_y], s=18, color="#4b5563", zorder=3)
    label(ax, city_x + 0.008, city_y + 0.006, "Indianapolis", "#111827", size=16)

    if show_note:
        note = "Pinned from screenshot anchors: " + ", ".join(features["pinning_clues"])
        label(ax, width * 0.02, height * 0.965, note, "#374151", size=7)
    if show_heading:
        label(ax, width * 0.96, height * 0.965, "N", "#111827", size=11, ha="center")
        ax.annotate(
            "",
            xy=(width * 0.96, height * 0.93),
            xytext=(width * 0.96, height * 0.87),
            arrowprops=dict(arrowstyle="-|>", lw=1.2, color="#111827"),
        )


def draw_airspaces(ax, features: dict[str, object]) -> None:
    region = features["region"]
    class_styles = {
        "CLASS_B": {"edge": "#1d4ed8", "fill": "#93c5fd", "alpha": 0.12, "lw": 1.8, "ls": "-"},
        "CLASS_C": {"edge": "#8b1e6d", "fill": "#f9a8d4", "alpha": 0.12, "lw": 1.6, "ls": "-"},
        "CLASS_D": {"edge": "#1d4ed8", "fill": "#bfdbfe", "alpha": 0.08, "lw": 1.4, "ls": (0, (6, 4))},
        "CLASS_E2": {"edge": "#8b1e6d", "fill": None, "alpha": 0.0, "lw": 1.1, "ls": (0, (5, 3))},
        "CLASS_E3": {"edge": "#8b1e6d", "fill": None, "alpha": 0.0, "lw": 0.9, "ls": (0, (3, 3))},
        "CLASS_E4": {"edge": "#8b1e6d", "fill": None, "alpha": 0.0, "lw": 0.9, "ls": (0, (3, 3))},
        "CLASS_E5": {"edge": "#8b1e6d", "fill": "#fbcfe8", "alpha": 0.05, "lw": 0.8, "ls": "-"},
    }

    for record in features["class_airspaces"]:
        style = class_styles.get(record["attrs"].get("TYPE_CODE"))
        if style is None:
            continue
        for part in record["parts"]:
            if len(part) < 3:
                continue
            poly = Polygon(
                point_list_xy(region, part),
                closed=True,
                facecolor=style["fill"] if style["fill"] else "none",
                edgecolor=style["edge"],
                linewidth=style["lw"],
                linestyle=style["ls"],
                alpha=style["alpha"] if style["fill"] else 0.9,
                zorder=2,
            )
            ax.add_patch(poly)

    for record in features["special_activity"]:
        for part in record["parts"]:
            if len(part) < 3:
                continue
            poly = Polygon(
                point_list_xy(region, part),
                closed=True,
                facecolor="#a21caf",
                edgecolor="#7e22ce",
                linewidth=1.0,
                linestyle=(0, (2, 2)),
                alpha=0.08,
                zorder=2,
            )
            ax.add_patch(poly)

    for record in features["aerobatic"]:
        for part in record["parts"]:
            if len(part) < 3:
                continue
            poly = Polygon(
                point_list_xy(region, part),
                closed=True,
                fill=False,
                edgecolor="#be123c",
                linewidth=1.0,
                linestyle=(0, (4, 3)),
                alpha=0.9,
                zorder=2,
            )
            ax.add_patch(poly)


def draw_victors(ax, features: dict[str, object]) -> None:
    region = features["region"]
    for seg in features["airway_segments"]:
        start = project_xy(region, seg["from"][1], seg["from"][0])
        end = project_xy(region, seg["to"][1], seg["to"][0])
        ax.plot(
            [start[0], end[0]],
            [start[1], end[1]],
            color="#0f4c81",
            linewidth=1.25,
            alpha=0.92,
            zorder=3,
            path_effects=[pe.withStroke(linewidth=2.6, foreground="white", alpha=0.74)],
        )

    for airway_id, points in sorted(features["airway_label_points"].items()):
        lon, lat = points[len(points) // 2]
        x, y = project_xy(region, lon, lat)
        label(ax, x, y, airway_id, "#0f4c81", size=7, ha="center")


def draw_intersections(ax, features: dict[str, object]) -> None:
    region = features["region"]
    ordered = sorted(
        features["intersections"],
        key=lambda row: (
            row["FIX_ID"] not in FIX_PRIORITY,
            "ENROUTE LOW" not in row["charting_types"],
            "SECTIONAL" not in row["charting_types"],
            row["FIX_ID"],
        ),
    )
    for row in ordered:
        x, y = project_xy(region, row["lon"], row["lat"])
        ax.scatter([x], [y], marker="x", s=28, linewidths=1.0, color="#0f4c81", zorder=5)
        label(ax, x + 0.004, y + 0.004, row["FIX_ID"], "#0f4c81", size=7)


def draw_airports(ax, features: dict[str, object]) -> None:
    region = features["region"]
    runway_segments = features["runway_segments"]

    for row in features["airports"]:
        airport_id = row["ARPT_ID"]
        towered = row["TWR_TYPE_CODE"] != "NON-ATCT"
        edge = "#1d4ed8" if towered else "#8b1e6d"
        segments = runway_segments.get(airport_id, [])

        if segments:
            for start_lonlat, end_lonlat in segments:
                start = project_xy(region, start_lonlat[0], start_lonlat[1])
                end = project_xy(region, end_lonlat[0], end_lonlat[1])
                ax.plot(
                    [start[0], end[0]],
                    [start[1], end[1]],
                    color=edge,
                    linewidth=3.0 if airport_id == "IND" else 2.0,
                    solid_capstyle="round",
                    zorder=6,
                    path_effects=[pe.withStroke(linewidth=4.6, foreground="white", alpha=0.84)],
                )
        else:
            x, y = project_xy(region, row["lon"], row["lat"])
            ax.scatter(
                [x],
                [y],
                marker="o",
                s=55 if airport_id == "IND" else 34,
                facecolors="white",
                edgecolors=edge,
                linewidths=1.5,
                zorder=6,
            )

        if airport_id in AIRPORT_LABEL_IDS:
            x, y = project_xy(region, row["lon"], row["lat"])
            label(ax, x + 0.004, y + 0.004, airport_id, edge, size=8)


def draw_navaids(ax, features: dict[str, object]) -> None:
    region = features["region"]
    for row in features["navaids"]:
        x, y = project_xy(region, row["lon"], row["lat"])
        nav_type = row["NAV_TYPE"]
        marker = "h" if ("VOR" in nav_type or "TACAN" in nav_type or "VOT" in nav_type) else "D"
        face = "white" if marker == "h" else "#dbeafe"
        ax.scatter(
            [x],
            [y],
            marker=marker,
            s=52,
            facecolors=face,
            edgecolors="#0f4c81",
            linewidths=1.2,
            zorder=6,
        )
        label(ax, x + 0.004, y - 0.004, row["NAV_ID"], "#0f4c81", size=8)


def render_image(
    features: dict[str, object],
    filename: str,
    title: str,
    draw_fn=None,
    include_base: bool = True,
    show_note: bool = False,
) -> None:
    width, height = region_units(features["region"])
    fig_height = 10.0
    fig_width = fig_height * (width / height)
    fig, ax = plt.subplots(figsize=(fig_width, fig_height), dpi=180)
    setup_axes(ax, features, title)
    if include_base:
        draw_reference_base(ax, features, show_heading=True, show_note=show_note)
    if draw_fn:
        draw_fn(ax, features)
    fig.tight_layout()
    fig.savefig(OUTPUT_DIR / filename, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def write_summary(features: dict[str, object]) -> None:
    lines = [
        f"AOI label: {features['label']}",
        f"Approx screenshot-derived bbox: {features['region']}",
        "Pinning method: visible screenshot anchors -> Indianapolis urban area / IND / Eagle Creek / Lawrence / Cumberland / Geist.",
        "Important note: the attached Google-style screenshot was used only to pin the area. These map layers are rebuilt from FAA/NASR data, not traced from screenshot pixels.",
        f"Airports: {len(features['airports'])}",
        f"NAVAIDs: {len(features['navaids'])}",
        f"Intersections: {len(features['intersections'])}",
        f"Victor airway segments: {len(features['airway_segments'])}",
        f"Victor airways: {len(features['airway_label_points'])}",
        f"Class airspaces: {len(features['class_airspaces'])}",
        f"Special activity polygons: {len(features['special_activity'])}",
        f"Aerobatic polygons: {len(features['aerobatic'])}",
    ]
    (OUTPUT_DIR / "indy_screenshot_summary.txt").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    features = build_features()

    render_image(features, "01_map_chart.png", "Indianapolis Screenshot Area - Reference Map", show_note=True)
    render_image(features, "02_airspaces.png", "Indianapolis Screenshot Area - Airspaces", draw_airspaces)
    render_image(features, "03_victors.png", "Indianapolis Screenshot Area - Victor Airways", draw_victors)
    render_image(features, "04_intersections.png", "Indianapolis Screenshot Area - Intersections", draw_intersections)
    render_image(features, "05_airports.png", "Indianapolis Screenshot Area - Airports", draw_airports)
    render_image(features, "06_navaids.png", "Indianapolis Screenshot Area - NAVAIDs", draw_navaids)

    def composite(ax, feats):
        draw_airspaces(ax, feats)
        draw_victors(ax, feats)
        draw_intersections(ax, feats)
        draw_airports(ax, feats)
        draw_navaids(ax, feats)

    render_image(features, "07_composite.png", "Indianapolis Screenshot Area - Composite", composite)
    write_summary(features)


if __name__ == "__main__":
    main()
