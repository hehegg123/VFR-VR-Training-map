import { loadSectionIndex, loadSectionManifest } from "../data/sectionRepository.js";
import { MapCanvasView } from "../scene/MapCanvasView.js?v=20260814-conflict-controls-v1";
import { EventSetRepository } from "../../../babylon-vr-faa-map/src/data/EventSetRepository.js";
import { TaskSetRepository } from "../../../babylon-vr-faa-map/src/data/TaskSetRepository.js?v=20260621-task-sessions-v2";
import { EventSession } from "../../../babylon-vr-faa-map/src/training/EventSession.js?v=20260814-conflict-controls-v1";
import {
  buildScenarioControls,
  updateScenarioControls,
} from "../../../shared/scenarioControls.js?v=20260814-conflict-controls-v1";
import {
  BroadcastLinkSession,
  generateSessionId,
  readSavedSessionId,
} from "../../../shared/linkSession.js?v=20260814-conflict-controls-v1";

export class AppShell {
  constructor(elements) {
    this.elements = elements;
    this.sectionIndex = null;
    this.currentManifest = null;
    this.layerUiState = new Map();
    this.taskSetRepository = new TaskSetRepository();
    this.eventSetRepository = new EventSetRepository();
    this.activeTaskSet = null;
    this.activeEventSet = null;
    this.eventSession = null;
    this.unsubscribeEventSession = null;
    this.scenarioFrameHandle = 0;
    this.eventControlSignature = "";
    this.taskSetLoadToken = 0;
    this.eventSetLoadToken = 0;
    this.taskSetLoading = false;
    this.eventSetLoading = false;
    this.sectionLoading = false;
    this.defaultStatusMessage = "";
    this.applyingRemoteSelection = false;
    this.applyingRemoteToggle = false;
    this.applyingRemoteEvent = false;
    this.mapView = new MapCanvasView(elements);
    this.linkSession = new BroadcastLinkSession({
      appId: "2d-review",
    });
  }

  async start() {
    try {
      this.setStatus("Loading 2D map...");
      this.elements.fitViewButton.addEventListener("click", () => this.mapView.fitView());
      this.elements.sectionSelect.addEventListener("change", async (event) => {
        try {
          await this.loadSectionById(event.target.value);
        } catch (error) {
          console.error(error);
          this.setStatus(error.message ?? "Unable to change map section.");
        }
      });
      this.elements.instructionSelect.addEventListener("change", (event) => {
        this.handleInstructionSetChange(event.target.value);
      });
      this.elements.eventSelect.addEventListener("change", (event) => {
        this.handleEventSetChange(event.target.value);
      });
      this.elements.resetTaskSessionButton.addEventListener("click", () => this.resetTaskSession());
      this.elements.startLinkButton.addEventListener("click", () => this.handleStartLink());
      this.elements.disconnectLinkButton.addEventListener("click", () => this.handleDisconnectLink());
      this.elements.linkSessionInput.value = readSavedSessionId() || "stlouis-review";

      this.mapView.onSelectionChange = (selection) => {
        if (!selection) {
          this.setStatus(this.defaultStatusMessage);
          this.publishSelection(selection);
          return;
        }
        if (selection.kind === "feature") {
          this.setStatus(`Selected ${formatLayerTitle(selection.layerId)} area: ${selection.featureId}`);
        } else {
          this.setStatus(`Selected ${formatLayerTitle(selection.layerId)} label: ${selection.label}`);
        }
        this.publishSelection(selection);
      };

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
      this.setStatus(error.message ?? "Failed to start 2D app.");
    }
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
    this.elements.sectionSelect.hidden = singleSection;
    const sectionLabel = this.elements.sectionSelect?.previousElementSibling;
    if (sectionLabel) {
      sectionLabel.hidden = singleSection;
    }
    this.elements.sectionNote.hidden = !singleSection;
    this.elements.sectionNote.textContent = singleSection
      ? `${sections[0]?.title ?? "St. Louis Sectional"} is the only active section in this prototype right now.`
      : "";
  }

  async loadSectionById(sectionId) {
    const entry = this.sectionIndex.sections.find((section) => section.id === sectionId);
    if (!entry) {
      throw new Error(`Unknown section: ${sectionId}`);
    }

    this.clearInstructionSelection({ publish: true });
    this.clearEventSession({ publish: true });
    this.sectionLoading = true;
    this.resetInstructionList();
    this.resetEventList();
    this.syncInstructionControls();
    this.syncEventControls();
    this.elements.sectionSelect.value = sectionId;
    this.setStatus(`Loading ${entry.title}...`);

    try {
      const manifest = await loadSectionManifest(entry);
      await this.mapView.loadSection(manifest);

      this.currentManifest = manifest;
      this.renderLayerControls(manifest);
      this.populateInstructionList(manifest);
      this.populateEventList(manifest);
      this.syncUrl(sectionId);
      this.elements.sectionQuality.dataset.quality = entry.quality ?? "primary";
      this.elements.sectionQuality.textContent = entry.quality ?? "primary";
      this.defaultStatusMessage =
        `${manifest.title} loaded with ${manifest.layers.length} map layers and linked highlight support.${formatBuildSuffix(manifest.assetVersion)}`;
      this.setStatus(this.defaultStatusMessage);
    } finally {
      this.sectionLoading = false;
      this.syncInstructionControls();
      this.syncEventControls();
    }
  }

  populateInstructionList(manifest) {
    const entries = manifest.training?.taskSets ?? [];
    this.elements.instructionSelect.innerHTML = "";
    this.elements.instructionSelect.append(new Option("No instructions", ""));
    for (const entry of entries) {
      this.elements.instructionSelect.append(new Option(entry.title, entry.id));
    }
    this.elements.instructionSelect.value = "";
    this.elements.instructionGroup.hidden = entries.length === 0;
    this.setInstructionStatus(entries.length ? "Choose a task set to send to the linked VR app." : "");
    this.syncInstructionControls();
  }

  resetInstructionList() {
    this.elements.instructionSelect.innerHTML = "";
    this.elements.instructionSelect.append(new Option("No instructions", ""));
    this.elements.instructionSelect.value = "";
    this.elements.instructionGroup.hidden = true;
    this.setInstructionStatus("");
  }

  populateEventList(manifest) {
    const entries = manifest.training?.eventSets ?? [];
    this.elements.eventSelect.innerHTML = "";
    this.elements.eventSelect.append(new Option("No events", ""));
    for (const entry of entries) {
      this.elements.eventSelect.append(new Option(entry.title, entry.id));
    }
    this.elements.eventSelect.value = "";
    this.elements.eventGroup.hidden = entries.length === 0;
    this.elements.eventControls.innerHTML = "";
    this.setEventStatus(entries.length ? "Choose an event set to show training events or scenarios." : "");
    this.syncEventControls();
  }

  resetEventList() {
    this.elements.eventSelect.innerHTML = "";
    this.elements.eventSelect.append(new Option("No events", ""));
    this.elements.eventSelect.value = "";
    this.elements.eventGroup.hidden = true;
    this.elements.eventControls.innerHTML = "";
    this.setEventStatus("");
  }

  async handleInstructionSetChange(taskSetId) {
    const loadToken = ++this.taskSetLoadToken;
    this.clearInstructionSelection({ publish: Boolean(!taskSetId) });
    if (!taskSetId) {
      this.elements.instructionSelect.value = "";
      this.setInstructionStatus("Instruction session cleared.");
      this.syncInstructionControls();
      return;
    }

    const manifest = this.currentManifest;
    const entry = manifest?.training?.taskSets?.find((candidate) => candidate.id === taskSetId);
    if (!manifest || !entry) {
      this.elements.instructionSelect.value = "";
      this.setInstructionStatus(`Instruction set ${taskSetId} is unavailable.`, { error: true });
      return;
    }

    this.taskSetLoading = true;
    this.syncInstructionControls();
    this.setInstructionStatus(`Loading ${entry.title}...`);
    try {
      const taskSet = await this.taskSetRepository.load(manifest, entry);
      if (loadToken !== this.taskSetLoadToken || manifest !== this.currentManifest) {
        return;
      }
      this.activeTaskSet = taskSet;
      this.elements.instructionSelect.value = entry.id;
      this.publishInstruction({ action: "load", sectionId: manifest.id, taskSetId: entry.id });
      this.setInstructionStatus(this.linkSession.isConnected()
        ? `${entry.title} sent to the linked VR app.`
        : `${entry.title} selected. Start Link to send it to the VR app.`);
    } catch (error) {
      if (loadToken !== this.taskSetLoadToken) {
        return;
      }
      console.error(error);
      this.activeTaskSet = null;
      this.elements.instructionSelect.value = "";
      this.setInstructionStatus(`Unable to load ${entry.title}: ${error.message ?? error}`, { error: true });
    } finally {
      if (loadToken === this.taskSetLoadToken) {
        this.taskSetLoading = false;
        this.syncInstructionControls();
      }
    }
  }

  resetTaskSession() {
    if (!this.activeTaskSet || this.taskSetLoading || this.sectionLoading) {
      return;
    }
    this.publishInstruction({
      action: "reset",
      sectionId: this.currentManifest?.id,
      taskSetId: this.activeTaskSet.id,
    });
    this.setInstructionStatus(this.linkSession.isConnected()
      ? `${this.activeTaskSet.title} reset in the linked VR app.`
      : "Start Link before resetting the VR task session.",
      { error: !this.linkSession.isConnected() });
  }

  clearInstructionSelection({ publish = false } = {}) {
    const taskSetId = this.activeTaskSet?.id ?? null;
    const sectionId = this.currentManifest?.id ?? null;
    this.activeTaskSet = null;
    if (publish && (taskSetId || this.linkSession.isConnected())) {
      this.publishInstruction({ action: "clear", sectionId, taskSetId });
    }
    this.syncInstructionControls();
  }

  async handleEventSetChange(eventSetId, options = {}) {
    const loadToken = ++this.eventSetLoadToken;
    this.clearEventSession({ publish: Boolean(!eventSetId) && !options.suppressSync });
    if (!eventSetId) {
      this.elements.eventSelect.value = "";
      this.setEventStatus("Event session cleared.");
      this.syncEventControls();
      return;
    }

    const manifest = this.currentManifest;
    const entry = manifest?.training?.eventSets?.find((candidate) => candidate.id === eventSetId);
    if (!manifest || !entry) {
      this.elements.eventSelect.value = "";
      this.setEventStatus(`Event set ${eventSetId} is unavailable.`, { error: true });
      return;
    }

    this.eventSetLoading = true;
    this.syncEventControls();
    this.setEventStatus(`Loading ${entry.title}...`);
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
      this.unsubscribeEventSession = this.eventSession.subscribe((snapshot) => {
        this.mapView.setEventSnapshot(snapshot);
        const nextSignature = eventControlSignature(snapshot);
        if (
          nextSignature === this.eventControlSignature
          && this.elements.eventControls.querySelector?.(".scenario-controls")
        ) {
          updateScenarioControls(this.elements.eventControls, snapshot);
        } else {
          this.renderEventControls(snapshot);
        }
        if (!snapshot.authoritative && snapshot.scenarioStatus === "running") {
          this.startScenarioAnimation();
        }
      });
      this.elements.eventSelect.value = entry.id;
      if (!options.suppressSync) {
        this.publishEvent({
          action: "load",
          sectionId: manifest.id,
          eventSetId: entry.id,
          activeEventIds: this.eventSession.getSnapshot().activeEventIds,
        });
      }
      this.setEventStatus(this.linkSession.isConnected()
        ? `${entry.title} active and synced.`
        : `${entry.title} selected. Start Link to sync it to VR.`);
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
        this.syncEventControls();
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
    this.stopScenarioAnimation();
    this.activeEventSet = null;
    this.eventControlSignature = "";
    this.mapView.setEventSnapshot(null);
    this.elements.eventControls.innerHTML = "";
    if (publish && (eventSetId || this.linkSession.isConnected())) {
      this.publishEvent({ action: "clear", sectionId, eventSetId });
    }
    this.syncEventControls();
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
    if (this.linkSession.isConnected()) {
      this.publishEvent({
        action: "scenario-command",
        sectionId: this.currentManifest?.id,
        eventSetId: this.eventSession.eventSet.id,
        command,
        scenarioActionId: actionId,
        activeEventIds: this.eventSession.getSnapshot().activeEventIds,
      });
      return true;
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
    this.mapView.setEventSnapshot(snapshot);
    updateScenarioControls(this.elements.eventControls, snapshot);
    if (snapshot.scenarioStatus === "running") {
      this.startScenarioAnimation();
    } else {
      this.stopScenarioAnimation();
    }
    return changed;
  }

  startScenarioAnimation() {
    if (this.scenarioFrameHandle || !this.eventSession) {
      return;
    }
    const tick = () => {
      this.scenarioFrameHandle = 0;
      if (!this.eventSession) {
        return;
      }
      const snapshot = this.eventSession.getSnapshot();
      this.mapView.setEventSnapshot(snapshot);
      updateScenarioControls(this.elements.eventControls, snapshot);
      if (!snapshot.authoritative && snapshot.scenarioStatus === "running") {
        this.scenarioFrameHandle = requestAnimationFrame(tick);
      }
    };
    this.scenarioFrameHandle = requestAnimationFrame(tick);
  }

  stopScenarioAnimation() {
    if (this.scenarioFrameHandle) {
      cancelAnimationFrame(this.scenarioFrameHandle);
      this.scenarioFrameHandle = 0;
    }
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

  syncEventControls() {
    const eventSetCount = this.currentManifest?.training?.eventSets?.length ?? 0;
    this.elements.eventSelect.disabled = eventSetCount === 0 || this.sectionLoading || this.eventSetLoading;
    const sectionCount = this.sectionIndex?.sections?.length ?? 0;
    this.elements.sectionSelect.disabled = sectionCount <= 1 || this.sectionLoading || this.taskSetLoading || this.eventSetLoading;
  }

  setEventStatus(message, options = {}) {
    this.elements.eventStatus.textContent = message;
    if (options.error) {
      this.elements.eventStatus.dataset.state = "error";
    } else {
      delete this.elements.eventStatus.dataset.state;
    }
  }

  syncInstructionControls() {
    const taskSetCount = this.currentManifest?.training?.taskSets?.length ?? 0;
    this.elements.instructionSelect.disabled = taskSetCount === 0 || this.sectionLoading || this.taskSetLoading || this.eventSetLoading;
    const hasTaskSet = Boolean(this.activeTaskSet);
    this.elements.resetTaskSessionButton.hidden = !hasTaskSet;
    this.elements.resetTaskSessionButton.disabled = !hasTaskSet || this.sectionLoading || this.taskSetLoading;
    const sectionCount = this.sectionIndex?.sections?.length ?? 0;
    this.elements.sectionSelect.disabled = sectionCount <= 1 || this.sectionLoading || this.taskSetLoading || this.eventSetLoading;
  }

  setInstructionStatus(message, options = {}) {
    this.elements.instructionStatus.textContent = message;
    if (options.error) {
      this.elements.instructionStatus.dataset.state = "error";
    } else {
      delete this.elements.instructionStatus.dataset.state;
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
        extendedLabelsEnabled: false,
      };
      nextState.set(layer.id, layerState);

      const card = document.createElement("section");
      card.className = "layer-card";
      const header = document.createElement("header");
      header.innerHTML = `<h3>${layer.title}</h3><p>${layer.id}</p>`;

      const visibilityRow = this.buildToggleRow("Layer visible", layerState.layerVisible, (checked) => {
        this.updateLayerVisibility(layer.id, checked);
      });
      const labelToggleAvailable = Boolean(layer.labelData);
      const labelRow = this.buildToggleRow(
        labelToggleAvailable ? "Labels" : "Labels unavailable",
        layerState.labelsEnabled,
        (checked) => this.updateLayerLabels(layer.id, checked),
      );
      labelRow.querySelector("input").disabled = !labelToggleAvailable;
      card.append(header, visibilityRow, labelRow);

      if (layer.supportsExtendedLabels) {
        const extendedRow = this.buildToggleRow(
          "Extended airspace labels",
          layerState.extendedLabelsEnabled,
          (checked) => this.updateExtendedLabels(layer.id, checked),
        );
        extendedRow.querySelector("input").disabled = !labelToggleAvailable;
        card.append(extendedRow);
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
    header.innerHTML = "<h3>Master Control</h3><p>All layers</p>";

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

  updateLayerVisibility(layerId, checked) {
    this.setLayerVisibilityState(layerId, checked);
  }

  setLayerVisibilityState(layerId, checked, options = {}) {
    const layerState = this.layerUiState.get(layerId);
    if (!layerState) {
      return;
    }
    layerState.layerVisible = checked;
    this.mapView.setLayerVisible(layerId, checked);
    this.mapView.setLabelVisible(layerId, checked && layerState.labelsEnabled);
    if (!options.suppressRender && this.currentManifest) {
      this.renderLayerControls(this.currentManifest);
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
    this.mapView.setLabelVisible(layerId, layerState.layerVisible && checked);
    if (!options.suppressRender && this.currentManifest) {
      this.renderLayerControls(this.currentManifest);
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

  updateExtendedLabels(layerId, checked) {
    this.setExtendedLabelState(layerId, checked);
  }

  setExtendedLabelState(layerId, checked, options = {}) {
    const layerState = this.layerUiState.get(layerId);
    if (!layerState) {
      return;
    }
    layerState.extendedLabelsEnabled = checked;
    this.mapView.setLabelOptions(layerId, {
      extendedAirspaceLabels: checked,
    });
    if (!options.suppressRender && this.currentManifest) {
      this.renderLayerControls(this.currentManifest);
    }
    if (!options.suppressSync) {
      this.publishToggle({
        sectionId: this.currentManifest?.id,
        layerId,
        target: "extended-labels",
        checked,
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
  }

  handleStartLink() {
    const sectionId = this.currentManifest?.id ?? "stlouis";
    const entered = this.elements.linkSessionInput.value.trim();
    const sessionId = entered || readSavedSessionId() || generateSessionId(sectionId);
    this.elements.linkSessionInput.value = sessionId;
    this.linkSession.connect(sessionId, {
      onSelection: (selection) => this.applyRemoteSelection(selection),
      onToggle: (toggle) => this.applyRemoteToggle(toggle),
      onEvent: (eventState) => this.applyRemoteEvent(eventState),
      onStatusChange: (status) => this.syncLinkStatus(status),
    });
    this.syncLinkStatus({
      connected: true,
      sessionId,
    });
    if (this.activeTaskSet && this.currentManifest) {
      this.publishInstruction({
        action: "load",
        sectionId: this.currentManifest.id,
        taskSetId: this.activeTaskSet.id,
      });
      this.setInstructionStatus(`${this.activeTaskSet.title} sent to the linked VR app.`);
    }
    if (this.eventSession && this.currentManifest) {
      this.publishEvent({
        action: "load",
        sectionId: this.currentManifest.id,
        eventSetId: this.eventSession.eventSet.id,
        activeEventIds: this.eventSession.getSnapshot().activeEventIds,
      });
      this.setEventStatus(`${this.eventSession.eventSet.title} sent to the linked VR app.`);
    }
  }

  handleDisconnectLink() {
    this.linkSession.disconnect();
    this.eventSession?.clearAuthoritativeScenarioSnapshot?.({ notify: true });
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
      this.mapView.setSelection(selection, { notify: false });
      if (selection) {
        this.setStatus(`Linked selection: ${selection.label ?? selection.featureId ?? selection.labelId}`);
      } else {
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
      if (toggle.target === "extended-labels") {
        this.setExtendedLabelState(toggle.layerId, toggle.checked, { suppressSync: true });
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
    if (eventState.sectionId && this.currentManifest?.id !== eventState.sectionId) {
      return;
    }

    this.applyingRemoteEvent = true;
    try {
      if (eventState.action === "clear") {
        this.clearEventSession({ publish: false });
        this.elements.eventSelect.value = "";
        this.setEventStatus("Event session cleared from the linked VR app.");
        return;
      }
      if (!eventState.eventSetId) {
        return;
      }
      if (eventState.action === "load") {
        await this.handleEventSetChange(eventState.eventSetId, {
          activeEventIds: eventState.activeEventIds ?? [],
          suppressSync: true,
        });
        return;
      }
      if (eventState.action === "scenario-command") {
        return;
      }
      if (eventState.action === "scenario-snapshot") {
        if (!eventState.scenarioSnapshot) {
          return;
        }
        if (this.eventSession?.eventSet?.id !== eventState.eventSetId) {
          await this.handleEventSetChange(eventState.eventSetId, {
            activeEventIds: eventState.scenarioSnapshot.activeEventIds ?? [],
            suppressSync: true,
          });
        }
        this.eventSession?.applyAuthoritativeScenarioSnapshot(eventState.scenarioSnapshot);
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
      this.setEventStatus(`Unable to apply linked event state: ${error.message ?? error}`, { error: true });
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

  publishInstruction(instruction) {
    if (!this.linkSession.isConnected()) {
      return;
    }
    this.linkSession.publishInstruction(instruction);
  }

  syncLinkStatus(status = { connected: false, sessionId: "" }) {
    const connected = Boolean(status.connected);
    this.elements.startLinkButton.disabled = connected;
    this.elements.disconnectLinkButton.disabled = !connected;
    this.elements.linkSessionInput.disabled = connected;
    this.elements.linkStatus.textContent = connected
      ? `Linked locally via session "${status.sessionId}".`
      : "Not linked. Start a local session to sync highlights with the VR app.";
  }

  syncUrl(sectionId) {
    const url = new URL(window.location.href);
    url.searchParams.set("section", sectionId);
    window.history.replaceState({}, "", url);
  }

  setStatus(message) {
    this.elements.statusLine.textContent = message;
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
