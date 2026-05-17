from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DATA_ROOT = PROTOTYPE_ROOT / "reference-data"
GEOTIFF_DIR = REFERENCE_DATA_ROOT / "stlouis" / "St_Louis_geotiff"
GEOTIFF_PATH = GEOTIFF_DIR / "St Louis SEC.tif"
WORLD_FILE_PATH = GEOTIFF_DIR / "St Louis SEC.tfw"
DISPLAY_CACHE_PATH = GEOTIFF_DIR / "St Louis SEC.display_3330.png"
DISPLAY_MAX_WIDTH = 3330
# Tight crop of the actual sectional map face within the display image.
# This excludes the printed legend strip on the left and the annotation/footer
# block below the chart so VR overlays only stage over the usable map area.
MAP_FACE_DISPLAY_BOX = (592, 0, 3330, 2087)


def has_chart() -> bool:
    return GEOTIFF_PATH.exists() and WORLD_FILE_PATH.exists()


def _deg(value: float) -> float:
    return math.radians(value)


def _read_world_file() -> tuple[float, float, float, float, float, float]:
    values = [float(line.strip()) for line in WORLD_FILE_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(values) != 6:
        raise RuntimeError(f"Unexpected world file content in {WORLD_FILE_PATH}")
    return tuple(values)  # type: ignore[return-value]


def _eccentricity(a: float, inv_f: float) -> float:
    f = 1.0 / inv_f
    return math.sqrt(2.0 * f - f * f)


def _m(phi: float, e: float) -> float:
    sin_phi = math.sin(phi)
    return math.cos(phi) / math.sqrt(1.0 - e * e * sin_phi * sin_phi)


def _t(phi: float, e: float) -> float:
    sin_phi = math.sin(phi)
    ratio = (1.0 - e * sin_phi) / (1.0 + e * sin_phi)
    return math.tan(math.pi / 4.0 - phi / 2.0) / (ratio ** (e / 2.0))


def _build_projection() -> dict[str, float]:
    if not has_chart():
        raise RuntimeError("St. Louis GeoTIFF files are missing")

    Image.MAX_IMAGE_PIXELS = None
    with Image.open(GEOTIFF_PATH) as image:
        geo_keys = tuple(int(value) for value in image.tag_v2.get(34735))
        geo_double = tuple(float(value) for value in image.tag_v2.get(34736))
        width, height = image.size

    if len(geo_keys) < 8 or len(geo_double) < 2:
        raise RuntimeError("GeoTIFF projection metadata is missing or incomplete")

    doubles_by_key: dict[int, float] = {}
    start = 4
    while start + 3 < len(geo_keys):
        key_id, tiff_tag_location, count, value_offset = geo_keys[start : start + 4]
        start += 4
        if tiff_tag_location == 34736 and count == 1 and value_offset < len(geo_double):
            doubles_by_key[key_id] = geo_double[value_offset]

    std_parallel_1 = doubles_by_key[3078]
    std_parallel_2 = doubles_by_key[3079]
    central_meridian = doubles_by_key[3084]
    lat_origin = doubles_by_key[3085]
    false_easting = doubles_by_key[3086]
    false_northing = doubles_by_key[3087]
    inv_f = doubles_by_key[2059]
    semi_major = doubles_by_key[2057]
    phi1 = _deg(std_parallel_1)
    phi2 = _deg(std_parallel_2)
    lat0 = _deg(lat_origin)
    lon0 = _deg(central_meridian)
    e = _eccentricity(semi_major, inv_f)

    if abs(phi1 - phi2) < 1e-12:
        n = math.sin(phi1)
    else:
        n = (math.log(_m(phi1, e)) - math.log(_m(phi2, e))) / (math.log(_t(phi1, e)) - math.log(_t(phi2, e)))
    f_value = _m(phi1, e) / (n * (_t(phi1, e) ** n))
    rho0 = semi_major * f_value * (_t(lat0, e) ** n)

    return {
        "a": semi_major,
        "inv_f": inv_f,
        "e": e,
        "phi1": phi1,
        "phi2": phi2,
        "lat0": lat0,
        "lon0": lon0,
        "false_easting": false_easting,
        "false_northing": false_northing,
        "n": n,
        "f_value": f_value,
        "rho0": rho0,
        "width": width,
        "height": height,
    }


def _project_lonlat_to_model(meta: dict[str, float], lon: float, lat: float) -> tuple[float, float]:
    lam = _deg(lon)
    phi = _deg(lat)
    theta = meta["n"] * (lam - meta["lon0"])
    rho = meta["a"] * meta["f_value"] * (_t(phi, meta["e"]) ** meta["n"])
    x = meta["false_easting"] + rho * math.sin(theta)
    y = meta["false_northing"] + meta["rho0"] - rho * math.cos(theta)
    return x, y


def _project_model_to_lonlat(meta: dict[str, float], x: float, y: float) -> tuple[float, float]:
    x_adj = x - meta["false_easting"]
    y_adj = meta["rho0"] - (y - meta["false_northing"])
    rho = math.copysign(math.hypot(x_adj, y_adj), meta["n"])
    theta = math.atan2(x_adj, y_adj)
    t_value = (rho / (meta["a"] * meta["f_value"])) ** (1.0 / meta["n"])

    phi = math.pi / 2.0 - 2.0 * math.atan(t_value)
    for _ in range(8):
        sin_phi = math.sin(phi)
        ratio = (1.0 - meta["e"] * sin_phi) / (1.0 + meta["e"] * sin_phi)
        phi = math.pi / 2.0 - 2.0 * math.atan(t_value * (ratio ** (meta["e"] / 2.0)))

    lam = meta["lon0"] + theta / meta["n"]
    return math.degrees(lam), math.degrees(phi)


def _pixel_to_model(meta: dict[str, float], col: float, row: float) -> tuple[float, float]:
    a, b, d, e, c, f_value = _read_world_file()
    x = a * col + b * row + c
    y = d * col + e * row + f_value
    return x, y


def _model_to_pixel(meta: dict[str, float], x: float, y: float) -> tuple[float, float]:
    a, _, _, e, c, f_value = _read_world_file()
    col = (x - c) / a
    row = (y - f_value) / e
    return col, row


def _ensure_display_cache(meta: dict[str, float]) -> None:
    if DISPLAY_CACHE_PATH.exists():
        return
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(GEOTIFF_PATH) as image:
        rgb = image.convert("RGB")
        if rgb.size[0] > DISPLAY_MAX_WIDTH:
            display_height = round(rgb.size[1] * DISPLAY_MAX_WIDTH / rgb.size[0])
            rgb = rgb.resize((DISPLAY_MAX_WIDTH, display_height), Image.Resampling.LANCZOS)
        rgb.save(DISPLAY_CACHE_PATH)


def _display_box_to_full_res_box(box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    meta = chart_metadata()
    scale_x = float(meta["scale_x"])
    scale_y = float(meta["scale_y"])
    full_width = int(meta["projection"]["width"])  # type: ignore[index]
    full_height = int(meta["projection"]["height"])  # type: ignore[index]
    x0 = max(0, int(round(box[0] / scale_x)))
    y0 = max(0, int(round(box[1] / scale_y)))
    x1 = min(full_width, int(round(box[2] / scale_x)))
    y1 = min(full_height, int(round(box[3] / scale_y)))
    return x0, y0, x1, y1


@lru_cache(maxsize=1)
def chart_metadata() -> dict[str, object]:
    meta = _build_projection()
    _ensure_display_cache(meta)
    display_image = Image.open(DISPLAY_CACHE_PATH)
    display_width, display_height = display_image.size
    display_image.close()

    scale_x = display_width / float(meta["width"])
    scale_y = display_height / float(meta["height"])

    corners = [
        _project_model_to_lonlat(meta, *_pixel_to_model(meta, 0.0, 0.0)),
        _project_model_to_lonlat(meta, *_pixel_to_model(meta, meta["width"] - 1.0, 0.0)),
        _project_model_to_lonlat(meta, *_pixel_to_model(meta, meta["width"] - 1.0, meta["height"] - 1.0)),
        _project_model_to_lonlat(meta, *_pixel_to_model(meta, 0.0, meta["height"] - 1.0)),
    ]
    lons = [lon for lon, _ in corners]
    lats = [lat for _, lat in corners]

    return {
        "projection": meta,
        "display_width": display_width,
        "display_height": display_height,
        "scale_x": scale_x,
        "scale_y": scale_y,
        "lonlat_bbox": (min(lons), max(lons), min(lats), max(lats)),
    }


CHART_LONLAT_BBOX = chart_metadata()["lonlat_bbox"] if has_chart() else None


def figure_size_for_background(background: np.ndarray, width_inches: float = 18.5) -> tuple[float, float]:
    height, width = background.shape[:2]
    return width_inches, width_inches * height / width


def _load_full_display_image() -> np.ndarray:
    _ensure_display_cache(chart_metadata()["projection"])  # type: ignore[arg-type]
    with Image.open(DISPLAY_CACHE_PATH) as image:
        rgb = image.convert("RGB")
        return np.asarray(rgb, dtype=np.float32) / 255.0


def _crop_box(region: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    meta = chart_metadata()
    full_bbox = meta["lonlat_bbox"]
    face_x0, face_y0, face_x1, face_y1 = MAP_FACE_DISPLAY_BOX
    if all(abs(region[idx] - full_bbox[idx]) < 1e-6 for idx in range(4)):
        return face_x0, face_y0, face_x1, face_y1

    left, right, bottom, top = region
    points = [
        full_display_xy(lon, lat)
        for lon, lat in [
            (left, top),
            (right, top),
            (right, bottom),
            (left, bottom),
        ]
    ]
    xs = [pt[0] for pt in points]
    ys = [pt[1] for pt in points]
    x0 = max(face_x0, int(math.floor(min(xs))) - 6)
    y0 = max(face_y0, int(math.floor(min(ys))) - 6)
    x1 = min(face_x1, int(math.ceil(max(xs))) + 7)
    y1 = min(face_y1, int(math.ceil(max(ys))) + 7)
    return x0, y0, x1, y1


def load_chart_background(region: tuple[float, float, float, float]) -> np.ndarray:
    image = _load_full_display_image()
    x0, y0, x1, y1 = _crop_box(region)
    return image[y0:y1, x0:x1].copy()


def full_resolution_crop_box(region: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    return _display_box_to_full_res_box(_crop_box(region))


def load_full_res_chart_background(region: tuple[float, float, float, float]) -> np.ndarray:
    x0, y0, x1, y1 = full_resolution_crop_box(region)
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(GEOTIFF_PATH) as image:
        rgb = image.convert("RGB")
        cropped = rgb.crop((x0, y0, x1, y1))
        return np.asarray(cropped, dtype=np.float32) / 255.0


def build_chart_transform(region: tuple[float, float, float, float]) -> dict[str, object]:
    x0, y0, x1, y1 = _crop_box(region)
    meta = chart_metadata()
    return {
        "kind": "geotiff",
        "crop_box": (x0, y0, x1, y1),
        "control_points": [],
        "median_residual_px": 0.0,
        "mean_residual_px": 0.0,
        "max_residual_px": 0.0,
        "full_display_size": (meta["display_width"], meta["display_height"]),
    }


def full_display_xy(lon: float, lat: float) -> tuple[float, float]:
    meta = chart_metadata()
    proj = meta["projection"]  # type: ignore[assignment]
    model_x, model_y = _project_lonlat_to_model(proj, lon, lat)  # type: ignore[arg-type]
    col, row = _model_to_pixel(proj, model_x, model_y)  # type: ignore[arg-type]
    x = col * float(meta["scale_x"])
    y = row * float(meta["scale_y"])
    return float(x), float(y)


def lonlat_to_chart_xy(transform: dict[str, object], lon: float, lat: float) -> tuple[float, float]:
    x0, y0, _, _ = transform["crop_box"]
    full_x, full_y = full_display_xy(lon, lat)
    return float(full_x - x0), float(full_y - y0)
