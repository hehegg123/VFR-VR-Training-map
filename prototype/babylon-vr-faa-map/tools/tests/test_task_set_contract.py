from __future__ import annotations

import sys
import unittest
from pathlib import Path


TOOLS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_ROOT))
from task_set_contract import collect_staged_selection_ids, validate_task_set


class TaskSetContractTest(unittest.TestCase):
    def test_valid_task_set_passes(self) -> None:
        errors = validate_task_set(
            valid_payload(),
            expected_id="example",
            expected_section_id="stlouis",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"STL-CLASS_B"}},
            source="fixture/example.json",
        )
        self.assertEqual(errors, [])

    def test_invalid_source_reports_actionable_errors(self) -> None:
        payload = valid_payload()
        payload["sectionId"] = "daytona"
        payload["tasks"][0]["instructions"] = ""
        payload["tasks"][0]["recommendedLayers"] = ["unknown"]
        payload["tasks"][0]["targets"] = [{"layerId": "airspace", "selectionId": ""}]
        payload["tasks"].append(dict(payload["tasks"][0], instructions="Duplicate"))
        errors = validate_task_set(
            payload,
            expected_id="example",
            expected_section_id="stlouis",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"STL-CLASS_B"}},
            source="fixture/example.json",
        )
        message = "\n".join(errors)
        self.assertIn("sectionId must be 'stlouis'", message)
        self.assertIn("instructions must be a nonempty string", message)
        self.assertIn("unknown layer 'unknown'", message)
        self.assertIn("selectionId must be a nonempty string", message)
        self.assertIn("duplicates an earlier task id", message)

    def test_unknown_staged_selection_id_fails(self) -> None:
        payload = valid_payload()
        payload["tasks"][0]["targets"] = [{"layerId": "airspace", "selectionId": "MISSING"}]
        errors = validate_task_set(
            payload,
            expected_id="example",
            expected_section_id="stlouis",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"STL-CLASS_B"}},
            source="fixture/example.json",
        )
        self.assertIn("does not exist in staged selectable IDs", "\n".join(errors))

    def test_collects_label_and_interaction_region_ids(self) -> None:
        section_root = Path(__file__).resolve().parents[2] / "data" / "sections" / "stlouis"
        result = collect_staged_selection_ids(
            section_root=section_root,
            layers=[{
                "id": "airspace",
                "labelData": "labels/airspace.json",
                "overlayData": "overlays/airspace.vector.json",
            }],
        )
        self.assertIn("STL-CLASS_B", result["airspace"])


def valid_payload() -> dict[str, object]:
    return {
        "schema": "faa-vr-task-set-v1",
        "id": "example",
        "sectionId": "stlouis",
        "title": "Example",
        "tasks": [
            {
                "id": "task-one",
                "title": "Task One",
                "instructions": "Select the airspace.",
                "completionMode": "manual",
                "recommendedLayers": ["base", "airspace"],
                "targets": [{"layerId": "airspace", "selectionId": "STL-CLASS_B"}],
            }
        ],
    }


if __name__ == "__main__":
    unittest.main()
