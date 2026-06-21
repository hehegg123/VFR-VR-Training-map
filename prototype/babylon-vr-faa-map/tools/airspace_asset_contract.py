from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


REQUIRED_LABEL_FIELDS = (
    "id",
    "selectionId",
    "labelGroup",
    "detailTier",
    "familyKey",
    "airspaceType",
    "placementMode",
    "x",
    "y",
)
REQUIRED_REGION_FIELDS = ("id", "kind", "familyKey", "airspaceType", "anchor", "parts")
VALID_LABEL_GROUPS = {"airfield", "shelf", "special"}
VALID_DETAIL_TIERS = {"core", "extended", "detail"}
VALID_PLACEMENT_MODES = {"interior", "callout"}
SHELF_AIRSPACE_TYPES = {"CLASS_B", "CLASS_C"}
FORBIDDEN_SHELF_AIRSPACE_TYPES = {"CLASS_D", "CLASS_E2"}


class AirspaceAssetValidationError(RuntimeError):
    pass


def compact_number(value: float, digits: int = 3) -> int | float:
    rounded = round(float(value), digits)
    return int(rounded) if rounded.is_integer() else rounded


def _require_builder_fields(row: dict[str, object]) -> None:
    missing = [field for field in REQUIRED_LABEL_FIELDS if row.get(field) in (None, "")]
    if missing:
        label_id = row.get("id", "<missing-id>")
        raise AirspaceAssetValidationError(
            f"builder label {label_id}: missing required metadata: {', '.join(missing)}"
        )


def stage_airspace_label_row(
    row: dict[str, object],
    scale_x: float,
    scale_y: float,
) -> dict[str, object]:
    """Scale a fully classified builder label without changing its placed anchor."""
    _require_builder_fields(row)
    item: dict[str, object] = {
        "id": row["id"],
        "selectionId": row["selectionId"],
        "x": compact_number(float(row["x"]) * scale_x),
        "y": compact_number(float(row["y"]) * scale_y),
        "lines": row["lines"],
        "style": row["style"],
        "priority": row["priority"],
        "labelGroup": row["labelGroup"],
        "detailTier": row["detailTier"],
        "familyKey": row["familyKey"],
        "airspaceType": row["airspaceType"],
        "placementMode": row["placementMode"],
    }
    has_anchor_x = row.get("anchorX") is not None
    has_anchor_y = row.get("anchorY") is not None
    if has_anchor_x != has_anchor_y:
        raise AirspaceAssetValidationError(
            f"builder label {row['id']}: anchorX and anchorY must be supplied together"
        )
    if has_anchor_x:
        item["anchorX"] = compact_number(float(row["anchorX"]) * scale_x)
        item["anchorY"] = compact_number(float(row["anchorY"]) * scale_y)
    if "elevation" in row:
        item["elevation"] = compact_number(float(row["elevation"]), digits=4)
    if "connector" in row:
        item["connector"] = bool(row["connector"])
    if row["placementMode"] == "callout" and not (item.get("connector") and has_anchor_x):
        raise AirspaceAssetValidationError(
            f"builder label {row['id']}: callout placement requires connector and anchor metadata"
        )
    return item


def _is_finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_airspace_payloads(
    section_id: str,
    labels_payload: dict[str, object],
    overlay_payload: dict[str, object],
    pixel_width: int,
    pixel_height: int,
) -> list[str]:
    errors: list[str] = []
    labels = list(labels_payload.get("items", []))
    regions = list(overlay_payload.get("interactionRegions", []))

    def error(subject: str, message: str) -> None:
        errors.append(f"[{section_id}] {subject}: {message}")

    label_ids: dict[str, dict[str, object]] = {}
    selection_ids: dict[str, dict[str, object]] = {}
    for label in labels:
        label_id = str(label.get("id") or "<missing-id>")
        missing = [field for field in REQUIRED_LABEL_FIELDS if label.get(field) in (None, "")]
        if missing:
            error(f"label {label_id}", f"missing required metadata: {', '.join(missing)}")
        if label_id in label_ids:
            error(f"label {label_id}", "duplicate label id")
        else:
            label_ids[label_id] = label
        selection_id = str(label.get("selectionId") or "")
        if selection_id:
            if selection_id in selection_ids:
                error(f"label {label_id}", f"duplicate selectionId {selection_id}")
            else:
                selection_ids[selection_id] = label
        for axis, limit in (("x", pixel_width), ("y", pixel_height)):
            value = label.get(axis)
            if not _is_finite_number(value) or not 0 <= float(value) <= limit:
                error(f"label {label_id}", f"{axis}={value!r} is outside 0..{limit}")
        if label.get("labelGroup") not in VALID_LABEL_GROUPS:
            error(f"label {label_id}", f"invalid labelGroup {label.get('labelGroup')!r}")
        if label.get("detailTier") not in VALID_DETAIL_TIERS:
            error(f"label {label_id}", f"invalid detailTier {label.get('detailTier')!r}")
        if label.get("placementMode") not in VALID_PLACEMENT_MODES:
            error(f"label {label_id}", f"invalid placementMode {label.get('placementMode')!r}")
        if label.get("placementMode") == "callout":
            if not label.get("connector") or not all(_is_finite_number(label.get(k)) for k in ("anchorX", "anchorY")):
                error(f"label {label_id}", "callout is missing connector/anchor metadata")

    region_ids: dict[str, dict[str, object]] = {}
    for region in regions:
        region_id = str(region.get("id") or "<missing-id>")
        missing = [field for field in REQUIRED_REGION_FIELDS if region.get(field) in (None, "", [])]
        if missing:
            error(f"region {region_id}", f"missing required metadata: {', '.join(missing)}")
        if region_id in region_ids:
            error(f"region {region_id}", "duplicate interaction-region id")
        else:
            region_ids[region_id] = region
        anchor = region.get("anchor")
        if not isinstance(anchor, list) or len(anchor) != 2:
            error(f"region {region_id}", f"invalid anchor {anchor!r}")
        else:
            for value, axis, limit in zip(anchor, ("x", "y"), (pixel_width, pixel_height)):
                if not _is_finite_number(value) or not 0 <= float(value) <= limit:
                    error(f"region {region_id}", f"anchor {axis}={value!r} is outside 0..{limit}")
        for part_index, part in enumerate(region.get("parts") or []):
            if not isinstance(part, list) or len(part) < 3:
                error(f"region {region_id}", f"part {part_index} has fewer than three points")
                continue
            for point_index, point in enumerate(part):
                if not isinstance(point, list) or len(point) != 2 or not all(_is_finite_number(v) for v in point):
                    error(f"region {region_id}", f"part {part_index} point {point_index} is invalid: {point!r}")
                    break

    for selection_id, label in selection_ids.items():
        label_id = str(label.get("id"))
        region = region_ids.get(selection_id)
        if region is None:
            error(f"label {label_id}", f"selectionId {selection_id} has no matching region")
            continue
        if label.get("familyKey") != region.get("familyKey"):
            error(
                f"label {label_id}",
                f"familyKey {label.get('familyKey')!r} does not match region {selection_id} familyKey {region.get('familyKey')!r}",
            )
        if label.get("airspaceType") != region.get("airspaceType"):
            error(
                f"label {label_id}",
                f"airspaceType {label.get('airspaceType')!r} does not match region {selection_id} airspaceType {region.get('airspaceType')!r}",
            )
        expected_kind = {"airfield": "airfield", "shelf": "shelf", "special": "special"}.get(label.get("labelGroup"))
        if expected_kind and region.get("kind") != expected_kind:
            error(f"label {label_id}", f"labelGroup requires region kind {expected_kind}, found {region.get('kind')!r}")

    for region_id in region_ids:
        if region_id not in selection_ids:
            error(f"region {region_id}", "orphaned interaction region has no label selectionId")

    primary_families = {
        label.get("familyKey")
        for label in labels
        if label.get("labelGroup") == "airfield"
    }
    for label in labels:
        if label.get("labelGroup") != "shelf":
            continue
        label_id = str(label.get("id"))
        airspace_type = label.get("airspaceType")
        if airspace_type in FORBIDDEN_SHELF_AIRSPACE_TYPES:
            error(f"label {label_id}", f"redundant {airspace_type} shelf label is forbidden")
        if airspace_type not in SHELF_AIRSPACE_TYPES:
            error(f"label {label_id}", f"shelf labels are only valid for CLASS_B/CLASS_C, found {airspace_type!r}")
        if label.get("detailTier") != "detail":
            error(f"label {label_id}", "shelf label must use detailTier='detail'")
        if label.get("familyKey") not in primary_families:
            error(f"label {label_id}", f"family {label.get('familyKey')!r} has no primary airfield label")
    for region in regions:
        if region.get("kind") == "shelf" and region.get("airspaceType") in FORBIDDEN_SHELF_AIRSPACE_TYPES:
            error(f"region {region.get('id')}", f"redundant {region.get('airspaceType')} shelf region is forbidden")

    return errors


def assert_valid_airspace_payloads(
    section_id: str,
    labels_payload: dict[str, object],
    overlay_payload: dict[str, object],
    pixel_width: int,
    pixel_height: int,
) -> None:
    errors = validate_airspace_payloads(section_id, labels_payload, overlay_payload, pixel_width, pixel_height)
    if errors:
        raise AirspaceAssetValidationError("Airspace asset validation failed:\n" + "\n".join(f"- {item}" for item in errors))


def validate_staged_section(section_root: Path) -> list[str]:
    manifest = json.loads((section_root / "manifest.json").read_text(encoding="utf-8"))
    chart = manifest.get("chart", {})
    labels = json.loads((section_root / "labels" / "airspace.json").read_text(encoding="utf-8"))
    overlay = json.loads((section_root / "overlays" / "airspace.vector.json").read_text(encoding="utf-8"))
    return validate_airspace_payloads(
        str(manifest.get("id") or section_root.name),
        labels,
        overlay,
        int(chart["pixelWidth"]),
        int(chart["pixelHeight"]),
    )


def assert_valid_staged_section(section_root: Path) -> None:
    errors = validate_staged_section(section_root)
    if errors:
        raise AirspaceAssetValidationError(
            "Staged airspace asset validation failed:\n" + "\n".join(f"- {item}" for item in errors)
        )
