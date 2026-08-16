import { TASK_EVENT_TYPES } from "../../training/TaskEventLog.js?v=20260621-instruction-workflow-v1";

const XR_STATES = BABYLON.WebXRState ?? {};
const PANEL_TOGGLE_DEBOUNCE_MS = 300;
const FALLBACK_VIEW_OFFSET = new BABYLON.Vector3(-0.34, -0.02, 0.72);
const CONTROLLER_FOREARM_OFFSET = new BABYLON.Vector3(0.02, 0.21, 0.16);
const ACTION_ROW_HEIGHT_PX = 52;
const CHECKBOX_WIDTH_PX = 148;
const CHECKBOX_HEIGHT_PX = 44;
const CHECKBOX_FONT_SIZE_PX = 28;
const LABEL_FONT_SIZE_PX = 29;
const MASTER_BUTTON_WIDTH_PX = 154;
const MASTER_BUTTON_HEIGHT_PX = 42;
const PANEL_TAB_MAP = "map";
const PANEL_TAB_INSTRUCTIONS = "instructions";
const PANEL_TAB_EVENTS = "events";
const INSTRUCTION_CONTENT_HEIGHT_PX = 1320;
const EVENT_CONTENT_HEIGHT_PX = 1320;

export class VrControlPanel {
  constructor(scene, xrHelper, camera, inputSourceVisualManager = null) {
    this.scene = scene;
    this.xrHelper = xrHelper;
    this.camera = camera;
    this.inputSourceVisualManager = inputSourceVisualManager;
    this.config = null;
    this.currentAnchor = null;
    this.leftController = null;
    this.panelVisible = true;
    this.lastToggleTime = 0;
    this.selectedTab = PANEL_TAB_MAP;
    this.taskSession = null;
    this.taskSnapshot = null;
    this.unsubscribeTaskSession = null;
    this.taskEventLog = null;
    this.lastViewedTaskKey = null;
    this.eventSession = null;
    this.eventSnapshot = null;
    this.unsubscribeEventSession = null;
    this.eventControlSignature = "";
    this.eventReadouts = null;
    this.controllerEntries = new Map();
    this.fallbackAnchor = new BABYLON.TransformNode("xr-panel-fallback-anchor", scene);
    this.fallbackAnchor.parent = camera;
    this.fallbackAnchor.position.copyFrom(FALLBACK_VIEW_OFFSET);
    this.root = new BABYLON.TransformNode("xr-panel-root", scene);
    this.root.parent = this.fallbackAnchor;
    this.root.position = BABYLON.Vector3.Zero();
    this.root.setEnabled(false);

    this.panelMesh = BABYLON.MeshBuilder.CreatePlane(
      "xr-panel-plane",
      { width: 0.46, height: 0.58 },
      scene,
    );
    this.panelMesh.parent = this.root;
    this.panelMesh.isPickable = true;
    this.panelMesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;

    this.panelMaterial = new BABYLON.StandardMaterial("xr-panel-material", scene);
    this.panelMaterial.diffuseColor = new BABYLON.Color3(0.07, 0.12, 0.2);
    this.panelMaterial.emissiveColor = new BABYLON.Color3(0.09, 0.15, 0.28);
    this.panelMaterial.alpha = 0.92;
    this.panelMaterial.specularColor = BABYLON.Color3.Black();
    this.panelMesh.material = this.panelMaterial;

    this.texture = BABYLON.GUI.AdvancedDynamicTexture.CreateForMesh(this.panelMesh, 1280, 1800, false);
    this.texture.background = "transparent";
    this.contentRoot = new BABYLON.GUI.Rectangle("xr-panel-content");
    this.contentRoot.thickness = 0;
    this.contentRoot.cornerRadius = 34;
    this.contentRoot.background = "#102038D9";
    this.texture.addControl(this.contentRoot);

    this.stack = new BABYLON.GUI.StackPanel("xr-panel-stack");
    this.stack.width = 0.92;
    this.stack.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.stack.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    this.stack.paddingTop = "24px";
    this.stack.paddingBottom = "22px";
    this.contentRoot.addControl(this.stack);

    this.controllerAddedObserver = xrHelper?.input?.onControllerAddedObservable?.add((controller) => {
      this.handleControllerAdded(controller);
    }) ?? null;
    this.controllerRemovedObserver = xrHelper?.input?.onControllerRemovedObservable?.add((controller) => {
      this.handleControllerRemoved(controller);
    }) ?? null;
    this.xrStateObserver = xrHelper?.baseExperience?.onStateChangedObservable?.add(() => {
      this.updateAnchor();
      this.updateVisibility();
    }) ?? null;
    this.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
      this.syncRuntimePlacement();
    });

    for (const controller of xrHelper?.input?.controllers ?? []) {
      this.handleControllerAdded(controller);
    }
  }

  setConfig(config) {
    this.config = config;
    this.rebuild();
    this.updateAnchor();
    this.updateVisibility();
  }

  setTaskSession(taskSession, taskEventLog = null) {
    if (taskSession === this.taskSession && taskEventLog === this.taskEventLog) {
      return;
    }
    this.unsubscribeTaskSession?.();
    this.unsubscribeTaskSession = null;
    this.taskSession = taskSession ?? null;
    this.taskEventLog = taskEventLog ?? null;
    this.taskSnapshot = null;
    this.lastViewedTaskKey = null;

    if (!this.taskSession) {
      this.selectedTab = PANEL_TAB_MAP;
      this.rebuild();
      return;
    }

    this.unsubscribeTaskSession = this.taskSession.subscribe((snapshot) => {
      this.taskSnapshot = snapshot;
      if (snapshot.disposed) {
        this.selectedTab = PANEL_TAB_MAP;
      }
      if (this.selectedTab === PANEL_TAB_INSTRUCTIONS && !snapshot.disposed) {
        this.recordTaskViewed(snapshot);
      }
      this.rebuild();
    });
  }

  setEventSession(eventSession) {
    if (eventSession === this.eventSession) {
      return;
    }
    this.unsubscribeEventSession?.();
    this.unsubscribeEventSession = null;
    this.eventSession = eventSession ?? null;
    this.eventSnapshot = null;
    this.eventControlSignature = "";
    this.eventReadouts = null;

    if (!this.eventSession) {
      if (this.selectedTab === PANEL_TAB_EVENTS && !(this.config?.eventSets?.length)) {
        this.selectedTab = PANEL_TAB_MAP;
      }
      this.rebuild();
      return;
    }

    this.unsubscribeEventSession = this.eventSession.subscribe((snapshot) => {
      const previousSignature = this.eventControlSignature;
      this.eventSnapshot = snapshot;
      this.eventControlSignature = scenarioControlSignature(snapshot);
      if (snapshot.disposed && this.selectedTab === PANEL_TAB_EVENTS) {
        this.selectedTab = PANEL_TAB_MAP;
      }
      if (
        this.selectedTab === PANEL_TAB_EVENTS
        && !snapshot.disposed
        && previousSignature === this.eventControlSignature
        && this.eventReadouts
      ) {
        this.updateEventReadouts(snapshot);
      } else {
        this.rebuild();
      }
    });
  }

  updateAnchor() {
    this.fallbackAnchor.parent = this.resolveFallbackParent();
    this.fallbackAnchor.position.copyFrom(FALLBACK_VIEW_OFFSET);
    const anchor = this.resolveAnchor();
    if (anchor === this.currentAnchor) {
      this.applyMountedOffset(anchor);
      return;
    }
    this.currentAnchor = anchor;
    this.root.parent = anchor;
    this.applyMountedOffset(anchor);
  }

  updateVisibility() {
    const inXr = this.isInXr();
    this.root.setEnabled(Boolean(this.config) && inXr && this.panelVisible);
  }

  rebuild() {
    this.stack.clearControls();
    this.eventReadouts = null;
    if (!this.config) {
      return;
    }

    this.stack.addControl(this.buildTitle(this.config.title ?? "St. Louis Controls", 44, "#E8F0FF"));
    if (this.config.subtitle) {
      const subtitle = this.buildTitle(this.config.subtitle, 27, "#B9C9E8");
      subtitle.height = "44px";
      this.stack.addControl(subtitle);
    }

    const hasInstructions = Boolean(this.taskSession && this.taskSnapshot && !this.taskSnapshot.disposed);
    const hasEventSession = Boolean(this.eventSession && this.eventSnapshot && !this.eventSnapshot.disposed);
    const hasEvents = Boolean(this.config.eventSets?.length) || hasEventSession;
    if (!hasInstructions && this.selectedTab === PANEL_TAB_INSTRUCTIONS) {
      this.selectedTab = PANEL_TAB_MAP;
    }
    if (!hasEvents && this.selectedTab === PANEL_TAB_EVENTS) {
      this.selectedTab = PANEL_TAB_MAP;
    }
    this.stack.addControl(this.buildTabs({ hasInstructions, hasEvents }));

    if (this.selectedTab === PANEL_TAB_INSTRUCTIONS && hasInstructions) {
      this.stack.addControl(this.buildInstructionsView());
      return;
    }
    if (this.selectedTab === PANEL_TAB_EVENTS && hasEvents) {
      this.stack.addControl(this.buildEventsView());
      return;
    }

    this.stack.addControl(this.buildMasterControls());

    for (const layer of this.config.layers ?? []) {
      this.stack.addControl(this.buildLayerCard(layer));
    }
  }

  buildTabs({ hasInstructions, hasEvents }) {
    const tabs = [
      ["Map Controls", PANEL_TAB_MAP],
      ...(hasInstructions ? [["Instructions", PANEL_TAB_INSTRUCTIONS]] : []),
      ...(hasEvents ? [["Events", PANEL_TAB_EVENTS]] : []),
    ];
    const row = new BABYLON.GUI.Grid("xr-panel-tabs");
    row.height = "72px";
    for (let index = 0; index < tabs.length; index += 1) {
      row.addColumnDefinition(1 / tabs.length);
      row.addControl(this.buildTabButton(tabs[index][0], tabs[index][1]), 0, index);
    }
    row.paddingBottom = "10px";
    return row;
  }

  buildTabButton(label, tabId) {
    const active = this.selectedTab === tabId;
    const button = BABYLON.GUI.Button.CreateSimpleButton(`xr-panel-tab-${tabId}`, label);
    button.height = "58px";
    button.width = "96%";
    button.cornerRadius = 14;
    button.thickness = active ? 3 : 1;
    button.fontSize = "27px";
    button.fontWeight = "700";
    button.color = "#F8FBFF";
    button.background = active ? "#1E7BFF" : "#243650";
    button.onPointerUpObservable.add(() => {
      if (this.selectedTab !== tabId) {
        this.selectedTab = tabId;
        if (tabId === PANEL_TAB_INSTRUCTIONS) {
          this.taskEventLog?.record(TASK_EVENT_TYPES.INSTRUCTIONS_TAB_OPENED, this.currentTaskEventDetails());
          this.lastViewedTaskKey = null;
          this.recordTaskViewed(this.taskSnapshot);
        } else {
          this.lastViewedTaskKey = null;
        }
        this.rebuild();
      }
    });
    return button;
  }

  buildInstructionsView() {
    const snapshot = this.taskSnapshot;
    const task = snapshot.currentTask;
    const completed = snapshot.completedTaskIds.includes(task.id);
    const isFinalTask = snapshot.currentTaskIndex === snapshot.taskCount - 1;

    const viewer = new BABYLON.GUI.ScrollViewer("xr-instructions-scroll");
    viewer.height = `${INSTRUCTION_CONTENT_HEIGHT_PX}px`;
    viewer.width = 0.98;
    viewer.thickness = 1;
    viewer.color = "#35527A";
    viewer.background = "#0D1A2FD9";
    viewer.cornerRadius = 20;
    viewer.barColor = "#74A8F5";
    viewer.barBackground = "#1A2D49";
    viewer.barSize = 24;
    viewer.thumbLength = 0.2;
    viewer.wheelPrecision = 0.12;
    viewer.forceVerticalBar = true;

    const content = new BABYLON.GUI.StackPanel("xr-instructions-content");
    content.width = 0.9;
    content.isVertical = true;
    content.paddingTop = "28px";
    content.paddingBottom = "28px";
    viewer.addControl(content);

    const setTitle = this.buildTitle(snapshot.taskSetTitle, 27, "#9EBCEB");
    setTitle.height = "46px";
    content.addControl(setTitle);

    const progress = this.buildTitle(`Task ${snapshot.currentTaskIndex + 1} of ${snapshot.taskCount}`, 30, "#C5D8F5");
    progress.height = "48px";
    content.addControl(progress);

    const taskTitle = this.buildTitle(task.title, 40, "#F4F8FF");
    taskTitle.height = `${estimateWrappedTextHeight(task.title, 30, 52, 84)}px`;
    taskTitle.textWrapping = true;
    content.addControl(taskTitle);

    const instructions = new BABYLON.GUI.TextBlock("xr-instruction-steps");
    instructions.text = task.instructions;
    instructions.color = "#E8F0FF";
    instructions.fontSize = "32px";
    instructions.fontWeight = "500";
    instructions.textWrapping = true;
    instructions.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    instructions.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    instructions.paddingLeft = "12px";
    instructions.paddingRight = "12px";
    instructions.paddingTop = "20px";
    instructions.paddingBottom = "24px";
    instructions.height = `${estimateWrappedTextHeight(task.instructions, 43, 45, 190)}px`;
    content.addControl(instructions);

    const status = this.buildTitle(completed ? "Status: Complete" : "Status: Not complete", 30, completed ? "#7CE6A0" : "#FFD37A");
    status.height = "58px";
    content.addControl(status);

    const actions = new BABYLON.GUI.Grid("xr-instruction-actions");
    actions.height = "82px";
    actions.addColumnDefinition(0.42);
    actions.addColumnDefinition(0.58);
    actions.addControl(this.buildInstructionButton(
      "Previous",
      () => {
        this.taskEventLog?.record(TASK_EVENT_TYPES.PREVIOUS_SELECTED, this.currentTaskEventDetails());
        this.taskSession?.previous();
      },
      !snapshot.canGoPrevious,
      "#243650",
    ), 0, 0);

    const finalCompleted = isFinalTask && completed;
    actions.addControl(this.buildInstructionButton(
      finalCompleted ? "Task Completed" : "Mark Complete",
      () => this.completeCurrentTask(),
      finalCompleted,
      finalCompleted ? "#24543A" : "#1E7BFF",
    ), 0, 1);
    content.addControl(actions);

    if (finalCompleted) {
      const completeMessage = this.buildTitle("Instruction set complete", 32, "#7CE6A0");
      completeMessage.height = "64px";
      content.addControl(completeMessage);
    }

    return viewer;
  }

  buildEventsView() {
    const snapshot = this.eventSnapshot?.disposed ? null : this.eventSnapshot;
    const viewer = new BABYLON.GUI.ScrollViewer("xr-events-scroll");
    viewer.height = `${EVENT_CONTENT_HEIGHT_PX}px`;
    viewer.width = 0.98;
    viewer.thickness = 1;
    viewer.color = "#35527A";
    viewer.background = "#0D1A2FD9";
    viewer.cornerRadius = 20;
    viewer.barColor = "#74A8F5";
    viewer.barBackground = "#1A2D49";
    viewer.barSize = 24;
    viewer.thumbLength = 0.2;
    viewer.wheelPrecision = 0.12;
    viewer.forceVerticalBar = true;

    const content = new BABYLON.GUI.StackPanel("xr-events-content");
    content.width = 0.9;
    content.isVertical = true;
    content.paddingTop = "28px";
    content.paddingBottom = "28px";
    viewer.addControl(content);

    const pickerTitle = this.buildTitle("Event Sets", 32, "#9EBCEB");
    pickerTitle.height = "54px";
    content.addControl(pickerTitle);

    const activeEventSetId = this.config?.activeEventSetId ?? snapshot?.eventSetId ?? null;
    for (const entry of this.config?.eventSets ?? []) {
      content.addControl(this.buildEventSetRow(entry, entry.id === activeEventSetId));
    }

    if (activeEventSetId) {
      content.addControl(this.buildInstructionButton(
        "Clear Event Set",
        () => this.config?.onSelectEventSet?.(""),
        Boolean(this.config?.eventSetLoading),
        "#8B3341",
      ));
    }

    if (!snapshot) {
      const message = this.buildTitle(
        this.config?.eventSetLoading ? "Loading event set..." : "Select an event set to display and control it in VR.",
        29,
        "#D9E7FF",
      );
      message.height = "110px";
      message.textWrapping = true;
      content.addControl(message);
      return viewer;
    }

    const title = this.buildTitle(snapshot.eventSetTitle, 34, "#F4F8FF");
    title.height = `${estimateWrappedTextHeight(snapshot.eventSetTitle, 32, 46, 58)}px`;
    title.textWrapping = true;
    content.addControl(title);

    if (snapshot.scenarioStatus && snapshot.scenarioStatus !== "unavailable") {
      this.buildScenarioControls(content, snapshot);
    }

    for (const type of ["aircraft", "weather"]) {
      const events = (snapshot.events ?? []).filter((event) => event.type === type);
      if (!events.length) {
        continue;
      }
      const heading = this.buildTitle(type === "aircraft" ? "Aircraft" : "Weather", 30, "#9EBCEB");
      heading.height = "54px";
      content.addControl(heading);
      for (const event of events) {
        content.addControl(this.buildEventRow(event, snapshot.activeEventIds.includes(event.id)));
      }
    }
    return viewer;
  }

  buildEventSetRow(entry, active) {
    const row = new BABYLON.GUI.Grid(`xr-event-set-${entry.id}`);
    row.height = "78px";
    row.addColumnDefinition(0.66);
    row.addColumnDefinition(0.34);
    row.paddingTop = "8px";

    const select = () => {
      if (!active && !this.config?.eventSetLoading) {
        this.config?.onSelectEventSet?.(entry.id);
      }
    };

    const label = new BABYLON.GUI.TextBlock(`xr-event-set-label-${entry.id}`);
    label.text = entry.title;
    label.color = "#D9E7FF";
    label.fontSize = "27px";
    label.fontWeight = "600";
    label.textWrapping = true;
    label.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    label.isPointerBlocker = true;
    label.onPointerUpObservable.add(select);
    row.addControl(label, 0, 0);

    const button = BABYLON.GUI.Button.CreateSimpleButton(
      `xr-event-set-load-${entry.id}`,
      active ? "Active" : "Load",
    );
    button.height = `${CHECKBOX_HEIGHT_PX}px`;
    button.width = `${CHECKBOX_WIDTH_PX}px`;
    button.cornerRadius = 12;
    button.thickness = active ? 2 : 1;
    button.fontSize = `${CHECKBOX_FONT_SIZE_PX}px`;
    button.fontWeight = "700";
    button.color = "#F8FBFF";
    button.background = active ? "#24543A" : "#1E7BFF";
    button.isEnabled = !active && !this.config?.eventSetLoading;
    button.onPointerUpObservable.add(select);
    row.addControl(button, 0, 1);
    return row;
  }

  buildScenarioControls(content, snapshot) {
    const elapsed = this.buildTitle("", 29, "#D9E7FF");
    const separation = this.buildTitle("", 29, "#D9E7FF");
    const status = this.buildTitle("", 31, "#FFD37A");
    for (const block of [elapsed, separation, status]) {
      block.height = "48px";
      content.addControl(block);
    }
    this.eventReadouts = { elapsed, separation, status };
    this.updateEventReadouts(snapshot);

    const transport = new BABYLON.GUI.Grid("xr-scenario-transport");
    transport.height = "76px";
    transport.addColumnDefinition(1 / 3);
    transport.addColumnDefinition(1 / 3);
    transport.addColumnDefinition(1 / 3);
    transport.addControl(this.buildInstructionButton(
      "Start",
      () => this.config?.onScenarioCommand?.("start"),
      !["ready", "paused"].includes(snapshot.scenarioStatus),
      "#1E7BFF",
    ), 0, 0);
    transport.addControl(this.buildInstructionButton(
      "Pause",
      () => this.config?.onScenarioCommand?.("pause"),
      snapshot.scenarioStatus !== "running",
      "#8A5B16",
    ), 0, 1);
    const canReset = snapshot.scenarioStatus !== "ready"
      || snapshot.scenarioElapsedSec > 0
      || (snapshot.appliedScenarioActions ?? []).length > 0;
    transport.addControl(this.buildInstructionButton(
      "Reset",
      () => this.config?.onScenarioCommand?.("reset"),
      !canReset,
      "#8B3341",
    ), 0, 2);
    content.addControl(transport);

    const appliedIds = new Set((snapshot.appliedScenarioActions ?? []).map((action) => action.id));
    const turnId = "flight-a-turn-right-130";
    const resumeId = "flight-a-resume-route";
    content.addControl(this.buildInstructionButton(
      "Flight A: Turn Right Heading 130",
      () => this.config?.onScenarioCommand?.("action", turnId),
      snapshot.scenarioStatus !== "running"
        || !["conflict-predicted", "loss-of-separation"].includes(snapshot.conflictState)
        || appliedIds.has(turnId),
      "#1E7BFF",
    ));
    content.addControl(this.buildInstructionButton(
      "Resume Route",
      () => this.config?.onScenarioCommand?.("action", resumeId),
      snapshot.scenarioStatus !== "running"
        || !appliedIds.has(turnId)
        || snapshot.conflictState !== "resolved"
        || appliedIds.has(resumeId),
      "#24543A",
    ));
  }

  updateEventReadouts(snapshot) {
    if (!this.eventReadouts) {
      return;
    }
    this.eventReadouts.elapsed.text = "Elapsed: " + formatScenarioTime(snapshot.scenarioElapsedSec);
    this.eventReadouts.separation.text = "Separation: " + formatScenarioSeparation(snapshot.conflict);
    this.eventReadouts.status.text = "Conflict: " + formatConflictState(snapshot.conflictState);
    this.eventReadouts.status.color = conflictStateColor(snapshot.conflictState);
  }

  buildEventRow(event, active) {
    const row = new BABYLON.GUI.Grid(`xr-event-${event.id}`);
    row.height = "66px";
    row.addColumnDefinition(0.62);
    row.addColumnDefinition(0.38);
    row.paddingTop = "8px";

    const toggle = () => {
      this.config?.onToggleEvent?.(event.id, !active);
    };

    const label = new BABYLON.GUI.TextBlock(`xr-event-label-${event.id}`);
    label.text = event.title;
    label.color = "#D9E7FF";
    label.fontSize = "27px";
    label.fontWeight = "600";
    label.textWrapping = true;
    label.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    label.isPointerBlocker = true;
    label.onPointerUpObservable.add(toggle);
    row.addControl(label, 0, 0);

    const button = BABYLON.GUI.Button.CreateSimpleButton(`xr-event-toggle-${event.id}`, active ? "On" : "Off");
    button.height = `${CHECKBOX_HEIGHT_PX}px`;
    button.width = `${CHECKBOX_WIDTH_PX}px`;
    button.cornerRadius = 12;
    button.thickness = active ? 2 : 1;
    button.fontSize = `${CHECKBOX_FONT_SIZE_PX}px`;
    button.fontWeight = "700";
    button.color = "#F8FBFF";
    button.background = active ? "#1E7BFF" : "#243650";
    button.onPointerUpObservable.add(toggle);
    row.addControl(button, 0, 1);
    return row;
  }

  completeCurrentTask() {
    const snapshot = this.taskSnapshot;
    const task = snapshot?.currentTask;
    if (!task || !this.taskSession) {
      return;
    }
    const alreadyCompleted = snapshot.completedTaskIds.includes(task.id);
    const completesTaskSet = !alreadyCompleted && snapshot.completedTaskIds.length + 1 === snapshot.taskCount;
    if (!alreadyCompleted) {
      this.taskEventLog?.record(TASK_EVENT_TYPES.TASK_COMPLETED, this.currentTaskEventDetails());
    }
    this.taskSession.completeCurrentAndAdvance();
    if (completesTaskSet) {
      this.taskEventLog?.record(TASK_EVENT_TYPES.TASK_SET_COMPLETED, {
        ...this.currentTaskEventDetails(),
        taskId: task.id,
      });
    }
  }

  recordTaskViewed(snapshot) {
    const taskSetId = snapshot?.taskSetId;
    const taskId = snapshot?.currentTask?.id;
    if (!taskSetId || !taskId) {
      return;
    }
    const viewKey = `${taskSetId}:${taskId}`;
    if (viewKey === this.lastViewedTaskKey) {
      return;
    }
    this.lastViewedTaskKey = viewKey;
    this.taskEventLog?.record(TASK_EVENT_TYPES.TASK_VIEWED, { taskSetId, taskId });
  }

  currentTaskEventDetails() {
    return {
      taskSetId: this.taskSnapshot?.taskSetId ?? this.taskSession?.taskSet?.id ?? null,
      taskId: this.taskSnapshot?.currentTask?.id ?? this.taskSession?.currentTask?.id ?? null,
    };
  }

  buildInstructionButton(label, onPress, disabled, background) {
    const button = BABYLON.GUI.Button.CreateSimpleButton(`xr-instruction-${label}`, label);
    button.height = "62px";
    button.width = "94%";
    button.cornerRadius = 14;
    button.thickness = 2;
    button.fontSize = "27px";
    button.fontWeight = "700";
    button.color = disabled ? "#A9B6CA" : "#FFFFFF";
    button.background = disabled ? "#263449" : background;
    button.isEnabled = !disabled;
    if (!disabled) {
      button.onPointerUpObservable.add(onPress);
    }
    return button;
  }

  buildTitle(text, size, color) {
    const block = new BABYLON.GUI.TextBlock();
    block.text = text;
    block.color = color;
    block.fontSize = `${size}px`;
    block.fontWeight = "600";
    block.height = "56px";
    block.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    block.paddingLeft = "12px";
    return block;
  }

  buildLayerCard(layer) {
    const card = new BABYLON.GUI.Rectangle(`xr-layer-${layer.id}`);
    const actionRows = layer.supportsAltitudeVolume ? 3 : 2;
    card.height = `${72 + actionRows * ACTION_ROW_HEIGHT_PX}px`;
    card.thickness = 1;
    card.color = "#35527A";
    card.cornerRadius = 20;
    card.background = layer.layerVisible ? "#173050E3" : "#0E1B30D6";
    card.paddingBottom = "12px";
    card.paddingTop = "8px";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = 0.94;
    stack.isVertical = true;
    card.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = layer.title;
    title.color = "#F4F8FF";
    title.fontSize = "34px";
    title.fontWeight = "600";
    title.height = "48px";
    title.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    stack.addControl(title);

    stack.addControl(this.buildActionRow("Map", layer.layerVisible, () => {
      this.config?.onToggleLayerVisible?.(layer.id, !layer.layerVisible);
    }));

    stack.addControl(this.buildActionRow("Labels", layer.labelsEnabled, () => {
      if (!layer.labelToggleAvailable) {
        return;
      }
      this.config?.onToggleLabels?.(layer.id, !layer.labelsEnabled);
    }, !layer.labelToggleAvailable));

    if (layer.supportsAltitudeVolume) {
      stack.addControl(this.buildActionRow("Altitude", layer.altitudeVolumeEnabled, () => {
        this.config?.onToggleAirspaceAltitude?.(!layer.altitudeVolumeEnabled);
      }));
    }

    return card;
  }

  buildActionRow(label, active, onPress, disabled = false) {
    const row = new BABYLON.GUI.Grid();
    row.height = `${ACTION_ROW_HEIGHT_PX}px`;
    row.addColumnDefinition(0.56);
    row.addColumnDefinition(0.44);
    row.paddingTop = "8px";

    const toggle = () => {
      if (!disabled) {
        onPress();
      }
    };

    const labelBlock = new BABYLON.GUI.TextBlock();
    labelBlock.text = label;
    labelBlock.color = disabled ? "#7D90B3" : "#D9E7FF";
    labelBlock.fontSize = `${LABEL_FONT_SIZE_PX}px`;
    labelBlock.fontWeight = "600";
    labelBlock.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    labelBlock.isPointerBlocker = !disabled;
    if (!disabled) {
      labelBlock.onPointerUpObservable.add(toggle);
    }
    row.addControl(labelBlock, 0, 0);

    const button = BABYLON.GUI.Button.CreateSimpleButton(`${label}-toggle`, active ? "On" : "Off");
    button.height = `${CHECKBOX_HEIGHT_PX}px`;
    button.width = `${CHECKBOX_WIDTH_PX}px`;
    button.cornerRadius = 12;
    button.thickness = active ? 2 : 1;
    button.fontSize = `${CHECKBOX_FONT_SIZE_PX}px`;
    button.fontWeight = "700";
    button.color = disabled ? "#95A3BF" : "#F8FBFF";
    button.background = disabled ? "#1D2B42" : active ? "#1E7BFF" : "#243650";
    button.isEnabled = !disabled;
    if (!disabled) {
      button.onPointerUpObservable.add(toggle);
    }
    row.addControl(button, 0, 1);

    return row;
  }

  buildMasterControls() {
    const card = new BABYLON.GUI.Rectangle("xr-master-controls");
    card.height = "162px";
    card.thickness = 1;
    card.color = "#4B668E";
    card.cornerRadius = 20;
    card.background = "#0D1A2FD9";
    card.paddingTop = "8px";
    card.paddingBottom = "12px";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = 0.94;
    stack.isVertical = true;
    card.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "Master Control";
    title.color = "#F4F8FF";
    title.fontSize = "32px";
    title.fontWeight = "700";
    title.height = "44px";
    title.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    stack.addControl(title);

    stack.addControl(this.buildMasterRow("Maps", () => {
      this.config?.onSetAllLayerVisible?.(true);
    }, () => {
      this.config?.onSetAllLayerVisible?.(false);
    }));

    const hasLabelToggles = (this.config?.layers ?? []).some((layer) => layer.labelToggleAvailable);
    stack.addControl(this.buildMasterRow("Labels", () => {
      this.config?.onSetAllLabels?.(true);
    }, () => {
      this.config?.onSetAllLabels?.(false);
    }, !hasLabelToggles));

    return card;
  }

  buildMasterRow(label, onSelectAll, onDeselectAll, disabled = false) {
    const row = new BABYLON.GUI.Grid();
    row.height = "48px";
    row.addColumnDefinition(0.34);
    row.addColumnDefinition(0.33);
    row.addColumnDefinition(0.33);
    row.paddingTop = "6px";

    const labelBlock = new BABYLON.GUI.TextBlock();
    labelBlock.text = label;
    labelBlock.color = disabled ? "#7D90B3" : "#D9E7FF";
    labelBlock.fontSize = "27px";
    labelBlock.fontWeight = "600";
    labelBlock.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    row.addControl(labelBlock, 0, 0);

    row.addControl(this.buildMasterButton(label, "Select All", onSelectAll, disabled), 0, 1);
    row.addControl(this.buildMasterButton(label, "Deselect All", onDeselectAll, disabled), 0, 2);
    return row;
  }

  buildMasterButton(category, text, onPress, disabled = false) {
    const button = BABYLON.GUI.Button.CreateSimpleButton(`master-${category}-${text}`, text);
    button.height = `${MASTER_BUTTON_HEIGHT_PX}px`;
    button.width = `${MASTER_BUTTON_WIDTH_PX}px`;
    button.cornerRadius = 12;
    button.thickness = 1;
    button.fontSize = "22px";
    button.fontWeight = "700";
    button.color = disabled ? "#95A3BF" : "#F8FBFF";
    button.background = disabled ? "#1D2B42" : "#23466E";
    button.isEnabled = !disabled;
    if (!disabled) {
      button.onPointerUpObservable.add(() => onPress());
    }
    return button;
  }

  handleControllerAdded(controller) {
    if (!controller?.uniqueId || this.controllerEntries.has(controller.uniqueId)) {
      return;
    }
    const entry = {
      controller,
      motionControllerObserver: null,
      toggleComponent: null,
      toggleObserver: null,
      togglePressed: false,
    };
    this.controllerEntries.set(controller.uniqueId, entry);

    if (controller.inputSource?.handedness === "left") {
      this.leftController = controller;
      entry.motionControllerObserver = controller.onMotionControllerInitObservable?.add((motionController) => {
        this.attachPanelToggleComponent(entry, motionController);
      }) ?? null;
      // Controllers may finish initialization before the panel is constructed.
      // In that case the observable will not replay the existing controller.
      this.attachPanelToggleComponent(entry, controller.motionController);
      this.updateAnchor();
      this.updateVisibility();
    }
  }

  attachPanelToggleComponent(entry, motionController) {
    if (!motionController) {
      return;
    }
    const component = findPanelToggleComponent(motionController);
    if (!component?.onButtonStateChangedObservable || component === entry.toggleComponent) {
      return;
    }
    if (entry.toggleComponent && entry.toggleObserver) {
      entry.toggleComponent.onButtonStateChangedObservable?.remove(entry.toggleObserver);
    }
    entry.toggleComponent = component;
    entry.togglePressed = Boolean(component.pressed);
    entry.toggleObserver = component.onButtonStateChangedObservable.add(() => {
      const pressed = Boolean(component.pressed);
      if (pressed === entry.togglePressed) {
        return;
      }
      entry.togglePressed = pressed;
      if (pressed) {
        this.togglePanelVisibility();
      }
    });
  }

  handleControllerRemoved(controller) {
    const entry = this.controllerEntries.get(controller.uniqueId);
    if (entry?.toggleComponent && entry.toggleObserver) {
      entry.toggleComponent.onButtonStateChangedObservable?.remove(entry.toggleObserver);
    }
    if (entry?.motionControllerObserver) {
      controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
    }
    this.controllerEntries.delete(controller.uniqueId);

    if (controller === this.leftController) {
      this.leftController = null;
      this.updateAnchor();
    }
  }

  togglePanelVisibility() {
    const now = Date.now();
    if (now - this.lastToggleTime < PANEL_TOGGLE_DEBOUNCE_MS) {
      return;
    }
    this.lastToggleTime = now;
    this.panelVisible = !this.panelVisible;
    this.updateVisibility();
  }

  resolveAnchor() {
    if (!this.isInXr()) {
      return this.fallbackAnchor;
    }
    const leftController = this.syncActiveLeftController();
    return leftController?.grip ?? leftController?.pointer ?? this.fallbackAnchor;
  }

  resolveFallbackParent() {
    return this.xrHelper?.baseExperience?.camera ?? this.camera;
  }

  applyMountedOffset(anchor) {
    this.root.position.copyFrom(anchor === this.fallbackAnchor ? BABYLON.Vector3.Zero() : CONTROLLER_FOREARM_OFFSET);
    this.panelMesh.position.copyFrom(BABYLON.Vector3.Zero());
  }

  syncRuntimePlacement() {
    if (!this.config) {
      return;
    }
    this.syncActiveLeftController();
    this.updateAnchor();
  }

  isInXr() {
    const state = this.xrHelper?.baseExperience?.state;
    return state === XR_STATES.IN_XR || state === XR_STATES.ENTERING_XR;
  }

  syncActiveLeftController() {
    const activeLeftController = this.inputSourceVisualManager?.getActiveController("left") ?? this.leftController;
    if (activeLeftController !== this.leftController) {
      this.leftController = activeLeftController;
    }
    return this.leftController;
  }

  dispose() {
    this.unsubscribeTaskSession?.();
    this.unsubscribeEventSession?.();
    this.unsubscribeTaskSession = null;
    this.unsubscribeEventSession = null;
    this.taskSession = null;
    this.taskSnapshot = null;
    this.eventSession = null;
    this.eventSnapshot = null;
    this.eventControlSignature = "";
    this.eventReadouts = null;
    this.taskEventLog = null;
    this.lastViewedTaskKey = null;
    for (const entry of this.controllerEntries.values()) {
      if (entry.toggleComponent && entry.toggleObserver) {
        entry.toggleComponent.onButtonStateChangedObservable?.remove(entry.toggleObserver);
      }
      if (entry.motionControllerObserver) {
        entry.controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
      }
    }
    this.controllerEntries.clear();
    if (this.controllerAddedObserver) {
      this.xrHelper?.input?.onControllerAddedObservable?.remove(this.controllerAddedObserver);
    }
    if (this.controllerRemovedObserver) {
      this.xrHelper?.input?.onControllerRemovedObservable?.remove(this.controllerRemovedObserver);
    }
    if (this.xrStateObserver) {
      this.xrHelper?.baseExperience?.onStateChangedObservable?.remove(this.xrStateObserver);
    }
    if (this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
    }
    this.texture?.dispose();
    this.panelMaterial?.dispose();
    this.panelMesh?.dispose();
    this.root?.dispose();
    this.fallbackAnchor?.dispose();
  }
}

function estimateWrappedTextHeight(text, charactersPerLine, lineHeight, minimumHeight) {
  const lineCount = `${text ?? ""}`.split(/\r?\n/).reduce((count, paragraph) => (
    count + Math.max(1, Math.ceil(paragraph.length / charactersPerLine))
  ), 0);
  return Math.max(minimumHeight, lineCount * lineHeight + 24);
}

function scenarioControlSignature(snapshot) {
  return JSON.stringify({
    eventSetId: snapshot?.eventSetId ?? null,
    disposed: Boolean(snapshot?.disposed),
    scenarioStatus: snapshot?.scenarioStatus ?? "unavailable",
    conflictState: snapshot?.conflictState ?? "unavailable",
    activeEventIds: snapshot?.activeEventIds ?? [],
    appliedActionIds: (snapshot?.appliedScenarioActions ?? []).map((action) => action.id),
  });
}

function formatScenarioTime(seconds) {
  const wholeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(wholeSeconds / 60) + ":" + String(wholeSeconds % 60).padStart(2, "0");
}

function formatScenarioSeparation(conflict) {
  if (!conflict) {
    return "Unavailable";
  }
  return conflict.horizontalSeparationNm.toFixed(1)
    + " NM / "
    + Math.round(conflict.verticalSeparationFt)
    + " ft";
}

function formatConflictState(state) {
  return ({
    normal: "Normal",
    "conflict-predicted": "Conflict predicted",
    "loss-of-separation": "Loss of separation",
    resolved: "Resolved",
  })[state] ?? "Unavailable";
}

function conflictStateColor(state) {
  return ({
    normal: "#9FD6FF",
    "conflict-predicted": "#FFD37A",
    "loss-of-separation": "#FF8B8B",
    resolved: "#7CE6A0",
  })[state] ?? "#B9C9E8";
}

function findPanelToggleComponent(motionController) {
  const componentIds = motionController.getComponentIds?.() ?? [];
  const preferredIds = [
    "xr-standard-thumbstick",
    "xr-standard-touchpad",
    "thumbstick",
    "touchpad",
    "trackpad",
  ];

  for (const preferredId of preferredIds) {
    const exactId = componentIds.find((componentId) => `${componentId}`.toLowerCase() === preferredId);
    const component = exactId ? motionController.getComponent(exactId) : null;
    if (isClickablePanelToggleComponent(component)) {
      return component;
    }
  }

  for (const componentId of componentIds) {
    const component = motionController.getComponent(componentId);
    const id = `${componentId}`.toLowerCase();
    const type = `${component?.type ?? ""}`.toLowerCase();
    const isStickOrPad = ["thumbstick", "touchpad", "trackpad"].some((matcher) => (
      id.includes(matcher) || type.includes(matcher)
    ));
    if (!id.includes("thumbrest") && isStickOrPad && isClickablePanelToggleComponent(component)) {
      return component;
    }
  }

  for (const componentId of componentIds) {
    const component = motionController.getComponent(componentId);
    const id = `${componentId}`.toLowerCase();
    if (["buttonx", "buttony", "buttona", "buttonb", "secondary"].some((matcher) => id.includes(matcher))
      && isClickablePanelToggleComponent(component)) {
      return component;
    }
  }

  return null;
}

function isClickablePanelToggleComponent(component) {
  return Boolean(component?.onButtonStateChangedObservable && "pressed" in component);
}
