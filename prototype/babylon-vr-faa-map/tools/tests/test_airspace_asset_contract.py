from __future__ import annotations

import sys
import unittest
from pathlib import Path


TOOLS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_ROOT))

from airspace_asset_contract import stage_airspace_label_row, validate_airspace_payloads


class AirspaceAssetContractTest(unittest.TestCase):
    def test_staging_preserves_placed_coordinates_and_validates_shelf_policy(self) -> None:
        primary = {
            "id": "AAA-CLASS_C",
            "selectionId": "AAA-CLASS_C",
            "labelGroup": "airfield",
            "detailTier": "core",
            "familyKey": "AAA-CLASS_C",
            "airspaceType": "CLASS_C",
            "placementMode": "callout",
            "x": 123.25,
            "y": 88.75,
            "anchorX": 100.0,
            "anchorY": 80.0,
            "connector": True,
            "lines": ["ALPHA AIRPORT", "Class C"],
            "style": "airspace-primary",
            "priority": 1.0,
        }
        shelf = {
            "id": "shelf-CLASS_C-0",
            "selectionId": "shelf-CLASS_C-0",
            "labelGroup": "shelf",
            "detailTier": "detail",
            "familyKey": "AAA-CLASS_C",
            "airspaceType": "CLASS_C",
            "placementMode": "interior",
            "x": 160.0,
            "y": 90.0,
            "lines": ["C AREA A", "SFC-40"],
            "style": "airspace-secondary",
            "priority": 0.7,
        }
        staged_primary = stage_airspace_label_row(primary, 2.0, 3.0)
        staged_shelf = stage_airspace_label_row(shelf, 2.0, 3.0)
        self.assertEqual(staged_primary["x"], 246.5)
        self.assertEqual(staged_primary["y"], 266.25)
        self.assertEqual(staged_primary["anchorX"], 200)
        self.assertEqual(staged_primary["anchorY"], 240)

        class_d_primary = {
            "id": "DDD-CLASS_D",
            "selectionId": "DDD-CLASS_D",
            "labelGroup": "airfield",
            "detailTier": "core",
            "familyKey": "DDD-CLASS_D",
            "airspaceType": "CLASS_D",
            "placementMode": "interior",
            "x": 40,
            "y": 30,
        }
        labels = {"items": [staged_primary, staged_shelf, class_d_primary]}
        regions = {
            "interactionRegions": [
                self.region("AAA-CLASS_C", "airfield", "AAA-CLASS_C", "CLASS_C", [200, 240]),
                self.region("shelf-CLASS_C-0", "shelf", "AAA-CLASS_C", "CLASS_C", [320, 270]),
                self.region("DDD-CLASS_D", "airfield", "DDD-CLASS_D", "CLASS_D", [40, 30]),
            ]
        }
        self.assertEqual(validate_airspace_payloads("fixture", labels, regions, 500, 400), [])

    def test_class_d_shelf_is_rejected(self) -> None:
        labels = {
            "items": [
                {
                    "id": "DDD-CLASS_D",
                    "selectionId": "DDD-CLASS_D",
                    "labelGroup": "airfield",
                    "detailTier": "core",
                    "familyKey": "DDD-CLASS_D",
                    "airspaceType": "CLASS_D",
                    "placementMode": "interior",
                    "x": 50,
                    "y": 50,
                },
                {
                    "id": "shelf-CLASS_D-0",
                    "selectionId": "shelf-CLASS_D-0",
                    "labelGroup": "shelf",
                    "detailTier": "detail",
                    "familyKey": "DDD-CLASS_D",
                    "airspaceType": "CLASS_D",
                    "placementMode": "interior",
                    "x": 60,
                    "y": 60,
                },
            ]
        }
        regions = {
            "interactionRegions": [
                self.region("DDD-CLASS_D", "airfield", "DDD-CLASS_D", "CLASS_D", [50, 50]),
                self.region("shelf-CLASS_D-0", "shelf", "DDD-CLASS_D", "CLASS_D", [60, 60]),
            ]
        }
        errors = validate_airspace_payloads("fixture", labels, regions, 100, 100)
        self.assertTrue(any("redundant CLASS_D shelf label" in error for error in errors))
        self.assertTrue(any("redundant CLASS_D shelf region" in error for error in errors))

    @staticmethod
    def region(region_id: str, kind: str, family: str, airspace_type: str, anchor: list[int]) -> dict[str, object]:
        return {
            "id": region_id,
            "kind": kind,
            "familyKey": family,
            "airspaceType": airspace_type,
            "anchor": anchor,
            "parts": [[[0, 0], [10, 0], [0, 10]]],
        }


if __name__ == "__main__":
    unittest.main()
