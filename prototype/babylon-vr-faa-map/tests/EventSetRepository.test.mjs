import assert from "node:assert/strict";
import test from "node:test";

import { EventSetRepository } from "../src/data/EventSetRepository.js";


const manifest = {
  id: "daytona",
  assetVersion: "test-version",
  __baseUrl: "https://example.test/data/sections/daytona/",
  layers: [{ id: "base" }, { id: "airspace" }],
};
const entry = { id: "example", title: "Example", data: "events/example.json" };

test("loads and validates an event set through the section asset resolver", async () => {
  let requestedUrl = null;
  const repository = new EventSetRepository(async (url, options) => {
    requestedUrl = url;
    assert.deepEqual(options, { cache: "no-store" });
    return { ok: true, status: 200, json: async () => validPayload() };
  });
  const payload = await repository.load(manifest, entry);
  assert.equal(payload.id, "example");
  assert.equal(requestedUrl, "https://example.test/data/sections/daytona/events/example.json?v=test-version");
});

test("loads scenario aircraft routes without breaking static event compatibility", async () => {
  const repository = new EventSetRepository(async () => ({ ok: true, status: 200, json: async () => validScenarioPayload() }));
  const payload = await repository.load(manifest, entry);
  assert.equal(payload.scenario.durationSec, 90);
  assert.equal(payload.scenario.separation.horizontalNm, 5);
  assert.equal(payload.events.length, 2);
  assert.equal(payload.events[0].route.points[1].altitude.valueFt, 35000);
  assert.equal(payload.scenario.actions[0].headingDeg, 130);
});

test("reports a clear missing-file error", async () => {
  const repository = new EventSetRepository(async () => ({ ok: false, status: 404 }));
  await assert.rejects(repository.load(manifest, entry), /Failed to load event set example.*HTTP 404/);
});

test("reports invalid schema, IDs, event fields, layers, and geometry", async () => {
  const invalid = validPayload();
  invalid.schema = "wrong-schema";
  invalid.id = "wrong-id";
  invalid.sectionId = "stlouis";
  invalid.events[0].triggerMode = "auto";
  invalid.events[0].defaultEnabled = "false";
  invalid.events[0].position = { x: 2, y: null };
  invalid.events[0].target = { layerId: "unknown", selectionId: "" };
  invalid.events[0].altitude = { valueFt: -1, reference: "BARO" };
  invalid.events.push({ ...invalid.events[0] });
  const repository = new EventSetRepository(async () => ({ ok: true, status: 200, json: async () => invalid }));
  await assert.rejects(repository.load(manifest, entry), (error) => {
    assert.match(error.message, /schema must be/);
    assert.match(error.message, /id must match manifest id/);
    assert.match(error.message, /sectionId must be/);
    assert.match(error.message, /triggerMode must be "manual"/);
    assert.match(error.message, /defaultEnabled must be a boolean/);
    assert.match(error.message, /duplicates an earlier event id/);
    assert.match(error.message, /unknown layer/);
    assert.match(error.message, /selectionId must be a nonempty string/);
    assert.match(error.message, /position.x must be a normalized number/);
    assert.match(error.message, /altitude.reference must be/);
    assert.match(error.message, /altitude.valueFt must be a finite nonnegative number/);
    return true;
  });
});

test("reports invalid scenario route and action fields", async () => {
  const invalid = validScenarioPayload();
  invalid.scenario.durationSec = 0;
  invalid.scenario.alertLookaheadSec = -1;
  invalid.scenario.coordinateScale.widthNm = 0;
  invalid.scenario.separation.horizontalNm = 0;
  invalid.scenario.actions[0].headingDeg = 360;
  invalid.scenario.actions[0].aircraftId = "missing-aircraft";
  invalid.events[0].route.points[1].timeSec = invalid.events[0].route.points[0].timeSec;
  delete invalid.events[0].route.points[1].altitude;
  const repository = new EventSetRepository(async () => ({ ok: true, status: 200, json: async () => invalid }));
  await assert.rejects(repository.load(manifest, entry), (error) => {
    assert.match(error.message, /scenario.durationSec must be a positive finite number/);
    assert.match(error.message, /scenario.alertLookaheadSec must be a finite nonnegative number/);
    assert.match(error.message, /scenario.coordinateScale.widthNm must be a positive finite number/);
    assert.match(error.message, /scenario.separation.horizontalNm must be a positive finite number/);
    assert.match(error.message, /headingDeg must be a finite heading/);
    assert.match(error.message, /aircraftId must reference an aircraft event id/);
    assert.match(error.message, /timeSec must be greater than the previous route point timeSec/);
    assert.match(error.message, /altitude must be provided for route-based aircraft events/);
    return true;
  });
});

function validPayload() {
  return {
    schema: "faa-vr-event-set-v1",
    id: "example",
    sectionId: "daytona",
    title: "Example",
    events: [{
      id: "aircraft-one",
      type: "aircraft",
      title: "Aircraft One",
      triggerMode: "manual",
      defaultEnabled: false,
      position: { x: 0.5, y: 0.5 },
      altitude: { valueFt: 1800, reference: "MSL" },
      visual: { label: "N123AB" },
    }],
  };
}

function validScenarioPayload() {
  return {
    schema: "faa-vr-event-set-v1",
    id: "example",
    sectionId: "daytona",
    title: "Example",
    scenario: {
      durationSec: 90,
      alertLookaheadSec: 30,
      coordinateScale: { widthNm: 120, heightNm: 96 },
      separation: { horizontalNm: 5, verticalFt: 1000 },
      metadata: { description: "Conflict scenario fixture" },
      actions: [
        {
          id: "flight-a-turn-right-130",
          title: "Flight A: Turn Right Heading 130",
          type: "turnHeading",
          aircraftId: "flight-a",
          headingDeg: 130,
        },
        {
          id: "flight-a-resume-route",
          title: "Flight A: Resume Route",
          type: "resumeRoute",
          aircraftId: "flight-a",
        },
      ],
    },
    events: [
      routeAircraft("flight-a", "Flight A", 0.35, 0.52, 0.72, 0.52, 90),
      routeAircraft("flight-b", "Flight B", 0.535, 0.72, 0.535, 0.32, 0),
    ],
  };
}

function routeAircraft(id, title, startX, startY, endX, endY, headingDeg) {
  return {
    id,
    type: "aircraft",
    title,
    triggerMode: "manual",
    defaultEnabled: true,
    position: { x: startX, y: startY },
    altitude: { valueFt: 35000, reference: "MSL" },
    orientation: { headingDeg },
    route: {
      points: [
        {
          timeSec: 0,
          position: { x: startX, y: startY },
          altitude: { valueFt: 35000, reference: "MSL" },
          headingDeg,
        },
        {
          timeSec: 90,
          position: { x: endX, y: endY },
          altitude: { valueFt: 35000, reference: "MSL" },
          headingDeg,
        },
      ],
    },
    visual: { label: title },
  };
}
