from __future__ import annotations

import csv
import math
from collections import Counter
from pathlib import Path

import matplotlib.patches as mpatches
import matplotlib.pyplot as plt

import build_indy_vfr_layers as base
import build_stlouis_airspaces_layer as stl
import stlouis_geotiff as geo


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = PROTOTYPE_ROOT / "outputs"
OUTPUT_DIR = OUTPUT_ROOT / "stlouis" / "navaids"
FULL_REGION = stl.FULL_REGION

SUPPORTED_TYPES = {"VOR", "VOR/DME", "VORTAC", "TACAN", "NDB", "DME"}
TYPE_PRIORITY = {
    "VORTAC": 0,
    "VOR/DME": 1,
    "VOR": 2,
    "TACAN": 3,
    "NDB": 4,
    "DME": 5,
}

BLUE = "#0f4c81"
BLUE_LIGHT = "#1d4ed8"
MAGENTA = "#8b1e6d"


def shorten_name(name: str) -> str:
    replacements = {
        "INTERNATIONAL": "INTL",
        "REGIONAL": "RGNL",
        "MUNICIPAL": "MUNI",
        "COUNTY": "CO",
        "MEMORIAL": "MEML",
        "UNIVERSITY": "UNIV",
        "SAINT": "ST",
        "MOUNT": "MT",
        "FORT": "FT",
    }
    text = " ".join((name or "").split())
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    return text


def load_navaids(region: tuple[float, float, float, float]) -> list[dict[str, object]]:
    navaids = []
    for row in stl.read_csv_from_dir("NAV_BASE.csv"):
        nav_type = row.get("NAV_TYPE", "").strip()
        if nav_type not in SUPPORTED_TYPES:
            continue
        if row.get("PUBLIC_USE_FLAG") != "Y":
            continue
        if not row.get("NAV_STATUS", "").startswith("OPERATIONAL"):
            continue
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        if not base.bbox_intersects(lon, lon, lat, lat, region):
            continue
        navaids.append(
            {
                "nav_id": row["NAV_ID"],
                "nav_type": nav_type,
                "name": row["NAME"],
                "display_name": shorten_name(row["NAME"]),
                "city": row["CITY"],
                "lat": lat,
                "lon": lon,
                "freq": row.get("FREQ", "").strip(),
                "channel": row.get("CHAN", "").strip(),
                "status": row.get("NAV_STATUS", "").strip(),
                "voice_call": row.get("VOICE_CALL", "").strip(),
                "ndb_class": row.get("NDB_CLASS_CODE", "").strip(),
            }
        )
    navaids.sort(key=lambda row: (TYPE_PRIORITY.get(row["nav_type"], 99), row["nav_id"]))
    return navaids


def build_features() -> dict[str, object]:
    image = geo.load_chart_background(FULL_REGION) if geo.has_chart() else base.load_chart_background(FULL_REGION)
    light_bg = base.lighten_background(image, factor=0.44)
    airports = stl.load_public_airports(FULL_REGION)
    chart_transform = geo.build_chart_transform(FULL_REGION) if geo.has_chart() else stl.calibrate_full_chart_transform(image, FULL_REGION, airports)
    navaids = load_navaids(FULL_REGION)
    return {
        "region": FULL_REGION,
        "background": image,
        "light_bg": light_bg,
        "chart_transform": chart_transform,
        "navaids": navaids,
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


def symbol_color(row: dict[str, object]) -> str:
    if row["nav_type"] == "NDB":
        return MAGENTA
    if row["nav_type"] == "DME":
        return BLUE_LIGHT
    return BLUE


def base_radius(row: dict[str, object]) -> float:
    nav_type = row["nav_type"]
    if nav_type in {"VORTAC", "VOR/DME", "VOR"}:
        return 5.2
    if nav_type == "TACAN":
        return 5.0
    if nav_type == "NDB":
        return 4.1
    return 4.0


def add_halo_patch(ax, patch) -> None:
    ax.add_patch(patch)


def draw_hexagon(ax, x: float, y: float, radius: float, color: str, zorder: int) -> None:
    halo = mpatches.RegularPolygon((x, y), 6, radius=radius + 0.8, orientation=math.radians(30), facecolor="white", edgecolor="none", alpha=0.92, zorder=zorder)
    outer = mpatches.RegularPolygon((x, y), 6, radius=radius, orientation=math.radians(30), facecolor="white", edgecolor=color, linewidth=1.05, zorder=zorder + 0.1)
    add_halo_patch(ax, halo)
    ax.add_patch(outer)


def draw_square(ax, x: float, y: float, half: float, color: str, zorder: int) -> None:
    halo = mpatches.Rectangle((x - half - 0.7, y - half - 0.7), 2 * (half + 0.7), 2 * (half + 0.7), facecolor="white", edgecolor="none", alpha=0.92, zorder=zorder)
    outer = mpatches.Rectangle((x - half, y - half), 2 * half, 2 * half, facecolor="white", edgecolor=color, linewidth=1.0, zorder=zorder + 0.1)
    add_halo_patch(ax, halo)
    ax.add_patch(outer)


def draw_triangle(ax, x: float, y: float, radius: float, color: str, zorder: int) -> None:
    halo = mpatches.RegularPolygon((x, y), 3, radius=radius + 0.8, orientation=math.radians(90), facecolor="white", edgecolor="none", alpha=0.92, zorder=zorder)
    outer = mpatches.RegularPolygon((x, y), 3, radius=radius, orientation=math.radians(90), facecolor="white", edgecolor=color, linewidth=1.0, zorder=zorder + 0.1)
    add_halo_patch(ax, halo)
    ax.add_patch(outer)


def draw_circle(ax, x: float, y: float, radius: float, color: str, zorder: int) -> None:
    halo = mpatches.Circle((x, y), radius + 0.8, facecolor="white", edgecolor="none", alpha=0.92, zorder=zorder)
    outer = mpatches.Circle((x, y), radius, facecolor="white", edgecolor=color, linewidth=1.0, zorder=zorder + 0.1)
    add_halo_patch(ax, halo)
    ax.add_patch(outer)


def draw_dot(ax, x: float, y: float, radius: float, color: str, zorder: int) -> None:
    ax.add_patch(mpatches.Circle((x, y), radius, facecolor=color, edgecolor="none", zorder=zorder))


def draw_navaid_symbol(ax, row: dict[str, object], x: float, y: float) -> None:
    nav_type = row["nav_type"]
    color = symbol_color(row)
    radius = base_radius(row)
    zorder = 5

    if nav_type == "VOR":
        draw_hexagon(ax, x, y, radius, color, zorder)
        draw_dot(ax, x, y, 0.9, color, zorder + 0.2)
    elif nav_type == "VOR/DME":
        draw_hexagon(ax, x, y, radius, color, zorder)
        draw_square(ax, x, y, 1.35, color, zorder + 0.2)
    elif nav_type == "VORTAC":
        draw_hexagon(ax, x, y, radius, color, zorder)
        inner = mpatches.RegularPolygon((x, y), 3, radius=1.8, orientation=math.radians(90), facecolor=color, edgecolor="none", zorder=zorder + 0.2)
        ax.add_patch(inner)
    elif nav_type == "TACAN":
        draw_triangle(ax, x, y, radius, color, zorder)
        draw_dot(ax, x, y, 0.8, color, zorder + 0.2)
    elif nav_type == "NDB":
        draw_circle(ax, x, y, radius, color, zorder)
        draw_dot(ax, x, y, 0.95, color, zorder + 0.2)
    elif nav_type == "DME":
        draw_square(ax, x, y, radius - 0.6, color, zorder)
        draw_dot(ax, x, y, 0.75, color, zorder + 0.2)


def draw_symbols(ax, features: dict[str, object]) -> None:
    for row in features["navaids"]:
        x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl.inside_chart(features, x, y, margin=20):
            continue
        draw_navaid_symbol(ax, row, x, y)


def label_text(row: dict[str, object]) -> str:
    freq = row["freq"]
    if row["nav_type"] in {"VORTAC", "VOR/DME", "VOR", "TACAN"}:
        lines = [row["nav_id"], row["display_name"]]
        if freq:
            lines.append(freq)
        return "\n".join(lines)
    if row["nav_type"] == "NDB":
        second = row["display_name"]
        if freq:
            second = f"{second} {freq}".strip()
        return "\n".join([row["nav_id"], second])
    second = row["display_name"]
    if freq:
        second = f"{second} {freq}".strip()
    return "\n".join([row["nav_id"], second])


def label_lines(row: dict[str, object]) -> list[str]:
    lines = [row["nav_id"], row["display_name"], row["nav_type"]]
    meta: list[str] = []
    if row["freq"]:
        meta.append(row["freq"])
    if row["channel"] and row["nav_type"] in {"VORTAC", "VOR/DME", "TACAN", "DME"}:
        meta.append(row["channel"])
    if meta:
        lines.append(" / ".join(meta))
    return lines


def label_candidates(row: dict[str, object]) -> list[tuple[float, float, str, str]]:
    if row["nav_type"] in {"VORTAC", "VOR/DME", "VOR", "TACAN"}:
        radii = [10, 16, 24, 34, 46]
    elif row["nav_type"] == "NDB":
        radii = [8, 13, 20, 28, 38]
    else:
        radii = [8, 13, 20, 28, 38]
    return stl.radial_candidates(
        radii,
        [(1, -1), (1, 1), (-1, -1), (-1, 1), (1, 0), (-1, 0), (0, -1), (0, 1)],
    )


def reserve_symbol_space(placer: stl.LabelPlacer, ax, row: dict[str, object], x: float, y: float) -> None:
    disp_x, disp_y = ax.transData.transform((x, y))
    radius = base_radius(row) + 3.5
    placer.occupied.append((disp_x - radius, disp_y - radius, disp_x + radius, disp_y + radius))


def label_fontsize(row: dict[str, object]) -> float:
    if row["nav_type"] in {"VORTAC", "VOR/DME", "VOR", "TACAN"}:
        return 4.2
    if row["nav_type"] == "NDB":
        return 3.85
    return 3.7


def label_max_score(row: dict[str, object]) -> float:
    if row["nav_type"] in {"VORTAC", "VOR/DME", "VOR", "TACAN"}:
        return 520.0
    if row["nav_type"] == "NDB":
        return 300.0
    return 240.0


def label_style(row: dict[str, object]) -> str:
    if row["nav_type"] == "NDB":
        return "navaid-ndb"
    if row["nav_type"] == "DME":
        return "navaid-dme"
    return "navaid-vor"


def label_priority(row: dict[str, object]) -> float:
    return max(0.45, 1.0 - TYPE_PRIORITY.get(row["nav_type"], 9) * 0.08)


def compute_navaid_label_layout(features: dict[str, object]) -> list[dict[str, object]]:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    try:
        ax.patch.set_alpha(0)
        setup_axes(ax, features, None)
        draw_symbols(ax, features)
        ax.figure.canvas.draw()
        placer = stl.AirspaceLabelPlacer(ax)
        ordered = sorted(
            features["navaids"],
            key=lambda row: (TYPE_PRIORITY.get(row["nav_type"], 99), row["nav_id"]),
        )

        for row in ordered:
            x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
            if stl.inside_chart(features, x, y, margin=20):
                reserve_symbol_space(placer, ax, row, x, y)

        layout: list[dict[str, object]] = []
        for row in ordered:
            x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
            if not stl.inside_chart(features, x, y, margin=20):
                continue

            placement = placer.place_text(
                x,
                y,
                "\n".join(label_lines(row)),
                fontsize=label_fontsize(row),
                color=symbol_color(row),
                candidates=label_candidates(row),
                zorder=7,
                allow_skip=True,
                max_score=label_max_score(row),
            )
            if placement is None:
                continue

            layout.append(
                {
                    "id": row["nav_id"],
                    "navaid_type": row["nav_type"],
                    "x": placement["x"],
                    "y": placement["y"],
                    "lines": label_lines(row),
                    "style": label_style(row),
                    "priority": label_priority(row),
                    "color": symbol_color(row),
                    "fontsize": label_fontsize(row),
                    "ha": placement["ha"],
                    "va": placement["va"],
                }
            )

        return layout
    finally:
        plt.close(fig)


def draw_labels(ax, features: dict[str, object]) -> None:
    ax.figure.canvas.draw()
    placer = stl.LabelPlacer(ax)
    ordered = sorted(
        features["navaids"],
        key=lambda row: (TYPE_PRIORITY.get(row["nav_type"], 99), row["nav_id"]),
    )
    for row in ordered:
        x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if stl.inside_chart(features, x, y, margin=20):
            reserve_symbol_space(placer, ax, row, x, y)

    for row in ordered:
        x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl.inside_chart(features, x, y, margin=20):
            continue
        placer.place(
            x,
            y,
            label_text(row),
            fontsize=label_fontsize(row),
            color=symbol_color(row),
            candidates=label_candidates(row),
            zorder=7,
            allow_skip=True,
            max_score=label_max_score(row),
        )


def write_csv(features: dict[str, object]) -> None:
    path = OUTPUT_DIR / "stlouis_navaids.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "nav_id",
                "nav_type",
                "name",
                "city",
                "lat",
                "lon",
                "frequency",
                "channel",
                "status",
                "voice_call",
                "ndb_class",
            ]
        )
        for row in sorted(features["navaids"], key=lambda item: (TYPE_PRIORITY.get(item["nav_type"], 99), item["nav_id"])):
            writer.writerow(
                [
                    row["nav_id"],
                    row["nav_type"],
                    row["name"],
                    row["city"],
                    f"{row['lat']:.8f}",
                    f"{row['lon']:.8f}",
                    row["freq"],
                    row["channel"],
                    row["status"],
                    row["voice_call"],
                    row["ndb_class"],
                ]
            )


def write_summary(features: dict[str, object]) -> None:
    transform = features["chart_transform"]
    type_counts = Counter(row["nav_type"] for row in features["navaids"])
    lines = [
        "Chart: St. Louis Sectional",
        f"Sectional extent assumption: {features['region']}",
        f"Airport control points used: {len(transform['control_points'])}",
        f"Median alignment residual (px): {transform['median_residual_px']:.2f}",
        f"Mean alignment residual (px): {transform['mean_residual_px']:.2f}",
        f"Max alignment residual (px): {transform['max_residual_px']:.2f}",
        f"NAVAIDs rendered: {len(features['navaids'])}",
        "",
        "Type counts:",
    ]
    for nav_type, count in sorted(type_counts.items()):
        lines.append(f"- {nav_type}: {count}")
    (OUTPUT_DIR / "stlouis_navaids_summary.txt").write_text("\n".join(lines), encoding="utf-8")


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
    draw_symbols(ax, features)
    fig.savefig(
        OUTPUT_DIR / "02_stlouis_navaids_symbols_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_labels_transparent(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    setup_axes(ax, features, None)
    draw_symbols(ax, features)
    draw_labels(ax, features)
    fig.savefig(
        OUTPUT_DIR / "03_stlouis_navaids_labels_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_overlay(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    draw_symbols(ax, features)
    draw_labels(ax, features)
    fig.savefig(OUTPUT_DIR / "04_stlouis_navaids_overlay.png", pad_inches=0)
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
