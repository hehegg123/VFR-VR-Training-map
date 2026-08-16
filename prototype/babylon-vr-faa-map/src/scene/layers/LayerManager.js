import { resolveSectionAsset } from "../../data/sectionRepository.js";
import {
  createFeatureSelection,
  createLabelSelection,
} from "../../../../shared/selectionContract.js";
import { RasterLayer } from "./RasterLayer.js";
import { TiledRasterLayer } from "./TiledRasterLayer.js";
import { VectorOverlayLayer } from "./VectorOverlayLayer.js?v=20260514-feature-highlight-v1";
import { AirspaceAltitudeOverlay } from "./AirspaceAltitudeOverlay.js?v=20260712-event-altitude-v1";
import { EventOverlayLayer } from "./EventOverlayLayer.js";
import { VrLabelLayer } from "./VrLabelLayer.js?v=20260618-airspace-picking-v1";

export class LayerManager {
  constructor(scene, mapRoot) {
    this.scene = scene;
    this.mapRoot = mapRoot;
    this.layers = new Map();
    this.boardMesh = null;
    this.boardMaterial = null;
    this.sectionMetrics = null;
    this.currentManifest = null;
    this.currentSectionId = null;
    this.layerInteractionState = new Map();
    this.airspaceAltitudeEnabled = false;
    this.airspaceAltitudeOverlay = null;
    this.eventOverlayLayer = null;
    this.selectedAirspaceId = null;
    this.airspaceRegionById = new Map();
    this.selectedLabel = null;
    this.currentSelection = null;
    this.hoveredLabel = null;
    this.onAirspaceSelectionChange = null;
    this.onSelectionChange = null;
    this.pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERMOVE) {
        this.updateHoveredLabel(this.resolvePriorityInteractionMetadata(pointerInfo.pickInfo));
        return;
      }
      if (pointerInfo.type !== BABYLON.PointerEventTypes.POINTERPICK) {
        return;
      }
      const metadata = this.resolvePriorityInteractionMetadata(pointerInfo.pickInfo);
      if (metadata?.interactiveLayerId) {
        this.handleInteractionMetadata(metadata);
        return;
      }
      this.clearSelections();
    });
  }

  async loadSection(manifest) {
    this.dispose();
    this.currentManifest = manifest;
    this.currentSectionId = manifest.id;
    this.layerInteractionState.clear();

    this.sectionMetrics = {
      pixelWidth: manifest.chart.pixelWidth,
      pixelHeight: manifest.chart.pixelHeight,
      worldWidth: manifest.world?.widthUnits ?? 12,
    };
    this.sectionMetrics.worldHeight =
      this.sectionMetrics.worldWidth * (this.sectionMetrics.pixelHeight / this.sectionMetrics.pixelWidth);

    this.createBoard();

    for (const [index, layerDef] of manifest.layers.entries()) {
      const hydrated = this.hydrateLayerDefinition(manifest, layerDef);
      const renderLayer = await this.createRenderLayer(hydrated, index);

      let labelLayer = null;
      if (layerDef.labelData) {
        const response = await fetch(resolveSectionAsset(manifest, layerDef.labelData), { cache: "no-store" });
        const labelPayload = await response.json();
        labelLayer = new VrLabelLayer(this.scene, this.mapRoot, hydrated, this.sectionMetrics, labelPayload);
        await labelLayer.load();
      }

      const defaultLayerVisible = layerDef.defaultVisible !== false;
      const defaultLabelsVisible = Boolean(layerDef.labelData) && layerDef.defaultLabels !== false;
      this.layerInteractionState.set(layerDef.id, {
        layerVisible: defaultLayerVisible,
        labelsVisible: defaultLabelsVisible,
      });
      labelLayer?.setLayerActive(defaultLayerVisible);
      labelLayer?.setVisible(defaultLabelsVisible);
      if (layerDef.id === "airspace") {
        labelLayer?.setAltitudeMode(this.airspaceAltitudeEnabled);
      }

      this.layers.set(layerDef.id, { definition: hydrated, renderLayer, labelLayer });

      if (layerDef.id === "airspace" && renderLayer?.overlayPayload?.interactionRegions?.length) {
        this.airspaceRegionById = new Map(
          renderLayer.overlayPayload.interactionRegions.map((region) => [region.id, region]),
        );
        this.airspaceAltitudeOverlay = new AirspaceAltitudeOverlay(
          this.scene,
          this.mapRoot,
          this.sectionMetrics,
          hydrated.altitudeVolume ?? {},
        );
        this.airspaceAltitudeOverlay.setRegions(renderLayer.overlayPayload.interactionRegions ?? []);
        this.airspaceAltitudeOverlay.setLayerVisible(layerDef.defaultVisible !== false);
        this.airspaceAltitudeOverlay.setEnabled(this.airspaceAltitudeEnabled);
      }
    }
    this.eventOverlayLayer = new EventOverlayLayer(
      this.scene,
      this.mapRoot,
      this.sectionMetrics,
      (target) => this.resolveSelectionChartPoint(target),
      manifest.layers.find((layer) => layer.id === "airspace")?.altitudeVolume ?? {},
    );
    this.clearSelections();
  }

  hydrateLayerDefinition(manifest, layerDef) {
    const hydrated = { ...layerDef };
    if (layerDef.texture) {
      hydrated.textureUrl = resolveSectionAsset(manifest, layerDef.texture);
    }
    if (layerDef.tilePyramid) {
      hydrated.tilePyramid = {
        ...layerDef.tilePyramid,
        levels: (layerDef.tilePyramid.levels ?? []).map((level) => ({
          ...level,
          tiles: (level.tiles ?? []).map((tile) => ({
            ...tile,
            url: resolveSectionAsset(manifest, tile.url),
          })),
        })),
      };
    }
    if (layerDef.overlayData) {
      hydrated.overlayUrl = resolveSectionAsset(manifest, layerDef.overlayData);
    }
    return hydrated;
  }

  async createRenderLayer(layerDef, index) {
    if (layerDef.renderMode === "vector") {
      const response = await fetch(layerDef.overlayUrl, { cache: "no-store" });
      const overlayPayload = await response.json();
      const vectorLayer = new VectorOverlayLayer(
        this.scene,
        this.mapRoot,
        layerDef,
        this.sectionMetrics,
        overlayPayload,
        index,
      );
      await vectorLayer.load();
      return vectorLayer;
    }

    if (layerDef.renderMode === "raster-pyramid") {
      const tiledRasterLayer = new TiledRasterLayer(
        this.scene,
        this.mapRoot,
        layerDef,
        this.sectionMetrics,
        index,
      );
      await tiledRasterLayer.load();
      return tiledRasterLayer;
    }

    const rasterLayer = new RasterLayer(
      this.scene,
      this.mapRoot,
      layerDef,
      this.sectionMetrics,
      index,
    );
    await rasterLayer.load();
    return rasterLayer;
  }

  createBoard() {
    this.boardMesh = BABYLON.MeshBuilder.CreateGround(
      "map-board",
      {
        width: this.sectionMetrics.worldWidth + 0.45,
        height: this.sectionMetrics.worldHeight + 0.45,
      },
      this.scene,
    );
    this.boardMesh.parent = this.mapRoot;
    this.boardMesh.position.y = -0.05;
    this.boardMesh.isPickable = false;

    this.boardMaterial = new BABYLON.StandardMaterial("map-board-material", this.scene);
    this.boardMaterial.diffuseColor = new BABYLON.Color3(0.14, 0.18, 0.24);
    this.boardMaterial.specularColor = BABYLON.Color3.Black();
    this.boardMesh.material = this.boardMaterial;
  }

  setLayerVisible(layerId, visible) {
    const nextState = {
      ...(this.layerInteractionState.get(layerId) ?? {}),
      layerVisible: Boolean(visible),
    };
    this.layerInteractionState.set(layerId, nextState);
    this.layers.get(layerId)?.renderLayer.setVisible(visible);
    this.layers.get(layerId)?.labelLayer?.setLayerActive(visible);
    if (layerId === "airspace") {
      this.airspaceAltitudeOverlay?.setLayerVisible(visible);
    }
    if (!visible) {
      if (this.selectedAirspaceId && layerId === "airspace") {
        this.clearAirspaceSelection({ suppressNotify: true });
      }
      if (this.selectedLabel?.layerId === layerId) {
        this.clearLabelSelection({ suppressNotify: true });
      }
      this.notifySelectionChange(null);
    }
  }

  setLabelVisible(layerId, visible) {
    const nextState = {
      ...(this.layerInteractionState.get(layerId) ?? {}),
      labelsVisible: Boolean(visible),
    };
    this.layerInteractionState.set(layerId, nextState);
    this.layers.get(layerId)?.labelLayer?.setVisible(visible);
  }

  setAirspaceSelection(selectionId, options = {}) {
    if (this.selectedAirspaceId === selectionId) {
      return;
    }
    if (selectionId && !options.preserveLabelSelection) {
      this.clearLabelSelection({ suppressNotify: true });
    }
    this.selectedAirspaceId = selectionId;
    this.syncAirspaceSelectionVisualState();
    this.onAirspaceSelectionChange?.(selectionId);
    if (!options.suppressNotify) {
      this.notifySelectionChange(selectionId
        ? createFeatureSelection({
            sectionId: this.currentSectionId,
            layerId: "airspace",
            featureId: selectionId,
            label: selectionId,
          })
        : null);
    }
  }

  clearAirspaceSelection(options = {}) {
    this.setAirspaceSelection(null, options);
  }

  setAirspaceLinkedLabelSelection(layerId, itemId, metadata = null, options = {}) {
    const nextSelection = layerId && itemId ? { layerId, itemId, label: metadata?.labelText ?? itemId } : null;
    const nextAirspaceId = metadata?.selectionId ?? itemId;
    const sameLabel =
      this.selectedLabel?.layerId === nextSelection?.layerId
      && this.selectedLabel?.itemId === nextSelection?.itemId;
    const sameAirspace = this.selectedAirspaceId === nextAirspaceId;
    if (sameLabel && sameAirspace) {
      return;
    }

    this.selectedLabel = nextSelection;
    this.selectedAirspaceId = nextAirspaceId;
    this.syncAirspaceSelectionVisualState(nextSelection);
    this.onAirspaceSelectionChange?.(nextAirspaceId);

    if (!options.suppressNotify) {
      this.notifySelectionChange(nextSelection
        ? createLabelSelection({
            sectionId: this.currentSectionId,
            layerId,
            labelId: itemId,
            featureId: nextAirspaceId,
            label: nextSelection.label,
          })
        : null);
    }
  }

  setLabelSelection(layerId, itemId, metadata = null, options = {}) {
    const nextSelection = layerId && itemId ? { layerId, itemId, label: metadata?.labelText ?? itemId } : null;
    if (
      this.selectedLabel?.layerId === nextSelection?.layerId
      && this.selectedLabel?.itemId === nextSelection?.itemId
    ) {
      return;
    }

    if (nextSelection && layerId === "airspace" && metadata?.selectionId) {
      this.setAirspaceLinkedLabelSelection(layerId, itemId, metadata, options);
      return;
    }

    if (nextSelection) {
      this.clearAirspaceSelection({ suppressNotify: true });
    }

    this.selectedLabel = nextSelection;
    for (const [currentLayerId, layer] of this.layers.entries()) {
      layer.labelLayer?.setSelection(currentLayerId === layerId ? (metadata?.selectionId ?? itemId) : null);
      layer.labelLayer?.setFocusedLabel(nextSelection);
    }

    if (!options.suppressNotify) {
      this.notifySelectionChange(nextSelection
        ? createLabelSelection({
            sectionId: this.currentSectionId,
            layerId,
            labelId: itemId,
            featureId: metadata?.selectionId ?? itemId,
            label: nextSelection.label,
          })
        : null);
    }
  }

  clearLabelSelection(options = {}) {
    if (!this.selectedLabel) {
      if (!options.suppressNotify) {
        this.notifySelectionChange(null);
      }
      return;
    }
    this.selectedLabel = null;
    for (const layer of this.layers.values()) {
      layer.labelLayer?.setSelection(null);
      layer.labelLayer?.setFocusedLabel(null);
    }
    if (!options.suppressNotify) {
      this.notifySelectionChange(null);
    }
  }

  clearSelections() {
    this.clearAirspaceSelection({ suppressNotify: true });
    this.clearLabelSelection({ suppressNotify: true });
    this.notifySelectionChange(null);
  }

  setAirspaceAltitudeMode(enabled) {
    this.airspaceAltitudeEnabled = Boolean(enabled);
    this.airspaceAltitudeOverlay?.setEnabled(this.airspaceAltitudeEnabled);
    this.layers.get("airspace")?.labelLayer?.setAltitudeMode(this.airspaceAltitudeEnabled);
    this.updateHoveredLabel(null);
    this.syncAirspaceSelectionVisualState();
  }

  applySelection(selection, options = {}) {
    if (!selection || selection.sectionId !== this.currentSectionId) {
      this.clearSelections();
      return;
    }

    if (selection.kind === "feature" && selection.layerId === "airspace" && selection.featureId) {
      this.setAirspaceSelection(selection.featureId, { suppressNotify: options.suppressNotify ?? true });
      return;
    }

    if (selection.kind === "label" && selection.layerId && selection.labelId) {
      if (selection.layerId === "airspace" && (selection.featureId ?? selection.labelId)) {
        this.setAirspaceLinkedLabelSelection(
          selection.layerId,
          selection.labelId,
          {
            labelText: selection.label,
            selectionId: selection.featureId ?? selection.labelId,
          },
          { suppressNotify: options.suppressNotify ?? true },
        );
        return;
      }
      this.setLabelSelection(
        selection.layerId,
        selection.labelId,
        {
          labelText: selection.label,
          selectionId: selection.featureId ?? selection.labelId,
        },
        { suppressNotify: options.suppressNotify ?? true },
      );
      return;
    }

    if (selection.kind === "feature" && selection.layerId && selection.featureId) {
      this.setLabelSelection(
        selection.layerId,
        selection.featureId,
        {
          labelText: selection.label,
          selectionId: selection.featureId,
        },
        { suppressNotify: options.suppressNotify ?? true },
      );
      return;
    }

    this.clearSelections();
  }

  handleInteractionMetadata(metadata) {
    const interactionState = this.layerInteractionState.get(metadata.interactiveLayerId);
    if (!interactionState?.layerVisible) {
      this.clearSelections();
      return;
    }

    if (
      metadata.interactiveRole === "label"
      && metadata.interactiveLayerId
      && metadata.itemId
    ) {
      this.setLabelSelection(metadata.interactiveLayerId, metadata.itemId, metadata);
      return;
    }
    if (metadata.interactiveLayerId === "airspace" && metadata.selectionId) {
      this.setAirspaceSelection(metadata.selectionId);
      return;
    }
    this.clearSelections();
  }

  notifySelectionChange(payload) {
    this.currentSelection = payload;
    this.onSelectionChange?.(payload);
  }

  updateHoveredLabel(metadata) {
    const interactionState = metadata?.interactiveLayerId
      ? this.layerInteractionState.get(metadata.interactiveLayerId)
      : null;
    const nextHoveredLabel =
      metadata?.interactiveRole === "label"
      && metadata.interactiveLayerId
      && metadata.itemId
      && interactionState?.layerVisible
        ? {
            layerId: metadata.interactiveLayerId,
            itemId: metadata.itemId,
          }
        : null;

    if (
      this.hoveredLabel?.layerId === nextHoveredLabel?.layerId
      && this.hoveredLabel?.itemId === nextHoveredLabel?.itemId
    ) {
      return;
    }

    this.hoveredLabel = nextHoveredLabel;
    for (const [layerId, layer] of this.layers.entries()) {
      layer.labelLayer?.setHoveredLabel(layerId === nextHoveredLabel?.layerId ? nextHoveredLabel.itemId : null);
    }
  }

  getSectionMetrics() {
    return this.sectionMetrics;
  }

  getSelection() {
    return this.currentSelection;
  }

  setEventSnapshot(snapshot) {
    this.eventOverlayLayer?.setSnapshot(snapshot);
  }

  resolveSelectionChartPoint(target) {
    if (!target?.layerId || !target?.selectionId) {
      return null;
    }
    const layer = this.layers.get(target.layerId);
    const labelItem = layer?.labelLayer?.labelPayload?.items?.find((item) =>
      item.id === target.selectionId || (item.selectionId ?? item.id) === target.selectionId);
    if (labelItem && Number.isFinite(labelItem.x) && Number.isFinite(labelItem.y)) {
      return { x: labelItem.x, y: labelItem.y };
    }
    const region = layer?.renderLayer?.overlayPayload?.interactionRegions?.find((entry) => entry.id === target.selectionId);
    if (region) {
      return centroidOfParts(region.parts ?? []);
    }
    return null;
  }

  dispose() {
    this.clearSelections();
    this.hoveredLabel = null;
    this.airspaceAltitudeOverlay?.dispose();
    this.airspaceAltitudeOverlay = null;
    this.eventOverlayLayer?.dispose();
    this.eventOverlayLayer = null;
    for (const layer of this.layers.values()) {
      layer.labelLayer?.dispose();
      layer.renderLayer.dispose();
    }
    this.layers.clear();
    this.layerInteractionState.clear();
    this.airspaceRegionById.clear();
    this.boardMaterial?.dispose(false, true);
    this.boardMesh?.dispose(false, true);
    this.boardMaterial = null;
    this.boardMesh = null;
    this.currentManifest = null;
    this.currentSectionId = null;
  }

  resolvePriorityInteractionMetadata(pickInfo) {
    const direct = findInteractionMetadata(pickInfo?.pickedMesh ?? null);
    const pickResults = collectInteractivePickResults(this.scene, pickInfo);
    this.lastResolvedInteractionPick = null;
    if (!pickResults.length) {
      return direct;
    }

    pickResults.sort(compareInteractivePickResults);
    this.lastResolvedInteractionPick = pickResults[0] ?? null;
    return this.lastResolvedInteractionPick?.metadata ?? direct;
  }

  syncAirspaceSelectionVisualState(focusedLabelOverride = null) {
    const airspaceLayer = this.layers.get("airspace");
    const selectedFamilyKey = this.airspaceRegionById.get(this.selectedAirspaceId)?.familyKey ?? this.selectedAirspaceId;
    airspaceLayer?.renderLayer?.setSelection?.(this.airspaceAltitudeEnabled ? null : this.selectedAirspaceId);
    const focusedLabel = focusedLabelOverride ?? (this.selectedAirspaceId
      ? {
          layerId: "airspace",
          itemId: this.selectedAirspaceId,
        }
      : null);
    for (const [layerId, layer] of this.layers.entries()) {
      layer.labelLayer?.setSelection(
        layerId === "airspace" ? this.selectedAirspaceId : null,
        layerId === "airspace" ? selectedFamilyKey : null,
      );
      layer.labelLayer?.setFocusedLabel(focusedLabel);
    }
    this.airspaceAltitudeOverlay?.setSelection(this.selectedAirspaceId);
  }
}

function centroidOfParts(parts) {
  const points = parts.flatMap((part) => Array.isArray(part) ? part : []);
  const validPoints = points.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (!validPoints.length) {
    return null;
  }
  const sum = validPoints.reduce((accumulator, point) => ({
    x: accumulator.x + point[0],
    y: accumulator.y + point[1],
  }), { x: 0, y: 0 });
  return {
    x: sum.x / validPoints.length,
    y: sum.y / validPoints.length,
  };
}

function findInteractionMetadata(mesh) {
  let current = mesh;
  while (current) {
    if (current.metadata?.interactiveLayerId) {
      return current.metadata;
    }
    current = current.parent ?? null;
  }
  return null;
}

function collectInteractivePickResults(scene, pickInfo) {
  if (pickInfo?.ray && typeof scene.multiPickWithRay === "function") {
    const results = scene.multiPickWithRay(
      pickInfo.ray,
      (mesh) => Boolean(mesh.isPickable && mesh.isEnabled?.() && findInteractionMetadata(mesh)),
    ) ?? [];
    return results
      .map((result) => ({
        metadata: findInteractionMetadata(result.pickedMesh ?? null),
        pickedMesh: result.pickedMesh ?? null,
        pickedPoint: result.pickedPoint ?? null,
        distance: result.distance ?? Number.POSITIVE_INFINITY,
      }))
      .filter((result) => result.metadata?.interactiveLayerId);
  }

  const direct = findInteractionMetadata(pickInfo?.pickedMesh ?? null);
  return direct
    ? [{
        metadata: direct,
        pickedMesh: pickInfo?.pickedMesh ?? null,
        pickedPoint: pickInfo?.pickedPoint ?? null,
        distance: pickInfo?.distance ?? Number.POSITIVE_INFINITY,
      }]
    : [];
}

function compareInteractivePickResults(left, right) {
  const leftPriority = interactionPriority(left.metadata);
  const rightPriority = interactionPriority(right.metadata);
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }
  return (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY);
}

function interactionPriority(metadata) {
  if (!metadata) {
    return 0;
  }
  if (metadata.interactiveRole === "label") {
    if (metadata.labelGroup === "airfield") {
      return 5;
    }
    if (metadata.labelGroup === "shelf" || metadata.detailTier === "detail") {
      return 3;
    }
    return 4;
  }
  if (metadata.interactiveRole === "geometry") {
    return 2;
  }
  return 1;
}
