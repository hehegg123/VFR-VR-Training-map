from __future__ import annotations

import argparse
import json
from pathlib import Path

from event_set_contract import stage_section_event_sets
from task_set_contract import collect_staged_selection_ids, stage_section_task_sets


APP_ROOT = Path(__file__).resolve().parents[1]
PROTOTYPE_ROOT = APP_ROOT.parent
SECTIONS_ROOT = APP_ROOT / "data" / "sections"
TRAINING_ROOT = PROTOTYPE_ROOT / "training" / "task-sets"
EVENT_TRAINING_ROOT = PROTOTYPE_ROOT / "training" / "event-sets"


def stage_section(section_id: str) -> None:
    section_root = SECTIONS_ROOT / section_id
    manifest_path = section_root / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"Section manifest does not exist: {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    layers = manifest.get("layers")
    if not isinstance(layers, list):
        raise RuntimeError(f"Section manifest has no layers array: {manifest_path}")

    layer_ids = {layer["id"] for layer in layers if isinstance(layer, dict) and isinstance(layer.get("id"), str)}
    selection_ids_by_layer = collect_staged_selection_ids(section_root=section_root, layers=layers)
    task_entries = stage_section_task_sets(
        training_root=TRAINING_ROOT,
        section_root=section_root,
        section_id=section_id,
        layer_ids=layer_ids,
        selection_ids_by_layer=selection_ids_by_layer,
    )
    event_entries = stage_section_event_sets(
        training_root=EVENT_TRAINING_ROOT,
        section_root=section_root,
        section_id=section_id,
        layer_ids=layer_ids,
        selection_ids_by_layer=selection_ids_by_layer,
    )
    manifest["training"] = {"taskSets": task_entries, "eventSets": event_entries}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        f"Staged {len(task_entries)} task set(s) and {len(event_entries)} event set(s) "
        f"for {section_id}: {manifest_path}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate and stage task/event sets without rebuilding map rasters.")
    parser.add_argument("section_id", help="Section ID, for example daytona or stlouis")
    args = parser.parse_args()
    stage_section(args.section_id)


if __name__ == "__main__":
    main()
