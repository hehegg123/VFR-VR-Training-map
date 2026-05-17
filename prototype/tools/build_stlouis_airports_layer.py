from __future__ import annotations

import csv
import math
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.patches as mpatches
import matplotlib.pyplot as plt
import matplotlib.transforms as mtransforms

import build_indy_vfr_layers as base
import build_stlouis_airspaces_layer as stl
import stlouis_geotiff as geo


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = PROTOTYPE_ROOT / "outputs"
OUTPUT_DIR = OUTPUT_ROOT / "stlouis" / "airports"
FULL_REGION = stl.FULL_REGION


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


def load_public_airports(region: tuple[float, float, float, float]) -> list[dict[str, object]]:
    airports = []
    for row in stl.read_csv_from_dir("APT_BASE.csv"):
        if row["SITE_TYPE_CODE"] != "A" or row["FACILITY_USE_CODE"] != "PU" or row["ARPT_STATUS"] != "O":
            continue
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        if base.bbox_intersects(lon, lon, lat, lat, region):
            row = dict(row)
            row["lat"] = lat
            row["lon"] = lon
            row["elev"] = float(row["ELEV"]) if row.get("ELEV") else None
            airports.append(row)
    return airports


def load_runway_data(airport_ids: set[str]) -> tuple[dict[str, list[dict[str, object]]], dict[tuple[str, str], list[dict[str, object]]]]:
    runway_rows: defaultdict[str, list[dict[str, object]]] = defaultdict(list)
    for row in stl.read_csv_from_dir("APT_RWY.csv"):
        arpt_id = row["ARPT_ID"]
        if arpt_id not in airport_ids:
            continue
        runway_rows[arpt_id].append(
            {
                "rwy_id": row["RWY_ID"],
                "length_ft": int(float(row["RWY_LEN"])) if row.get("RWY_LEN") else 0,
                "width_ft": int(float(row["RWY_WIDTH"])) if row.get("RWY_WIDTH") else 0,
                "surface": row.get("SURFACE_TYPE_CODE", "").strip(),
                "lights": row.get("RWY_LGT_CODE", "").strip(),
            }
        )

    runway_ends: defaultdict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    for row in stl.read_csv_from_dir("APT_RWY_END.csv"):
        arpt_id = row["ARPT_ID"]
        if arpt_id not in airport_ids:
            continue
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        runway_ends[(arpt_id, row["RWY_ID"])].append(
            {
                "end_id": row.get("RWY_END_ID", "").strip(),
                "lat": lat,
                "lon": lon,
                "true_alignment": row.get("TRUE_ALIGNMENT", "").strip(),
            }
        )
    return runway_rows, runway_ends


def is_hard_surface(surface: str) -> bool:
    surface = (surface or "").upper().strip()
    if not surface:
        return False
    return not any(token in surface for token in SOFT_SURFACE_TOKENS)


def shorten_name(name: str) -> str:
    replacements = {
        "INTERNATIONAL": "INTL",
        "REGIONAL": "RGNL",
        "MUNICIPAL": "MUNI",
        "COUNTY": "CO",
        "MEMORIAL": "MEML",
        "UNIVERSITY": "UNIV",
        "SAINT": "ST",
    }
    text = " ".join((name or "").split())
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    return text


def airport_priority(row: dict[str, object]) -> tuple:
    towered = row["TWR_TYPE_CODE"] != "NON-ATCT"
    longest = int(row.get("longest_runway_ft") or 0)
    return (not towered, -longest, row["ARPT_ID"])


def build_features() -> dict[str, object]:
    image = geo.load_chart_background(FULL_REGION) if geo.has_chart() else base.load_chart_background(FULL_REGION)
    light_bg = base.lighten_background(image, factor=0.44)
    airports = load_public_airports(FULL_REGION)
    chart_transform = geo.build_chart_transform(FULL_REGION) if geo.has_chart() else stl.calibrate_full_chart_transform(image, FULL_REGION, airports)

    airport_ids = {row["ARPT_ID"] for row in airports}
    runway_rows, runway_ends = load_runway_data(airport_ids)

    enriched = []
    for row in airports:
        arpt_id = row["ARPT_ID"]
        towered = row["TWR_TYPE_CODE"] != "NON-ATCT"
        runways = runway_rows.get(arpt_id, [])
        non_heli_runways = [r for r in runways if not r["rwy_id"].startswith("H")]
        hard_runways = [r for r in non_heli_runways if is_hard_surface(r["surface"])]
        qualifying = [r for r in hard_runways if r["length_ft"] >= 1500]
        longest_runway_ft = max((r["length_ft"] for r in non_heli_runways), default=0)
        longest_hard_ft = max((r["length_ft"] for r in hard_runways), default=0)
        has_lights = bool(row.get("BCN_LENS_COLOR")) or any(r["lights"] for r in non_heli_runways) or bool(row.get("LGT_SKED"))
        row = dict(row)
        row["towered"] = towered
        row["runways"] = runways
        row["qualifying_runways"] = qualifying
        row["longest_runway_ft"] = longest_runway_ft
        row["longest_hard_ft"] = longest_hard_ft
        row["has_lights"] = has_lights
        row["layout_eligible"] = bool(qualifying)
        row["display_name"] = shorten_name(row["ARPT_NAME"])
        row["runway_end_points"] = runway_ends
        enriched.append(row)

    enriched.sort(key=airport_priority)
    return {
        "region": FULL_REGION,
        "background": image,
        "light_bg": light_bg,
        "chart_transform": chart_transform,
        "airports": enriched,
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


def airport_color(row: dict[str, object]) -> str:
    return "#1d4ed8" if row["towered"] else "#8b1e6d"


def draw_simple_symbol(ax, x: float, y: float, color: str, size: float) -> None:
    ax.scatter(
        [x],
        [y],
        marker="o",
        s=size,
        facecolors="white",
        edgecolors=color,
        linewidths=1.1,
        zorder=5,
    )


def draw_runway_bar(
    ax,
    center_x: float,
    center_y: float,
    length_px: float,
    width_px: float,
    angle_deg: float,
    color: str,
    zorder: int,
) -> None:
    halo_pad = 0.9
    transform = mtransforms.Affine2D().rotate_deg_around(center_x, center_y, angle_deg) + ax.transData
    halo = mpatches.Rectangle(
        (center_x - (length_px / 2.0) - halo_pad, center_y - (width_px / 2.0) - halo_pad),
        length_px + halo_pad * 2.0,
        width_px + halo_pad * 2.0,
        facecolor="white",
        edgecolor="none",
        alpha=0.9,
        transform=transform,
        zorder=zorder,
    )
    runway = mpatches.Rectangle(
        (center_x - length_px / 2.0, center_y - width_px / 2.0),
        length_px,
        width_px,
        facecolor=color,
        edgecolor="none",
        transform=transform,
        zorder=zorder + 0.1,
    )
    ax.add_patch(halo)
    ax.add_patch(runway)


def draw_runway_layout(ax, features: dict[str, object], row: dict[str, object], color: str) -> None:
    runway_ends = row["runway_end_points"]
    airport_center = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
    qualifying = sorted(row["qualifying_runways"], key=lambda r: (-r["length_ft"], r["rwy_id"]))
    if not qualifying:
        draw_simple_symbol(ax, airport_center[0], airport_center[1], color, 22)
        return

    target_max = 18.0 + min(12.0, max(0.0, (row["longest_hard_ft"] - 1500) / 900.0))
    lengths = []
    usable = []
    max_runway_length_ft = max((runway["length_ft"] for runway in qualifying[:4]), default=1)
    for runway in qualifying[:4]:
        ends = runway_ends.get((row["ARPT_ID"], runway["rwy_id"]), [])
        if len(ends) < 2:
            continue
        p1 = stl.lonlat_to_chart_xy(features, ends[0]["lon"], ends[0]["lat"])
        p2 = stl.lonlat_to_chart_xy(features, ends[1]["lon"], ends[1]["lat"])
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        pixel_len = max((dx * dx + dy * dy) ** 0.5, 1e-6)
        usable.append((runway, p1, p2, dx, dy, pixel_len))
        lengths.append(pixel_len)

    if not usable:
        draw_simple_symbol(ax, airport_center[0], airport_center[1], color, 22)
        return

    scale = target_max / max(lengths)
    for runway, p1, p2, dx, dy, pixel_len in usable:
        mid_x = (p1[0] + p2[0]) / 2.0
        mid_y = (p1[1] + p2[1]) / 2.0
        center_x = airport_center[0] + (mid_x - airport_center[0]) * scale
        center_y = airport_center[1] + (mid_y - airport_center[1]) * scale
        angle_deg = math.degrees(math.atan2(dy, dx))
        length_ratio = runway["length_ft"] / max_runway_length_ft if max_runway_length_ft else 1.0
        length_px = max(8.5, target_max * (0.55 + 0.45 * length_ratio))
        width_px = 2.4 if runway["width_ft"] < 75 else 3.0 if runway["width_ft"] < 120 else 3.8
        draw_runway_bar(
            ax,
            center_x,
            center_y,
            length_px,
            width_px,
            angle_deg,
            color,
            zorder=6,
        )


def draw_airport_symbols(ax, features: dict[str, object]) -> None:
    for row in features["airports"]:
        x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl.inside_chart(features, x, y, margin=20):
            continue
        color = airport_color(row)
        if row["layout_eligible"]:
            draw_runway_layout(ax, features, row, color)
        else:
            size = 28 if row["towered"] else 20
            draw_simple_symbol(ax, x, y, color, size)


def id_candidates() -> list[tuple[float, float, str, str]]:
    return stl.radial_candidates(
        [7, 12, 18, 26, 36],
        [(1, -1), (1, 1), (-1, -1), (-1, 1), (1, 0), (-1, 0), (0, -1), (0, 1)],
    )


def detail_candidates() -> list[tuple[float, float, str, str]]:
    return stl.radial_candidates(
        [12, 18, 26, 38, 52],
        [(1, -1), (1, 1), (-1, -1), (-1, 1), (1, 0), (-1, 0), (0, -1), (0, 1)],
    )


def airport_info_line(row: dict[str, object]) -> str:
    elev = f"ELEV {int(round(row['elev']))}" if row.get("elev") is not None else ""
    runway = f"RWY {int(row['longest_runway_ft'])}" if row.get("longest_runway_ft") else ""
    lgt = "LGT" if row.get("has_lights") else ""
    parts = [part for part in [elev, runway, lgt] if part]
    return "  ".join(parts)


def is_prominent(row: dict[str, object]) -> bool:
    return bool(
        row["towered"]
        or row.get("longest_runway_ft", 0) >= 5000
        or row["ARPT_ID"] in {"IND", "STL", "SUS", "PAH", "BMI", "EVV", "HUF", "DEC", "CGI", "SPI"}
    )


def reserve_airport_symbol_space(placer: stl.LabelPlacer, ax, x: float, y: float, row: dict[str, object]) -> None:
    disp_x, disp_y = ax.transData.transform((x, y))
    if row["layout_eligible"]:
        radius = 12.0 + min(8.0, max(0.0, (row["longest_hard_ft"] - 1500) / 1200.0))
    else:
        radius = 8.5 if row["towered"] else 7.0
    placer.occupied.append((disp_x - radius, disp_y - radius, disp_x + radius, disp_y + radius))


def airport_label_text(row: dict[str, object]) -> str:
    if is_prominent(row):
        info_line = airport_info_line(row)
        lines = [row["ARPT_ID"], row["display_name"]]
        if info_line:
            lines.append(info_line)
        return "\n".join(lines)
    return row["ARPT_ID"]


def draw_airport_labels(ax, features: dict[str, object]) -> None:
    ax.figure.canvas.draw()
    placer = stl.LabelPlacer(ax)
    for row in features["airports"]:
        x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if stl.inside_chart(features, x, y, margin=20):
            reserve_airport_symbol_space(placer, ax, x, y, row)

    ordered = sorted(
        features["airports"],
        key=lambda row: (
            not is_prominent(row),
            not row["towered"],
            -int(row.get("longest_runway_ft") or 0),
            row["ARPT_ID"],
        ),
    )

    for row in ordered:
        x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl.inside_chart(features, x, y, margin=20):
            continue
        prominent = is_prominent(row)
        text = airport_label_text(row)
        candidates = detail_candidates() if prominent else id_candidates()
        placer.place(
            x,
            y,
            text,
            fontsize=3.8 if prominent and row["towered"] else 3.6 if prominent else 4.0 if row["towered"] else 3.8,
            color=airport_color(row),
            candidates=candidates,
            zorder=8 if prominent else 7,
            allow_skip=True,
            max_score=600.0 if prominent else 240.0,
        )


def write_csv(features: dict[str, object]) -> None:
    path = OUTPUT_DIR / "stlouis_airports.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "airport_id",
                "airport_name",
                "city",
                "lat",
                "lon",
                "towered",
                "elev_ft",
                "longest_runway_ft",
                "longest_hard_runway_ft",
                "layout_eligible",
                "has_lights",
            ]
        )
        for row in features["airports"]:
            writer.writerow(
                [
                    row["ARPT_ID"],
                    row["ARPT_NAME"],
                    row["CITY"],
                    f"{row['lat']:.8f}",
                    f"{row['lon']:.8f}",
                    "Y" if row["towered"] else "N",
                    "" if row.get("elev") is None else f"{row['elev']:.1f}",
                    int(row["longest_runway_ft"]),
                    int(row["longest_hard_ft"]),
                    "Y" if row["layout_eligible"] else "N",
                    "Y" if row["has_lights"] else "N",
                ]
            )


def write_summary(features: dict[str, object]) -> None:
    transform = features["chart_transform"]
    towered = sum(1 for row in features["airports"] if row["towered"])
    layout = sum(1 for row in features["airports"] if row["layout_eligible"])
    lighted = sum(1 for row in features["airports"] if row["has_lights"])
    lines = [
        "Chart: St. Louis Sectional",
        f"Sectional extent assumption: {features['region']}",
        f"Airport control points used: {len(transform['control_points'])}",
        f"Median alignment residual (px): {transform['median_residual_px']:.2f}",
        f"Mean alignment residual (px): {transform['mean_residual_px']:.2f}",
        f"Max alignment residual (px): {transform['max_residual_px']:.2f}",
        f"Public airports rendered: {len(features['airports'])}",
        f"Towered airports: {towered}",
        f"Runway-layout depictions: {layout}",
        f"Airports with lighting info: {lighted}",
    ]
    (OUTPUT_DIR / "stlouis_airports_summary.txt").write_text("\n".join(lines), encoding="utf-8")


def render_chart_reference(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    fig.savefig(OUTPUT_DIR / "01_stlouis_chart_frame.png", pad_inches=0)
    plt.close(fig)


def render_symbols_transparent(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    setup_axes(ax, features, None)
    draw_airport_symbols(ax, features)
    fig.savefig(
        OUTPUT_DIR / "02_stlouis_airports_symbols_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_labels_transparent(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    setup_axes(ax, features, None)
    draw_airport_symbols(ax, features)
    draw_airport_labels(ax, features)
    fig.savefig(
        OUTPUT_DIR / "03_stlouis_airports_labels_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_overlay(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    draw_airport_symbols(ax, features)
    draw_airport_labels(ax, features)
    fig.savefig(OUTPUT_DIR / "04_stlouis_airports_overlay.png", pad_inches=0)
    plt.close(fig)


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    features = build_features()
    render_chart_reference(features)
    render_symbols_transparent(features)
    render_labels_transparent(features)
    render_overlay(features)
    write_csv(features)
    write_summary(features)


if __name__ == "__main__":
    main()
