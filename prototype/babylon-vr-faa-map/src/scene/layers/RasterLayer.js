export class RasterLayer {
  constructor(scene, parent, definition, sectionMetrics, orderIndex) {
    this.scene = scene;
    this.parent = parent;
    this.definition = definition;
    this.sectionMetrics = sectionMetrics;
    this.orderIndex = orderIndex;
    this.mesh = null;
    this.material = null;
  }

  async load() {
    const { worldWidth, worldHeight } = this.sectionMetrics;

    this.mesh = BABYLON.MeshBuilder.CreateGround(
      `layer-${this.definition.id}`,
      { width: worldWidth, height: worldHeight, subdivisions: 1 },
      this.scene,
    );
    this.mesh.parent = this.parent;
    this.mesh.position.y = this.definition.id === "base" ? 0 : 0.004 + this.orderIndex * 0.002;
    this.mesh.isPickable = false;

    this.material = new BABYLON.StandardMaterial(`layer-material-${this.definition.id}`, this.scene);
    this.material.specularColor = BABYLON.Color3.Black();
    this.material.emissiveColor = new BABYLON.Color3(1, 1, 1);
    this.material.backFaceCulling = false;
    this.material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;

    const texture = new BABYLON.Texture(this.definition.textureUrl, this.scene, false, true);
    texture.anisotropicFilteringLevel = 8;
    this.material.diffuseTexture = texture;

    if (this.definition.id !== "base") {
      this.material.opacityTexture = texture;
      this.material.useAlphaFromDiffuseTexture = true;
    }

    this.mesh.material = this.material;
    this.setVisible(this.definition.defaultVisible !== false);
  }

  setVisible(visible) {
    if (this.mesh) {
      this.mesh.setEnabled(visible);
    }
  }

  dispose() {
    this.material?.dispose(false, true);
    this.mesh?.dispose(false, true);
  }
}
