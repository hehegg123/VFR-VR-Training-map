import { pixelsToWorldPoint } from "./geometry/projector.js";

const LABEL_TILT_RADIANS = Math.PI / 2 - 0.5;
const LABEL_ROLL_RADIANS = Math.PI;
const LABEL_FIXED_YAW_RADIANS = 0;
const AIRSPACE_LABEL_PITCH_RADIANS = Math.PI / 2 - 0.35;
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
    height: 94,
    scale: 0.48,
  },
  "navaid-dme": {
    fill: "#0e5560",
    border: "#67e8f9",
    text: "#ecfeff",
    width: 252,
    height: 90,
    scale: 0.46,
  },
  "navaid-ndb": {
    fill: "#1f5f67",
    border: "#99f6e4",
    text: "#ecfeff",
    width: 252,
    height: 90,
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

function labelHitTargetScale(definition) {
  return isAirspaceLayer(definition)
    ? { width: 1.16, height: 1.22, yOffset: -0.002 }
    : { width: 1.12, height: 1.16, yOffset: -0.0015 };
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

function airspaceTypeForItem(item) {
  if (item.airspaceType) {
    return item.airspaceType;
  }
  const match = item.id?.match(/-CLASS_(E[2345]|[BCD])/);
  return match ? `CLASS_${match[1]}` : null;
}

function airspaceLabelGroup(item) {
  if (item.labelGroup) {
    return item.labelGroup;
  }
  if (typeof item.id === "string" && item.id.startsWith("special-")) {
    return "special";
  }
  if (typeof item.id === "string" && item.id.startsWith("shelf-")) {
    return "shelf";
  }
  return airspaceTypeForItem(item) ? "airfield" : "other";
}

function airspaceFamilyKeyForItem(item) {
  if (item.familyKey) {
    return item.familyKey;
  }

  if (typeof item.selectionId === "string" && item.selectionId.includes("-CLASS_")) {
    return item.selectionId;
  }

  const title = item.lines?.[0] ?? item.text ?? "";
  const match = title.match(/^([A-Z0-9]+)\s+([BCD])(?:\s+AREA\b|$)/);
  if (match) {
    return `${match[1]}-CLASS_${match[2]}`;
  }

  return null;
}

function isSpecialAirspaceItem(item) {
  return airspaceLabelGroup(item) === "special";
}

function isControlledAirspaceItem(item) {
  if (airspaceLabelGroup(item) !== "airfield") {
    return false;
  }
  const airspaceType = airspaceTypeForItem(item);
  return airspaceType && airspaceType !== "CLASS_E3" && airspaceType !== "CLASS_E5";
}

function isClassEDetailItem(item) {
  if (airspaceLabelGroup(item) !== "airfield") {
    return false;
  }
  const airspaceType = airspaceTypeForItem(item);
  return airspaceType === "CLASS_E3" || airspaceType === "CLASS_E5";
}

function isShelfItem(item) {
  return airspaceLabelGroup(item) === "shelf";
}

function isMajorShelfItem(item) {
  return isShelfItem(item) && ["CLASS_B", "CLASS_C"].includes(item.airspaceType);
}

function isCoreClassEDetailItem(item) {
  return isClassEDetailItem(item) && item.detailTier !== "extended";
}

function isExtendedClassEDetailItem(item) {
  return isClassEDetailItem(item) && item.detailTier === "extended";
}

function isCalloutItem(item) {
  return Boolean(item.connector);
}

function selectDistributedAirspaceDetails(items, limit, sectionMetrics) {
  if (limit <= 0 || items.length === 0) {
    return [];
  }

  const cols = 6;
  const rows = 4;
  const buckets = new Map();
  for (const item of items) {
    const col = Math.max(0, Math.min(cols - 1, Math.floor((item.x / sectionMetrics.pixelWidth) * cols)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor((item.y / sectionMetrics.pixelHeight) * rows)));
    const key = `${col}:${row}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(item);
  }

  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  }

  const orderedKeys = [...buckets.keys()].sort((left, right) => {
    const [leftCol, leftRow] = left.split(":").map(Number);
    const [rightCol, rightRow] = right.split(":").map(Number);
    return leftRow - rightRow || leftCol - rightCol;
  });

  const selected = [];
  let round = 0;
  while (selected.length < limit) {
    let progressed = false;
    for (const key of orderedKeys) {
      const bucket = buckets.get(key);
      if (round < bucket.length) {
        selected.push(bucket[round]);
        progressed = true;
        if (selected.length >= limit) {
          break;
        }
      }
    }
    if (!progressed) {
      break;
    }
    round += 1;
  }
  return selected;
}

function computeEffectiveAirspaceLimit(definition, viewState, itemCount) {
  const baseLimit = definition.maxVisibleLabels ?? itemCount;
  const extendedLimit = definition.extendedMaxVisibleLabels ?? itemCount;
  let visibleLabels = baseLimit;
  let includeExtended = false;

  const radius = viewState?.cameraRadius;
  if (Number.isFinite(radius)) {
    const thresholds = [...(definition.zoomLabelThresholds ?? [])].sort((left, right) => right.radius - left.radius);
    for (const threshold of thresholds) {
      if (radius <= threshold.radius) {
        visibleLabels = Math.max(visibleLabels, threshold.visibleLabels ?? baseLimit);
        includeExtended = includeExtended || Boolean(threshold.includeExtended);
      }
    }
  }

  return {
    limit: Math.min(itemCount, Math.min(extendedLimit, Math.max(baseLimit, visibleLabels))),
    includeExtended,
  };
}

function shelfRepresentativeTitle(item) {
  return item.lines?.[0] ?? item.text ?? item.id;
}

function shelfRepresentativeOrder(item) {
  const title = shelfRepresentativeTitle(item);
  const areaMatch = title.match(/\bAREA\s+([A-Z0-9]+)/);
  if (areaMatch) {
    const token = areaMatch[1];
    if (/^\d+$/.test(token)) {
      return Number(token);
    }
    return token.charCodeAt(0);
  }
  return Number.MAX_SAFE_INTEGER;
}

function selectRepresentativeShelves(items, limit) {
  if (limit <= 0 || items.length === 0) {
    return [];
  }

  const representativeByKey = new Map();
  for (const item of items) {
    const key = `${item.familyKey ?? item.selectionId ?? item.id}::${shelfRepresentativeTitle(item)}`;
    const existing = representativeByKey.get(key);
    if (!existing || (item.priority ?? 0) > (existing.priority ?? 0)) {
      representativeByKey.set(key, item);
    }
  }

  const families = new Map();
  for (const item of representativeByKey.values()) {
    const familyKey = item.familyKey ?? item.selectionId ?? item.id;
    if (!families.has(familyKey)) {
      families.set(familyKey, []);
    }
    families.get(familyKey).push(item);
  }

  for (const itemsForFamily of families.values()) {
    itemsForFamily.sort((left, right) =>
      shelfRepresentativeOrder(left) - shelfRepresentativeOrder(right)
      || (right.priority ?? 0) - (left.priority ?? 0)
      || shelfRepresentativeTitle(left).localeCompare(shelfRepresentativeTitle(right))
    );
  }

  const orderedFamilies = [...families.entries()].sort((left, right) => {
    const leftType = left[1][0]?.airspaceType ?? "";
    const rightType = right[1][0]?.airspaceType ?? "";
    const leftWeight = leftType === "CLASS_B" ? 0 : leftType === "CLASS_C" ? 1 : 2;
    const rightWeight = rightType === "CLASS_B" ? 0 : rightType === "CLASS_C" ? 1 : 2;
    return leftWeight - rightWeight || left[0].localeCompare(right[0]);
  });

  const selected = [];
  let round = 0;
  while (selected.length < limit) {
    let progressed = false;
    for (const [, itemsForFamily] of orderedFamilies) {
      if (round < itemsForFamily.length) {
        selected.push(itemsForFamily[round]);
        progressed = true;
        if (selected.length >= limit) {
          break;
        }
      }
    }
    if (!progressed) {
      break;
    }
    round += 1;
  }

  return selected;
}

function selectVisibleItems(items, definition, sectionMetrics, viewState) {
  const defaultLimit = definition.maxVisibleLabels ?? items.length;
  const sorted = [...items].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  if (definition.id !== "airspace") {
    return {
      items: sorted.slice(0, defaultLimit),
      includeExtended: false,
    };
  }

  const { limit, includeExtended } = computeEffectiveAirspaceLimit(definition, viewState, sorted.length);
  const special = sorted.filter((item) => isSpecialAirspaceItem(item));
  const controlled = sorted.filter((item) => isControlledAirspaceItem(item));
  const coreEDetail = sorted.filter((item) => isCoreClassEDetailItem(item));
  const extendedEDetail = sorted.filter((item) => isExtendedClassEDetailItem(item));
  const activeEDetail = includeExtended ? [...coreEDetail, ...extendedEDetail] : coreEDetail;
  const eCallouts = activeEDetail.filter((item) => isCalloutItem(item));
  const eSurface = activeEDetail.filter((item) => !isCalloutItem(item));
  const shelves = sorted.filter((item) => isShelfItem(item));
  const majorShelves = shelves.filter((item) => isMajorShelfItem(item));
  const minorShelves = shelves.filter((item) => !isMajorShelfItem(item));
  const remainder = sorted.filter(
    (item) =>
      !isSpecialAirspaceItem(item)
      && !isControlledAirspaceItem(item)
      && !isClassEDetailItem(item)
      && !isShelfItem(item),
  );

  const selected = [];
  const seen = new Set();
  const pushUnique = (item) => {
    if (!seen.has(item.id) && selected.length < limit) {
      seen.add(item.id);
      selected.push(item);
    }
  };

  for (const item of [...special, ...controlled]) {
    pushUnique(item);
  }

  const remainingAfterControlled = Math.max(0, limit - selected.length);
  const majorShelfBudget = Math.min(
    majorShelves.length,
    Math.max(
      includeExtended ? 18 : 12,
      Math.min(includeExtended ? 28 : 18, Math.floor(remainingAfterControlled * (includeExtended ? 0.32 : 0.28))),
    ),
  );
  const representativeMajorShelves = selectRepresentativeShelves(majorShelves, majorShelfBudget);
  for (const item of representativeMajorShelves) {
    pushUnique(item);
  }

  const calloutBudgetCap = includeExtended ? 34 : 18;
  const calloutBudgetFloor = includeExtended ? 12 : 8;
  const calloutBudget = Math.min(
    eCallouts.length,
    Math.max(calloutBudgetFloor, Math.min(calloutBudgetCap, Math.floor((limit - selected.length) * 0.4))),
  );
  for (const item of eCallouts.slice(0, calloutBudget)) {
    pushUnique(item);
  }

  const remainingBudget = Math.max(0, limit - selected.length);
  const distributedE = selectDistributedAirspaceDetails(eSurface, remainingBudget, sectionMetrics);
  for (const item of distributedE) {
    pushUnique(item);
  }

  for (const item of [...minorShelves, ...majorShelves, ...eCallouts.slice(calloutBudget), ...eSurface, ...remainder]) {
    pushUnique(item);
  }

  return {
    items: selected,
    includeExtended,
  };
}

function labelFootprintInChartPixels(style, sectionMetrics) {
  const worldWidth = style.scale;
  const worldHeight = style.scale * (style.height / style.width);
  return {
    widthPx: (worldWidth / sectionMetrics.worldWidth) * sectionMetrics.pixelWidth,
    heightPx: (worldHeight / sectionMetrics.worldHeight) * sectionMetrics.pixelHeight,
  };
}

function airspaceLabelBounds(item, sectionMetrics) {
  const style = pickLabelStyle(item.style);
  const footprint = labelFootprintInChartPixels(style, sectionMetrics);
  const widthPx = footprint.widthPx * 0.92;
  const heightPx = footprint.heightPx * 0.86;
  return {
    x0: item.x - widthPx / 2,
    y0: item.y - heightPx / 2,
    x1: item.x + widthPx / 2,
    y1: item.y + heightPx / 2,
  };
}

function boundsOverlapArea(left, right) {
  const x0 = Math.max(left.x0, right.x0);
  const y0 = Math.max(left.y0, right.y0);
  const x1 = Math.min(left.x1, right.x1);
  const y1 = Math.min(left.y1, right.y1);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function pruneAirspaceLabelCollisions(
  items,
  sectionMetrics,
  forcedSelectionId = null,
  includeExtended = false,
  forcedFamilyKey = null,
) {
  const overlapThreshold = includeExtended ? 0.5 : 0.18;
  const sorted = [...items].sort((left, right) => {
    const leftForced = left.selectionId === forcedSelectionId ? 1 : 0;
    const rightForced = right.selectionId === forcedSelectionId ? 1 : 0;
    const leftFamily = forcedFamilyKey && airspaceFamilyKeyForItem(left) === forcedFamilyKey ? 1 : 0;
    const rightFamily = forcedFamilyKey && airspaceFamilyKeyForItem(right) === forcedFamilyKey ? 1 : 0;
    const leftExtendedAirfieldBoost = includeExtended && isClassEDetailItem(left) ? 1 : 0;
    const rightExtendedAirfieldBoost = includeExtended && isClassEDetailItem(right) ? 1 : 0;
    return rightForced - leftForced
      || rightFamily - leftFamily
      || rightExtendedAirfieldBoost - leftExtendedAirfieldBoost
      || (right.priority ?? 0) - (left.priority ?? 0);
  });

  const accepted = [];
  const acceptedBounds = [];
  for (const item of sorted) {
    const bounds = airspaceLabelBounds(item, sectionMetrics);
    const itemArea = Math.max(1, (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0));
    let blocked = false;
    for (const otherBounds of acceptedBounds) {
      const overlap = boundsOverlapArea(bounds, otherBounds);
      if (overlap / itemArea > overlapThreshold) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      continue;
    }
    accepted.push(item);
    acceptedBounds.push(bounds);
  }

  return accepted;
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
    this.options = {};
    this.viewState = {
      cameraRadius: null,
    };
    this.selectedSelectionId = null;
    this.focusedLabel = null;
    this.entryBySelectionId = new Map();
    this.beforeRenderObserver = null;
  }

  async load() {
    this.root = new BABYLON.TransformNode(`label-root-${this.definition.id}`, this.scene);
    this.root.parent = this.parent;

    const items = this.labelPayload.items ?? [];
    for (const item of items) {
      const point = pixelsToWorldPoint(
        this.sectionMetrics,
        item.x,
        item.y,
        isAirspaceLayer(this.definition) ? AIRSPACE_LABEL_BASE_ELEVATION : 0.08 + (item.elevation ?? 0.02),
      );
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
      plane.position = point;
      plane.rotationQuaternion = isAirspaceLayer(this.definition)
        ? airspaceFixedLabelQuaternion()
        : fixedLabelQuaternion();
      plane.isPickable = true;
      plane.material = material;
      plane.metadata = {
        interactiveLayerId: this.definition.id,
        interactiveRole: "label",
        itemId: item.id,
        labelText: (item.lines?.length ? item.lines.join(" / ") : item.text) ?? item.id,
        selectionId: item.selectionId ?? item.id,
      };

      const hitScale = labelHitTargetScale(this.definition);
      const hitTarget = BABYLON.MeshBuilder.CreatePlane(
        `label-hit-${this.definition.id}-${item.id}`,
        { width: labelWidth * hitScale.width, height: labelHeight * hitScale.height },
        this.scene,
      );
      hitTarget.parent = entryRoot;
      hitTarget.position = point.clone();
      hitTarget.position.y += hitScale.yOffset;
      hitTarget.rotationQuaternion = plane.rotationQuaternion.clone();
      hitTarget.isPickable = true;
      hitTarget.visibility = 1;
      hitTarget.material = this.createHitTargetMaterial(item);
      hitTarget.metadata = {
        interactiveLayerId: this.definition.id,
        interactiveRole: "label-proxy",
        itemId: item.id,
        labelText: (item.lines?.length ? item.lines.join(" / ") : item.text) ?? item.id,
        selectionId: item.selectionId ?? item.id,
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
        meshes: [plane, hitTarget, selectionBorder],
        plane,
        hitTarget,
        selectionBorder,
        point,
        baseElevation: point.y,
        material,
        texture,
        hitTargetMaterial: hitTarget.material,
        selectionBorderMaterial,
        selectionBorderTexture,
      };
      this.entryBySelectionId.set(item.selectionId ?? item.id, entry);

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

  createHitTargetMaterial(item) {
    const material = new BABYLON.StandardMaterial(`label-hit-material-${item.id}`, this.scene);
    material.diffuseColor = BABYLON.Color3.Black();
    material.emissiveColor = BABYLON.Color3.Black();
    material.specularColor = BABYLON.Color3.Black();
    material.alpha = 0.001;
    material.backFaceCulling = false;
    material.disableLighting = true;
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

  setOptions(options = {}) {
    this.options = {
      ...this.options,
      ...options,
    };
    this.refreshVisibility();
  }

  setViewState(viewState = {}) {
    this.viewState = {
      ...this.viewState,
      ...viewState,
    };
    this.refreshVisibility();
  }

  setSelection(selectionId) {
    this.selectedSelectionId = selectionId;
    this.refreshVisibility();
  }

  setFocusedLabel(focusedLabel) {
    this.focusedLabel = focusedLabel;
    this.refreshVisibility();
  }

  refreshVisibility() {
    if (!this.root) {
      return;
    }

    if (!this.layerActive) {
      this.root.setEnabled(false);
      return;
    }

    const hasFocusedLabel = Boolean(this.focusedLabel?.layerId && this.focusedLabel?.itemId);
    if (hasFocusedLabel) {
      const sameLayerFocus = this.focusedLabel.layerId === this.definition.id;
      this.root.setEnabled(sameLayerFocus || Boolean(this.selectedSelectionId));
      for (const entry of this.entries) {
        const isSelected = (entry.item.selectionId ?? entry.item.id) === this.selectedSelectionId;
        const isFocusedItem = sameLayerFocus && entry.item.id === this.focusedLabel.itemId;
        entry.root.setEnabled(isFocusedItem || isSelected);
      }
      this.applySelectionState();
      return;
    }

    if (this.selectedSelectionId) {
      this.root.setEnabled(true);
      for (const entry of this.entries) {
        const isSelected = (entry.item.selectionId ?? entry.item.id) === this.selectedSelectionId;
        entry.root.setEnabled(isSelected);
      }
      this.applySelectionState();
      return;
    }

    if (!this.labelsVisible) {
      this.root.setEnabled(false);
      return;
    }

    const items = this.labelPayload.items ?? [];
    const selectionState = selectVisibleItems(items, this.definition, this.sectionMetrics, this.viewState);
    let visibleItems = selectionState.items;
    if (isAirspaceLayer(this.definition)) {
      visibleItems = pruneAirspaceLabelCollisions(
        visibleItems,
        this.sectionMetrics,
        this.selectedSelectionId,
        selectionState.includeExtended,
        null,
      );
    }
    const visibleIds = new Set(visibleItems.map((item) => item.id));

    this.root.setEnabled(this.labelsVisible);
    for (const entry of this.entries) {
      entry.root.setEnabled(visibleIds.has(entry.item.id));
    }
    this.applySelectionState();
  }

  applySelectionState() {
    for (const entry of this.entries) {
      const isSelected = (entry.item.selectionId ?? entry.item.id) === this.selectedSelectionId;
      entry.plane.renderingGroupId = isSelected ? 3 : 1;
      entry.plane.position.y = entry.baseElevation + (isSelected ? AIRSPACE_LABEL_SELECTION_LIFT : 0);
      if (entry.selectionBorder) {
        entry.selectionBorder.position.y = entry.plane.position.y + (isAirspaceLayer(this.definition) ? 0.002 : 0.0015);
        entry.selectionBorder.setEnabled(isSelected);
        entry.selectionBorder.renderingGroupId = isSelected ? 3 : 1;
      }
      if (entry.hitTarget) {
        entry.hitTarget.position.y = entry.plane.position.y + labelHitTargetScale(this.definition).yOffset;
      }
      entry.plane.scaling.setAll(isSelected ? 1.04 : 1);
      entry.material.alpha = isSelected ? 1 : 0.98;
      entry.material.zOffset = isSelected ? -6 : -1;
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
      entry.hitTargetMaterial?.dispose(false, true);
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

function airspaceFixedLabelQuaternion() {
  return BABYLON.Quaternion.RotationYawPitchRoll(
    LABEL_FIXED_YAW_RADIANS,
    AIRSPACE_LABEL_PITCH_RADIANS,
    LABEL_ROLL_RADIANS,
  );
}
