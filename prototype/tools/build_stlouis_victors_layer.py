from __future__ import annotations

import csv
import math
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt

import build_indy_vfr_layers as base
import build_stlouis_airspaces_layer as stl
import stlouis_geotiff as geo


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = PROTOTYPE_ROOT / "outputs"
OUTPUT_DIR = OUTPUT_ROOT / "stlouis" / "victors"
CSV_DIR = stl.CSV_DIR
FULL_REGION = stl.FULL_REGION


def expand_region(region: tuple[float, float, float, float], lon_pad: float = 1.0, lat_pad: float = 1.0):
    return (
        region[0] - lon_pad,
        region[1] + lon_pad,
        region[2] - lat_pad,
        region[3] + lat_pad,
    )


def parse_float(value: str) -> float | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def load_fix_lookup(region: tuple[float, float, float, float]) -> dict[str, dict[str, object]]:
    fixes: dict[str, dict[str, object]] = {}
    expanded = expand_region(region, 1.25, 1.25)
    for row in stl.read_csv_from_dir("FIX_BASE.csv"):
        lat = parse_float(row.get("LAT_DECIMAL", ""))
        lon = parse_float(row.get("LONG_DECIMAL", ""))
        if lat is None or lon is None:
            continue
        if not base.bbox_intersects(lon, lon, lat, lat, expanded):
            continue
        fixes[row["FIX_ID"]] = {
            "id": row["FIX_ID"],
            "lat": lat,
            "lon": lon,
            "point_type": row.get("FIX_USE_CODE", "").strip(),
        }
    return fixes


def load_nav_lookup(region: tuple[float, float, float, float]) -> dict[str, list[dict[str, object]]]:
    navs: defaultdict[str, list[dict[str, object]]] = defaultdict(list)
    expanded = expand_region(region, 1.25, 1.25)
    for row in stl.read_csv_from_dir("NAV_BASE.csv"):
        lat = parse_float(row.get("LAT_DECIMAL", ""))
        lon = parse_float(row.get("LONG_DECIMAL", ""))
        if lat is None or lon is None:
            continue
        if not base.bbox_intersects(lon, lon, lat, lat, expanded):
            continue
        navs[row["NAV_ID"]].append(
            {
                "id": row["NAV_ID"],
                "lat": lat,
                "lon": lon,
                "nav_type": row.get("NAV_TYPE", "").strip(),
                "name": row.get("NAME", "").strip(),
            }
        )
    return navs


def resolve_nav(point_id: str, nav_lookup: dict[str, list[dict[str, object]]]) -> dict[str, object] | None:
    candidates = nav_lookup.get(point_id, [])
    if not candidates:
        return None
    candidates = sorted(
        candidates,
        key=lambda row: (
            row.get("nav_type") == "NDB",
            row.get("nav_type"),
            row.get("name"),
        ),
    )
    return candidates[0]


def load_airway_meta() -> dict[str, dict[str, str]]:
    meta = {}
    for row in stl.read_csv_from_dir("AWY_BASE.csv"):
        airway_id = row["AWY_ID"]
        if not airway_id.startswith("V"):
            continue
        points = [token for token in row.get("AIRWAY_STRING", "").split() if token]
        meta[airway_id] = {
            "airway_string": row.get("AIRWAY_STRING", ""),
            "start_id": points[0] if points else "",
            "end_id": points[-1] if points else "",
        }
    return meta


def format_nm(value: float | None) -> str:
    if value is None:
        return ""
    if abs(value - round(value)) < 0.05:
        return f"{int(round(value))} NM"
    return f"{value:.1f} NM"


def short_dir(value: str) -> str:
    value = (value or "").strip()
    return value.replace(" BND", "")


def format_altitude_lines(row: dict[str, str]) -> list[str]:
    lines: list[str] = []
    mea = (row.get("MIN_ENROUTE_ALT") or "").strip()
    mea_dir = short_dir(row.get("MIN_ENROUTE_ALT_DIR", ""))
    mea_opp = (row.get("MIN_ENROUTE_ALT_OPPOSITE") or "").strip()
    mea_opp_dir = short_dir(row.get("MIN_ENROUTE_ALT_OPPOSITE_DIR", ""))
    if mea and mea_opp and mea_opp != mea:
        dir_a = f" {mea_dir}" if mea_dir else ""
        dir_b = f" {mea_opp_dir}" if mea_opp_dir else ""
        lines.append(f"MEA {mea}{dir_a} / {mea_opp}{dir_b}")
    elif mea:
        lines.append(f"MEA {mea}")

    moca = (row.get("MIN_OBSTN_CLNC_ALT") or "").strip()
    if moca:
        lines.append(f"MOCA {moca}")

    mca = (row.get("MIN_CROSS_ALT") or "").strip()
    mca_dir = short_dir(row.get("MIN_CROSS_ALT_DIR", ""))
    mca_pt = (row.get("MIN_CROSS_ALT_NAV_PT") or "").strip()
    if mca:
        suffix = f" {mca_dir}" if mca_dir else ""
        if mca_pt:
            lines.append(f"MCA {mca}{suffix} @{mca_pt}")
        else:
            lines.append(f"MCA {mca}{suffix}")

    max_auth = (row.get("MAX_AUTH_ALT") or "").strip()
    if max_auth and max_auth not in {"60000"}:
        lines.append(f"MAA {max_auth}")
    return lines


class VictorLabelPlacer(stl.LabelPlacer):
    def place_box(
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
        weight: str = "normal",
        box_alpha: float = 0.78,
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
                weight=weight,
                ha=ha,
                va=va,
                zorder=zorder,
                clip_on=True,
                linespacing=1.06,
                bbox={
                    "boxstyle": "round,pad=0.16",
                    "facecolor": "white",
                    "edgecolor": "none",
                    "alpha": box_alpha,
                },
                path_effects=[pe.withStroke(linewidth=0.8, foreground="white", alpha=0.9)],
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
                return None
            self.occupied.append(best_bbox)
            best_x, best_y = best_artist.get_position()
            return {
                "x": float(best_x),
                "y": float(best_y),
                "bbox": best_bbox,
                "score": float(best_score if best_score is not None else 0.0),
            }
        return None


def segment_candidates(start: tuple[float, float], end: tuple[float, float]) -> list[tuple[float, float, str, str]]:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = max((dx * dx + dy * dy) ** 0.5, 1.0)
    tx = dx / length
    ty = dy / length
    nx = -dy / length
    ny = dx / length

    candidates: list[tuple[float, float, str, str]] = []
    for normal_dist in [14, 22, 32, 44, 58]:
        for side in [1, -1]:
            for along in [0, 12, -12, 24, -24]:
                ox = nx * normal_dist * side + tx * along
                oy = ny * normal_dist * side + ty * along
                ha, va = stl.alignment_for_offset(ox, oy)
                candidates.append((ox, oy, ha, va))
    return candidates


def clip_segment_to_chart(
    width: float,
    height: float,
    start: tuple[float, float],
    end: tuple[float, float],
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    x0, y0 = start
    x1, y1 = end
    dx = x1 - x0
    dy = y1 - y0
    t0 = 0.0
    t1 = 1.0

    for p, q in (
        (-dx, x0),
        (dx, width - x0),
        (-dy, y0),
        (dy, height - y0),
    ):
        if abs(p) < 1e-9:
            if q < 0:
                return None
            continue

        ratio = q / p
        if p < 0:
            if ratio > t1:
                return None
            t0 = max(t0, ratio)
        else:
            if ratio < t0:
                return None
            t1 = min(t1, ratio)

    return (
        (x0 + dx * t0, y0 + dy * t0),
        (x0 + dx * t1, y0 + dy * t1),
    )


def segment_chart_points(seg: dict[str, object]) -> tuple[tuple[float, float], tuple[float, float]]:
    return seg["visible_start_xy"], seg["visible_end_xy"]


def build_features() -> dict[str, object]:
    image = geo.load_chart_background(FULL_REGION) if geo.has_chart() else base.load_chart_background(FULL_REGION)
    light_bg = base.lighten_background(image, factor=0.44)
    airports = stl.load_public_airports(FULL_REGION)
    chart_transform = geo.build_chart_transform(FULL_REGION) if geo.has_chart() else stl.calibrate_full_chart_transform(image, FULL_REGION, airports)

    fix_lookup = load_fix_lookup(FULL_REGION)
    nav_lookup = load_nav_lookup(FULL_REGION)
    airway_meta = load_airway_meta()
    chart_features = {
        "background": image,
        "chart_transform": chart_transform,
    }
    height, width = image.shape[:2]

    airway_segments: list[dict[str, object]] = []
    grouped: defaultdict[str, list[dict[str, object]]] = defaultdict(list)

    for row in stl.read_csv_from_dir("AWY_SEG_ALT.csv"):
        airway_id = row["AWY_ID"]
        if not airway_id.startswith("V"):
            continue

        from_row = fix_lookup.get(row["FROM_POINT"]) or resolve_nav(row["FROM_POINT"], nav_lookup)
        to_row = fix_lookup.get(row["TO_POINT"]) or resolve_nav(row["TO_POINT"], nav_lookup)
        if not from_row or not to_row:
            continue

        from_coord = (float(from_row["lat"]), float(from_row["lon"]))
        to_coord = (float(to_row["lat"]), float(to_row["lon"]))
        seg_left = min(from_coord[1], to_coord[1])
        seg_right = max(from_coord[1], to_coord[1])
        seg_bottom = min(from_coord[0], to_coord[0])
        seg_top = max(from_coord[0], to_coord[0])
        if not base.bbox_intersects(seg_left, seg_right, seg_bottom, seg_top, FULL_REGION):
            continue

        chart_start = stl.lonlat_to_chart_xy(chart_features, from_coord[1], from_coord[0])
        chart_end = stl.lonlat_to_chart_xy(chart_features, to_coord[1], to_coord[0])
        clipped = clip_segment_to_chart(width, height, chart_start, chart_end)
        if clipped is None:
            continue

        distance_nm = parse_float(row.get("MAG_COURSE_DIST", ""))
        altitude_lines = format_altitude_lines(row)
        segment = {
            "airway_id": airway_id,
            "point_seq": int(row.get("POINT_SEQ") or 0),
            "from_id": row["FROM_POINT"],
            "to_id": row["TO_POINT"],
            "from": from_coord,
            "to": to_coord,
            "distance_nm": distance_nm,
            "altitude_lines": altitude_lines,
            "row": row,
            "airway_meta": airway_meta.get(airway_id, {}),
            "chart_start": chart_start,
            "chart_end": chart_end,
            "visible_start_xy": clipped[0],
            "visible_end_xy": clipped[1],
            "from_inside_chart": stl.inside_chart(chart_features, chart_start[0], chart_start[1]),
            "to_inside_chart": stl.inside_chart(chart_features, chart_end[0], chart_end[1]),
            "visible_length_px": math.hypot(clipped[1][0] - clipped[0][0], clipped[1][1] - clipped[0][1]),
        }
        airway_segments.append(segment)
        grouped[airway_id].append(segment)

    airway_labels = []
    for airway_id, segments in grouped.items():
        ordered = sorted(segments, key=lambda item: item["point_seq"])
        representative = max(
            segments,
            key=lambda item: (item["visible_length_px"], item["distance_nm"] or 0.0),
        )
        visible_start = ordered[0]["from_id"]
        visible_end = ordered[-1]["to_id"]
        airway_labels.append(
            {
                "airway_id": airway_id,
                "visible_start": visible_start,
                "visible_end": visible_end,
                "representative": representative,
                "segment_count": len(segments),
            }
        )

    return {
        "region": FULL_REGION,
        "background": image,
        "light_bg": light_bg,
        "chart_transform": chart_transform,
        "airports": airports,
        "airway_segments": airway_segments,
        "airway_labels": sorted(airway_labels, key=lambda row: row["airway_id"]),
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


def draw_victor_lines(ax, features: dict[str, object]) -> None:
    for seg in features["airway_segments"]:
        start, end = segment_chart_points(seg)
        ax.plot(
            [start[0], end[0]],
            [start[1], end[1]],
            color="#0f4c81",
            linewidth=1.0,
            alpha=0.94,
            zorder=4,
            path_effects=[pe.withStroke(linewidth=2.4, foreground="white", alpha=0.7)],
        )
        scatter_xs = []
        scatter_ys = []
        if seg["from_inside_chart"]:
            scatter_xs.append(seg["chart_start"][0])
            scatter_ys.append(seg["chart_start"][1])
        if seg["to_inside_chart"]:
            scatter_xs.append(seg["chart_end"][0])
            scatter_ys.append(seg["chart_end"][1])
        if scatter_xs:
            ax.scatter(
                scatter_xs,
                scatter_ys,
                s=7,
                facecolors="white",
                edgecolors="#0f4c81",
                linewidths=0.6,
                zorder=5,
                alpha=0.92,
            )


def draw_airway_name_labels(ax, features: dict[str, object], placer: VictorLabelPlacer) -> None:
    for meta in sorted(features["airway_labels"], key=lambda row: row["airway_id"]):
        seg = meta["representative"]
        start, end = segment_chart_points(seg)
        mid_x = (start[0] + end[0]) / 2.0
        mid_y = (start[1] + end[1]) / 2.0
        text = f"{meta['airway_id']}\n{meta['visible_start']}-{meta['visible_end']}"
        placer.place_box(
            mid_x,
            mid_y,
            text,
            fontsize=4.4,
            color="#0b3d63",
            candidates=segment_candidates(start, end),
            zorder=8,
            allow_skip=False,
            weight="bold",
            box_alpha=0.82,
        )


def compute_airway_label_layout(features: dict[str, object]) -> list[dict[str, object]]:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    try:
        ax.patch.set_alpha(0)
        setup_axes(ax, features, None)
        draw_victor_lines(ax, features)
        ax.figure.canvas.draw()
        placer = VictorLabelPlacer(ax)
        layout: list[dict[str, object]] = []
        for meta in sorted(features["airway_labels"], key=lambda row: row["airway_id"]):
            seg = meta["representative"]
            start, end = segment_chart_points(seg)
            mid_x = (start[0] + end[0]) / 2.0
            mid_y = (start[1] + end[1]) / 2.0
            text = f"{meta['airway_id']}\n{meta['visible_start']}-{meta['visible_end']}"
            placement = placer.place_box(
                mid_x,
                mid_y,
                text,
                fontsize=4.4,
                color="#0b3d63",
                candidates=segment_candidates(start, end),
                zorder=8,
                allow_skip=False,
                weight="bold",
                box_alpha=0.82,
            )
            if placement is None:
                continue
            layout.append(
                {
                    "airway_id": meta["airway_id"],
                    "visible_start": meta["visible_start"],
                    "visible_end": meta["visible_end"],
                    "x": placement["x"],
                    "y": placement["y"],
                    "priority": min(1.0, 0.35 + meta["segment_count"] * 0.02),
                }
            )
        return layout
    finally:
        plt.close(fig)


def segment_label_text(seg: dict[str, object]) -> str:
    line1 = f"{seg['airway_id']}  {seg['from_id']}->{seg['to_id']}"
    line2 = format_nm(seg["distance_nm"])
    altitude_lines = seg["altitude_lines"] or ["MEA n/a"]
    return "\n".join([line1, line2, *altitude_lines])


def draw_segment_details(ax, features: dict[str, object], placer: VictorLabelPlacer) -> None:
    ordered = sorted(
        features["airway_segments"],
        key=lambda seg: (
            -(seg["distance_nm"] or 0.0),
            seg["airway_id"],
            seg["point_seq"],
        ),
    )
    for seg in ordered:
        start, end = segment_chart_points(seg)
        mid_x = (start[0] + end[0]) / 2.0
        mid_y = (start[1] + end[1]) / 2.0
        placer.place_box(
            mid_x,
            mid_y,
            segment_label_text(seg),
            fontsize=3.7,
            color="#16324f",
            candidates=segment_candidates(start, end),
            zorder=9,
            allow_skip=False,
            box_alpha=0.76,
        )


def write_segment_csv(features: dict[str, object]) -> None:
    path = OUTPUT_DIR / "stlouis_victor_segments.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "airway_id",
                "visible_start",
                "visible_end",
                "point_seq",
                "from_point",
                "to_point",
                "distance_nm",
                "mea",
                "mea_dir",
                "mea_opposite",
                "mea_opposite_dir",
                "moca",
                "mca",
                "mca_dir",
                "mca_nav_point",
                "max_auth_alt",
                "altitude_summary",
            ]
        )
        meta_lookup = {row["airway_id"]: row for row in features["airway_labels"]}
        for seg in sorted(features["airway_segments"], key=lambda row: (row["airway_id"], row["point_seq"])):
            row = seg["row"]
            meta = meta_lookup[seg["airway_id"]]
            writer.writerow(
                [
                    seg["airway_id"],
                    meta["visible_start"],
                    meta["visible_end"],
                    seg["point_seq"],
                    seg["from_id"],
                    seg["to_id"],
                    "" if seg["distance_nm"] is None else f"{seg['distance_nm']:.2f}",
                    row.get("MIN_ENROUTE_ALT", ""),
                    row.get("MIN_ENROUTE_ALT_DIR", ""),
                    row.get("MIN_ENROUTE_ALT_OPPOSITE", ""),
                    row.get("MIN_ENROUTE_ALT_OPPOSITE_DIR", ""),
                    row.get("MIN_OBSTN_CLNC_ALT", ""),
                    row.get("MIN_CROSS_ALT", ""),
                    row.get("MIN_CROSS_ALT_DIR", ""),
                    row.get("MIN_CROSS_ALT_NAV_PT", ""),
                    row.get("MAX_AUTH_ALT", ""),
                    " | ".join(seg["altitude_lines"]),
                ]
            )


def write_summary(features: dict[str, object]) -> None:
    transform = features["chart_transform"]
    counts = Counter(seg["airway_id"] for seg in features["airway_segments"])
    lines = [
        "Chart: St. Louis Sectional",
        f"Sectional extent assumption: {features['region']}",
        f"Airport control points used: {len(transform['control_points'])}",
        f"Median alignment residual (px): {transform['median_residual_px']:.2f}",
        f"Mean alignment residual (px): {transform['mean_residual_px']:.2f}",
        f"Max alignment residual (px): {transform['max_residual_px']:.2f}",
        f"Victor airways rendered: {len(features['airway_labels'])}",
        f"Victor airway segments rendered: {len(features['airway_segments'])}",
        "Outputs include full segment metadata in stlouis_victor_segments.csv.",
        "",
        "Segments per airway:",
    ]
    for airway_id, count in sorted(counts.items()):
        lines.append(f"- {airway_id}: {count}")
    (OUTPUT_DIR / "stlouis_victors_summary.txt").write_text("\n".join(lines), encoding="utf-8")


def render_chart_reference(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    fig.savefig(OUTPUT_DIR / "01_stlouis_chart_frame.png", pad_inches=0)
    plt.close(fig)


def render_network_transparent(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    setup_axes(ax, features, None)
    draw_victor_lines(ax, features)
    ax.figure.canvas.draw()
    placer = VictorLabelPlacer(ax)
    draw_airway_name_labels(ax, features, placer)
    fig.savefig(
        OUTPUT_DIR / "02_stlouis_victors_network_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_detail_transparent(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    setup_axes(ax, features, None)
    draw_victor_lines(ax, features)
    ax.figure.canvas.draw()
    placer = VictorLabelPlacer(ax)
    draw_airway_name_labels(ax, features, placer)
    draw_segment_details(ax, features, placer)
    fig.savefig(
        OUTPUT_DIR / "03_stlouis_victors_detail_transparent.png",
        pad_inches=0,
        transparent=True,
    )
    plt.close(fig)


def render_overlay(features: dict[str, object]) -> None:
    fig, ax = plt.subplots(figsize=geo.figure_size_for_background(features["background"]), dpi=180)
    setup_axes(ax, features, None)
    draw_background(ax, features, faded=False)
    draw_victor_lines(ax, features)
    ax.figure.canvas.draw()
    placer = VictorLabelPlacer(ax)
    draw_airway_name_labels(ax, features, placer)
    draw_segment_details(ax, features, placer)
    fig.savefig(OUTPUT_DIR / "04_stlouis_victors_overlay.png", pad_inches=0)
    plt.close(fig)


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    features = build_features()
    render_chart_reference(features)
    render_network_transparent(features)
    render_detail_transparent(features)
    render_overlay(features)
    write_segment_csv(features)
    write_summary(features)


if __name__ == "__main__":
    main()
