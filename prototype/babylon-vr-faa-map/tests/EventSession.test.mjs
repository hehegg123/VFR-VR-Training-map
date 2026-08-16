import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EventSession } from "../src/training/EventSession.js";

const daytonaConflictScenario = JSON.parse(readFileSync(
  new URL("../../training/event-sets/daytona/daytona-conflict-scenario.json", import.meta.url),
  "utf8",
));

test("tracks enabled static events and notifies subscribers", () => {
  const session = new EventSession(eventSet());
  const snapshots = [];
  const unsubscribe = session.subscribe((snapshot) => snapshots.push(snapshot));

  assert.deepEqual(snapshots.at(-1).activeEventIds, ["weather-one"]);
  assert.equal(session.setEventEnabled("aircraft-one", true), true);
  assert.deepEqual(snapshots.at(-1).activeEventIds.sort(), ["aircraft-one", "weather-one"]);
  assert.equal(session.setEventEnabled("aircraft-one", true), false);
  session.applyEnabledEventIds(["aircraft-one", "missing"]);
  assert.deepEqual(snapshots.at(-1).activeEventIds, ["aircraft-one"]);

  unsubscribe();
  session.dispose();
  assert.equal(session.getSnapshot().disposed, true);
  assert.throws(() => session.setEventEnabled("aircraft-one", false), /disposed/);
});

test("interpolates aircraft position, altitude, and heading deterministically", () => {
  const clock = fakeClock();
  const session = new EventSession(scenarioEventSet(), { now: clock.now });

  assertAircraftState(session, {
    x: 0.2,
    y: 0.5,
    altitudeFt: 35000,
    headingDeg: 90,
  });

  session.startScenario();
  clock.advance(10);
  assertAircraftState(session, {
    x: 0.3,
    y: 0.5,
    altitudeFt: 35000,
    headingDeg: 90,
  });

  clock.advance(10);
  assertAircraftState(session, {
    x: 0.4,
    y: 0.5,
    altitudeFt: 35000,
    headingDeg: 90,
  });
  assert.equal(session.getSnapshot().scenarioStatus, "running");
});

test("pause freezes scenario time until playback resumes", () => {
  const clock = fakeClock();
  const session = new EventSession(scenarioEventSet(), { now: clock.now });

  session.startScenario();
  clock.advance(8);
  assert.equal(session.pauseScenario(), true);
  const paused = session.getSnapshot();
  assert.equal(paused.scenarioStatus, "paused");
  assert.equal(paused.scenarioElapsedSec, 8);

  clock.advance(20);
  assert.equal(session.getSnapshot().scenarioElapsedSec, 8);
  assert.equal(session.startScenario(), true);
  clock.advance(2);
  assert.equal(session.getSnapshot().scenarioElapsedSec, 10);
});

test("reset returns the scenario and aircraft to their initial state", () => {
  const clock = fakeClock();
  const session = new EventSession(scenarioEventSet(), { now: clock.now });

  session.startScenario();
  clock.advance(15);
  assert.equal(session.resetScenario(), true);
  const reset = session.getSnapshot();
  assert.equal(reset.scenarioStatus, "ready");
  assert.equal(reset.scenarioElapsedSec, 0);
  assert.equal(reset.aircraftStates[0].position.x, 0.2);

  clock.advance(10);
  assert.equal(session.getSnapshot().scenarioElapsedSec, 0);
});

test("predicts the conflict inside the configured lookahead and detects separation loss", () => {
  const clock = fakeClock();
  const session = new EventSession(scenarioEventSet(), { now: clock.now });
  session.startScenario();

  clock.advance(10);
  assert.equal(session.getSnapshot().conflictState, "normal");
  clock.advance(2);
  const predicted = session.getSnapshot();
  assert.equal(predicted.conflictState, "conflict-predicted");
  assert.equal(predicted.conflict.lookaheadSec, 15);
  assert.ok(predicted.conflict.predictedAtSec <= 27);

  clock.advance(18);
  const loss = session.getSnapshot();
  assert.equal(loss.conflictState, "loss-of-separation");
  assert.ok(loss.conflict.horizontalSeparationNm < 1e-9);
  assert.equal(loss.conflict.verticalSeparationFt, 0);
});

test("heading 130 resolves the conflict and Resume Route rejoins the remaining path", () => {
  const clock = fakeClock();
  const session = new EventSession(scenarioEventSet(), { now: clock.now });
  session.startScenario();
  assert.throws(
    () => session.applyScenarioAction("flight-a-turn-right-130"),
    /before an alert is active/,
  );
  clock.advance(12);
  assert.equal(session.getSnapshot().conflictState, "conflict-predicted");

  assert.equal(session.applyScenarioAction("flight-a-turn-right-130"), true);
  assert.throws(
    () => session.applyScenarioAction("flight-a-resume-route"),
    /until the conflict is resolved/,
  );
  clock.advance(1);
  assert.equal(session.getSnapshot().conflictState, "conflict-predicted");
  clock.advance(17);
  const resolved = session.getSnapshot();
  const divertedFlightA = resolved.aircraftStates.find((state) => state.eventId === "flight-a");
  assert.equal(resolved.conflictState, "resolved");
  assert.equal(divertedFlightA.headingDeg, 130);
  assert.ok(resolved.conflict.horizontalSeparationNm >= 5);
  assert.equal(resolved.conflict.safelyDiverging, true);

  assert.equal(session.applyScenarioAction("flight-a-resume-route"), true);
  clock.advance(10);
  const resumedFlightA = session.getSnapshot().aircraftStates.find((state) => state.eventId === "flight-a");
  assert.ok(resumedFlightA.position.x > divertedFlightA.position.x);
  assert.ok(resumedFlightA.position.y < divertedFlightA.position.y);
  assert.notEqual(resumedFlightA.headingDeg, 130);
});

test("Daytona scenario completes the integrated conflict-training flow deterministically", () => {
  const clock = fakeClock();
  const session = new EventSession(daytonaConflictScenario, { now: clock.now });
  const initial = structuredClone(session.getSnapshot());

  assert.equal(session.startScenario(), true);
  let warning = session.getSnapshot();
  while (warning.conflictState === "normal" && warning.scenarioElapsedSec < 30) {
    clock.advance(1);
    warning = session.getSnapshot();
  }
  assert.equal(warning.conflictState, "conflict-predicted");
  assert.ok(warning.conflict.horizontalSeparationNm >= warning.conflict.horizontalMinimumNm);
  assert.ok(warning.conflict.predictedMinimumHorizontalNm < warning.conflict.horizontalMinimumNm);
  assert.ok(warning.conflict.predictedAtSec > warning.scenarioElapsedSec);

  assert.equal(session.applyScenarioAction("flight-a-turn-right-130"), true);
  clock.advance(1);
  assert.equal(session.getSnapshot().conflictState, "conflict-predicted");

  let resolved = session.getSnapshot();
  while (resolved.conflictState !== "resolved" && resolved.scenarioElapsedSec < 70) {
    clock.advance(1);
    resolved = session.getSnapshot();
  }
  assert.equal(resolved.conflictState, "resolved");
  assert.ok(resolved.conflict.horizontalSeparationNm >= resolved.conflict.horizontalMinimumNm);
  assert.equal(resolved.conflict.safelyDiverging, true);
  const divertedFlightA = aircraft(resolved, "flight-a-eastbound");
  const northboundFlightB = aircraft(resolved, "flight-b-northbound");
  assert.equal(divertedFlightA.headingDeg, 130);
  assert.ok(divertedFlightA.position.y > northboundFlightB.position.y);

  assert.equal(session.applyScenarioAction("flight-a-resume-route"), true);
  clock.advance(5);
  const resumed = session.getSnapshot();
  const resumedFlightA = aircraft(resumed, "flight-a-eastbound");
  assert.equal(resumed.conflictState, "resolved");
  assert.ok(resumedFlightA.position.x > divertedFlightA.position.x);
  assert.ok(resumedFlightA.position.y < divertedFlightA.position.y);
  assert.notEqual(resumedFlightA.headingDeg, 130);

  assert.equal(session.resetScenario(), true);
  assert.deepEqual(session.getSnapshot(), initial);
});

test("reset clears the intervention and restores the original conflict timeline", () => {
  const clock = fakeClock();
  const session = new EventSession(scenarioEventSet(), { now: clock.now });
  session.startScenario();
  clock.advance(12);
  session.applyScenarioAction("flight-a-turn-right-130");
  clock.advance(5);

  session.resetScenario();
  const reset = session.getSnapshot();
  assert.equal(reset.scenarioStatus, "ready");
  assert.equal(reset.conflictState, "normal");
  assert.deepEqual(reset.appliedScenarioActions, []);
  assert.deepEqual(reset.aircraftStates.find((state) => state.eventId === "flight-a").position, { x: 0.2, y: 0.5 });
});

test("authoritative snapshots freeze a linked view at the supplied scenario state", () => {
  const clock = fakeClock();
  const session = new EventSession(scenarioEventSet(), { now: clock.now });
  const remoteSnapshot = {
    eventSetId: "conflict-scenario",
    scenarioStatus: "running",
    scenarioElapsedSec: 22.5,
    activeEventIds: ["flight-a", "flight-b"],
    aircraftStates: [
      {
        eventId: "flight-a",
        position: { x: 0.425, y: 0.5 },
        altitude: { valueFt: 35000, reference: "MSL" },
        headingDeg: 90,
      },
      {
        eventId: "flight-b",
        position: { x: 0.5, y: 0.575 },
        altitude: { valueFt: 35000, reference: "MSL" },
        headingDeg: 0,
      },
    ],
    conflictState: "conflict-predicted",
    conflict: {
      state: "conflict-predicted",
      horizontalSeparationNm: 10.61,
      verticalSeparationFt: 0,
    },
    appliedScenarioActions: [],
  };

  session.applyAuthoritativeScenarioSnapshot(remoteSnapshot);
  clock.advance(30);
  const frozen = session.getSnapshot();
  assert.equal(frozen.authoritative, true);
  assert.equal(frozen.scenarioElapsedSec, 22.5);
  assert.deepEqual(frozen.aircraftStates[0].position, { x: 0.425, y: 0.5 });
  assert.equal(frozen.conflictState, "conflict-predicted");

  assert.equal(session.clearAuthoritativeScenarioSnapshot(), true);
  assert.equal(session.getSnapshot().authoritative, false);
  assert.throws(
    () => session.applyAuthoritativeScenarioSnapshot({ ...remoteSnapshot, eventSetId: "another-set" }),
    /does not match this event set/,
  );
});

test("legacy static event sets remain toggleable without a scenario", () => {
  const session = new EventSession(eventSet());
  const initial = session.getSnapshot();

  assert.equal(initial.scenarioStatus, "unavailable");
  assert.equal(initial.scenarioElapsedSec, 0);
  assert.deepEqual(initial.aircraftStates[0], {
    eventId: "aircraft-one",
    position: { x: 0.5, y: 0.5 },
    altitude: null,
    headingDeg: 0,
  });
  assert.equal(session.setEventEnabled("aircraft-one", true), true);
  assert.deepEqual(session.getSnapshot().activeEventIds.sort(), ["aircraft-one", "weather-one"]);
  assert.throws(() => session.startScenario(), /does not contain a scenario timeline/);
});

function eventSet() {
  return {
    schema: "faa-vr-event-set-v1",
    id: "example-events",
    sectionId: "daytona",
    title: "Example Events",
    events: [
      {
        id: "aircraft-one",
        type: "aircraft",
        title: "Aircraft One",
        triggerMode: "manual",
        defaultEnabled: false,
        position: { x: 0.5, y: 0.5 },
      },
      {
        id: "weather-one",
        type: "weather",
        title: "Weather One",
        triggerMode: "manual",
        defaultEnabled: true,
        geometry: { type: "circle", x: 0.6, y: 0.4, radius: 0.08 },
      },
    ],
  };
}

function scenarioEventSet() {
  return {
    schema: "faa-vr-event-set-v1",
    id: "conflict-scenario",
    sectionId: "daytona",
    title: "Conflict Scenario",
    scenario: {
      durationSec: 60,
      alertLookaheadSec: 15,
      coordinateScale: { widthNm: 100, heightNm: 100 },
      separation: { horizontalNm: 5, verticalFt: 1000 },
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
      {
        id: "flight-a",
        type: "aircraft",
        title: "Flight A",
        triggerMode: "manual",
        defaultEnabled: true,
        route: {
          points: [
            {
              timeSec: 0,
              position: { x: 0.2, y: 0.5 },
              altitude: { valueFt: 35000, reference: "MSL" },
            },
            {
              timeSec: 60,
              position: { x: 0.8, y: 0.5 },
              altitude: { valueFt: 35000, reference: "MSL" },
            },
          ],
        },
      },
      {
        id: "flight-b",
        type: "aircraft",
        title: "Flight B",
        triggerMode: "manual",
        defaultEnabled: true,
        route: {
          points: [
            {
              timeSec: 0,
              position: { x: 0.5, y: 0.8 },
              altitude: { valueFt: 35000, reference: "MSL" },
            },
            {
              timeSec: 60,
              position: { x: 0.5, y: 0.2 },
              altitude: { valueFt: 35000, reference: "MSL" },
            },
          ],
        },
      },
      {
        id: "weather-one",
        type: "weather",
        title: "Weather One",
        triggerMode: "manual",
        defaultEnabled: false,
        geometry: { type: "circle", x: 0.6, y: 0.4, radius: 0.08 },
      },
    ],
  };
}

function fakeClock() {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    advance(seconds) {
      milliseconds += seconds * 1000;
    },
  };
}

function assertAircraftState(session, expected) {
  const state = session.getSnapshot().aircraftStates[0];
  assert.ok(Math.abs(state.position.x - expected.x) < 1e-9);
  assert.ok(Math.abs(state.position.y - expected.y) < 1e-9);
  assert.ok(Math.abs(state.altitude.valueFt - expected.altitudeFt) < 1e-9);
  assert.ok(Math.abs(state.headingDeg - expected.headingDeg) < 1e-9);
}

function aircraft(snapshot, eventId) {
  return snapshot.aircraftStates.find((state) => state.eventId === eventId);
}
