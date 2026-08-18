import { loadSectionIndex, loadSectionManifest } from "../data/sectionRepository.js";
import { EventSetRepository } from "../data/EventSetRepository.js";
import { TaskSetRepository } from "../data/TaskSetRepository.js?v=20260621-task-sessions-v2";
import { createMapScene } from "../scene/MapScene.js?v=20260816-xr-aircraft-v2";
import { TaskEventLog, TASK_EVENT_TYPES } from "../training/TaskEventLog.js?v=20260621-instruction-workflow-v1";
import { EventSession } from "../training/EventSession.js?v=20260814-conflict-controls-v1";
import {
  buildScenarioControls,
  createScenarioSyncSnapshot,
  updateScenarioControls,
} from "../../../shared/scenarioControls.js?v=20260814-conflict-controls-v1";
import { TaskSession } from "../training/TaskSession.js?v=20260621-task-sessions-v1";
import {
  BroadcastLinkSession,
  generateSessionId,
  readSavedSessionId,
} from "../../../shared/linkSession.js?v=20260814-conflict-controls-v1";

export class AppShell {
  constructor(elements) {
    this.elements = elements;
    this.sectionIndex = null;
    this.sceneController = null;
    this.currentManifest = null;
    this.layerUiState = new Map();
    this.taskSetRepository = new TaskSetRepository();
    this.eventSetRepository = new EventSetRepository();
    this.taskSession = null;
    this.eventSession = null;
    this.activeEventSet = null;
    this.unsubscribeEventSession = null;
    this.scenarioUiFrameHandle = 0;
    this.lastScenarioBroadcastMs = 0;
    this.eventControlSignature = "";
    this.activeTaskSet = null;
    this.taskSetLoadToken = 0;
    this.eventSetLoadToken = 0;
    this.taskSetLoading = false;
    this.eventSetLoading = false;
    this.sectionLoading = false;
    this.airspaceAltitudeMode = false;
    this.defaultStatusMessage = "";
    this.applyingRemoteSelection = false;
    this.applyingRemoteToggle = false;
    this.applyingRemoteEvent = false;
    this.linkSession = new BroadcastLinkSession({
      appId: "vr-viewer",
    });
    this.taskEventLog = new TaskEventLog({
      contextProvider: () => ({
        sectionId: this.currentManifest?.id ?? null,
        linkedSessionId: this.linkSession.isConnected() ? this.linkSession.sessionId : null,
        taskSetId: this.taskSession?.taskSet?.id ?? this.activeTaskSet?.id ?? null,
        taskId: this.taskSession?.currentTask?.id ?? null,
      }),
    });
  }

  async start() {
    try {
      this.setStatus("Loading Babylon scene...");
      this.sceneController = await createMapScene(this.elements.canvas);
      this.sceneController.layerManager.onAirspaceSelectionChange = (selectionId) => {
        if (!selectionId && this.defaultStatusMessage) {
          this.setStatus(this.defaultStatusMessage);
        }
      };
      this.sceneController.layerManager.onSelectionChange = (selection) => {
        if (!selection) {
          if (this.defaultStatusMessage) {
            this.setStatus(this.defaultStatusMessage);
          }
          this.publishSelection(selection);
          return;
        }
        if (selection.kind === "feature") {
          this.setStatus(`Selected ${formatLayerTitle(selection.layerId)} area: ${selection.featureId}`);
          this.publishSelection(selection);
          return;
        }
        if (selection.kind === "label") {
          this.setStatus(`Selected ${formatLayerTitle(selection.layerId)} label: ${selection.label}`);
          this.publishSelection(selection);
        }
      };
      this.unsubscribeXrAvailability = this.sceneController.onXrAvailabilityChange?.(() => {
        this.syncXrState();
      });
      this.syncXrState();
      this.elements.linkSessionInput.value = readSavedSessionId() || "stlouis-review";

      this.elements.enterVrButton.addEventListener("click", () => this.handleEnterVr());
      this.elements.startLinkButton.addEventListener("click", () => this.handleStartLink());
      this.elements.disconnectLinkButton.addEventListener("click", () => this.handleDisconnectLink());
      this.elements.sectionSelect.addEventListener("change", async (event) => {
        const sectionId = event.target.value;
        try {
          await this.loadSectionById(sectionId);
        } catch (error) {
          console.error(error);
          this.setStatus(error.message ?? `Failed to load section ${sectionId}.`, { error: true });
        }
      });
      this.elements.instructionSelect.addEventListener("change", (event) => {
        this.handleInstructionSetChange(event.target.value);
      });
      this.elements.eventSelect.addEventListener("change", (event) => {
        this.handleEventSetChange(event.target.value);
      });
      this.elements.resetTaskSessionButton.addEventListener("click", () => {
        this.resetTaskSession();
      });

      this.sectionIndex = await loadSectionIndex();
      this.populateSectionList();

      const preferredSectionId = readPreferredSectionId(this.sectionIndex);
      const firstSection = this.sectionIndex.sections.find((section) => section.id === preferredSectionId)
        ?? this.sectionIndex.sections[0];
      if (!firstSection) {
        throw new Error("No sections were generated.");
      }

      await this.loadSectionById(firstSection.id);
    } catch (error) {
      console.error(error);
      this.setStatus(error.message ?? "Failed to start app.", { error: true });
    }
  }

  syncXrState() {
    const supported = this.sceneController?.hasXr();
    const availability = this.sceneController?.getXrAvailability?.();
    if (availability?.initializing) {
      this.elements.xrHint.textContent = availability.reason;
      this.elements.enterVrButton.disabled = true;
      this.elements.enterVrButton.textContent = "Preparing VR";
      return;
    }
    this.elements.xrHint.textContent = supported
      ? "Immersive VR is available. Put on a headset and use Enter VR."
      : availability?.reason ?? "WebXR immersive-vr is not available in this browser/session.";
    this.elements.enterVrButton.disabled = !supported;
    this.elements.enterVrButton.textContent = supported ? "Enter VR" : "VR Unavailable";
  }

  populateSectionList() {
    const sections = this.sectionIndex.sections ?? [];
    this.elements.sectionSelect.innerHTML = "";
    for (const section of sections) {
      const option = document.createElement("option");
      option.value = section.id;
      option.textContent = section.title;
      this.elements.sectionSelect.append(option);
    }

    const singleSection = sections.length <= 1;
    this.elements.sectionSelect.disabled = singleSection || this.sectionLoading || this.taskSetLoading;
    this.elements.sectionSelect.setAttribute("aria-disabled", String(singleSection));
    this.elements.sectionSelect.title = singleSection ? "Only one active section is staged." : "";

    const sectionLabel = this.elements.sectionSelect?.previousElementSibling;
    if (sectionLabel) {
      sectionLabel.hidden = singleSection;
    }
    this.elements.sectionSelect.hidden = singleSection;

    if (this.elements.sectionNote) {
      this.elements.sectionNote.hidden = !singleSection;
      this.elements.sectionNote.textContent = singleSection
        ? `${sections[0]?.title ?? "St. Louis Sectional"} is the only active section in this prototype right now.`
        : "";
    }
  }

  async loadSectionById(sectionId) {
    const entry = this.sectionIndex.sections.find((section) => section.id === sectionId);
    if (!entry) {
      throw new Error(`Unknown section: ${sectionId}`);
    }

    this.taskSetLoadToken += 1;
    this.eventSetLoadToken += 1;
    this.clearTaskSession("section_changed");
    this.clearEventSession({ publish: true });
    this.sectionLoading = true;
    this.resetInstructionList();
    this.resetEventList();
    this.syncSelectorDisabledStates();
    this.elements.sectionSelect.value = sectionId;
    this.setStatus(`Loading ${entry.title}...`);

    try {
      const manifest = await loadSectionManifest(entry);
      await this.sceneController.layerManager.loadSection(manifest);
      this.sceneController.setAirspaceAltitudeMode?.(this.airspaceAltitudeMode);

      this.currentManifest = manifest;
      this.renderLayerControls(manifest);
      this.populateInstructionList(manifest);
      this.populateEventList(manifest);
      this.syncVrControlPanel();
      this.syncUrl(sectionId);

      this.elements.sectionQuality.dataset.quality = entry.quality ?? "primary";
      this.elements.sectionQuality.textContent = entry.quality ?? "primary";
      if (manifest.assetVersion) {
        this.elements.sectionQuality.title = `Asset build ${manifest.assetVersion}`;
      }
      this.defaultStatusMessage =
        `${manifest.title} loaded with ${manifest.layers.length} map layers and VR-native label anchors.${formatBuildSuffix(manifest.assetVersion)}`,
      this.setStatus(this.defaultStatusMessage);
    } finally {
      this.sectionLoading = false;
      this.syncSelectorDisabledStates();
    }
  }

  populateInstructionList(manifest) {
    const entries = manifest.training?.taskSets ?? [];
    const select = this.elements.instructionSelect;
    select.innerHTML = "";
    select.append(new Option("No instructions", ""));
    for (const entry of entries) {
      select.append(new Option(entry.title, entry.id));
    }
    select.value = "";
    this.elements.instructionGroup.hidden = entries.length === 0;
    this.syncSelectorDisabledStates();
  }

  resetInstructionList() {
    this.elements.instructionSelect.innerHTML = "";
    this.elements.instructionSelect.append(new Option("No instructions", ""));
    this.elements.instructionSelect.value = "";
    this.elements.instructionGroup.hidden = true;
    this.syncSelectorDisabledStates();
  }

  populateEventList(manifest) {
    const entries = manifest.training?.eventSets ?? [];
    const select = this.elements.eventSelect;
    select.innerHTML = "";
    select.append(new Option("No events", ""));
    for (const entry of entries) {
      select.append(new Option(entry.title, entry.id));
    }
    select.value = "";
    this.elements.eventGroup.hidden = entries.length === 0;
    this.elements.eventControls.innerHTML = "";
    this.setEventStatus(entries.length ? "Choose an event set to show training events or scenarios in this VR scene." : "");
    this.syncSelectorDisabledStates();
  }

  resetEventList() {
    this.elements.eventSelect.innerHTML = "";
    this.elements.eventSelect.append(new Option("No events", ""));
    this.elements.eventSelect.value = "";
    this.elements.eventGroup.hidden = true;
    this.elements.eventControls.innerHTML = "";
    this.setEventStatus("");
    this.syncSelectorDisabledStates();
  }

  async handleInstructionSetChange(taskSetId) {
    const loadToken = ++this.taskSetLoadToken;
    this.clearTaskSession(taskSetId ? "instruction_changed" : "no_instructions");
    if (!taskSetId) {
      this.elements.instructionSelect.value = "";
      this.setStatus(this.defaultStatusMessage || "No instruction set selected.");
      this.syncSelectorDisabledStates();
      return;
    }

    const manifest = this.currentManifest;
    const entry = manifest?.training?.taskSets?.find((candidate) => candidate.id === taskSetId);
    if (!manifest || !entry) {
      this.elements.instructionSelect.value = "";
      this.setStatus(`Instruction set ${taskSetId} is not available for this section.`, { error: true });
      return;
    }

    this.taskSetLoading = true;
    this.syncSelectorDisabledStates();
    this.setStatus(`Loading instruction set ${entry.title}...`);
    try {
      const taskSet = await this.taskSetRepository.load(manifest, entry);
      if (loadToken !== this.taskSetLoadToken || manifest !== this.currentManifest) {
        return;
      }
      this.taskSession = new TaskSession(taskSet);
      this.activeTaskSet = taskSet;
      this.sceneController.setVrTaskSession?.(this.taskSession, this.taskEventLog);
      this.taskEventLog.record(TASK_EVENT_TYPES.TASK_SET_LOADED, {
        taskSetId: taskSet.id,
        taskId: this.taskSession.currentTask?.id ?? null,
      });
      this.elements.instructionSelect.value = entry.id;
      this.setStatus(`${entry.title} loaded with ${taskSet.tasks.length} task${taskSet.tasks.length === 1 ? "" : "s"}.`);
    } catch (error) {
      if (loadToken !== this.taskSetLoadToken) {
        return;
      }
      console.error(error);
      this.clearTaskSession("load_failed");
      this.elements.instructionSelect.value = "";
      this.setStatus(`Unable to load instruction set "${entry.title}": ${error.message ?? error}`, { error: true });
    } finally {
      if (loadToken === this.taskSetLoadToken) {
        this.taskSetLoading = false;
        this.syncSelectorDisabledStates();
      }
    }
  }

  clearTaskSession(reason = "cleared") {
    const taskSession = this.taskSession;
    const taskSetId = taskSession?.taskSet?.id ?? this.activeTaskSet?.id ?? null;
    const taskId = taskSession?.currentTask?.id ?? null;
    this.taskSession = null;
    this.activeTaskSet = null;
    this.sceneController?.setVrTaskSession?.(null, this.taskEventLog);
    taskSession?.dispose();
    if (taskSession || taskSetId) {
      this.taskEventLog.record(TASK_EVENT_TYPES.TASK_SESSION_CLEARED, {
        taskSetId,
        taskId,
        reason,
      });
    }
    this.syncSelectorDisabledStates();
  }

  async handleEventSetChange(eventSetId, options = {}) {
    const loadToken = ++this.eventSetLoadToken;
    this.clearEventSession({ publish: Boolean(!eventSetId) && !options.suppressSync });
    if (!eventSetId) {
      this.elements.eventSelect.value = "";
      this.setEventStatus("Event session cleared.");
      this.syncSelectorDisabledStates();
      this.syncVrControlPanel();
      return;
    }

    const manifest = this.currentManifest;
    const entry = manifest?.training?.eventSets?.find((candidate) => candidate.id === eventSetId);
    if (!manifest || !entry) {
      this.elements.eventSelect.value = "";
      this.setEventStatus(`Event set ${eventSetId} is not available for this section.`, { error: true });
      return;
    }

    this.eventSetLoading = true;
    this.syncSelectorDisabledStates();
    this.syncVrControlPanel();
    this.setEventStatus(`Loading ${entry.title}...`);
    try {
      await this.loadEventSet(entry.id, {
        activeEventIds: options.activeEventIds,
        loadToken,
        suppressSync: options.suppressSync,
      });
    } catch (error) {
      if (loadToken !== this.eventSetLoadToken) {
        return;
      }
      console.error(error);
      this.clearEventSession({ publish: false });
      this.elements.eventSelect.value = "";
      this.setEventStatus(`Unable to load ${entry.title}: ${error.message ?? error}`, { error: true });
    } finally {
      if (loadToken === this.eventSetLoadToken) {
        this.eventSetLoading = false;
        this.syncSelectorDisabledStates();
        this.syncVrControlPanel();
      }
    }
  }

  async loadEventSet(eventSetId, options = {}) {
    const loadToken = options.loadToken ?? ++this.eventSetLoadToken;
    this.clearEventSession({ publish: false });
    if (!eventSetId) {
      return;
    }

    const manifest = this.currentManifest;
    const entry = manifest?.training?.eventSets?.find((candidate) => candidate.id === eventSetId);
    if (!manifest || !entry) {
      throw new Error(`Event set ${eventSetId} is not available for this section.`);
    }

    this.eventSetLoading = true;
    this.syncSelectorDisabledStates();
    try {
      const eventSet = await this.eventSetRepository.load(manifest, entry);
      if (loadToken !== this.eventSetLoadToken || manifest !== this.currentManifest) {
        return;
      }
      this.activeEventSet = eventSet;
      this.eventSession = new EventSession(eventSet);
      if (options.activeEventIds) {
        this.eventSession.applyEnabledEventIds(options.activeEventIds);
      }
      this.unsubscribeEventSession = this.eventSession.subscribe(() => {
        const snapshot = this.eventSession.getSnapshot();
        const nextSignature = eventControlSignature(snapshot);
        if (
          nextSignature === this.eventControlSignature
          && this.elements.eventControls.querySelector?.(".scenario-controls")
        ) {
          updateScenarioControls(this.elements.eventControls, snapshot);
        } else {
          this.renderEventControls(snapshot);
        }
        if (snapshot.scenarioStatus === "running") {
          this.startScenarioUiAnimation();
        }
      });
      this.sceneController?.setVrEventSession?.(this.eventSession);
      this.elements.eventSelect.value = entry.id;
      this.renderEventControls();
      this.syncVrControlPanel();
      if (!options.suppressSync) {
        this.publishEvent({
          action: "load",
          sectionId: manifest.id,
          eventSetId: entry.id,
          activeEventIds: this.eventSession.getSnapshot().activeEventIds,
        });
      }
      this.publishScenarioSnapshot(this.eventSession.getSnapshot());
      this.setEventStatus(this.linkSession.isConnected()
        ? `${eventSet.title} active and synced.`
        : `${eventSet.title} selected. Start Link to sync it to the 2D companion.`);
      this.setStatus(`${eventSet.title} loaded with ${eventSet.events.length} event${eventSet.events.length === 1 ? "" : "s"}.`);
    } finally {
      if (options.loadToken === undefined && loadToken === this.eventSetLoadToken) {
        this.eventSetLoading = false;
        this.syncSelectorDisabledStates();
      }
    }
  }

  clearEventSession({ publish = false } = {}) {
    const eventSetId = this.activeEventSet?.id ?? this.eventSession?.eventSet?.id ?? null;
    const sectionId = this.currentManifest?.id ?? null;
    this.unsubscribeEventSession?.();
    this.unsubscribeEventSession = null;
    this.eventSession?.dispose();
    this.eventSession = null;
    this.stopScenarioUiAnimation();
    this.activeEventSet = null;
    this.eventControlSignature = "";
    this.sceneController?.setVrEventSession?.(null);
    this.elements.eventControls.innerHTML = "";
    if (publish && (eventSetId || this.linkSession.isConnected())) {
      this.publishEvent({ action: "clear", sectionId, eventSetId });
    }
    this.syncVrControlPanel();
    this.syncSelectorDisabledStates();
  }

  renderEventControls(snapshot = this.eventSession?.getSnapshot()) {
    const container = this.elements.eventControls;
    container.innerHTML = "";
    this.eventControlSignature = eventControlSignature(snapshot);
    if (!snapshot || snapshot.disposed) {
      return;
    }

    const scenarioControls = buildScenarioControls(
      snapshot,
      (command, actionId) => this.handleScenarioCommand(command, actionId),
    );
    if (scenarioControls) {
      container.append(scenarioControls);
    }

    for (const type of ["aircraft", "weather"]) {
      const events = (snapshot.events ?? []).filter((event) => event.type === type);
      if (!events.length) {
        continue;
      }

      const group = document.createElement("section");
      group.className = "event-group";
      const heading = document.createElement("h3");
      heading.textContent = type === "aircraft" ? "Aircraft" : "Weather";
      group.append(heading);

      for (const event of events) {
        const row = this.buildToggleRow(event.title, snapshot.activeEventIds.includes(event.id), (checked) => {
          this.setEventEnabled(event.id, checked);
        });
        group.append(row);
      }
      container.append(group);
    }
  }

  handleScenarioCommand(command, actionId = null) {
    const scenarioStatus = this.eventSession?.getSnapshot().scenarioStatus;
    if (!scenarioStatus || scenarioStatus === "unavailable") {
      return false;
    }
    let changed = false;
    if (command === "start") {
      changed = this.eventSession.startScenario();
    } else if (command === "pause") {
      changed = this.eventSession.pauseScenario();
    } else if (command === "reset") {
      changed = this.eventSession.resetScenario();
    } else if (command === "action" && actionId) {
      changed = this.eventSession.applyScenarioAction(actionId);
    }
    const snapshot = this.eventSession.getSnapshot();
    updateScenarioControls(this.elements.eventControls, snapshot);
    this.publishScenarioSnapshot(snapshot);
    if (snapshot.scenarioStatus === "running") {
      this.startScenarioUiAnimation();
    } else {
      this.stopScenarioUiAnimation();
    }
    return changed;
  }

  startScenarioUiAnimation() {
    if (this.scenarioUiFrameHandle || !this.eventSession) {
      return;
    }
    const tick = (timestamp) => {
      this.scenarioUiFrameHandle = 0;
      if (!this.eventSession) {
        return;
      }
      const snapshot = this.eventSession.getSnapshot();
      updateScenarioControls(this.elements.eventControls, snapshot);
      if (timestamp - this.lastScenarioBroadcastMs >= 50) {
        this.lastScenarioBroadcastMs = timestamp;
        this.publishScenarioSnapshot(snapshot);
      }
      if (snapshot.scenarioStatus === "running") {
        this.scenarioUiFrameHandle = requestAnimationFrame(tick);
      } else {
        this.publishScenarioSnapshot(snapshot);
      }
    };
    this.scenarioUiFrameHandle = requestAnimationFrame(tick);
  }

  stopScenarioUiAnimation() {
    if (this.scenarioUiFrameHandle) {
      cancelAnimationFrame(this.scenarioUiFrameHandle);
      this.scenarioUiFrameHandle = 0;
    }
  }

  publishScenarioSnapshot(snapshot = this.eventSession?.getSnapshot()) {
    if (
      !snapshot?.scenarioStatus
      || snapshot.scenarioStatus === "unavailable"
      || !this.linkSession.isConnected()
      || !this.currentManifest
    ) {
      return;
    }
    this.linkSession.publishEvent({
      action: "scenario-snapshot",
      sectionId: this.currentManifest.id,
      eventSetId: snapshot.eventSetId,
      scenarioSnapshot: createScenarioSyncSnapshot(snapshot),
    });
  }

  resetTaskSession() {
    if (!this.activeTaskSet || this.taskSetLoading || this.sectionLoading) {
      return;
    }
    const taskSet = this.activeTaskSet;
    this.clearTaskSession("researcher_reset");
    this.activeTaskSet = taskSet;
    this.taskSession = new TaskSession(taskSet);
    this.sceneController?.setVrTaskSession?.(this.taskSession, this.taskEventLog);
    this.taskEventLog.record(TASK_EVENT_TYPES.TASK_SET_LOADED, {
      taskSetId: taskSet.id,
      taskId: this.taskSession.currentTask?.id ?? null,
      reason: "researcher_reset",
    });
    this.elements.instructionSelect.value = taskSet.id;
    this.setStatus(`${taskSet.title} reset for a new participant.`);
    this.syncSelectorDisabledStates();
  }

  syncSelectorDisabledStates() {
    const sectionCount = this.sectionIndex?.sections?.length ?? 0;
    this.elements.sectionSelect.disabled = sectionCount <= 1 || this.sectionLoading || this.taskSetLoading || this.eventSetLoading;
    this.elements.sectionSelect.setAttribute("aria-disabled", String(this.elements.sectionSelect.disabled));
    const taskSetCount = this.currentManifest?.training?.taskSets?.length ?? 0;
    this.elements.instructionSelect.disabled = taskSetCount === 0 || this.sectionLoading || this.taskSetLoading || this.eventSetLoading;
    this.elements.instructionSelect.setAttribute("aria-disabled", String(this.elements.instructionSelect.disabled));
    this.elements.instructionGroup.setAttribute("aria-busy", String(this.taskSetLoading));
    const eventSetCount = this.currentManifest?.training?.eventSets?.length ?? 0;
    this.elements.eventSelect.disabled = eventSetCount === 0 || this.sectionLoading || this.taskSetLoading || this.eventSetLoading;
    this.elements.eventSelect.setAttribute("aria-disabled", String(this.elements.eventSelect.disabled));
    this.elements.eventGroup.setAttribute("aria-busy", String(this.eventSetLoading));
    const hasTaskSession = Boolean(this.taskSession && !this.taskSession.disposed);
    this.elements.resetTaskSessionButton.hidden = !hasTaskSession;
    this.elements.resetTaskSessionButton.disabled = !hasTaskSession || this.sectionLoading || this.taskSetLoading;
  }

  setEventStatus(message, options = {}) {
    this.elements.eventStatus.textContent = message;
    if (options.error) {
      this.elements.eventStatus.dataset.state = "error";
    } else {
      delete this.elements.eventStatus.dataset.state;
    }
  }

  renderLayerControls(manifest) {
    const container = this.elements.layerControls;
    container.innerHTML = "";
    const nextState = new Map();
    const layerCards = [];

    for (const layer of manifest.layers) {
      const existingState = this.layerUiState.get(layer.id);
      const layerState = existingState ?? {
        layerVisible: layer.defaultVisible !== false,
        labelsEnabled: Boolean(layer.labelData) && layer.defaultLabels !== false,
      };
      nextState.set(layer.id, layerState);

      const card = document.createElement("section");
      card.className = "layer-card";

      const header = document.createElement("header");
      header.innerHTML = `<h2>${layer.title}</h2><p>${layer.id}</p>`;

      const visibilityRow = this.buildToggleRow(
        "Layer visible",
        layerState.layerVisible,
        (checked) => {
          this.updateLayerVisibility(layer.id, checked);
        },
      );

      const labelToggleAvailable = Boolean(layer.labelData);
      const labelRow = this.buildToggleRow(
        labelToggleAvailable ? "VR labels" : "VR labels unavailable",
        layerState.labelsEnabled,
        (checked) => {
          this.updateLayerLabels(layer.id, checked);
        },
      );
      labelRow.querySelector("input").disabled = !labelToggleAvailable;

      card.append(header, visibilityRow, labelRow);

      if (layer.altitudeVolume) {
        const altitudeRow = this.buildToggleRow(
          "Altitude volume",
          this.airspaceAltitudeMode,
          (checked) => {
            this.setAirspaceAltitudeMode(checked);
          },
        );
        card.append(altitudeRow);

        const altitudeNote = document.createElement("p");
        altitudeNote.className = "hud-note layer-card-note";
        altitudeNote.textContent = "Enable, then select an eligible airfield or airspace shelf to show its 3D volume.";
        card.append(altitudeNote);
      }

      layerCards.push(card);
    }
    this.layerUiState = nextState;
    container.append(this.buildMasterControlCard(manifest), ...layerCards);
  }

  buildMasterControlCard(manifest) {
    const card = document.createElement("section");
    card.className = "layer-card master-control-card";

    const header = document.createElement("header");
    header.innerHTML = "<h2>Master Control</h2><p>All layers</p>";

    const mapRow = this.buildMasterControlRow(
      "Maps",
      () => this.setAllLayerVisibility(true),
      () => this.setAllLayerVisibility(false),
    );

    const hasLabelLayers = manifest.layers.some((layer) => Boolean(layer.labelData));
    const labelRow = this.buildMasterControlRow(
      "Labels",
      () => this.setAllLayerLabels(true),
      () => this.setAllLayerLabels(false),
      !hasLabelLayers,
    );

    card.append(header, mapRow, labelRow);
    return card;
  }

  buildMasterControlRow(label, onSelectAll, onDeselectAll, disabled = false) {
    const row = document.createElement("div");
    row.className = "master-control-row";

    const text = document.createElement("span");
    text.textContent = label;

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.textContent = "Select All";
    selectButton.disabled = disabled;
    selectButton.addEventListener("click", onSelectAll);

    const deselectButton = document.createElement("button");
    deselectButton.type = "button";
    deselectButton.textContent = "Deselect All";
    deselectButton.disabled = disabled;
    deselectButton.className = "button-secondary";
    deselectButton.addEventListener("click", onDeselectAll);

    row.append(text, selectButton, deselectButton);
    return row;
  }

  buildToggleRow(label, checked, onChange) {
    const row = document.createElement("label");
    row.className = "toggle-row";

    const text = document.createElement("span");
    text.textContent = label;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", (event) => onChange(event.target.checked));

    row.append(text, input);
    return row;
  }

  async handleEnterVr() {
    try {
      await this.sceneController.enterVr();
      this.setStatus("Entering immersive VR mode...");
    } catch (error) {
      console.error(error);
      this.setStatus(error.message ?? "Unable to enter VR mode.");
    }
  }

  setStatus(message, options = {}) {
    this.elements.statusLine.textContent = message;
    if (options.error) {
      this.elements.statusLine.dataset.state = "error";
    } else {
      delete this.elements.statusLine.dataset.state;
    }
  }

  updateLayerVisibility(layerId, checked) {
    this.setLayerVisibilityState(layerId, checked);
  }

  setLayerVisibilityState(layerId, checked, options = {}) {
    const layerState = this.layerUiState.get(layerId);
    if (!layerState) {
      return;
    }
    layerState.layerVisible = checked;
    this.sceneController.layerManager.setLayerVisible(layerId, checked);
    this.sceneController.layerManager.setLabelVisible(layerId, layerState.labelsEnabled);
    if (!options.suppressRender && this.currentManifest) {
      this.renderLayerControls(this.currentManifest);
    }
    if (!options.suppressPanelSync) {
      this.syncVrControlPanel();
    }
    if (!options.suppressSync) {
      this.publishToggle({
        sectionId: this.currentManifest?.id,
        layerId,
        target: "layer",
        checked,
      });
    }
  }

  updateLayerLabels(layerId, checked) {
    this.setLayerLabelState(layerId, checked);
  }

  setLayerLabelState(layerId, checked, options = {}) {
    const layerState = this.layerUiState.get(layerId);
    if (!layerState) {
      return;
    }
    layerState.labelsEnabled = checked;
    this.sceneController.layerManager.setLabelVisible(layerId, checked);
    if (!options.suppressRender && this.currentManifest) {
      this.renderLayerControls(this.currentManifest);
    }
    if (!options.suppressPanelSync) {
      this.syncVrControlPanel();
    }
    if (!options.suppressSync) {
      this.publishToggle({
        sectionId: this.currentManifest?.id,
        layerId,
        target: "labels",
        checked,
      });
    }
  }

  syncVrControlPanel() {
    if (!this.sceneController?.setVrControlPanel || !this.currentManifest) {
      return;
    }

    const layers = this.currentManifest.layers.map((layer) => {
      const layerState = this.layerUiState.get(layer.id) ?? {
        layerVisible: layer.defaultVisible !== false,
        labelsEnabled: Boolean(layer.labelData) && layer.defaultLabels !== false,
      };
      return {
        id: layer.id,
        title: layer.title,
        layerVisible: layerState.layerVisible,
        labelsEnabled: layerState.labelsEnabled,
        labelToggleAvailable: Boolean(layer.labelData),
        supportsAltitudeVolume: Boolean(layer.altitudeVolume),
        altitudeVolumeEnabled: layer.id === "airspace" ? this.airspaceAltitudeMode : false,
      };
    });

    this.sceneController.setVrControlPanel({
      title: "St. Louis Layers",
      subtitle: "Left wrist panel - stick click toggles",
      layers,
      eventSets: (this.currentManifest.training?.eventSets ?? []).map((entry) => ({
        id: entry.id,
        title: entry.title,
      })),
      activeEventSetId: this.activeEventSet?.id ?? this.eventSession?.eventSet?.id ?? null,
      eventSetLoading: this.eventSetLoading,
      onToggleLayerVisible: (layerId, checked) => this.updateLayerVisibility(layerId, checked),
      onToggleLabels: (layerId, checked) => this.updateLayerLabels(layerId, checked),
      onToggleAirspaceAltitude: (checked) => this.setAirspaceAltitudeMode(checked),
      onSetAllLayerVisible: (checked) => this.setAllLayerVisibility(checked),
      onSetAllLabels: (checked) => this.setAllLayerLabels(checked),
      onSelectEventSet: (eventSetId) => this.handleEventSetChange(eventSetId),
      onToggleEvent: (eventId, enabled) => this.setEventEnabled(eventId, enabled),
      onScenarioCommand: (command, actionId) => this.handleScenarioCommand(command, actionId),
    });
  }

  setEventEnabled(eventId, enabled, options = {}) {
    if (!this.eventSession) {
      return;
    }
    const changed = this.eventSession.setEventEnabled(eventId, enabled);
    if (changed && !options.suppressSync) {
      this.publishEvent({
        action: "toggle",
        sectionId: this.currentManifest?.id,
        eventSetId: this.eventSession.eventSet.id,
        eventId,
        enabled: Boolean(enabled),
        activeEventIds: this.eventSession.getSnapshot().activeEventIds,
      });
    }
  }

  setAllLayerVisibility(checked) {
    if (!this.currentManifest) {
      return;
    }

    for (const layer of this.currentManifest.layers) {
      this.setLayerVisibilityState(layer.id, checked, {
        suppressRender: true,
        suppressPanelSync: true,
        suppressSync: true,
      });
      this.publishToggle({
        sectionId: this.currentManifest.id,
        layerId: layer.id,
        target: "layer",
        checked,
      });
    }
    this.renderLayerControls(this.currentManifest);
    this.syncVrControlPanel();
  }

  setAllLayerLabels(checked) {
    if (!this.currentManifest) {
      return;
    }

    for (const layer of this.currentManifest.layers) {
      if (!layer.labelData) {
        continue;
      }
      this.setLayerLabelState(layer.id, checked, {
        suppressRender: true,
        suppressPanelSync: true,
        suppressSync: true,
      });
      this.publishToggle({
        sectionId: this.currentManifest.id,
        layerId: layer.id,
        target: "labels",
        checked,
      });
    }
    this.renderLayerControls(this.currentManifest);
    this.syncVrControlPanel();
  }

  setAirspaceAltitudeMode(enabled) {
    this.airspaceAltitudeMode = Boolean(enabled);
    this.sceneController.setAirspaceAltitudeMode?.(this.airspaceAltitudeMode);
    if (this.currentManifest) {
      this.renderLayerControls(this.currentManifest);
    }
    this.syncVrControlPanel();
    const sectionTitle = this.currentManifest?.title ?? "the current section";
    this.setStatus(
      this.airspaceAltitudeMode
        ? `Airspace altitude mode enabled for ${sectionTitle}. Select an eligible airfield or airspace shelf to show its 3D volume.`
        : (this.defaultStatusMessage || "Airspace altitude mode disabled."),
    );
  }

  syncUrl(sectionId) {
    const url = new URL(window.location.href);
    url.searchParams.set("section", sectionId);
    window.history.replaceState({}, "", url);
  }

  handleStartLink() {
    const sectionId = this.currentManifest?.id ?? "stlouis";
    const entered = this.elements.linkSessionInput.value.trim();
    const sessionId = entered || readSavedSessionId() || generateSessionId(sectionId);
    this.elements.linkSessionInput.value = sessionId;

    this.linkSession.connect(sessionId, {
      onSelection: (selection) => this.applyRemoteSelection(selection),
      onToggle: (toggle) => this.applyRemoteToggle(toggle),
      onInstruction: (instruction) => this.applyRemoteInstruction(instruction),
      onEvent: (eventState) => this.applyRemoteEvent(eventState),
      onStatusChange: (status) => this.syncLinkStatus(status),
    });
    this.syncLinkStatus({
      connected: true,
      sessionId,
    });
    if (this.eventSession && this.currentManifest) {
      this.publishEvent({
        action: "load",
        sectionId: this.currentManifest.id,
        eventSetId: this.eventSession.eventSet.id,
        activeEventIds: this.eventSession.getSnapshot().activeEventIds,
      });
      this.publishScenarioSnapshot(this.eventSession.getSnapshot());
      this.setEventStatus(`${this.eventSession.eventSet.title} sent to the linked 2D companion.`);
    }
  }

  handleDisconnectLink() {
    this.linkSession.disconnect();
    this.syncLinkStatus({
      connected: false,
      sessionId: "",
    });
  }

  applyRemoteSelection(selection) {
    if (!this.currentManifest || (selection && selection.sectionId !== this.currentManifest.id)) {
      return;
    }

    this.applyingRemoteSelection = true;
    try {
      this.sceneController.layerManager.applySelection(selection, { suppressNotify: true });
      if (selection) {
        this.setStatus(`Linked selection: ${selection.label ?? selection.featureId ?? selection.labelId}`);
      } else if (this.defaultStatusMessage) {
        this.setStatus(this.defaultStatusMessage);
      }
    } finally {
      this.applyingRemoteSelection = false;
    }
  }

  publishSelection(selection) {
    if (this.applyingRemoteSelection || !this.linkSession.isConnected()) {
      return;
    }
    this.linkSession.publishSelection(selection);
  }

  applyRemoteToggle(toggle) {
    if (!toggle || !this.currentManifest || toggle.sectionId !== this.currentManifest.id) {
      return;
    }

    this.applyingRemoteToggle = true;
    try {
      if (toggle.target === "layer") {
        this.setLayerVisibilityState(toggle.layerId, toggle.checked, { suppressSync: true });
        return;
      }
      if (toggle.target === "labels") {
        this.setLayerLabelState(toggle.layerId, toggle.checked, { suppressSync: true });
        return;
      }
    } finally {
      this.applyingRemoteToggle = false;
    }
  }

  publishToggle(toggle) {
    if (this.applyingRemoteToggle || !this.linkSession.isConnected()) {
      return;
    }
    this.linkSession.publishToggle(toggle);
  }

  async applyRemoteEvent(eventState) {
    if (!eventState || !eventState.action) {
      return;
    }
    this.applyingRemoteEvent = true;
    try {
      if (eventState.action === "clear") {
        this.clearEventSession({ publish: false });
        this.elements.eventSelect.value = "";
        this.setEventStatus("Event session cleared from the 2D companion.");
        this.setStatus(this.defaultStatusMessage || "Event session cleared from the 2D companion.");
        return;
      }
      if (!eventState.sectionId || !eventState.eventSetId) {
        return;
      }
      if (this.currentManifest?.id !== eventState.sectionId) {
        await this.loadSectionById(eventState.sectionId);
      }
      if (eventState.action === "load") {
        await this.handleEventSetChange(eventState.eventSetId, {
          activeEventIds: eventState.activeEventIds ?? [],
          suppressSync: true,
        });
        return;
      }
      if (eventState.action === "scenario-snapshot") {
        return;
      }
      if (eventState.action === "scenario-command") {
        if (this.eventSession?.eventSet?.id !== eventState.eventSetId) {
          await this.handleEventSetChange(eventState.eventSetId, {
            activeEventIds: eventState.activeEventIds ?? [],
            suppressSync: true,
          });
        }
        this.handleScenarioCommand(eventState.command, eventState.scenarioActionId);
        return;
      }
      if (eventState.action === "toggle") {
        if (this.eventSession?.eventSet?.id !== eventState.eventSetId) {
          await this.handleEventSetChange(eventState.eventSetId, {
            activeEventIds: eventState.activeEventIds ?? [],
            suppressSync: true,
          });
        } else if (eventState.eventId && typeof eventState.enabled === "boolean") {
          this.setEventEnabled(eventState.eventId, eventState.enabled, { suppressSync: true });
        } else if (eventState.activeEventIds) {
          this.eventSession.applyEnabledEventIds(eventState.activeEventIds);
        }
      }
    } catch (error) {
      console.error(error);
      this.setStatus(`Unable to apply linked event state: ${error.message ?? error}`, { error: true });
    } finally {
      this.applyingRemoteEvent = false;
    }
  }

  publishEvent(eventState) {
    if (this.applyingRemoteEvent || !this.linkSession.isConnected()) {
      return;
    }
    this.linkSession.publishEvent(eventState);
  }

  async applyRemoteInstruction(instruction) {
    if (!instruction || !instruction.action) {
      return;
    }
    try {
      if (instruction.action === "clear") {
        this.clearTaskSession("linked_clear");
        this.elements.instructionSelect.value = "";
        this.setStatus(this.defaultStatusMessage || "Instruction session cleared from the 2D companion.");
        return;
      }
      if (!instruction.sectionId || !instruction.taskSetId) {
        return;
      }
      if (this.currentManifest?.id !== instruction.sectionId) {
        await this.loadSectionById(instruction.sectionId);
      }
      if (instruction.action === "reset" && this.activeTaskSet?.id === instruction.taskSetId) {
        this.resetTaskSession();
        return;
      }
      await this.handleInstructionSetChange(instruction.taskSetId);
    } catch (error) {
      console.error(error);
      this.setStatus(`Unable to apply linked instruction session: ${error.message ?? error}`, { error: true });
    }
  }

  syncLinkStatus(status = { connected: false, sessionId: "" }) {
    const connected = Boolean(status.connected);
    this.elements.startLinkButton.disabled = connected;
    this.elements.disconnectLinkButton.disabled = !connected;
    this.elements.linkSessionInput.disabled = connected;
    this.elements.linkStatus.textContent = connected
      ? `Linked locally via session "${status.sessionId}".`
      : "Not linked. Start a local session to sync highlights with the 2D app.";
  }
}

function eventControlSignature(snapshot) {
  return JSON.stringify({
    eventSetId: snapshot?.eventSetId ?? null,
    disposed: Boolean(snapshot?.disposed),
    activeEventIds: snapshot?.activeEventIds ?? [],
  });
}

function readPreferredSectionId(sectionIndex) {
  const url = new URL(window.location.href);
  const requested = url.searchParams.get("section");
  if (!requested) {
    return null;
  }
  return sectionIndex.sections.some((section) => section.id === requested) ? requested : null;
}

function formatBuildSuffix(assetVersion) {
  if (!assetVersion) {
    return "";
  }

  const parsed = new Date(assetVersion);
  if (Number.isNaN(parsed.valueOf())) {
    return "";
  }

  const time = parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return ` Build ${time}.`;
}

function formatLayerTitle(layerId) {
  return `${layerId ?? "map"}`
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
