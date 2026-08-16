import assert from "node:assert/strict";
import test from "node:test";

import { TaskSession } from "../src/training/TaskSession.js";
import { TaskEventLog } from "../src/training/TaskEventLog.js";

class Observable {
  constructor() {
    this.listeners = new Set();
  }

  add(listener) {
    this.listeners.add(listener);
    return listener;
  }

  remove(listener) {
    this.listeners.delete(listener);
  }

  notify(...args) {
    for (const listener of [...this.listeners]) {
      listener(...args);
    }
  }
}

class GuiControl {
  constructor(name = "") {
    this.name = name;
    this.controls = [];
    this.onPointerUpObservable = new Observable();
  }

  addControl(control) {
    this.controls.push(control);
  }

  clearControls() {
    this.controls = [];
  }
}

class Grid extends GuiControl {
  addColumnDefinition() {}
}

class Button extends GuiControl {
  static CreateSimpleButton(name, text) {
    const button = new Button(name);
    button.text = text;
    return button;
  }
}

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static Zero() {
    return new Vector3();
  }

  copyFrom(other) {
    Object.assign(this, other);
  }
}

class TransformNode {
  constructor() {
    this.position = new Vector3();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  dispose() {}
}

globalThis.BABYLON = {
  WebXRState: { IN_XR: 2, ENTERING_XR: 1 },
  Vector3,
  TransformNode,
  MeshBuilder: {
    CreatePlane: () => ({
      position: new Vector3(),
      setEnabled() {},
      dispose() {},
    }),
  },
  Mesh: { BILLBOARDMODE_ALL: 7 },
  StandardMaterial: class { dispose() {} },
  Color3: class {
    static Black() { return {}; }
  },
  GUI: {
    AdvancedDynamicTexture: {
      CreateForMesh: () => ({ addControl() {}, dispose() {} }),
    },
    Rectangle: class extends GuiControl {},
    StackPanel: class extends GuiControl {},
    Grid,
    Button,
    TextBlock: class extends GuiControl {},
    ScrollViewer: class extends GuiControl {},
    Control: {
      HORIZONTAL_ALIGNMENT_CENTER: 0,
      HORIZONTAL_ALIGNMENT_LEFT: 1,
      VERTICAL_ALIGNMENT_CENTER: 0,
      VERTICAL_ALIGNMENT_TOP: 1,
    },
  },
};

const { VrControlPanel } = await import("../src/scene/xr/VrControlPanel.js");

test("left stick click toggles when the motion controller was initialized before the panel", () => {
  const component = createButtonComponent();
  const controller = createController("left-ready", "left", createMotionController(component));
  const { panel } = createPanelHarness([controller]);

  assert.equal(panel.panelVisible, true);
  press(component);
  assert.equal(panel.panelVisible, false);
  release(component);
  panel.lastToggleTime = 0;
  press(component);
  assert.equal(panel.panelVisible, true);
  panel.dispose();
});

test("left stick click toggles when the motion controller initializes after the panel", () => {
  const component = createButtonComponent();
  const controller = createController("left-delayed", "left", null);
  const { panel } = createPanelHarness([controller]);

  controller.motionController = createMotionController(component);
  controller.onMotionControllerInitObservable.notify(controller.motionController);
  press(component);
  assert.equal(panel.panelVisible, false);
  panel.dispose();
});

test("right stick click does not toggle the left-arm panel", () => {
  const component = createButtonComponent();
  const controller = createController("right-ready", "right", createMotionController(component));
  const { panel } = createPanelHarness([controller]);

  press(component);
  assert.equal(panel.panelVisible, true);
  panel.dispose();
});

test("left WebXR gamepad stick click toggles when no motion-controller component is available", () => {
  const controller = createController("left-gamepad", "left", null);
  controller.inputSource.gamepad = { buttons: [{}, {}, {}, { pressed: false }] };
  const { panel, scene } = createPanelHarness([controller]);
  panel.setConfig(panelConfig());

  controller.inputSource.gamepad.buttons[3].pressed = true;
  scene.onBeforeRenderObservable.notify();
  assert.equal(panel.panelVisible, false);
  scene.onBeforeRenderObservable.notify();
  assert.equal(panel.panelVisible, false);
  controller.inputSource.gamepad.buttons[3].pressed = false;
  scene.onBeforeRenderObservable.notify();
  controller.inputSource.gamepad.buttons[3].pressed = true;
  scene.onBeforeRenderObservable.notify();
  assert.equal(panel.panelVisible, true);
  panel.dispose();
});

test("XR panel uses a world-space forearm position instead of inheriting wrist rotation", () => {
  const controller = createController("left-mounted", "left", null);
  controller.grip = {
    position: new Vector3(1, 2, 3),
    getAbsolutePosition: () => new Vector3(1, 2, 3),
  };
  const { panel, xrHelper } = createPanelHarness([controller]);
  xrHelper.baseExperience.state = BABYLON.WebXRState.IN_XR;
  xrHelper.baseExperience.camera = {
    getForwardRay: () => ({ direction: new Vector3(0, 0, 1) }),
  };
  panel.setConfig(panelConfig());

  assert.equal(panel.root.parent, null);
  assert.deepEqual(panel.root.position, new Vector3(1.02, 2.21, 3.16));
  panel.dispose();
});

test("desktop harness preserves instruction tab and task progress across panel rebuilds", () => {
  const beforeRender = new Observable();
  const scene = { onBeforeRenderObservable: beforeRender };
  const xrHelper = {
    input: {
      controllers: [],
      onControllerAddedObservable: new Observable(),
      onControllerRemovedObservable: new Observable(),
    },
    baseExperience: {
      state: 0,
      camera: {},
      onStateChangedObservable: new Observable(),
    },
  };
  const panel = new VrControlPanel(scene, xrHelper, {});
  const mapActions = [];
  panel.setConfig(panelConfig({}, {
    onToggleLayerVisible: (layerId, visible) => mapActions.push(["layer", layerId, visible]),
    onSetAllLayerVisible: (visible) => mapActions.push(["all-layers", visible]),
  }));

  assert.ok(findControl(panel.stack, "xr-panel-tab-map"));
  assert.equal(findControl(panel.stack, "xr-panel-tab-instructions"), null);
  click(findControl(panel.stack, "Map-toggle"));
  click(findControl(panel.stack, "master-Maps-Select All"));
  assert.deepEqual(mapActions, [
    ["layer", "airspace", false],
    ["all-layers", true],
  ]);
  const session = new TaskSession(taskSet());
  const eventLog = new TaskEventLog({
    contextProvider: () => ({ sectionId: "stlouis", linkedSessionId: "linked-test" }),
  });
  panel.setTaskSession(session, eventLog);
  assert.equal(session.subscribers.size, 1);

  click(findControl(panel.stack, "xr-panel-tab-instructions"));
  assert.equal(panel.selectedTab, "instructions");
  assert.ok(findControl(panel.stack, "xr-instructions-scroll"));
  assert.match(findControl(panel.stack, "xr-instruction-steps").text, /Enable the airspace layer/);
  assert.deepEqual(eventLog.getEvents().map((event) => event.type), [
    "instructions_tab_opened",
    "task_viewed",
  ]);

  click(findControl(panel.stack, "xr-instruction-Mark Complete"));
  assert.equal(session.currentTask.id, "task-two");
  assert.equal(session.completedTaskIds.has("task-one"), true);

  click(findControl(panel.stack, "xr-instruction-Previous"));
  assert.equal(session.currentTask.id, "task-one");
  session.next();

  panel.setConfig(panelConfig({ layerVisible: false }));
  assert.equal(panel.selectedTab, "instructions");
  assert.equal(session.currentTask.id, "task-two");
  assert.equal(findControls(panel.stack, "xr-panel-tabs").length, 1);
  assert.equal(findControls(panel.stack, "xr-instruction-actions").length, 1);

  click(findControl(panel.stack, "xr-panel-tab-map"));
  click(findControl(panel.stack, "xr-panel-tab-instructions"));
  assert.equal(panel.selectedTab, "instructions");

  panel.togglePanelVisibility();
  panel.togglePanelVisibility();
  assert.equal(session.currentTask.id, "task-two");

  click(findControl(panel.stack, "xr-instruction-Mark Complete"));
  assert.equal(session.currentTask.id, "task-two");
  assert.ok(findControl(panel.stack, "xr-instruction-Task Completed"));
  assert.ok(findText(panel.stack, "Instruction set complete"));
  assert.deepEqual(eventLog.getEvents().map((event) => event.type), [
    "instructions_tab_opened",
    "task_viewed",
    "task_completed",
    "task_viewed",
    "previous_selected",
    "task_viewed",
    "task_viewed",
    "instructions_tab_opened",
    "task_viewed",
    "task_completed",
    "task_set_completed",
  ]);
  assert.ok(eventLog.getEvents().every((event) => (
    event.timestamp && event.taskSetId === "test" && event.sectionId === "stlouis" && event.linkedSessionId === "linked-test"
  )));

  panel.setTaskSession(null);
  assert.equal(session.subscribers.size, 0);
  assert.equal(panel.selectedTab, "map");
  assert.ok(findControl(panel.stack, "xr-panel-tab-map"));
  assert.equal(findControl(panel.stack, "xr-panel-tab-instructions"), null);
  panel.dispose();
});

function createPanelHarness(controllers) {
  const scene = { onBeforeRenderObservable: new Observable() };
  const xrHelper = {
    input: {
      controllers,
      onControllerAddedObservable: new Observable(),
      onControllerRemovedObservable: new Observable(),
    },
    baseExperience: {
      state: 0,
      camera: {},
      onStateChangedObservable: new Observable(),
    },
  };
  return { panel: new VrControlPanel(scene, xrHelper, {}), scene, xrHelper };
}

function createController(uniqueId, handedness, motionController) {
  return {
    uniqueId,
    inputSource: { handedness },
    motionController,
    onMotionControllerInitObservable: new Observable(),
  };
}

function createMotionController(component) {
  return {
    getComponentIds: () => ["xr-standard-thumbstick"],
    getComponent: (id) => id === "xr-standard-thumbstick" ? component : null,
  };
}

function createButtonComponent() {
  return {
    pressed: false,
    onButtonStateChangedObservable: new Observable(),
  };
}

function press(component) {
  component.pressed = true;
  component.onButtonStateChangedObservable.notify();
}

function release(component) {
  component.pressed = false;
  component.onButtonStateChangedObservable.notify();
}

function panelConfig(overrides = {}, callbacks = {}) {
  return {
    title: "Test Controls",
    ...callbacks,
    layers: [{
      id: "airspace",
      title: "Airspace",
      layerVisible: true,
      labelsEnabled: true,
      labelToggleAvailable: true,
      supportsAltitudeVolume: true,
      altitudeVolumeEnabled: false,
      ...overrides,
    }],
  };
}

function taskSet() {
  return {
    id: "test",
    title: "Airspace Orientation",
    tasks: [
      {
        id: "task-one",
        title: "Find Class B",
        instructions: "Enable the airspace layer and select the main Class B label.",
        completionMode: "manual",
      },
      {
        id: "task-two",
        title: "Review altitude",
        instructions: "Enable altitude mode and review the floor and ceiling.",
        completionMode: "manual",
      },
    ],
  };
}

function findControl(root, name) {
  if (!root) {
    return null;
  }
  if (root.name === name) {
    return root;
  }
  for (const child of root.controls ?? []) {
    const found = findControl(child, name);
    if (found) {
      return found;
    }
  }
  return null;
}

function findControls(root, name, matches = []) {
  if (!root) {
    return matches;
  }
  if (root.name === name) {
    matches.push(root);
  }
  for (const child of root.controls ?? []) {
    findControls(child, name, matches);
  }
  return matches;
}

function findText(root, text) {
  if (`${root?.text ?? ""}` === text) {
    return root;
  }
  for (const child of root?.controls ?? []) {
    const found = findText(child, text);
    if (found) {
      return found;
    }
  }
  return null;
}

function click(control) {
  assert.ok(control, "Expected GUI control to exist");
  control.onPointerUpObservable.notify();
}
