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
const MapCanvasView = class { async loadSection() {} setLayerVisible() {} setLabelVisible() {} setLabelOptions() {} };
const TaskSetRepository = class { async load() { throw new Error("repository not replaced"); } };
const BroadcastLinkSession = class {
  constructor() { this.connected = false; this.instructions = []; }
  isConnected() { return this.connected; }
  publishInstruction(value) { this.instructions.push(value); }
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
  const synchronizedSections = [];
  shell.syncUrl = (sectionId) => synchronizedSections.push(sectionId);
  shell.taskSetRepository = { load: async () => taskSet() };

  await shell.loadSectionById("daytona");
  assert.equal(elements.instructionGroup.hidden, false);
  assert.deepEqual(elements.instructionSelect.options.map((option) => option.text), [
    "No instructions",
    "Daytona Orientation",
  ]);
  assert.deepEqual(synchronizedSections, ["daytona"]);

  shell.linkSession.connected = true;
  await shell.handleInstructionSetChange("daytona-orientation");
  assert.equal(shell.activeTaskSet.id, "daytona-orientation");
  assert.equal(elements.resetTaskSessionButton.hidden, false);
  assert.deepEqual(shell.linkSession.instructions.at(-1), {
    action: "load",
    sectionId: "daytona",
    taskSetId: "daytona-orientation",
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
  assert.equal(elements.instructionGroup.hidden, true);
  assert.equal(elements.instructionSelect.disabled, true);
  assert.deepEqual(synchronizedSections, ["daytona", "stlouis"]);
});

function createElements() {
  return {
    sectionSelect: new FakeSelect(),
    instructionSelect: new FakeSelect(),
    instructionGroup: new FakeElement(),
    resetTaskSessionButton: new FakeElement(),
    instructionStatus: { dataset: {}, textContent: "" },
    sectionQuality: { dataset: {}, textContent: "" },
    statusLine: { dataset: {}, textContent: "" },
  };
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
  }
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

function manifest(id, taskSets) {
  return {
    id,
    title: id,
    assetVersion: "2026-06-21T00:00:00Z",
    layers: [{ id: "base", title: "Base", defaultVisible: true }],
    training: { taskSets },
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
