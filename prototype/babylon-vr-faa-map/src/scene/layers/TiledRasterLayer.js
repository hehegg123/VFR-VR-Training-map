import { pixelsToWorldPoint } from "./geometry/projector.js";

export class TiledRasterLayer {
  constructor(scene, parent, definition, sectionMetrics, orderIndex) {
    this.scene = scene;
    this.parent = parent;
    this.definition = definition;
    this.sectionMetrics = sectionMetrics;
    this.orderIndex = orderIndex;
    this.root = null;
    this.tileNodes = [];
    this.activeLevelIndex = -1;
    this.beforeRenderObserver = null;
    this.lastSwitchAt = 0;
  }

  async load() {
    this.root = new BABYLON.TransformNode(`layer-${this.definition.id}`, this.scene);
    this.root.parent = this.parent;
    this.root.position.y = this.definition.id === "base" ? 0 : 0.004 + this.orderIndex * 0.002;

    this.setActiveLevel(this.pickLevelForCamera(), true);
    this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(() => {
      const nextLevel = this.pickLevelForCamera();
      if (nextLevel === this.activeLevelIndex) {
        return;
      }

      const now = performance.now();
      if (now - this.lastSwitchAt < 250) {
        return;
      }

      this.setActiveLevel(nextLevel, false);
    });

    this.setVisible(this.definition.defaultVisible !== false);
  }

  pickLevelForCamera() {
    const levels = this.definition.tilePyramid?.levels ?? [];
    if (levels.length <= 1) {
      return 0;
    }

    const camera = this.scene.activeCamera;
    const radius = camera?.radius ?? 18;
    const minRadius = camera?.lowerRadiusLimit ?? 4;
    const maxRadius = camera?.upperRadiusLimit ?? 38;
    const normalized = clamp((radius - minRadius) / Math.max(maxRadius - minRadius, 1e-6), 0, 1);
    const detailBias = 1 - normalized;
    return Math.round(detailBias * (levels.length - 1));
  }

  setActiveLevel(levelIndex, force = false) {
    if (!force && levelIndex === this.activeLevelIndex) {
      return;
    }

    const levels = this.definition.tilePyramid?.levels ?? [];
    const level = levels[levelIndex];
    if (!level) {
      return;
    }

    this.disposeTiles();
    this.activeLevelIndex = levelIndex;
    this.lastSwitchAt = performance.now();

    for (const tile of level.tiles ?? []) {
      const mesh = this.createTileMesh(tile);
      const material = this.createTileMaterial(tile.url);
      mesh.material = material;
      this.tileNodes.push({ mesh, material });
    }
  }

  createTileMesh(tile) {
    const [sourceX, sourceY, sourceWidth, sourceHeight] = tile.sourceRect;
    const worldWidth = (sourceWidth / this.sectionMetrics.pixelWidth) * this.sectionMetrics.worldWidth;
    const worldHeight = (sourceHeight / this.sectionMetrics.pixelHeight) * this.sectionMetrics.worldHeight;
    const center = pixelsToWorldPoint(
      this.sectionMetrics,
      sourceX + sourceWidth / 2,
      sourceY + sourceHeight / 2,
      0,
    );

    const mesh = BABYLON.MeshBuilder.CreateGround(
      `tile-${this.definition.id}-${tile.id}`,
      {
        width: worldWidth,
        height: worldHeight,
        subdivisions: 1,
      },
      this.scene,
    );
    mesh.parent = this.root;
    mesh.position = center;
    mesh.isPickable = false;
    return mesh;
  }

  createTileMaterial(url) {
    const material = new BABYLON.StandardMaterial(`tile-material-${this.definition.id}-${this.tileNodes.length}`, this.scene);
    material.specularColor = BABYLON.Color3.Black();
    material.emissiveColor = new BABYLON.Color3(1, 1, 1);
    material.backFaceCulling = false;
    material.transparencyMode = BABYLON.Material.MATERIAL_OPAQUE;
    material.disableLighting = true;

    const texture = new BABYLON.Texture(url, this.scene, false, true);
    texture.anisotropicFilteringLevel = 16;
    texture.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
    material.diffuseTexture = texture;
    return material;
  }

  setVisible(visible) {
    this.root?.setEnabled(visible);
  }

  disposeTiles() {
    for (const node of this.tileNodes) {
      node.material.dispose(false, true);
      node.mesh.dispose(false, true);
    }
    this.tileNodes = [];
  }

  dispose() {
    if (this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
      this.beforeRenderObserver = null;
    }
    this.disposeTiles();
    this.root?.dispose(false, true);
    this.root = null;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
