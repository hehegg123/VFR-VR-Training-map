import { resolveSectionAsset } from "../../data/sectionRepository.js";
import {
  createFeatureSelection,
  createLabelSelection,
} from "../../../../shared/selectionContract.js";
import { RasterLayer } from "./RasterLayer.js";
import { TiledRasterLayer } from "./TiledRasterLayer.js";
import { VectorOverlayLayer } from "./VectorOverlayLayer.js?v=20260514-feature-highlight-v1";
import { VrLabelLayer } from "./VrLabelLayer.js?v=20260516-label-style-v3";

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
    this.labelOptions = new Map();
    this.viewState = {
      cameraRadius: null,
    };
    this.selectedAirspaceId = null;
    this.selectedLabel = null;
    this.currentSelection = null;
    this.onAirspaceSelectionChange = null;
    this.onSelectionChange = null;
    this.pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type !== BABYLON.PointerEventTypes.POINTERPICK) {
        return;
      }
      const metadata = findInteractionMetadata(pointerInfo.pickInfo?.pickedMesh ?? null);
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
        labelLayer.setOptions(this.labelOptions.get(layerDef.id) ?? {});
        labelLayer.setViewState(this.viewState);
      }

      this.layers.set(layerDef.id, { definition: hydrated, renderLayer, labelLayer });
    }
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
    this.layers.get(layerId)?.renderLayer.setVisible(visible);
  }

  setLabelVisible(layerId, visible) {
    this.layers.get(layerId)?.labelLayer?.setVisible(visible);
  }

  setLabelOptions(layerId, options) {
    const nextOptions = {
      ...(this.labelOptions.get(layerId) ?? {}),
      ...options,
    };
    this.labelOptions.set(layerId, nextOptions);
    this.layers.get(layerId)?.labelLayer?.setOptions(nextOptions);
  }

  setViewState(viewState) {
    this.viewState = {
      ...this.viewState,
      ...viewState,
    };
    for (const layer of this.layers.values()) {
      layer.labelLayer?.setViewState(this.viewState);
    }
  }

  setAirspaceSelection(selectionId, options = {}) {
    if (this.selectedAirspaceId === selectionId) {
      return;
    }
    if (selectionId) {
      this.clearLabelSelection({ suppressNotify: true });
    }
    this.selectedAirspaceId = selectionId;
    const airspaceLayer = this.layers.get("airspace");
    airspaceLayer?.renderLayer?.setSelection?.(selectionId);
    airspaceLayer?.labelLayer?.setSelection?.(selectionId);
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

  setLabelSelection(layerId, itemId, metadata = null, options = {}) {
    const nextSelection = layerId && itemId ? { layerId, itemId, label: metadata?.labelText ?? itemId } : null;
    if (
      this.selectedLabel?.layerId === nextSelection?.layerId
      && this.selectedLabel?.itemId === nextSelection?.itemId
    ) {
      return;
    }

    if (nextSelection) {
      this.clearAirspaceSelection({ suppressNotify: true });
    }

    this.selectedLabel = nextSelection;
    for (const [currentLayerId, layer] of this.layers.entries()) {
      layer.labelLayer?.setSelection(currentLayerId === layerId ? itemId : null);
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
    if (metadata.interactiveLayerId === "airspace" && metadata.selectionId) {
      this.setAirspaceSelection(metadata.selectionId);
      return;
    }
    if (metadata.interactiveRole === "label" && metadata.interactiveLayerId && metadata.itemId) {
      this.setLabelSelection(metadata.interactiveLayerId, metadata.itemId, metadata);
      return;
    }
    this.clearSelections();
  }

  notifySelectionChange(payload) {
    this.currentSelection = payload;
    this.onSelectionChange?.(payload);
  }

  getSectionMetrics() {
    return this.sectionMetrics;
  }

  getSelection() {
    return this.currentSelection;
  }

  dispose() {
    this.clearSelections();
    for (const layer of this.layers.values()) {
      layer.labelLayer?.dispose();
      layer.renderLayer.dispose();
    }
    this.layers.clear();
    this.boardMaterial?.dispose(false, true);
    this.boardMesh?.dispose(false, true);
    this.boardMaterial = null;
    this.boardMesh = null;
    this.currentManifest = null;
    this.currentSectionId = null;
  }
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
