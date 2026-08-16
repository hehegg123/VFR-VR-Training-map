import { pixelsToWorldPoint } from "./geometry/projector.js";

const LABEL_TILT_RADIANS = Math.PI / 2 - 0.5;
const LABEL_ROLL_RADIANS = Math.PI;
const LABEL_FIXED_YAW_RADIANS = 0;
const AIRSPACE_LABEL_BASE_ELEVATION = 0.03;
const AIRSPACE_LABEL_SELECTION_LIFT = 0.045;

const LABEL_STYLES = {
  "airport-major": {
    fill: "#14365f",
    border: "#7dd3fc",
    text: "#ffffff",
    width: 320,
    height: 118,
    scale: 0.62,
  },
  "airport-minor": {
    fill: "#224c7c",
    border: "#93c5fd",
    text: "#ffffff",
    width: 256,
    height: 92,
    scale: 0.5,
  },
  "intersection-major": {
    fill: "#364152",
    border: "#fbbf24",
    text: "#f8fafc",
    width: 230,
    height: 76,
    scale: 0.42,
  },
  "intersection-minor": {
    fill: "#4b5563",
    border: "#fcd34d",
    text: "#f8fafc",
    width: 220,
    height: 70,
    scale: 0.38,
  },
  "navaid-vor": {
    fill: "#0f4f59",
    border: "#5eead4",
    text: "#ecfeff",
    width: 264,
    height: 126,
    scale: 0.48,
  },
  "navaid-dme": {
    fill: "#0e5560",
    border: "#67e8f9",
    text: "#ecfeff",
    width: 252,
    height: 122,
    scale: 0.46,
  },
  "navaid-ndb": {
    fill: "#1f5f67",
    border: "#99f6e4",
    text: "#ecfeff",
    width: 252,
    height: 122,
    scale: 0.46,
  },
  "victor-airway": {
    fill: "#102f57",
    border: "#fde68a",
    text: "#f8fafc",
    width: 250,
    height: 88,
    scale: 0.46,
  },
  "airspace-primary": {
    fill: "#6f1d67",
    border: "#f9a8d4",
    text: "#ffffff",
    width: 320,
    height: 112,
    scale: 0.54,
  },
  "airspace-secondary": {
    fill: "#87406f",
    border: "#fbcfe8",
    text: "#ffffff",
    width: 256,
    height: 86,
    scale: 0.42,
  },
};

function pickLabelStyle(styleId) {
  return LABEL_STYLES[styleId] ?? LABEL_STYLES["intersection-minor"];
}

function isAirspaceLayer(definition) {
  return definition?.id === "airspace";
}

function createLabelTexture(scene, item) {
  const style = pickLabelStyle(item.style);
  const texture = new BABYLON.DynamicTexture(
    `label-texture-${item.id}`,
    { width: style.width, height: style.height },
    scene,
    false,
  );

  const context = texture.getContext();
  context.clearRect(0, 0, style.width, style.height);
  context.fillStyle = `${style.fill}dd`;
  context.strokeStyle = style.border ?? "rgba(255,255,255,0.88)";
  context.lineWidth = 4;

  const radius = 18;
  roundRect(context, 4, 4, style.width - 8, style.height - 8, radius);
  context.fill();
  context.stroke();

  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = style.text;

  const lines = item.lines?.length ? item.lines : [item.text ?? item.id];
  const baseFontSize = lines.length > 1 ? 30 : 34;
  const lineGap = lines.length > 2 ? 28 : 32;
  const top = style.height / 2 - ((lines.length - 1) * (lineGap / 2));
  const maxTextWidth = style.width - 36;

  lines.forEach((line, index) => {
    const weight = index === 0 ? "700" : "500";
    const targetFontSize = Math.max(16, baseFontSize - index * 4);
    const fittedFontSize = fitFontSize(context, line, weight, targetFontSize, maxTextWidth);
    context.font = `${weight} ${fittedFontSize}px Segoe UI`;
    context.fillText(line, style.width / 2, top + index * lineGap);
  });

  texture.update(false);
  texture.uScale = -1;
  texture.uOffset = 1;
  return { texture, style };
}

function createSelectionBorderTexture(scene, item, style) {
  const texture = new BABYLON.DynamicTexture(
    `label-selection-texture-${item.id}`,
    { width: style.width, height: style.height },
    scene,
    false,
  );

  const context = texture.getContext();
  context.clearRect(0, 0, style.width, style.height);
  context.strokeStyle = "#fde047";
  context.lineWidth = 8;

  const radius = 18;
  roundRect(context, 4, 4, style.width - 8, style.height - 8, radius);
  context.stroke();

  texture.update(false);
  texture.uScale = -1;
  texture.uOffset = 1;
  return texture;
}

function fitFontSize(context, text, weight, initialSize, maxWidth) {
  let size = initialSize;
  while (size > 14) {
    context.font = `${weight} ${size}px Segoe UI`;
    if (context.measureText(text).width <= maxWidth) {
      return size;
    }
    size -= 1;
  }
  return 14;
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

export class VrLabelLayer {
  constructor(scene, parent, definition, sectionMetrics, labelPayload) {
    this.scene = scene;
    this.parent = parent;
    this.definition = definition;
    this.sectionMetrics = sectionMetrics;
    this.labelPayload = labelPayload;
    this.root = null;
    this.entries = [];
    this.layerActive = false;
    this.labelsVisible = false;
    this.altitudeMode = false;
    this.selectedSelectionId = null;
    this.selectedFamilyKey = null;
    this.focusedLabel = null;
    this.hoveredItemId = null;
    this.beforeRenderObserver = null;
  }

  async load() {
    this.root = new BABYLON.TransformNode(`label-root-${this.definition.id}`, this.scene);
    this.root.parent = this.parent;

    const items = this.labelPayload.items ?? [];
    for (const item of items) {
      const finalAnchor = resolveFinalLabelAnchor(this.sectionMetrics, this.definition, item);
      const point = finalAnchor.worldPoint.clone();
      const { texture, style } = createLabelTexture(this.scene, item);
      const labelWidth = style.scale;
      const labelHeight = style.scale * (style.height / style.width);
      const material = this.createLabelMaterial(item, texture);
      const entryRoot = new BABYLON.TransformNode(`label-entry-${this.definition.id}-${item.id}`, this.scene);
      entryRoot.parent = this.root;

      const plane = BABYLON.MeshBuilder.CreatePlane(
        `label-${this.definition.id}-${item.id}`,
        { width: labelWidth, height: labelHeight },
        this.scene,
      );
      plane.parent = entryRoot;
      plane.position = point.clone();
      plane.rotationQuaternion = fixedLabelQuaternion();
      plane.isPickable = true;
      plane.material = material;
      plane.metadata = {
        interactiveLayerId: this.definition.id,
        interactiveRole: "label",
        itemId: item.id,
        labelText: (item.lines?.length ? item.lines.join(" / ") : item.text) ?? item.id,
        selectionId: item.selectionId ?? item.id,
        familyKey: item.familyKey ?? null,
        labelGroup: item.labelGroup ?? null,
        detailTier: item.detailTier ?? null,
        airspaceType: item.airspaceType ?? null,
        placementMode: item.placementMode ?? null,
      };

      const selectionBorderTexture = createSelectionBorderTexture(this.scene, item, style);
      const selectionBorderMaterial = this.createSelectionBorderMaterial(item, selectionBorderTexture);
      const selectionBorder = BABYLON.MeshBuilder.CreatePlane(
        `label-selection-${this.definition.id}-${item.id}`,
        { width: labelWidth * 1.02, height: labelHeight * 1.02 },
        this.scene,
      );
      selectionBorder.parent = entryRoot;
      selectionBorder.position = point.clone();
      selectionBorder.position.y += isAirspaceLayer(this.definition) ? 0.002 : 0.0015;
      selectionBorder.rotationQuaternion = plane.rotationQuaternion.clone();
      selectionBorder.isPickable = false;
      selectionBorder.material = selectionBorderMaterial;
      selectionBorder.setEnabled(false);

      const entry = {
        item,
        root: entryRoot,
        meshes: [plane, selectionBorder],
        plane,
        selectionBorder,
        point,
        baseElevation: point.y,
        material,
        texture,
        selectionBorderMaterial,
        selectionBorderTexture,
      };

      if (item.connector && Number.isFinite(item.anchorX) && Number.isFinite(item.anchorY)) {
        const connector = this.createConnector(item, point, labelHeight, entryRoot);
        if (connector) {
          entry.meshes.push(connector);
        }
      }
      this.entries.push(entry);
    }

    this.setLayerActive(this.definition.defaultVisible !== false);
    this.setVisible(this.definition.defaultLabels !== false);
  }

  createLabelMaterial(item, texture) {
    const material = new BABYLON.StandardMaterial(`label-material-${item.id}`, this.scene);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = new BABYLON.Color3(1, 1, 1);
    material.specularColor = BABYLON.Color3.Black();
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;
    material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    return material;
  }

  createSelectionBorderMaterial(item, texture) {
    const material = new BABYLON.StandardMaterial(`label-selection-material-${item.id}`, this.scene);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = new BABYLON.Color3(1, 1, 1);
    material.specularColor = BABYLON.Color3.Black();
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;
    material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    return material;
  }

  createConnector(item, labelPoint, labelHeight, parent) {
    const anchor = pixelsToWorldPoint(this.sectionMetrics, item.anchorX, item.anchorY, 0.028);
    const dock = labelPoint.clone();
    dock.y += isAirspaceLayer(this.definition) ? 0.006 : -(labelHeight * 0.44);

    const connector = BABYLON.MeshBuilder.CreateLines(
      `label-connector-${this.definition.id}-${item.id}`,
      { points: [anchor, dock] },
      this.scene,
    );
    connector.parent = parent;
    connector.color = BABYLON.Color3.FromHexString("#ffffff");
    connector.alpha = 0.94;
    connector.isPickable = false;
    return connector;
  }

  setLayerActive(active) {
    this.layerActive = Boolean(active);
    this.refreshVisibility();
  }

  setVisible(visible) {
    this.labelsVisible = Boolean(visible);
    this.refreshVisibility();
  }

  setAltitudeMode(enabled) {
    this.altitudeMode = Boolean(enabled);
    if (this.altitudeMode && this.entries.some((entry) => entry.item.id === this.hoveredItemId && isShelfLabel(entry.item))) {
      this.hoveredItemId = null;
    }
    this.refreshVisibility();
  }

  setSelection(selectionId, familyKey = null) {
    this.selectedSelectionId = selectionId;
    this.selectedFamilyKey = familyKey;
    this.refreshVisibility();
  }

  setFocusedLabel(focusedLabel) {
    this.focusedLabel = focusedLabel;
    this.refreshVisibility();
  }

  setHoveredLabel(itemId) {
    if (this.hoveredItemId === itemId) {
      return;
    }
    this.hoveredItemId = itemId;
    this.applySelectionState();
  }

  refreshVisibility() {
    if (!this.root) {
      return;
    }

    if (!this.layerActive) {
      this.root.setEnabled(false);
      this.entries.forEach((entry) => this.setEntryEnabled(entry, false));
      return;
    }

    const hasFocusedLabel = Boolean(this.focusedLabel?.layerId && this.focusedLabel?.itemId);
    if (hasFocusedLabel) {
      const sameLayerFocus = this.focusedLabel.layerId === this.definition.id;
      this.root.setEnabled(sameLayerFocus || Boolean(this.selectedSelectionId));
      for (const entry of this.entries) {
        const isSelected = (entry.item.selectionId ?? entry.item.id) === this.selectedSelectionId;
        const isFamilyPrimary = this.isSelectedFamilyPrimary(entry);
        const isFocusedItem = sameLayerFocus && entry.item.id === this.focusedLabel.itemId;
        this.setEntryEnabled(entry, (isFocusedItem || isSelected || isFamilyPrimary) && this.isEntryAllowed(entry));
      }
      this.applySelectionState();
      return;
    }

    if (this.selectedSelectionId) {
      this.root.setEnabled(true);
      for (const entry of this.entries) {
        const isSelected = (entry.item.selectionId ?? entry.item.id) === this.selectedSelectionId;
        this.setEntryEnabled(entry, (isSelected || this.isSelectedFamilyPrimary(entry)) && this.isEntryAllowed(entry));
      }
      this.applySelectionState();
      return;
    }

    if (!this.labelsVisible) {
      this.root.setEnabled(false);
      this.entries.forEach((entry) => this.setEntryEnabled(entry, false));
      return;
    }

    this.root.setEnabled(true);
    for (const entry of this.entries) {
      this.setEntryEnabled(entry, this.isEntryAllowed(entry));
    }
    this.applySelectionState();
  }

  isEntryAllowed(entry) {
    return !(this.altitudeMode && isShelfLabel(entry.item));
  }

  isSelectedFamilyPrimary(entry) {
    return Boolean(
      this.altitudeMode
      && this.selectedFamilyKey
      && entry.item.labelGroup === "airfield"
      && entry.item.familyKey === this.selectedFamilyKey,
    );
  }

  setEntryEnabled(entry, enabled) {
    entry.root.setEnabled(enabled);
    entry.plane.isPickable = Boolean(enabled);
  }

  applySelectionState() {
    for (const entry of this.entries) {
      const isSelected = (entry.item.selectionId ?? entry.item.id) === this.selectedSelectionId;
      const isHovered = entry.item.id === this.hoveredItemId;
      entry.plane.renderingGroupId = isSelected ? 3 : isHovered ? 2 : 1;
      entry.plane.position.y = entry.baseElevation + (isSelected ? AIRSPACE_LABEL_SELECTION_LIFT : 0);
      if (entry.selectionBorder) {
        entry.selectionBorder.position.y = entry.plane.position.y + (isAirspaceLayer(this.definition) ? 0.002 : 0.0015);
        entry.selectionBorder.setEnabled(isSelected);
        entry.selectionBorder.renderingGroupId = isSelected ? 3 : 1;
      }
      entry.plane.scaling.setAll(isHovered ? 1.08 : isSelected ? 1.04 : 1);
      entry.material.emissiveColor.set(isHovered ? 0.2 : 1, 1, isHovered ? 0.35 : 1);
      entry.material.alpha = isSelected || isHovered ? 1 : 0.98;
      entry.material.zOffset = isSelected ? -6 : isHovered ? -4 : -1;
    }
  }

  dispose() {
    if (this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
      this.beforeRenderObserver = null;
    }
    for (const entry of this.entries) {
      entry.material?.dispose(false, true);
      entry.texture?.dispose();
      entry.selectionBorderMaterial?.dispose(false, true);
      entry.selectionBorderTexture?.dispose();
      for (const mesh of entry.meshes) {
        mesh?.dispose(false, true);
      }
      entry.root?.dispose(false, true);
    }
    this.root?.dispose(false, true);
    this.entries = [];
  }
}

function fixedLabelQuaternion() {
  return BABYLON.Quaternion.RotationYawPitchRoll(
    LABEL_FIXED_YAW_RADIANS,
    LABEL_TILT_RADIANS,
    LABEL_ROLL_RADIANS,
  );
}

function resolveFinalLabelAnchor(sectionMetrics, definition, item) {
  const pixelX = Number(item.x);
  const pixelY = Number(item.y);
  const elevation = isAirspaceLayer(definition) ? AIRSPACE_LABEL_BASE_ELEVATION : 0.08 + (item.elevation ?? 0.02);
  return {
    source: "label-json-x-y",
    pixelX,
    pixelY,
    elevation,
    worldPoint: pixelsToWorldPoint(sectionMetrics, pixelX, pixelY, elevation),
  };
}

function isShelfLabel(item) {
  return item?.labelGroup === "shelf" || item?.detailTier === "detail";
}
