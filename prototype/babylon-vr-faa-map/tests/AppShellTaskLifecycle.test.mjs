import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { TaskSession } from "../src/training/TaskSession.js";
import { TaskEventLog, TASK_EVENT_TYPES } from "../src/training/TaskEventLog.js";


globalThis.Option = class Option {
  constructor(text, value) {
    this.text = text;
    this.value = value;
  }
};
globalThis.__TestTaskSession = TaskSession;
globalThis.__TestTaskEventLog = TaskEventLog;
globalThis.__TestTaskEventTypes = TASK_EVENT_TYPES;
globalThis.__TestManifests = new Map();

const appShellSource = await readFile(new URL("../src/app/AppShell.js", import.meta.url), "utf8");
const classStart = appShellSource.indexOf("export class AppShell");
const testableSource = `
const TaskSetRepository = class {};
const TaskSession = globalThis.__TestTaskSession;
const TaskEventLog = globalThis.__TestTaskEventLog;
const TASK_EVENT_TYPES = globalThis.__TestTaskEventTypes;
const createMapScene = async () => null;
const loadSectionIndex = async () => ({ sections: [] });
const loadSectionManifest = async (entry) => globalThis.__TestManifests.get(entry.id);
const BroadcastLinkSession = class {
  constructor() {
    this.connected = false;
    this.sessionId = "";
    this.selections = [];
    this.toggles = [];
  }
  isConnected() { return this.connected; }
  disconnect() { this.connected = false; this.sessionId = ""; }
  publishSelection(selection) { this.selections.push(selection); }
  publishToggle(toggle) { this.toggles.push(toggle); }
};
const generateSessionId = () => "test";
const readSavedSessionId = () => "";
${appShellSource.slice(classStart)}
`;
const { AppShell } = await import(`data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`);

test("instruction selector handles loading, removal, failure, and section switching", async () => {
  const stlouis = manifest("stlouis", [{ id: "example", title: "Example", data: "tasks/example.json" }]);
  const daytona = manifest("daytona", []);
  globalThis.__TestManifests.set("stlouis", stlouis);
  globalThis.__TestManifests.set("daytona", daytona);

  const elements = createElements();
  const shell = new AppShell(elements);
  shell.sectionIndex = {
    sections: [
      { id: "stlouis", title: "St. Louis", quality: "primary" },
      { id: "daytona", title: "Daytona", quality: "primary" },
    ],
  };
  shell.sceneController = {
    layerManager: { loadSection: async () => {} },
    setAirspaceAltitudeMode() {},
    taskSessions: [],
    setVrTaskSession(taskSession) { this.taskSessions.push(taskSession); },
  };
  shell.renderLayerControls = () => {};
  shell.syncVrControlPanel = () => {};
  const synchronizedSections = [];
  shell.syncUrl = (sectionId) => synchronizedSections.push(sectionId);

  await shell.loadSectionById("stlouis");
  assert.deepEqual(synchronizedSections, ["stlouis"]);
  assert.equal(elements.instructionGroup.hidden, false);
  assert.deepEqual(elements.instructionSelect.options.map((option) => option.text), ["No instructions", "Example"]);

  const deferred = createDeferred();
  shell.linkSession.connected = true;
  shell.linkSession.sessionId = "linked-test";
  shell.taskSetRepository = { load: () => deferred.promise };
  const loading = shell.handleInstructionSetChange("example");
  assert.equal(elements.sectionSelect.disabled, true);
  assert.equal(elements.instructionSelect.disabled, true);
  deferred.resolve(taskSet());
  await loading;
  assert.deepEqual(synchronizedSections, ["stlouis"]);
  assert.equal(shell.taskSession.currentTask.id, "task-one");
  assert.equal(shell.sceneController.taskSessions.at(-1), shell.taskSession);
  assert.equal(elements.instructionSelect.value, "example");
  assert.equal(elements.sectionSelect.disabled, false);
  assert.equal(elements.resetTaskSessionButton.hidden, false);
  assert.equal(shell.taskEventLog.getEvents().at(-1).type, "task_set_loaded");
  assert.equal(shell.taskEventLog.getEvents().at(-1).linkedSessionId, "linked-test");
  shell.publishSelection({ kind: "label", labelId: "STL" });
  shell.publishToggle({ sectionId: "stlouis", layerId: "airspace", checked: true });
  assert.equal(shell.linkSession.selections.length, 1);
  assert.equal(shell.linkSession.toggles.length, 1);

  shell.taskSession.setCurrentTaskCompleted();
  const participantSession = shell.taskSession;
  shell.resetTaskSession();
  assert.equal(participantSession.disposed, true);
  assert.notEqual(shell.taskSession, participantSession);
  assert.deepEqual(shell.taskSession.getSnapshot().completedTaskIds, []);
  assert.equal(shell.taskSession.currentTask.id, "task-one");
  assert.equal(elements.instructionSelect.value, "example");
  assert.deepEqual(
    shell.taskEventLog.getEvents().slice(-2).map((event) => [event.type, event.reason]),
    [["task_session_cleared", "researcher_reset"], ["task_set_loaded", "researcher_reset"]],
  );

  const removedSession = shell.taskSession;
  await shell.handleInstructionSetChange("");
  assert.equal(removedSession.disposed, true);
  assert.equal(shell.taskSession, null);
  assert.equal(shell.sceneController.taskSessions.at(-1), null);
  assert.equal(elements.resetTaskSessionButton.hidden, true);
  assert.equal(shell.taskEventLog.getEvents().at(-1).type, "task_session_cleared");
  assert.deepEqual(synchronizedSections, ["stlouis"]);
  assert.equal(elements.instructionSelect.value, "");

  shell.taskSetRepository = { load: async () => taskSet() };
  await shell.handleInstructionSetChange("example");
  const sectionSession = shell.taskSession;
  await shell.loadSectionById("daytona");
  assert.equal(sectionSession.disposed, true);
  assert.equal(shell.taskSession, null);
  assert.equal(elements.instructionGroup.hidden, true);
  assert.equal(elements.instructionSelect.disabled, true);

  await shell.loadSectionById("stlouis");
  shell.taskSetRepository = { load: async () => { throw new Error("HTTP 404"); } };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await shell.handleInstructionSetChange("example");
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(shell.taskSession, null);
  assert.equal(elements.instructionSelect.value, "");
  assert.equal(elements.statusLine.dataset.state, "error");
  assert.match(elements.statusLine.textContent, /Unable to load instruction set.*HTTP 404/);
  assert.equal(elements.sectionSelect.disabled, false);
  assert.equal(elements.instructionSelect.disabled, false);
});

function createElements() {
  return {
    sectionSelect: new FakeSelect(),
    instructionSelect: new FakeSelect(),
    instructionGroup: new FakeElement(),
    resetTaskSessionButton: new FakeElement(),
    sectionQuality: { dataset: {}, textContent: "", title: "" },
    statusLine: { dataset: {}, textContent: "" },
  };
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

class FakeSelect extends FakeElement {
  constructor() {
    super();
    this.options = [];
    this.value = "";
    this.disabled = false;
    this.title = "";
    this.previousElementSibling = { hidden: false };
  }

  set innerHTML(_value) {
    this.options = [];
  }

  append(...options) {
    this.options.push(...options);
  }
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
    id: "example",
    title: "Example",
    tasks: [{ id: "task-one", title: "One", instructions: "Do it", completionMode: "manual" }],
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
