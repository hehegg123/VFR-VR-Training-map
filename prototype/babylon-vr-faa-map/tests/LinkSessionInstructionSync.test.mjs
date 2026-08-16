import assert from "node:assert/strict";
import test from "node:test";

class FakeBroadcastChannel {
  static channels = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    const peers = FakeBroadcastChannel.channels.get(name) ?? [];
    peers.push(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(data) {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer !== this) {
        peer.onmessage?.({ data });
      }
    }
  }

  close() {
    const peers = FakeBroadcastChannel.channels.get(this.name) ?? [];
    FakeBroadcastChannel.channels.set(this.name, peers.filter((peer) => peer !== this));
  }
}

globalThis.BroadcastChannel = FakeBroadcastChannel;
const { BroadcastLinkSession } = await import("../../shared/linkSession.js");

test("instruction commands are delivered only to linked peers", () => {
  const sender = new BroadcastLinkSession({ appId: "2d-test" });
  const receiver = new BroadcastLinkSession({ appId: "vr-test" });
  const received = [];

  sender.connect("instruction-test");
  receiver.connect("instruction-test", { onInstruction: (instruction) => received.push(instruction) });
  sender.publishInstruction({ action: "load", sectionId: "daytona", taskSetId: "daytona-orientation" });
  sender.publishInstruction({ action: "reset", sectionId: "daytona", taskSetId: "daytona-orientation" });
  sender.publishInstruction({ action: "clear", sectionId: "daytona", taskSetId: null });

  assert.deepEqual(received, [
    { action: "load", sectionId: "daytona", taskSetId: "daytona-orientation" },
    { action: "reset", sectionId: "daytona", taskSetId: "daytona-orientation" },
    { action: "clear", sectionId: "daytona", taskSetId: null },
  ]);
  sender.disconnect();
  receiver.disconnect();
});

test("event commands are delivered only to linked peers", () => {
  const sender = new BroadcastLinkSession({ appId: "2d-event-test" });
  const receiver = new BroadcastLinkSession({ appId: "vr-event-test" });
  const received = [];

  sender.connect("event-test");
  receiver.connect("event-test", { onEvent: (eventState) => received.push(eventState) });
  sender.publishEvent({
    action: "load",
    sectionId: "daytona",
    eventSetId: "daytona-basic-events",
    activeEventIds: [],
  });
  sender.publishEvent({
    action: "toggle",
    sectionId: "daytona",
    eventSetId: "daytona-basic-events",
    eventId: "aircraft-final-approach",
    enabled: true,
    activeEventIds: ["aircraft-final-approach"],
  });
  sender.publishEvent({ action: "clear", sectionId: "daytona", eventSetId: "daytona-basic-events" });

  assert.deepEqual(received, [
    {
      action: "load",
      sectionId: "daytona",
      eventSetId: "daytona-basic-events",
      eventId: null,
      enabled: null,
      activeEventIds: [],
    },
    {
      action: "toggle",
      sectionId: "daytona",
      eventSetId: "daytona-basic-events",
      eventId: "aircraft-final-approach",
      enabled: true,
      activeEventIds: ["aircraft-final-approach"],
    },
    {
      action: "clear",
      sectionId: "daytona",
      eventSetId: "daytona-basic-events",
      eventId: null,
      enabled: null,
      activeEventIds: null,
    },
  ]);
  sender.disconnect();
  receiver.disconnect();
});

test("scenario commands and authoritative snapshots cross the linked session", () => {
  const vr = new BroadcastLinkSession({ appId: "vr-scenario-test" });
  const desktop = new BroadcastLinkSession({ appId: "2d-scenario-test" });
  const desktopReceived = [];
  const vrReceived = [];
  const scenarioSnapshot = {
    eventSetId: "daytona-conflict-scenario",
    scenarioStatus: "running",
    scenarioElapsedSec: 12,
    activeEventIds: ["flight-a", "flight-b"],
    aircraftStates: [{ eventId: "flight-a", position: { x: 0.3, y: 0.5 }, headingDeg: 90 }],
    conflictState: "conflict-predicted",
    conflict: { state: "conflict-predicted", horizontalSeparationNm: 4.8, verticalSeparationFt: 0 },
    appliedScenarioActions: [],
  };

  vr.connect("scenario-test", { onEvent: (eventState) => vrReceived.push(eventState) });
  desktop.connect("scenario-test", { onEvent: (eventState) => desktopReceived.push(eventState) });
  vr.publishEvent({
    action: "scenario-command",
    sectionId: "daytona",
    eventSetId: "daytona-conflict-scenario",
    command: "action",
    scenarioActionId: "flight-a-turn-right-130",
  });
  desktop.publishEvent({
    action: "scenario-snapshot",
    sectionId: "daytona",
    eventSetId: "daytona-conflict-scenario",
    scenarioSnapshot,
  });

  assert.equal(desktopReceived.length, 1);
  assert.equal(desktopReceived[0].command, "action");
  assert.equal(desktopReceived[0].scenarioActionId, "flight-a-turn-right-130");
  assert.equal(vrReceived.length, 1);
  assert.deepEqual(vrReceived[0].scenarioSnapshot, scenarioSnapshot);
  assert.equal(vrReceived[0].command, undefined);

  vr.disconnect();
  desktop.disconnect();
});
