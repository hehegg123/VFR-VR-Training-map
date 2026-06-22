from __future__ import annotations

import json
import shutil
from pathlib import Path


TASK_SET_SCHEMA = "faa-vr-task-set-v1"


class TaskSetValidationError(RuntimeError):
    pass


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_task_set(
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
        error("task set must be a JSON object")
        return errors
    if payload.get("schema") != TASK_SET_SCHEMA:
        error(f"schema must be {TASK_SET_SCHEMA!r}")
    if payload.get("id") != expected_id:
        error(f"id must match file/manifest id {expected_id!r}, found {payload.get('id')!r}")
    if payload.get("sectionId") != expected_section_id:
        error(f"sectionId must be {expected_section_id!r}, found {payload.get('sectionId')!r}")
    if not _nonempty_string(payload.get("title")):
        error("title must be a nonempty string")

    tasks = payload.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        error("tasks must be a nonempty array")
        return errors

    seen_task_ids: set[str] = set()
    for task_index, task in enumerate(tasks):
        subject = f"task[{task_index}]"
        if not isinstance(task, dict):
            error(f"{subject} must be an object")
            continue
        task_id = task.get("id")
        if not _nonempty_string(task_id):
            error(f"{subject}.id must be a nonempty string")
            task_id = f"<index-{task_index}>"
        elif task_id in seen_task_ids:
            error(f"task {task_id!r} duplicates an earlier task id")
        else:
            seen_task_ids.add(task_id)
        subject = f"task {task_id!r}"
        if not _nonempty_string(task.get("title")):
            error(f"{subject}.title must be a nonempty string")
        if not _nonempty_string(task.get("instructions")):
            error(f"{subject}.instructions must be a nonempty string")
        if task.get("completionMode") != "manual":
            error(f"{subject}.completionMode must be 'manual'")

        recommended_layers = task.get("recommendedLayers")
        if recommended_layers is not None:
            if not isinstance(recommended_layers, list):
                error(f"{subject}.recommendedLayers must be an array")
            else:
                for layer_index, layer_id in enumerate(recommended_layers):
                    if not _nonempty_string(layer_id):
                        error(f"{subject}.recommendedLayers[{layer_index}] must be a nonempty string")
                    elif layer_id not in layer_ids:
                        error(f"{subject}.recommendedLayers[{layer_index}] references unknown layer {layer_id!r}")

        targets = task.get("targets")
        if targets is not None:
            if not isinstance(targets, list):
                error(f"{subject}.targets must be an array")
            else:
                for target_index, target in enumerate(targets):
                    target_subject = f"{subject}.targets[{target_index}]"
                    if not isinstance(target, dict):
                        error(f"{target_subject} must be an object")
                        continue
                    layer_id = target.get("layerId")
                    selection_id = target.get("selectionId")
                    if not _nonempty_string(layer_id):
                        error(f"{target_subject}.layerId must be a nonempty string")
                    elif layer_id not in layer_ids:
                        error(f"{target_subject}.layerId references unknown layer {layer_id!r}")
                    if not _nonempty_string(selection_id):
                        error(f"{target_subject}.selectionId must be a nonempty string")
                    elif _nonempty_string(layer_id) and layer_id in layer_ids and selection_ids_by_layer is not None:
                        selectable_ids = selection_ids_by_layer.get(layer_id, set())
                        if selection_id not in selectable_ids:
                            error(
                                f"{target_subject}.selectionId {selection_id!r} does not exist in "
                                f"staged selectable IDs for layer {layer_id!r}"
                            )

    return errors


def load_and_validate_task_set(
    source_path: Path,
    *,
    section_id: str,
    layer_ids: set[str],
    selection_ids_by_layer: dict[str, set[str]] | None = None,
) -> dict[str, object]:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise TaskSetValidationError(f"{source_path}: unable to read task set: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise TaskSetValidationError(f"{source_path}: invalid JSON: {exc}") from exc
    errors = validate_task_set(
        payload,
        expected_id=source_path.stem,
        expected_section_id=section_id,
        layer_ids=layer_ids,
        selection_ids_by_layer=selection_ids_by_layer,
        source=str(source_path),
    )
    if errors:
        raise TaskSetValidationError("Task-set validation failed:\n" + "\n".join(f"- {item}" for item in errors))
    return payload


def stage_section_task_sets(
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
            load_and_validate_task_set(
                source_path,
                section_id=section_id,
                layer_ids=layer_ids,
                selection_ids_by_layer=selection_ids_by_layer,
            ),
        )
        for source_path in source_paths
    ]

    destination_root = section_root / "tasks"
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
                "data": f"tasks/{source_path.name}",
            }
        )
    return entries


def collect_staged_selection_ids(
    *,
    section_root: Path,
    layers: list[dict[str, object]],
) -> dict[str, set[str]]:
    selection_ids_by_layer: dict[str, set[str]] = {}
    for layer in layers:
        layer_id = layer.get("id")
        if not _nonempty_string(layer_id):
            continue
        selection_ids: set[str] = set()
        for asset_key in ("labelData", "overlayData"):
            relative_path = layer.get(asset_key)
            if not _nonempty_string(relative_path):
                continue
            asset_path = section_root / relative_path
            try:
                payload = json.loads(asset_path.read_text(encoding="utf-8"))
            except OSError as exc:
                raise TaskSetValidationError(
                    f"Unable to inspect selectable IDs for layer {layer_id!r}: {asset_path}: {exc}"
                ) from exc
            except json.JSONDecodeError as exc:
                raise TaskSetValidationError(
                    f"Unable to inspect selectable IDs for layer {layer_id!r}: {asset_path}: invalid JSON: {exc}"
                ) from exc
            if not isinstance(payload, dict):
                continue
            if asset_key == "labelData":
                _collect_ids(payload.get("items"), selection_ids)
            else:
                _collect_ids(payload.get("interactionRegions"), selection_ids)
                _collect_ids(payload.get("primitives"), selection_ids)
        selection_ids_by_layer[layer_id] = selection_ids
    return selection_ids_by_layer


def _collect_ids(items: object, destination: set[str]) -> None:
    if not isinstance(items, list):
        return
    for item in items:
        if not isinstance(item, dict):
            continue
        for key in ("selectionId", "id"):
            value = item.get(key)
            if _nonempty_string(value):
                destination.add(value)
