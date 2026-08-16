from __future__ import annotations

import sys
import unittest
from pathlib import Path


TOOLS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_ROOT))
from event_set_contract import validate_event_set


class EventSetContractTest(unittest.TestCase):
    def test_valid_event_set_passes(self) -> None:
        errors = validate_event_set(
            valid_payload(),
            expected_id="example",
            expected_section_id="daytona",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"DAB-CLASS_C"}},
            source="fixture/example.json",
        )
        self.assertEqual(errors, [])

    def test_valid_scenario_routes_pass_without_breaking_static_events(self) -> None:
        errors = validate_event_set(
            valid_scenario_payload(),
            expected_id="example",
            expected_section_id="daytona",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"DAB-CLASS_C"}},
            source="fixture/example.json",
        )
        self.assertEqual(errors, [])

    def test_invalid_event_set_reports_actionable_errors(self) -> None:
        payload = valid_payload()
        payload["schema"] = "wrong"
        payload["id"] = "wrong-id"
        payload["sectionId"] = "stlouis"
        payload["events"][0]["triggerMode"] = "automatic"
        payload["events"][0]["defaultEnabled"] = "false"
        payload["events"][0]["position"] = {"x": 1.2, "y": -0.1}
        payload["events"][0]["target"] = {"layerId": "unknown", "selectionId": ""}
        payload["events"][0]["altitude"] = {"valueFt": -1, "reference": "BARO"}
        payload["events"].append(dict(payload["events"][0]))
        errors = validate_event_set(
            payload,
            expected_id="example",
            expected_section_id="daytona",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"DAB-CLASS_C"}},
            source="fixture/example.json",
        )
        message = "\n".join(errors)
        self.assertIn("schema must be 'faa-vr-event-set-v1'", message)
        self.assertIn("id must match file/manifest id 'example'", message)
        self.assertIn("sectionId must be 'daytona'", message)
        self.assertIn("triggerMode must be 'manual'", message)
        self.assertIn("defaultEnabled must be a boolean", message)
        self.assertIn("position.x must be a normalized number", message)
        self.assertIn("target.layerId references unknown layer", message)
        self.assertIn("target.selectionId must be a nonempty string", message)
        self.assertIn("altitude.reference must be 'MSL' or 'AGL'", message)
        self.assertIn("altitude.valueFt must be a finite nonnegative number", message)
        self.assertIn("duplicates an earlier event id", message)

    def test_invalid_scenario_reports_actionable_errors(self) -> None:
        payload = valid_scenario_payload()
        payload["scenario"]["durationSec"] = 0
        payload["scenario"]["alertLookaheadSec"] = -1
        payload["scenario"]["coordinateScale"]["widthNm"] = 0
        payload["scenario"]["separation"]["horizontalNm"] = 0
        payload["scenario"]["actions"][0]["headingDeg"] = 360
        payload["scenario"]["actions"][0]["aircraftId"] = "missing-aircraft"
        payload["events"][0]["route"]["points"][1]["timeSec"] = payload["events"][0]["route"]["points"][0]["timeSec"]
        del payload["events"][0]["route"]["points"][1]["altitude"]
        errors = validate_event_set(
            payload,
            expected_id="example",
            expected_section_id="daytona",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"DAB-CLASS_C"}},
            source="fixture/example.json",
        )
        message = "\n".join(errors)
        self.assertIn("scenario.durationSec must be a positive finite number", message)
        self.assertIn("scenario.alertLookaheadSec must be a finite nonnegative number", message)
        self.assertIn("scenario.coordinateScale.widthNm must be a positive finite number", message)
        self.assertIn("scenario.separation.horizontalNm must be a positive finite number", message)
        self.assertIn("headingDeg must be a finite heading", message)
        self.assertIn("aircraftId must reference an aircraft event id", message)
        self.assertIn("timeSec must be greater than the previous route point timeSec", message)
        self.assertIn("altitude must be provided for route-based aircraft events", message)

    def test_unknown_target_selection_id_fails(self) -> None:
        payload = valid_payload()
        payload["events"][0].pop("position")
        payload["events"][0]["target"] = {"layerId": "airspace", "selectionId": "MISSING"}
        errors = validate_event_set(
            payload,
            expected_id="example",
            expected_section_id="daytona",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"DAB-CLASS_C"}},
            source="fixture/example.json",
        )
        self.assertIn("does not exist in staged selectable IDs", "\n".join(errors))

    def test_weather_circle_geometry_can_anchor_an_event(self) -> None:
        payload = valid_payload()
        payload["events"] = [{
            "id": "weather",
            "type": "weather",
            "title": "Weather",
            "triggerMode": "manual",
            "defaultEnabled": False,
            "geometry": {"type": "circle", "x": 0.5, "y": 0.4, "radius": 0.08},
            "altitude": {"baseFt": 2500, "topFt": 9000, "reference": "MSL"},
        }]
        errors = validate_event_set(
            payload,
            expected_id="example",
            expected_section_id="daytona",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"DAB-CLASS_C"}},
            source="fixture/example.json",
        )
        self.assertEqual(errors, [])

    def test_weather_top_altitude_must_not_be_below_base(self) -> None:
        payload = valid_payload()
        payload["events"] = [{
            "id": "weather",
            "type": "weather",
            "title": "Weather",
            "triggerMode": "manual",
            "defaultEnabled": False,
            "geometry": {"type": "circle", "x": 0.5, "y": 0.4, "radius": 0.08},
            "altitude": {"baseFt": 9000, "topFt": 2500, "reference": "MSL"},
        }]
        errors = validate_event_set(
            payload,
            expected_id="example",
            expected_section_id="daytona",
            layer_ids={"base", "airspace"},
            selection_ids_by_layer={"base": set(), "airspace": {"DAB-CLASS_C"}},
            source="fixture/example.json",
        )
        self.assertIn("topFt must be greater than or equal to baseFt", "\n".join(errors))


def valid_payload() -> dict[str, object]:
    return {
        "schema": "faa-vr-event-set-v1",
        "id": "example",
        "sectionId": "daytona",
        "title": "Example",
        "events": [
            {
                "id": "aircraft-one",
                "type": "aircraft",
                "title": "Aircraft One",
                "triggerMode": "manual",
                "defaultEnabled": False,
                "position": {"x": 0.5, "y": 0.5},
                "altitude": {"valueFt": 1800, "reference": "MSL"},
                "visual": {"label": "N123AB"},
            }
        ],
    }


def valid_scenario_payload() -> dict[str, object]:
    return {
        "schema": "faa-vr-event-set-v1",
        "id": "example",
        "sectionId": "daytona",
        "title": "Example",
        "scenario": {
            "durationSec": 90,
            "alertLookaheadSec": 30,
            "coordinateScale": {"widthNm": 120, "heightNm": 96},
            "separation": {"horizontalNm": 5, "verticalFt": 1000},
            "metadata": {"description": "Conflict scenario fixture"},
            "actions": [
                {
                    "id": "flight-a-turn-right-130",
                    "title": "Flight A: Turn Right Heading 130",
                    "type": "turnHeading",
                    "aircraftId": "flight-a",
                    "headingDeg": 130,
                },
                {
                    "id": "flight-a-resume-route",
                    "title": "Flight A: Resume Route",
                    "type": "resumeRoute",
                    "aircraftId": "flight-a",
                },
            ],
        },
        "events": [
            route_aircraft("flight-a", "Flight A", 0.35, 0.52, 0.72, 0.52, 90),
            route_aircraft("flight-b", "Flight B", 0.535, 0.72, 0.535, 0.32, 0),
        ],
    }


def route_aircraft(
    event_id: str,
    title: str,
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
    heading_deg: float,
) -> dict[str, object]:
    return {
        "id": event_id,
        "type": "aircraft",
        "title": title,
        "triggerMode": "manual",
        "defaultEnabled": True,
        "position": {"x": start_x, "y": start_y},
        "altitude": {"valueFt": 35000, "reference": "MSL"},
        "orientation": {"headingDeg": heading_deg},
        "route": {
            "points": [
                {
                    "timeSec": 0,
                    "position": {"x": start_x, "y": start_y},
                    "altitude": {"valueFt": 35000, "reference": "MSL"},
                    "headingDeg": heading_deg,
                },
                {
                    "timeSec": 90,
                    "position": {"x": end_x, "y": end_y},
                    "altitude": {"valueFt": 35000, "reference": "MSL"},
                    "headingDeg": heading_deg,
                },
            ],
        },
        "visual": {"label": title},
    }


if __name__ == "__main__":
    unittest.main()
