from __future__ import annotations

import json
import math
import shutil
from pathlib import Path


EVENT_SET_SCHEMA = "faa-vr-event-set-v1"
SUPPORTED_EVENT_TYPES = {"aircraft", "weather"}


class EventSetValidationError(RuntimeError):
    pass


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _valid_normalized(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1


def validate_event_set(
    payload: object,
    *,
    expected_id: str,
    expected_section_id: str,
    layer_ids: set[str],
    selection_ids_by_layer: dict[str, set[str]] | None = None,
    source: str,
) -> list[str]:
    errors: list[str] = []

    def error(message: str) -> None:
        errors.append(f"{source}: {message}")

    if not isinstance(payload, dict):
        error("event set must be a JSON object")
        return errors
    if payload.get("schema") != EVENT_SET_SCHEMA:
        error(f"schema must be {EVENT_SET_SCHEMA!r}")
    if payload.get("id") != expected_id:
        error(f"id must match file/manifest id {expected_id!r}, found {payload.get('id')!r}")
    if payload.get("sectionId") != expected_section_id:
        error(f"sectionId must be {expected_section_id!r}, found {payload.get('sectionId')!r}")
    if not _nonempty_string(payload.get("title")):
        error("title must be a nonempty string")
    if "scenario" in payload:
        validate_scenario(payload.get("scenario"), error)

    events = payload.get("events")
    if not isinstance(events, list) or not events:
        error("events must be a nonempty array")
        return errors

    seen_event_ids: set[str] = set()
    for event_index, event in enumerate(events):
        subject = f"event[{event_index}]"
        if not isinstance(event, dict):
            error(f"{subject} must be an object")
            continue

        event_id = event.get("id")
        if not _nonempty_string(event_id):
            error(f"{subject}.id must be a nonempty string")
            event_id = f"<index-{event_index}>"
        elif event_id in seen_event_ids:
            error(f"event {event_id!r} duplicates an earlier event id")
        else:
            seen_event_ids.add(event_id)
        subject = f"event {event_id!r}"

        event_type = event.get("type")
        if event_type not in SUPPORTED_EVENT_TYPES:
            error(f"{subject}.type must be one of {sorted(SUPPORTED_EVENT_TYPES)!r}")
        if not _nonempty_string(event.get("title")):
            error(f"{subject}.title must be a nonempty string")
        if event.get("triggerMode") != "manual":
            error(f"{subject}.triggerMode must be 'manual'")
        if not isinstance(event.get("defaultEnabled"), bool):
            error(f"{subject}.defaultEnabled must be a boolean")

        has_position = "position" in event
        has_target = "target" in event
        has_geometry = "geometry" in event
        has_route = "route" in event
        if not (has_position or has_target or has_geometry or has_route):
            error(f"{subject} must define position, target, geometry, or route")
        if event_type == "aircraft" and not (has_position or has_target or has_route):
            error(f"{subject} aircraft events must define position, target, or route")
        if event_type == "weather" and not (has_geometry or has_position or has_target):
            error(f"{subject} weather events must define geometry, position, or target")

        if has_position:
            validate_position(event.get("position"), subject, error)
        if has_target:
            validate_target(event.get("target"), subject, layer_ids, selection_ids_by_layer, error)
        if has_geometry:
            validate_geometry(event.get("geometry"), subject, error)
        if "altitude" in event:
            validate_altitude(event.get("altitude"), event_type, subject, error)
        if has_route:
            validate_route(event.get("route"), event_type, subject, payload.get("scenario"), error)

    validate_scenario_action_targets(payload.get("scenario"), events, error)
    return errors


def validate_scenario(scenario: object, error) -> None:
    if not isinstance(scenario, dict):
        error("scenario must be an object")
        return
    if not _valid_positive_number(scenario.get("durationSec")):
        error("scenario.durationSec must be a positive finite number")
    if not _valid_nonnegative_number(scenario.get("alertLookaheadSec")):
        error("scenario.alertLookaheadSec must be a finite nonnegative number")
    validate_coordinate_scale(scenario.get("coordinateScale"), error)
    validate_separation(scenario.get("separation"), "scenario.separation", error)
    if "metadata" in scenario and not isinstance(scenario.get("metadata"), dict):
        error("scenario.metadata must be an object when provided")
    validate_scenario_actions(scenario.get("actions"), error)


def validate_coordinate_scale(coordinate_scale: object, error) -> None:
    if not isinstance(coordinate_scale, dict):
        error("scenario.coordinateScale must be an object")
        return
    if not _valid_positive_number(coordinate_scale.get("widthNm")):
        error("scenario.coordinateScale.widthNm must be a positive finite number")
    if not _valid_positive_number(coordinate_scale.get("heightNm")):
        error("scenario.coordinateScale.heightNm must be a positive finite number")


def validate_separation(separation: object, subject: str, error) -> None:
    if not isinstance(separation, dict):
        error(f"{subject} must be an object")
        return
    if not _valid_positive_number(separation.get("horizontalNm")):
        error(f"{subject}.horizontalNm must be a positive finite number")
    if not _valid_positive_number(separation.get("verticalFt")):
        error(f"{subject}.verticalFt must be a positive finite number")


def validate_scenario_actions(actions: object, error) -> None:
    if actions is None:
        return
    if not isinstance(actions, list):
        error("scenario.actions must be an array when provided")
        return
    seen_action_ids: set[str] = set()
    for action_index, action in enumerate(actions):
        action_id = action.get("id") if isinstance(action, dict) else None
        subject = f"scenario action {action_id!r}" if _nonempty_string(action_id) else f"scenario.actions[{action_index}]"
        if not isinstance(action, dict):
            error(f"{subject} must be an object")
            continue
        if not _nonempty_string(action_id):
            error(f"{subject}.id must be a nonempty string")
        elif action_id in seen_action_ids:
            error(f"{subject} duplicates an earlier scenario action id")
        else:
            seen_action_ids.add(str(action_id))
        if not _nonempty_string(action.get("title")):
            error(f"{subject}.title must be a nonempty string")
        action_type = action.get("type")
        if action_type not in {"turnHeading", "resumeRoute"}:
            error(f"{subject}.type must be 'turnHeading' or 'resumeRoute'")
        if not _nonempty_string(action.get("aircraftId")):
            error(f"{subject}.aircraftId must be a nonempty string")
        if action_type == "turnHeading" and not _valid_heading_degrees(action.get("headingDeg")):
            error(f"{subject}.headingDeg must be a finite heading in degrees from 0 to less than 360")


def validate_scenario_action_targets(scenario: object, events: object, error) -> None:
    if not isinstance(scenario, dict) or not isinstance(scenario.get("actions"), list) or not isinstance(events, list):
        return
    aircraft_ids = {
        str(event["id"])
        for event in events
        if isinstance(event, dict) and event.get("type") == "aircraft" and _nonempty_string(event.get("id"))
    }
    for action in scenario["actions"]:
        if not isinstance(action, dict):
            continue
        aircraft_id = action.get("aircraftId")
        if _nonempty_string(aircraft_id) and aircraft_id not in aircraft_ids:
            error(f"scenario action {action.get('id', '<unknown>')!r}.aircraftId must reference an aircraft event id")


def validate_position(position: object, subject: str, error) -> None:
    if not isinstance(position, dict):
        error(f"{subject}.position must be an object")
        return
    if not _valid_normalized(position.get("x")):
        error(f"{subject}.position.x must be a normalized number from 0 to 1")
    if not _valid_normalized(position.get("y")):
        error(f"{subject}.position.y must be a normalized number from 0 to 1")


def validate_target(
    target: object,
    subject: str,
    layer_ids: set[str],
    selection_ids_by_layer: dict[str, set[str]] | None,
    error,
) -> None:
    if not isinstance(target, dict):
        error(f"{subject}.target must be an object")
        return
    layer_id = target.get("layerId")
    selection_id = target.get("selectionId")
    if not _nonempty_string(layer_id):
        error(f"{subject}.target.layerId must be a nonempty string")
    elif layer_id not in layer_ids:
        error(f"{subject}.target.layerId references unknown layer {layer_id!r}")
    if not _nonempty_string(selection_id):
        error(f"{subject}.target.selectionId must be a nonempty string")
    elif _nonempty_string(layer_id) and layer_id in layer_ids and selection_ids_by_layer is not None:
        selectable_ids = selection_ids_by_layer.get(layer_id, set())
        if selection_id not in selectable_ids:
            error(
                f"{subject}.target.selectionId {selection_id!r} does not exist in "
                f"staged selectable IDs for layer {layer_id!r}"
            )


def validate_geometry(geometry: object, subject: str, error) -> None:
    if not isinstance(geometry, dict):
        error(f"{subject}.geometry must be an object")
        return
    geometry_type = geometry.get("type")
    if geometry_type == "circle":
        for key in ("x", "y"):
            if not _valid_normalized(geometry.get(key)):
                error(f"{subject}.geometry.{key} must be a normalized number from 0 to 1")
        radius = geometry.get("radius")
        if not isinstance(radius, (int, float)) or isinstance(radius, bool) or radius <= 0 or radius > 1:
            error(f"{subject}.geometry.radius must be a positive normalized number no larger than 1")
        return
    if geometry_type == "polygon":
        points = geometry.get("points")
        if not isinstance(points, list) or len(points) < 3:
            error(f"{subject}.geometry.points must contain at least three normalized points")
            return
        for point_index, point in enumerate(points):
            if (
                not isinstance(point, list)
                or len(point) != 2
                or not _valid_normalized(point[0])
                or not _valid_normalized(point[1])
            ):
                error(f"{subject}.geometry.points[{point_index}] must be [x, y] normalized numbers")
        return
    error(f"{subject}.geometry.type must be 'circle' or 'polygon'")


def validate_route(route: object, event_type: object, subject: str, scenario: object, error) -> None:
    if event_type != "aircraft":
        error(f"{subject}.route is only supported for aircraft events")
        return
    if not isinstance(route, dict):
        error(f"{subject}.route must be an object")
        return
    points = route.get("points")
    if not isinstance(points, list) or len(points) < 2:
        error(f"{subject}.route.points must contain at least two timed points")
        return

    scenario_duration = scenario.get("durationSec") if isinstance(scenario, dict) else None
    previous_time = -math.inf
    for point_index, point in enumerate(points):
        point_subject = f"{subject}.route.points[{point_index}]"
        if not isinstance(point, dict):
            error(f"{point_subject} must be an object")
            continue
        time_sec = point.get("timeSec")
        if not _valid_nonnegative_number(time_sec):
            error(f"{point_subject}.timeSec must be a finite nonnegative number")
        else:
            if time_sec <= previous_time:
                error(f"{point_subject}.timeSec must be greater than the previous route point timeSec")
            if _valid_positive_number(scenario_duration) and time_sec > scenario_duration:
                error(f"{point_subject}.timeSec must not exceed scenario.durationSec")
            previous_time = float(time_sec)
        validate_position(point.get("position"), point_subject, error)
        if "altitude" not in point:
            error(f"{point_subject}.altitude must be provided for route-based aircraft events")
        else:
            validate_altitude(point.get("altitude"), "aircraft", point_subject, error)
        if "headingDeg" in point and not _valid_heading_degrees(point.get("headingDeg")):
            error(f"{point_subject}.headingDeg must be a finite heading in degrees from 0 to less than 360")


def validate_altitude(altitude: object, event_type: object, subject: str, error) -> None:
    if not isinstance(altitude, dict):
        error(f"{subject}.altitude must be an object")
        return
    reference = altitude.get("reference")
    if reference not in {"MSL", "AGL"}:
        error(f"{subject}.altitude.reference must be 'MSL' or 'AGL'")
    if event_type == "aircraft":
        if "valueFt" in altitude and not _valid_nonnegative_number(altitude.get("valueFt")):
            error(f"{subject}.altitude.valueFt must be a finite nonnegative number")
        return
    if event_type == "weather":
        base = altitude.get("baseFt")
        top = altitude.get("topFt")
        if "baseFt" in altitude and not _valid_nonnegative_number(base):
            error(f"{subject}.altitude.baseFt must be a finite nonnegative number")
        if "topFt" in altitude and not _valid_nonnegative_number(top):
            error(f"{subject}.altitude.topFt must be a finite nonnegative number")
        if _valid_nonnegative_number(base) and _valid_nonnegative_number(top) and top < base:
            error(f"{subject}.altitude.topFt must be greater than or equal to baseFt")


def _valid_nonnegative_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def _valid_positive_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _valid_heading_degrees(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value < 360


def load_and_validate_event_set(
    source_path: Path,
    *,
    section_id: str,
    layer_ids: set[str],
    selection_ids_by_layer: dict[str, set[str]] | None = None,
) -> dict[str, object]:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise EventSetValidationError(f"{source_path}: unable to read event set: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise EventSetValidationError(f"{source_path}: invalid JSON: {exc}") from exc
    errors = validate_event_set(
        payload,
        expected_id=source_path.stem,
        expected_section_id=section_id,
        layer_ids=layer_ids,
        selection_ids_by_layer=selection_ids_by_layer,
        source=str(source_path),
    )
    if errors:
        raise EventSetValidationError("Event-set validation failed:\n" + "\n".join(f"- {item}" for item in errors))
    return payload


def stage_section_event_sets(
    *,
    training_root: Path,
    section_root: Path,
    section_id: str,
    layer_ids: set[str],
    selection_ids_by_layer: dict[str, set[str]],
) -> list[dict[str, str]]:
    source_root = training_root / section_id
    source_paths = sorted(source_root.glob("*.json")) if source_root.exists() else []
    validated = [
        (
            source_path,
            load_and_validate_event_set(
                source_path,
                section_id=section_id,
                layer_ids=layer_ids,
                selection_ids_by_layer=selection_ids_by_layer,
            ),
        )
        for source_path in source_paths
    ]

    destination_root = section_root / "events"
    destination_root.mkdir(parents=True, exist_ok=True)
    expected_names = {source_path.name for source_path, _payload in validated}
    for stale_path in destination_root.glob("*.json"):
        if stale_path.name not in expected_names:
            stale_path.unlink()

    entries: list[dict[str, str]] = []
    for source_path, payload in validated:
        destination_path = destination_root / source_path.name
        shutil.copyfile(source_path, destination_path)
        entries.append(
            {
                "id": str(payload["id"]),
                "title": str(payload["title"]),
                "data": f"events/{source_path.name}",
            }
        )
    return entries
