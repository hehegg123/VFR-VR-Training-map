import { loadSectionIndex, loadSectionManifest } from "../data/sectionRepository.js";
import { createMapScene } from "../scene/MapScene.js?v=20260620-panel-toggle-v1";
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
    this.airspaceAltitudeMode = false;
    this.defaultStatusMessage = "";
    this.applyingRemoteSelection = false;
    this.applyingRemoteToggle = false;
    this.linkSession = new BroadcastLinkSession({
      appId: "vr-viewer",
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
        await this.loadSectionById(sectionId);
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
      this.setStatus(error.message ?? "Failed to start app.");
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
    this.elements.sectionSelect.disabled = singleSection;
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

    this.elements.sectionSelect.value = sectionId;
    this.setStatus(`Loading ${entry.title}...`);

    const manifest = await loadSectionManifest(entry);
    await this.sceneController.layerManager.loadSection(manifest);
    this.sceneController.setAirspaceAltitudeMode?.(this.airspaceAltitudeMode);

    this.currentManifest = manifest;
    this.renderLayerControls(manifest);
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

  setStatus(message) {
    this.elements.statusLine.textContent = message;
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
