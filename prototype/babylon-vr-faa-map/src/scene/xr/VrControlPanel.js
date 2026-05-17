const XR_STATES = BABYLON.WebXRState ?? {};
const PANEL_TOGGLE_DEBOUNCE_MS = 300;

export class VrControlPanel {
  constructor(scene, xrHelper, camera) {
    this.scene = scene;
    this.xrHelper = xrHelper;
    this.camera = camera;
    this.config = null;
    this.currentAnchor = null;
    this.leftController = null;
    this.panelVisible = true;
    this.lastToggleTime = 0;
    this.controllerEntries = new Map();
    this.fallbackAnchor = new BABYLON.TransformNode("xr-panel-fallback-anchor", scene);
    this.fallbackAnchor.parent = camera;
    this.fallbackAnchor.position = new BABYLON.Vector3(-0.24, 0.04, 0.5);
    this.root = new BABYLON.TransformNode("xr-panel-root", scene);
    this.root.parent = this.fallbackAnchor;
    this.root.position = BABYLON.Vector3.Zero();
    this.root.setEnabled(false);

    this.panelMesh = BABYLON.MeshBuilder.CreatePlane(
      "xr-panel-plane",
      { width: 0.34, height: 0.42 },
      scene,
    );
    this.panelMesh.parent = this.root;
    this.panelMesh.isPickable = true;
    this.panelMesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;

    this.panelMaterial = new BABYLON.StandardMaterial("xr-panel-material", scene);
    this.panelMaterial.diffuseColor = new BABYLON.Color3(0.07, 0.12, 0.2);
    this.panelMaterial.emissiveColor = new BABYLON.Color3(0.09, 0.15, 0.28);
    this.panelMaterial.alpha = 0.92;
    this.panelMaterial.specularColor = BABYLON.Color3.Black();
    this.panelMesh.material = this.panelMaterial;

    this.texture = BABYLON.GUI.AdvancedDynamicTexture.CreateForMesh(this.panelMesh, 1024, 1280, false);
    this.texture.background = "transparent";
    this.contentRoot = new BABYLON.GUI.Rectangle("xr-panel-content");
    this.contentRoot.thickness = 0;
    this.contentRoot.cornerRadius = 34;
    this.contentRoot.background = "#102038D9";
    this.texture.addControl(this.contentRoot);

    this.stack = new BABYLON.GUI.StackPanel("xr-panel-stack");
    this.stack.width = 0.94;
    this.stack.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.stack.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    this.stack.paddingTop = "26px";
    this.stack.paddingBottom = "24px";
    this.contentRoot.addControl(this.stack);

    this.controllerAddedObserver = xrHelper?.input?.onControllerAddedObservable?.add((controller) => {
      this.handleControllerAdded(controller);
    }) ?? null;
    this.controllerRemovedObserver = xrHelper?.input?.onControllerRemovedObservable?.add((controller) => {
      this.handleControllerRemoved(controller);
    }) ?? null;
    this.xrStateObserver = xrHelper?.baseExperience?.onStateChangedObservable?.add(() => {
      this.updateAnchor();
      this.updateVisibility();
    }) ?? null;
  }

  setConfig(config) {
    this.config = config;
    this.rebuild();
    this.updateVisibility();
  }

  updateAnchor() {
    const anchor = this.resolveAnchor();
    if (anchor === this.currentAnchor) {
      return;
    }
    this.currentAnchor = anchor;
    this.root.parent = anchor;
    this.root.position.copyFrom(BABYLON.Vector3.Zero());
    this.panelMesh.position.copyFrom(anchor === this.fallbackAnchor
      ? new BABYLON.Vector3(0, 0, 0)
      : new BABYLON.Vector3(0.1, 0.13, 0.08));
  }

  updateVisibility() {
    const inXr = this.isInXr();
    this.root.setEnabled(Boolean(this.config) && inXr && this.panelVisible);
  }

  rebuild() {
    this.stack.clearControls();
    if (!this.config) {
      return;
    }

    this.stack.addControl(this.buildTitle(this.config.title ?? "St. Louis Controls", 44, "#E8F0FF"));
    if (this.config.subtitle) {
      const subtitle = this.buildTitle(this.config.subtitle, 24, "#B9C9E8");
      subtitle.height = "40px";
      this.stack.addControl(subtitle);
    }

    for (const layer of this.config.layers ?? []) {
      this.stack.addControl(this.buildLayerCard(layer));
    }
  }

  buildTitle(text, size, color) {
    const block = new BABYLON.GUI.TextBlock();
    block.text = text;
    block.color = color;
    block.fontSize = `${size}px`;
    block.fontWeight = "600";
    block.height = "56px";
    block.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    block.paddingLeft = "12px";
    return block;
  }

  buildLayerCard(layer) {
    const card = new BABYLON.GUI.Rectangle(`xr-layer-${layer.id}`);
    card.height = layer.supportsExtendedLabels ? "170px" : "138px";
    card.thickness = 1;
    card.color = "#35527A";
    card.cornerRadius = 20;
    card.background = layer.layerVisible ? "#173050E3" : "#0E1B30D6";
    card.paddingBottom = "14px";
    card.paddingTop = "8px";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = 0.92;
    stack.isVertical = true;
    card.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = layer.title;
    title.color = "#F4F8FF";
    title.fontSize = "30px";
    title.fontWeight = "600";
    title.height = "40px";
    title.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    stack.addControl(title);

    stack.addControl(this.buildActionRow("Map", layer.layerVisible, () => {
      this.config?.onToggleLayerVisible?.(layer.id, !layer.layerVisible);
    }));

    stack.addControl(this.buildActionRow("Labels", layer.labelsEnabled, () => {
      if (!layer.labelToggleAvailable) {
        return;
      }
      this.config?.onToggleLabels?.(layer.id, !layer.labelsEnabled);
    }, !layer.labelToggleAvailable));

    if (layer.supportsExtendedLabels) {
      stack.addControl(this.buildActionRow("More", layer.extendedLabelsEnabled, () => {
        this.config?.onToggleExtendedLabels?.(layer.id, !layer.extendedLabelsEnabled);
      }, !layer.labelToggleAvailable));
    }

    return card;
  }

  buildActionRow(label, active, onPress, disabled = false) {
    const row = new BABYLON.GUI.Grid();
    row.height = "34px";
    row.addColumnDefinition(0.45);
    row.addColumnDefinition(0.55);
    row.paddingTop = "10px";

    const labelBlock = new BABYLON.GUI.TextBlock();
    labelBlock.text = label;
    labelBlock.color = disabled ? "#7D90B3" : "#D9E7FF";
    labelBlock.fontSize = "24px";
    labelBlock.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    row.addControl(labelBlock, 0, 0);

    const button = BABYLON.GUI.Button.CreateSimpleButton(`${label}-toggle`, active ? "On" : "Off");
    button.height = "30px";
    button.width = "112px";
    button.cornerRadius = 14;
    button.thickness = 1;
    button.fontSize = "22px";
    button.color = disabled ? "#95A3BF" : "#F8FBFF";
    button.background = disabled ? "#1D2B42" : active ? "#1E7BFF" : "#243650";
    button.thickness = disabled ? 1 : active ? 0 : 1;
    button.isEnabled = !disabled;
    if (!disabled) {
      button.onPointerUpObservable.add(() => onPress());
    }
    row.addControl(button, 0, 1);

    return row;
  }

  handleControllerAdded(controller) {
    const entry = {
      controller,
      motionControllerObserver: null,
      toggleComponent: null,
      toggleObserver: null,
      togglePressed: false,
    };
    entry.motionControllerObserver = controller.onMotionControllerInitObservable?.add((motionController) => {
      const component = findPanelToggleComponent(motionController);
      if (!component?.onButtonStateChangedObservable) {
        return;
      }
      entry.toggleComponent = component;
      entry.togglePressed = Boolean(component.pressed);
      entry.toggleObserver = component.onButtonStateChangedObservable.add(() => {
        const pressed = Boolean(component.pressed);
        if (pressed === entry.togglePressed) {
          return;
        }
        entry.togglePressed = pressed;
        if (pressed) {
          this.togglePanelVisibility();
        }
      });
    }) ?? null;
    this.controllerEntries.set(controller.uniqueId, entry);

    if (controller.inputSource?.handedness === "left") {
      this.leftController = controller;
      this.updateAnchor();
      this.updateVisibility();
    }
  }

  handleControllerRemoved(controller) {
    const entry = this.controllerEntries.get(controller.uniqueId);
    if (entry?.toggleComponent && entry.toggleObserver) {
      entry.toggleComponent.onButtonStateChangedObservable?.remove(entry.toggleObserver);
    }
    if (entry?.motionControllerObserver) {
      controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
    }
    this.controllerEntries.delete(controller.uniqueId);

    if (controller === this.leftController) {
      this.leftController = null;
      this.updateAnchor();
    }
  }

  togglePanelVisibility() {
    const now = Date.now();
    if (now - this.lastToggleTime < PANEL_TOGGLE_DEBOUNCE_MS) {
      return;
    }
    this.lastToggleTime = now;
    this.panelVisible = !this.panelVisible;
    this.updateVisibility();
  }

  resolveAnchor() {
    if (!this.isInXr()) {
      return this.fallbackAnchor;
    }
    return this.leftController?.grip ?? this.leftController?.pointer ?? this.fallbackAnchor;
  }

  isInXr() {
    const state = this.xrHelper?.baseExperience?.state;
    return state === XR_STATES.IN_XR || state === XR_STATES.ENTERING_XR;
  }

  dispose() {
    for (const entry of this.controllerEntries.values()) {
      if (entry.toggleComponent && entry.toggleObserver) {
        entry.toggleComponent.onButtonStateChangedObservable?.remove(entry.toggleObserver);
      }
      if (entry.motionControllerObserver) {
        entry.controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
      }
    }
    this.controllerEntries.clear();
    if (this.controllerAddedObserver) {
      this.xrHelper?.input?.onControllerAddedObservable?.remove(this.controllerAddedObserver);
    }
    if (this.controllerRemovedObserver) {
      this.xrHelper?.input?.onControllerRemovedObservable?.remove(this.controllerRemovedObserver);
    }
    if (this.xrStateObserver) {
      this.xrHelper?.baseExperience?.onStateChangedObservable?.remove(this.xrStateObserver);
    }
    this.texture?.dispose();
    this.panelMaterial?.dispose();
    this.panelMesh?.dispose();
    this.root?.dispose();
    this.fallbackAnchor?.dispose();
  }
}

function findPanelToggleComponent(motionController) {
  const componentIds = motionController.getComponentIds?.() ?? [];
  const preferredMatchers = [
    "thumb",
    "stick",
    "touchpad",
    "trackpad",
    "buttonx",
    "buttony",
    "buttona",
    "buttonb",
    "secondary",
  ];

  for (const matcher of preferredMatchers) {
    for (const componentId of componentIds) {
      const component = motionController.getComponent(componentId);
      const id = `${componentId}`.toLowerCase();
      const type = `${component?.type ?? ""}`.toLowerCase();
      if ((id.includes(matcher) || type.includes(matcher)) && component?.onButtonStateChangedObservable) {
        return component;
      }
    }
  }

  return null;
}
