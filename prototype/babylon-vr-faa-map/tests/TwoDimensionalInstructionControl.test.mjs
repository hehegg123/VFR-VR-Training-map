import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.Option = class Option {
  constructor(text, value) {
    this.text = text;
    this.value = value;
  }
};
globalThis.__TwoDimensionalManifests = new Map();

const source = await readFile(new URL("../../faa-2d-map/src/app/AppShell.js", import.meta.url), "utf8");
const classStart = source.indexOf("export class AppShell");
const testableSource = `
const loadSectionIndex = async () => ({ sections: [] });
const loadSectionManifest = async (entry) => globalThis.__TwoDimensionalManifests.get(entry.id);
const MapCanvasView = class {
  async loadSection() {}
  setLayerVisible() {}
  setLabelVisible() {}
  setLabelOptions() {}
  setEventSnapshot(snapshot) { this.eventSnapshot = snapshot; }
};
const EventSetRepository = class { async load() { throw new Error("event repository not replaced"); } };
const TaskSetRepository = class { async load() { throw new Error("repository not replaced"); } };
const EventSession = class {
  constructor(eventSet) {
    this.eventSet = eventSet;
    this.enabled = new Set(eventSet.events.filter((event) => event.defaultEnabled).map((event) => event.id));
    this.subscribers = new Set();
  }
  getSnapshot() {
    return {
      eventSetId: this.eventSet.id,
      eventSetTitle: this.eventSet.title,
      sectionId: this.eventSet.sectionId,
      events: this.eventSet.events,
      activeEventIds: [...this.enabled],
      activeEvents: this.eventSet.events.filter((event) => this.enabled.has(event.id)),
      disposed: false,
    };
  }
  subscribe(listener) {
    this.subscribers.add(listener);
    listener(this.getSnapshot());
    return () => this.subscribers.delete(listener);
  }
  setEventEnabled(eventId, enabled) {
    const changed = enabled ? !this.enabled.has(eventId) : this.enabled.has(eventId);
    if (enabled) this.enabled.add(eventId); else this.enabled.delete(eventId);
    if (changed) for (const listener of this.subscribers) listener(this.getSnapshot());
    return changed;
  }
  applyEnabledEventIds(ids) {
    this.enabled = new Set(ids);
    for (const listener of this.subscribers) listener(this.getSnapshot());
  }
  dispose() {}
};
const BroadcastLinkSession = class {
  constructor() { this.connected = false; this.instructions = []; this.events = []; }
  isConnected() { return this.connected; }
  publishInstruction(value) { this.instructions.push(value); }
  publishEvent(value) { this.events.push(value); }
  publishSelection() {}
  publishToggle() {}
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
};
const generateSessionId = () => "test";
const readSavedSessionId = () => "";
${source.slice(classStart)}
`;
const { AppShell } = await import(`data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`);

test("2D instruction selector loads, resets, clears, and follows section changes", async () => {
  const daytona = manifest("daytona", [{
    id: "daytona-orientation",
    title: "Daytona Orientation",
    data: "tasks/daytona-orientation.json",
  }], [{
    id: "daytona-basic-events",
    title: "Daytona Basic Events",
    data: "events/daytona-basic-events.json",
  }]);
  const stlouis = manifest("stlouis", []);
  globalThis.__TwoDimensionalManifests.set("daytona", daytona);
  globalThis.__TwoDimensionalManifests.set("stlouis", stlouis);

  const elements = createElements();
  const shell = new AppShell(elements);
  shell.sectionIndex = { sections: [
    { id: "daytona", title: "Daytona", quality: "primary" },
    { id: "stlouis", title: "St. Louis", quality: "primary" },
  ] };
  shell.renderLayerControls = () => {};
  shell.renderEventControls = () => {};
  const synchronizedSections = [];
  shell.syncUrl = (sectionId) => synchronizedSections.push(sectionId);
  shell.taskSetRepository = { load: async () => taskSet() };
  shell.eventSetRepository = { load: async () => eventSet() };

  await shell.loadSectionById("daytona");
  assert.equal(elements.instructionGroup.hidden, false);
  assert.deepEqual(elements.instructionSelect.options.map((option) => option.text), [
    "No instructions",
    "Daytona Orientation",
  ]);
  assert.deepEqual(synchronizedSections, ["daytona"]);

  assert.equal(elements.eventGroup.hidden, false);
  assert.deepEqual(elements.eventSelect.options.map((option) => option.text), [
    "No events",
    "Daytona Basic Events",
  ]);

  shell.linkSession.connected = true;
  await shell.handleInstructionSetChange("daytona-orientation");
  assert.equal(shell.activeTaskSet.id, "daytona-orientation");
  assert.equal(elements.resetTaskSessionButton.hidden, false);
  assert.deepEqual(shell.linkSession.instructions.at(-1), {
    action: "load",
    sectionId: "daytona",
    taskSetId: "daytona-orientation",
  });

  await shell.handleEventSetChange("daytona-basic-events");
  assert.equal(shell.activeEventSet.id, "daytona-basic-events");
  assert.deepEqual(shell.linkSession.events.at(-1), {
    action: "load",
    sectionId: "daytona",
    eventSetId: "daytona-basic-events",
    activeEventIds: [],
  });
  shell.setEventEnabled("aircraft-final-approach", true);
  assert.deepEqual(shell.linkSession.events.at(-1), {
    action: "toggle",
    sectionId: "daytona",
    eventSetId: "daytona-basic-events",
    eventId: "aircraft-final-approach",
    enabled: true,
    activeEventIds: ["aircraft-final-approach"],
  });
  assert.deepEqual(synchronizedSections, ["daytona"]);

  shell.resetTaskSession();
  assert.equal(shell.linkSession.instructions.at(-1).action, "reset");

  await shell.handleInstructionSetChange("");
  assert.equal(shell.activeTaskSet, null);
  assert.equal(elements.resetTaskSessionButton.hidden, true);
  assert.equal(shell.linkSession.instructions.at(-1).action, "clear");

  await shell.handleInstructionSetChange("daytona-orientation");
  await shell.loadSectionById("stlouis");
  assert.equal(shell.activeTaskSet, null);
  assert.equal(shell.activeEventSet, null);
  assert.equal(elements.instructionGroup.hidden, true);
  assert.equal(elements.instructionSelect.disabled, true);
  assert.equal(elements.eventGroup.hidden, true);
  assert.equal(elements.eventSelect.disabled, true);
  assert.deepEqual(synchronizedSections, ["daytona", "stlouis"]);
});

function createElements() {
  return {
    sectionSelect: new FakeSelect(),
    instructionSelect: new FakeSelect(),
    instructionGroup: new FakeElement(),
    resetTaskSessionButton: new FakeElement(),
    instructionStatus: { dataset: {}, textContent: "" },
    eventSelect: new FakeSelect(),
    eventGroup: new FakeElement(),
    eventControls: new FakeElement(),
    eventStatus: { dataset: {}, textContent: "" },
    sectionQuality: { dataset: {}, textContent: "" },
    statusLine: { dataset: {}, textContent: "" },
  };
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.textContent = "";
  }

  set innerHTML(_value) { this.children = []; }
  append(...children) { this.children.push(...children); }
}

class FakeSelect extends FakeElement {
  constructor() {
    super();
    this.options = [];
    this.value = "";
    this.previousElementSibling = { hidden: false };
  }

  set innerHTML(_value) { this.options = []; }
  append(...options) { this.options.push(...options); }
}

function manifest(id, taskSets, eventSets = []) {
  return {
    id,
    title: id,
    assetVersion: "2026-06-21T00:00:00Z",
    layers: [{ id: "base", title: "Base", defaultVisible: true }],
    training: { taskSets, eventSets },
  };
}

function taskSet() {
  return {
    schema: "faa-vr-task-set-v1",
    id: "daytona-orientation",
    sectionId: "daytona",
    title: "Daytona Orientation",
    tasks: [{ id: "one", title: "One", instructions: "Inspect Daytona.", completionMode: "manual" }],
  };
}

function eventSet() {
  return {
    schema: "faa-vr-event-set-v1",
    id: "daytona-basic-events",
    sectionId: "daytona",
    title: "Daytona Basic Events",
    events: [{
      id: "aircraft-final-approach",
      type: "aircraft",
      title: "Aircraft on Final Approach",
      triggerMode: "manual",
      defaultEnabled: false,
      position: { x: 0.52, y: 0.43 },
      altitude: { valueFt: 1800, reference: "MSL" },
    }],
  };
}
