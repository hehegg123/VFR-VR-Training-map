from __future__ import annotations

import csv
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt

import build_indy_vfr_layers as base
import build_daytona_airspaces_layer as stl
import daytona_geotiff as geo


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = PROTOTYPE_ROOT / "outputs"
OUTPUT_DIR = OUTPUT_ROOT / "daytona" / "intersections"
CSV_DIR = stl.CSV_DIR
FULL_REGION = stl.FULL_REGION

IMPORTANT_TYPES = {"ENROUTE LOW", "SECTIONAL"}


def load_charting() -> dict[str, set[str]]:
    charting: defaultdict[str, set[str]] = defaultdict(set)
    for row in stl.read_csv_from_dir("FIX_CHRT.csv"):
        charting[row["FIX_ID"]].add(row["CHARTING_TYPE_DESC"])
    return charting


def load_victor_fix_ids() -> set[str]:
    fix_ids: set[str] = set()
    for row in stl.read_csv_from_dir("AWY_SEG_ALT.csv"):
        airway_id = row["AWY_ID"]
        if not airway_id.startswith("V"):
            continue
        fix_ids.add(row["FROM_POINT"])
        fix_ids.add(row["TO_POINT"])
    return fix_ids


def build_features() -> dict[str, object]:
    image = geo.load_chart_background(FULL_REGION) if geo.has_chart() else base.load_chart_background(FULL_REGION)
    light_bg = base.lighten_background(image, factor=0.44)
    airports = stl.load_public_airports(FULL_REGION)
    chart_transform = geo.build_chart_transform(FULL_REGION) if geo.has_chart() else stl.calibrate_full_chart_transform(image, FULL_REGION, airports)

    charting = load_charting()
    victor_fix_ids = load_victor_fix_ids()

    intersections = []
    for row in stl.read_csv_from_dir("FIX_BASE.csv"):
        try:
            lat = float(row["LAT_DECIMAL"])
            lon = float(row["LONG_DECIMAL"])
        except ValueError:
            continue
        if not base.bbox_intersects(lon, lon, lat, lat, FULL_REGION):
            continue
        types = charting.get(row["FIX_ID"], set())
        if not (types & IMPORTANT_TYPES):
            continue
        intersections.append(
            {
                "fix_id": row["FIX_ID"],
                "lat": lat,
                "lon": lon,
                "point_type": row.get("FIX_USE_CODE", "").strip(),
                "charting_types": types,
                "used_by_victor": row["FIX_ID"] in victor_fix_ids,
                "charts": row.get("CHARTS", ""),
            }
        )

    return {
        "region": FULL_REGION,
        "background": image,
        "light_bg": light_bg,
        "chart_transform": chart_transform,
        "intersections": intersections,
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


def draw_points(ax, features: dict[str, object]) -> None:
    ordered = sorted(
        features["intersections"],
        key=lambda row: (
            not row["used_by_victor"],
            "SECTIONAL" not in row["charting_types"],
            row["fix_id"],
        ),
    )
    for row in ordered:
        x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl.inside_chart(features, x, y, margin=24):
            continue
        color = "#0f4c81" if row["used_by_victor"] else "#1d4ed8"
        marker = "x" if row["used_by_victor"] else "+"
        size = 20 if row["used_by_victor"] else 12
        linewidth = 0.85 if row["used_by_victor"] else 0.65
        ax.scatter(
            [x],
            [y],
            marker=marker,
            s=size,
            linewidths=linewidth,
            color=color,
            alpha=0.92,
            zorder=5,
        )


def label_candidates(used_by_victor: bool):
    radii = [7, 12, 18, 26, 34] if used_by_victor else [7, 12, 18, 24]
    return stl.radial_candidates(
        radii,
        [(1, -1), (1, 1), (-1, -1), (-1, 1), (1, 0), (-1, 0), (0, -1), (0, 1)],
    )


def draw_labels(ax, features: dict[str, object]) -> None:
    ax.figure.canvas.draw()
    placer = stl.LabelPlacer(ax)
    ordered = sorted(
        features["intersections"],
        key=lambda row: (
            not row["used_by_victor"],
            "SECTIONAL" not in row["charting_types"],
            row["fix_id"],
        ),
    )
    for row in ordered:
        x, y = stl.lonlat_to_chart_xy(features, row["lon"], row["lat"])
        if not stl.inside_chart(features, x, y, margin=24):
            continue
        color = "#0b3d63" if row["used_by_victor"] else "#1d4ed8"
        fontsize = 4.6 if row["used_by_victor"] else 4.1
        max_score = 600.0 if row["used_by_victor"] else 260.0
        placer.place(
            x,
            y,
            row["fix_id"],
            fontsize=fontsize,
            color=color,
            candidates=label_candidates(row["used_by_victor"]),
            zorder=7,
            allow_skip=True,
            max_score=max_score,
        )


def write_csv(features: dict[str, object]) -> None:
    path = OUTPUT_DIR / "stlouis_intersections.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["fix_id", "lat", "lon", "used_by_victor", "charting_types", "charts"])
        for row in sorted(features["intersections"], key=lambda item: item["fix_id"]):
            writer.writerow(
                [
                    row["fix_id"],
                    f"{row['lat']:.8f}",
                    f"{row['lon']:.8f}",
                    "Y" if row["used_by_victor"] else "N",
                    ",".join(sorted(row["charting_types"])),
                    row["charts"],
                ]
            )


def write_summary(features: dict[str, object]) -> None:
    transform = features["chart_transform"]
    chart_type_counts = Counter()
    for row in features["intersections"]:
        for chart_type in row["charting_types"]:
            chart_type_counts[chart_type] += 1
    lines = [
        "Chart: St. Louis Sectional",
        f"Sectional extent assumption: {features['region']}",
        f"Airport control points used: {len(transform['control_points'])}",
        f"Median alignment residual (px): {transform['median_residual_px']:.2f}",
        f"Mean alignment residual (px): {transform['mean_residual_px']:.2f}",
        f"Max alignment residual (px): {transform['max_residual_px']:.2f}",
        f"Intersections rendered: {len(features['intersections'])}",
        f"Victor-connected intersections: {sum(1 for row in features['intersections'] if row['used_by_victor'])}",
        "",
        "Charting-type counts:",
    ]
    for chart_type, count in sorted(chart_type_counts.items()):
        lines.append(f"- {chart_type}: {count}")
    (OUTPUT_DIR / "stlouis_intersections_summary.txt").write_text("\n".join(lines), encoding="utf-8")


def render_chart_reference(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    fig.savefig(OUTPUT_DIR / "01_stlouis_chart_frame.png", pad_inches=0)
    plt.close(fig)


def render_points_transparent(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    setup_axes(ax, features, None)
    draw_points(ax, features)
    fig.savefig(
        OUTPUT_DIR / "02_stlouis_intersections_points_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_labels_transparent(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    setup_axes(ax, features, None)
    draw_points(ax, features)
    draw_labels(ax, features)
    fig.savefig(
        OUTPUT_DIR / "03_stlouis_intersections_labels_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_overlay(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    draw_points(ax, features)
    draw_labels(ax, features)
    fig.savefig(OUTPUT_DIR / "04_stlouis_intersections_overlay.png", pad_inches=0)
    plt.close(fig)


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    features = build_features()
    render_chart_reference(features)
    render_points_transparent(features)
    render_labels_transparent(features)
    render_overlay(features)
    write_csv(features)
    write_summary(features)


if __name__ == "__main__":
    main()
