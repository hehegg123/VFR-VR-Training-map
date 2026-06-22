import { loadSectionIndex, loadSectionManifest } from "../data/sectionRepository.js";
import { TaskSetRepository } from "../data/TaskSetRepository.js?v=20260621-task-sessions-v2";
import { createMapScene } from "../scene/MapScene.js?v=20260621-instruction-workflow-v1";
import { TaskEventLog, TASK_EVENT_TYPES } from "../training/TaskEventLog.js?v=20260621-instruction-workflow-v1";
import { TaskSession } from "../training/TaskSession.js?v=20260621-task-sessions-v1";
import {
  BroadcastLinkSession,
  generateSessionId,
  readSavedSessionId,
} from "../../../shared/linkSession.js";

export class AppShell {
  constructor(elements) {
    this.elements = elements;
    this.sectionIndex = null;
    this.sceneController = null;
    this.currentManifest = null;
    this.layerUiState = new Map();
    this.taskSetRepository = new TaskSetRepository();
    this.taskSession = null;
    this.activeTaskSet = null;
    this.taskSetLoadToken = 0;
    this.taskSetLoading = false;
    this.sectionLoading = false;
    this.airspaceAltitudeMode = false;
    this.defaultStatusMessage = "";
    this.applyingRemoteSelection = false;
    this.applyingRemoteToggle = false;
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
    this.clearTaskSession("section_changed");
    this.sectionLoading = true;
    this.resetInstructionList();
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
    this.elements.sectionSelect.disabled = sectionCount <= 1 || this.sectionLoading || this.taskSetLoading;
    this.elements.sectionSelect.setAttribute("aria-disabled", String(this.elements.sectionSelect.disabled));
    const taskSetCount = this.currentManifest?.training?.taskSets?.length ?? 0;
    this.elements.instructionSelect.disabled = taskSetCount === 0 || this.sectionLoading || this.taskSetLoading;
    this.elements.instructionSelect.setAttribute("aria-disabled", String(this.elements.instructionSelect.disabled));
    this.elements.instructionGroup.setAttribute("aria-busy", String(this.taskSetLoading));
    const hasTaskSession = Boolean(this.taskSession && !this.taskSession.disposed);
    this.elements.resetTaskSessionButton.hidden = !hasTaskSession;
    this.elements.resetTaskSessionButton.disabled = !hasTaskSession || this.sectionLoading || this.taskSetLoading;
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
      onToggleLayerVisible: (layerId, checked) => this.updateLayerVisibility(layerId, checked),
      onToggleLabels: (layerId, checked) => this.updateLayerLabels(layerId, checked),
      onToggleAirspaceAltitude: (checked) => this.setAirspaceAltitudeMode(checked),
      onSetAllLayerVisible: (checked) => this.setAllLayerVisibility(checked),
      onSetAllLabels: (checked) => this.setAllLayerLabels(checked),
    });
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
    this.syncVrControlPanel();
    this.setStatus(
      this.airspaceAltitudeMode
        ? "Airspace altitude mode enabled. Selected St. Louis airfield-related airspace now renders as a 3D proxy volume in VR."
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
      onStatusChange: (status) => this.syncLinkStatus(status),
    });
    this.syncLinkStatus({
      connected: true,
      sessionId,
    });
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
