import { loadSectionIndex, loadSectionManifest } from "../data/sectionRepository.js";
import { MapCanvasView } from "../scene/MapCanvasView.js";
import {
  BroadcastLinkSession,
  generateSessionId,
  readSavedSessionId,
} from "../../../shared/linkSession.js";

export class AppShell {
  constructor(elements) {
    this.elements = elements;
    this.sectionIndex = null;
    this.currentManifest = null;
    this.layerUiState = new Map();
    this.defaultStatusMessage = "";
    this.applyingRemoteSelection = false;
    this.applyingRemoteToggle = false;
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
        await this.loadSectionById(event.target.value);
      });
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
    this.elements.sectionSelect.disabled = singleSection;
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

    this.elements.sectionSelect.value = sectionId;
    this.setStatus(`Loading ${entry.title}...`);

    const manifest = await loadSectionManifest(entry);
    await this.mapView.loadSection(manifest);

    this.currentManifest = manifest;
    this.renderLayerControls(manifest);
    this.syncUrl(sectionId);
    this.elements.sectionQuality.dataset.quality = entry.quality ?? "primary";
    this.elements.sectionQuality.textContent = entry.quality ?? "primary";
    this.defaultStatusMessage =
      `${manifest.title} loaded with ${manifest.layers.length} map layers and linked highlight support.${formatBuildSuffix(manifest.assetVersion)}`;
    this.setStatus(this.defaultStatusMessage);
  }

  renderLayerControls(manifest) {
    const container = this.elements.layerControls;
    container.innerHTML = "";
    const nextState = new Map();

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

      container.append(card);
    }

    this.layerUiState = nextState;
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
    if (this.currentManifest) {
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
    if (this.currentManifest) {
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
    if (this.currentManifest) {
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
