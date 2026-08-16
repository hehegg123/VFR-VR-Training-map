import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EventSession } from "../src/training/EventSession.js";

globalThis.BABYLON = {
  WebXRState: {},
  Vector3: class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
  },
};
const { AppShell: VrAppShell } = await import("../src/app/AppShell.js");
const { AppShell: DesktopAppShell } = await import("../../faa-2d-map/src/app/AppShell.js");

const eventSet = JSON.parse(readFileSync(
  new URL("../../training/event-sets/daytona/daytona-conflict-scenario.json", import.meta.url),
  "utf8",
));

test("repeated VR and desktop Start/Pause/Reset cycles retain one frame loop", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const scheduler = createFrameScheduler();
  globalThis.requestAnimationFrame = scheduler.request;
  globalThis.cancelAnimationFrame = scheduler.cancel;

  try {
    const vrClock = fakeClock();
    const vrShell = new VrAppShell({ eventControls: fakeEventControls() });
    vrShell.eventSession = new EventSession(eventSet, { now: vrClock.now });
    vrShell.currentManifest = { id: "daytona" };
    exerciseFrameLoop({
      shell: vrShell,
      session: vrShell.eventSession,
      clock: vrClock,
      scheduler,
      startMethod: "startScenarioUiAnimation",
      stopMethod: "stopScenarioUiAnimation",
      handleField: "scenarioUiFrameHandle",
    });

    const desktopClock = fakeClock();
    const desktopShell = Object.create(DesktopAppShell.prototype);
    desktopShell.eventSession = new EventSession(eventSet, { now: desktopClock.now });
    desktopShell.scenarioFrameHandle = 0;
    desktopShell.elements = { eventControls: fakeEventControls() };
    desktopShell.mapView = { setEventSnapshot() {} };
    exerciseFrameLoop({
      shell: desktopShell,
      session: desktopShell.eventSession,
      clock: desktopClock,
      scheduler,
      startMethod: "startScenarioAnimation",
      stopMethod: "stopScenarioAnimation",
      handleField: "scenarioFrameHandle",
    });
  } finally {
    restoreGlobal("requestAnimationFrame", originalRequestAnimationFrame);
    restoreGlobal("cancelAnimationFrame", originalCancelAnimationFrame);
  }
});

function exerciseFrameLoop({
  shell,
  session,
  clock,
  scheduler,
  startMethod,
  stopMethod,
  handleField,
}) {
  for (let cycle = 0; cycle < 5; cycle += 1) {
    assert.equal(session.startScenario(), true);
    shell[startMethod]();
    shell[startMethod]();
    assert.equal(scheduler.size(), 1);

    clock.advance(0.25);
    scheduler.runNext(cycle * 250);
    assert.equal(scheduler.size(), 1);
    assert.notEqual(shell[handleField], 0);

    assert.equal(session.pauseScenario(), true);
    shell[stopMethod]();
    assert.equal(scheduler.size(), 0);
    assert.equal(shell[handleField], 0);
    assert.equal(session.resetScenario(), true);
  }
}

function createFrameScheduler() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    request(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    runNext(timestamp) {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, "Expected one scheduled animation frame.");
      callbacks.delete(entry[0]);
      entry[1](timestamp);
    },
    size() {
      return callbacks.size;
    },
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

function fakeEventControls() {
  return { querySelector: () => null };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
