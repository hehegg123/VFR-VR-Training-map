const XR_STATES = BABYLON.WebXRState ?? {};
const PANEL_TOGGLE_DEBOUNCE_MS = 300;
const FALLBACK_VIEW_OFFSET = new BABYLON.Vector3(-0.34, -0.02, 0.72);
const CONTROLLER_FOREARM_OFFSET = new BABYLON.Vector3(0.02, 0.21, 0.16);
const ACTION_ROW_HEIGHT_PX = 52;
const CHECKBOX_WIDTH_PX = 148;
const CHECKBOX_HEIGHT_PX = 44;
const CHECKBOX_FONT_SIZE_PX = 28;
const LABEL_FONT_SIZE_PX = 29;
const MASTER_BUTTON_WIDTH_PX = 154;
const MASTER_BUTTON_HEIGHT_PX = 42;

export class VrControlPanel {
  constructor(scene, xrHelper, camera, inputSourceVisualManager = null) {
    this.scene = scene;
    this.xrHelper = xrHelper;
    this.camera = camera;
    this.inputSourceVisualManager = inputSourceVisualManager;
    this.config = null;
    this.currentAnchor = null;
    this.leftController = null;
    this.panelVisible = true;
    this.lastToggleTime = 0;
    this.controllerEntries = new Map();
    this.fallbackAnchor = new BABYLON.TransformNode("xr-panel-fallback-anchor", scene);
    this.fallbackAnchor.parent = camera;
    this.fallbackAnchor.position.copyFrom(FALLBACK_VIEW_OFFSET);
    this.root = new BABYLON.TransformNode("xr-panel-root", scene);
    this.root.parent = this.fallbackAnchor;
    this.root.position = BABYLON.Vector3.Zero();
    this.root.setEnabled(false);

    this.panelMesh = BABYLON.MeshBuilder.CreatePlane(
      "xr-panel-plane",
      { width: 0.46, height: 0.58 },
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

    this.texture = BABYLON.GUI.AdvancedDynamicTexture.CreateForMesh(this.panelMesh, 1280, 1800, false);
    this.texture.background = "transparent";
    this.contentRoot = new BABYLON.GUI.Rectangle("xr-panel-content");
    this.contentRoot.thickness = 0;
    this.contentRoot.cornerRadius = 34;
    this.contentRoot.background = "#102038D9";
    this.texture.addControl(this.contentRoot);

    this.stack = new BABYLON.GUI.StackPanel("xr-panel-stack");
    this.stack.width = 0.92;
    this.stack.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_CENTER;
    this.stack.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
    this.stack.paddingTop = "24px";
    this.stack.paddingBottom = "22px";
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
    this.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
      this.syncRuntimePlacement();
    });

    for (const controller of xrHelper?.input?.controllers ?? []) {
      this.handleControllerAdded(controller);
    }
  }

  setConfig(config) {
    this.config = config;
    this.rebuild();
    this.updateAnchor();
    this.updateVisibility();
  }

  updateAnchor() {
    this.fallbackAnchor.parent = this.resolveFallbackParent();
    this.fallbackAnchor.position.copyFrom(FALLBACK_VIEW_OFFSET);
    const anchor = this.resolveAnchor();
    if (anchor === this.currentAnchor) {
      this.applyMountedOffset(anchor);
      return;
    }
    this.currentAnchor = anchor;
    this.root.parent = anchor;
    this.applyMountedOffset(anchor);
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
      const subtitle = this.buildTitle(this.config.subtitle, 27, "#B9C9E8");
      subtitle.height = "44px";
      this.stack.addControl(subtitle);
    }

    this.stack.addControl(this.buildMasterControls());

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
    const actionRows = layer.supportsAltitudeVolume ? 3 : 2;
    card.height = `${72 + actionRows * ACTION_ROW_HEIGHT_PX}px`;
    card.thickness = 1;
    card.color = "#35527A";
    card.cornerRadius = 20;
    card.background = layer.layerVisible ? "#173050E3" : "#0E1B30D6";
    card.paddingBottom = "12px";
    card.paddingTop = "8px";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = 0.94;
    stack.isVertical = true;
    card.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = layer.title;
    title.color = "#F4F8FF";
    title.fontSize = "34px";
    title.fontWeight = "600";
    title.height = "48px";
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

    if (layer.supportsAltitudeVolume) {
      stack.addControl(this.buildActionRow("Altitude", layer.altitudeVolumeEnabled, () => {
        this.config?.onToggleAirspaceAltitude?.(!layer.altitudeVolumeEnabled);
      }));
    }

    return card;
  }

  buildActionRow(label, active, onPress, disabled = false) {
    const row = new BABYLON.GUI.Grid();
    row.height = `${ACTION_ROW_HEIGHT_PX}px`;
    row.addColumnDefinition(0.56);
    row.addColumnDefinition(0.44);
    row.paddingTop = "8px";

    const toggle = () => {
      if (!disabled) {
        onPress();
      }
    };

    const labelBlock = new BABYLON.GUI.TextBlock();
    labelBlock.text = label;
    labelBlock.color = disabled ? "#7D90B3" : "#D9E7FF";
    labelBlock.fontSize = `${LABEL_FONT_SIZE_PX}px`;
    labelBlock.fontWeight = "600";
    labelBlock.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    labelBlock.isPointerBlocker = !disabled;
    if (!disabled) {
      labelBlock.onPointerUpObservable.add(toggle);
    }
    row.addControl(labelBlock, 0, 0);

    const button = BABYLON.GUI.Button.CreateSimpleButton(`${label}-toggle`, active ? "On" : "Off");
    button.height = `${CHECKBOX_HEIGHT_PX}px`;
    button.width = `${CHECKBOX_WIDTH_PX}px`;
    button.cornerRadius = 12;
    button.thickness = active ? 2 : 1;
    button.fontSize = `${CHECKBOX_FONT_SIZE_PX}px`;
    button.fontWeight = "700";
    button.color = disabled ? "#95A3BF" : "#F8FBFF";
    button.background = disabled ? "#1D2B42" : active ? "#1E7BFF" : "#243650";
    button.isEnabled = !disabled;
    if (!disabled) {
      button.onPointerUpObservable.add(toggle);
    }
    row.addControl(button, 0, 1);

    return row;
  }

  buildMasterControls() {
    const card = new BABYLON.GUI.Rectangle("xr-master-controls");
    card.height = "162px";
    card.thickness = 1;
    card.color = "#4B668E";
    card.cornerRadius = 20;
    card.background = "#0D1A2FD9";
    card.paddingTop = "8px";
    card.paddingBottom = "12px";

    const stack = new BABYLON.GUI.StackPanel();
    stack.width = 0.94;
    stack.isVertical = true;
    card.addControl(stack);

    const title = new BABYLON.GUI.TextBlock();
    title.text = "Master Control";
    title.color = "#F4F8FF";
    title.fontSize = "32px";
    title.fontWeight = "700";
    title.height = "44px";
    title.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    stack.addControl(title);

    stack.addControl(this.buildMasterRow("Maps", () => {
      this.config?.onSetAllLayerVisible?.(true);
    }, () => {
      this.config?.onSetAllLayerVisible?.(false);
    }));

    const hasLabelToggles = (this.config?.layers ?? []).some((layer) => layer.labelToggleAvailable);
    stack.addControl(this.buildMasterRow("Labels", () => {
      this.config?.onSetAllLabels?.(true);
    }, () => {
      this.config?.onSetAllLabels?.(false);
    }, !hasLabelToggles));

    return card;
  }

  buildMasterRow(label, onSelectAll, onDeselectAll, disabled = false) {
    const row = new BABYLON.GUI.Grid();
    row.height = "48px";
    row.addColumnDefinition(0.34);
    row.addColumnDefinition(0.33);
    row.addColumnDefinition(0.33);
    row.paddingTop = "6px";

    const labelBlock = new BABYLON.GUI.TextBlock();
    labelBlock.text = label;
    labelBlock.color = disabled ? "#7D90B3" : "#D9E7FF";
    labelBlock.fontSize = "27px";
    labelBlock.fontWeight = "600";
    labelBlock.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    row.addControl(labelBlock, 0, 0);

    row.addControl(this.buildMasterButton(label, "Select All", onSelectAll, disabled), 0, 1);
    row.addControl(this.buildMasterButton(label, "Deselect All", onDeselectAll, disabled), 0, 2);
    return row;
  }

  buildMasterButton(category, text, onPress, disabled = false) {
    const button = BABYLON.GUI.Button.CreateSimpleButton(`master-${category}-${text}`, text);
    button.height = `${MASTER_BUTTON_HEIGHT_PX}px`;
    button.width = `${MASTER_BUTTON_WIDTH_PX}px`;
    button.cornerRadius = 12;
    button.thickness = 1;
    button.fontSize = "22px";
    button.fontWeight = "700";
    button.color = disabled ? "#95A3BF" : "#F8FBFF";
    button.background = disabled ? "#1D2B42" : "#23466E";
    button.isEnabled = !disabled;
    if (!disabled) {
      button.onPointerUpObservable.add(() => onPress());
    }
    return button;
  }

  handleControllerAdded(controller) {
    if (!controller?.uniqueId || this.controllerEntries.has(controller.uniqueId)) {
      return;
    }
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
    const leftController = this.syncActiveLeftController();
    return leftController?.grip ?? leftController?.pointer ?? this.fallbackAnchor;
  }

  resolveFallbackParent() {
    return this.xrHelper?.baseExperience?.camera ?? this.camera;
  }

  applyMountedOffset(anchor) {
    this.root.position.copyFrom(anchor === this.fallbackAnchor ? BABYLON.Vector3.Zero() : CONTROLLER_FOREARM_OFFSET);
    this.panelMesh.position.copyFrom(BABYLON.Vector3.Zero());
  }

  syncRuntimePlacement() {
    if (!this.config) {
      return;
    }
    this.syncActiveLeftController();
    this.updateAnchor();
  }

  isInXr() {
    const state = this.xrHelper?.baseExperience?.state;
    return state === XR_STATES.IN_XR || state === XR_STATES.ENTERING_XR;
  }

  syncActiveLeftController() {
    const activeLeftController = this.inputSourceVisualManager?.getActiveController("left") ?? this.leftController;
    if (activeLeftController !== this.leftController) {
      this.leftController = activeLeftController;
    }
    return this.leftController;
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
    if (this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
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
  const preferredIds = [
    "xr-standard-thumbstick",
    "xr-standard-touchpad",
    "thumbstick",
    "touchpad",
    "trackpad",
  ];

  for (const preferredId of preferredIds) {
    const exactId = componentIds.find((componentId) => `${componentId}`.toLowerCase() === preferredId);
    const component = exactId ? motionController.getComponent(exactId) : null;
    if (isClickablePanelToggleComponent(component)) {
      return component;
    }
  }

  for (const componentId of componentIds) {
    const component = motionController.getComponent(componentId);
    const id = `${componentId}`.toLowerCase();
    const type = `${component?.type ?? ""}`.toLowerCase();
    const isStickOrPad = ["thumbstick", "touchpad", "trackpad"].some((matcher) => (
      id.includes(matcher) || type.includes(matcher)
    ));
    if (!id.includes("thumbrest") && isStickOrPad && isClickablePanelToggleComponent(component)) {
      return component;
    }
  }

  for (const componentId of componentIds) {
    const component = motionController.getComponent(componentId);
    const id = `${componentId}`.toLowerCase();
    if (["buttonx", "buttony", "buttona", "buttonb", "secondary"].some((matcher) => id.includes(matcher))
      && isClickablePanelToggleComponent(component)) {
      return component;
    }
  }

  return null;
}

function isClickablePanelToggleComponent(component) {
  return Boolean(component?.onButtonStateChangedObservable && "pressed" in component);
}
