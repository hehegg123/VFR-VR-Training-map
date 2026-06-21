const XR_STATES = BABYLON.WebXRState ?? {};

const MIN_MAP_SCALE = 0.2;
const MAX_MAP_SCALE = 2.75;
const ONE_HAND_TRANSLATION_GAIN = 3.4;
const TWO_HAND_TRANSLATION_GAIN = 3.0;
const TWO_HAND_SCALE_GAIN = 1.8;
const TWO_HAND_ROTATION_GAIN = 1.55;

export class XrMapManipulator {
  constructor(scene, xrHelper, mapRoot, inputSourceVisualManager = null) {
    this.scene = scene;
    this.xrHelper = xrHelper;
    this.mapRoot = mapRoot;
    this.inputSourceVisualManager = inputSourceVisualManager;
    this.controllers = new Map();
    this.activeGrabs = new Map();
    this.oneHandGesture = null;
    this.twoHandGesture = null;

    this.mapRoot.rotationQuaternion ??= BABYLON.Quaternion.Identity();
    this.mapRoot.scaling ??= new BABYLON.Vector3(1, 1, 1);

    this.controllerAddedObserver = xrHelper?.input?.onControllerAddedObservable?.add((controller) => {
      this.registerController(controller);
    }) ?? null;
    this.controllerRemovedObserver = xrHelper?.input?.onControllerRemovedObservable?.add((controller) => {
      this.unregisterController(controller);
    }) ?? null;
    this.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
      this.update();
    });
  }

  registerController(controller) {
    const entry = {
      controller,
      handedness: controller.inputSource?.handedness ?? "none",
      squeezeComponent: null,
      squeezeObserver: null,
      squeezePressed: false,
      motionControllerObserver: null,
    };

    entry.motionControllerObserver = controller.onMotionControllerInitObservable?.add((motionController) => {
      const component = findSqueezeComponent(motionController) ?? findTriggerFallbackComponent(motionController);
      if (!component?.onButtonStateChangedObservable) {
        return;
      }
      entry.squeezeComponent = component;
      entry.squeezePressed = Boolean(component.pressed);
      entry.squeezeObserver = component.onButtonStateChangedObservable.add(() => {
        const pressed = Boolean(component.pressed);
        if (pressed === entry.squeezePressed) {
          return;
        }
        entry.squeezePressed = pressed;
        if (pressed) {
          this.beginGrab(entry);
        } else {
          this.endGrab(entry);
        }
      });
    }) ?? null;

    this.controllers.set(controller.uniqueId, entry);
  }

  unregisterController(controller) {
    const entry = this.controllers.get(controller.uniqueId);
    if (!entry) {
      return;
    }
    this.endGrab(entry);
    if (entry.squeezeComponent && entry.squeezeObserver) {
      entry.squeezeComponent.onButtonStateChangedObservable?.remove(entry.squeezeObserver);
    }
    if (entry.motionControllerObserver) {
      controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
    }
    this.controllers.delete(controller.uniqueId);
  }

  beginGrab(entry) {
    if (!this.isActiveController(entry.controller)) {
      return;
    }
    const anchor = controllerAnchor(entry.controller);
    if (!anchor) {
      return;
    }
    this.activeGrabs.set(entry.controller.uniqueId, entry);
    if (this.activeGrabs.size >= 2) {
      this.establishTwoHandGesture();
      this.oneHandGesture = null;
      return;
    }
    this.establishOneHandGesture(entry);
  }

  endGrab(entry) {
    if (!this.activeGrabs.has(entry.controller.uniqueId)) {
      return;
    }
    this.activeGrabs.delete(entry.controller.uniqueId);
    this.twoHandGesture = null;
    if (this.activeGrabs.size === 1) {
      const [remaining] = this.activeGrabs.values();
      this.establishOneHandGesture(remaining);
      return;
    }
    this.oneHandGesture = null;
  }

  establishOneHandGesture(entry) {
    const anchor = controllerAnchor(entry.controller);
    if (!anchor) {
      this.oneHandGesture = null;
      return;
    }
    this.oneHandGesture = {
      controllerId: entry.controller.uniqueId,
      startControllerPosition: anchor.getAbsolutePosition().clone(),
      startMapPosition: this.mapRoot.position.clone(),
    };
  }

  establishTwoHandGesture() {
    const grabs = [...this.activeGrabs.values()].slice(0, 2);
    if (grabs.length < 2) {
      this.twoHandGesture = null;
      return;
    }

    const anchorA = controllerAnchor(grabs[0].controller);
    const anchorB = controllerAnchor(grabs[1].controller);
    if (!anchorA || !anchorB) {
      this.twoHandGesture = null;
      return;
    }

    const startA = anchorA.getAbsolutePosition().clone();
    const startB = anchorB.getAbsolutePosition().clone();
    const startMidpoint = midpoint(startA, startB);
    const startVector = startB.subtract(startA);
    const startDistance = Math.max(startVector.length(), 1e-4);
    const startYaw = Math.atan2(startVector.z, startVector.x);
    const startScale = this.mapRoot.scaling.x;
    const startRotation = this.mapRoot.rotationQuaternion.clone();
    const startOffset = this.mapRoot.position.subtract(startMidpoint);

    this.twoHandGesture = {
      controllerIds: grabs.map((grab) => grab.controller.uniqueId),
      startMidpoint,
      startDistance,
      startYaw,
      startScale,
      startRotation,
      startOffset,
    };
  }

  update() {
    if (!this.isInXr()) {
      return;
    }

    this.dropInactiveGrabs();

    if (this.activeGrabs.size >= 2 && this.twoHandGesture) {
      this.updateTwoHandGesture();
      return;
    }

    if (this.activeGrabs.size === 1 && this.oneHandGesture) {
      this.updateOneHandGesture();
    }
  }

  updateOneHandGesture() {
    const gesture = this.oneHandGesture;
    const entry = gesture ? this.activeGrabs.get(gesture.controllerId) : null;
    const anchor = entry ? controllerAnchor(entry.controller) : null;
    if (!gesture || !anchor) {
      return;
    }

    const currentPosition = anchor.getAbsolutePosition();
    const delta = currentPosition.subtract(gesture.startControllerPosition);
    this.mapRoot.position.copyFrom(gesture.startMapPosition.add(delta.scale(ONE_HAND_TRANSLATION_GAIN)));
  }

  updateTwoHandGesture() {
    const gesture = this.twoHandGesture;
    if (!gesture) {
      return;
    }

    const entries = gesture.controllerIds
      .map((controllerId) => this.activeGrabs.get(controllerId))
      .filter(Boolean);
    if (entries.length < 2) {
      return;
    }

    const anchorA = controllerAnchor(entries[0].controller);
    const anchorB = controllerAnchor(entries[1].controller);
    if (!anchorA || !anchorB) {
      return;
    }

    const currentA = anchorA.getAbsolutePosition();
    const currentB = anchorB.getAbsolutePosition();
    const currentMidpoint = midpoint(currentA, currentB);
    const currentVector = currentB.subtract(currentA);
    const currentDistance = Math.max(currentVector.length(), 1e-4);
    const currentYaw = Math.atan2(currentVector.z, currentVector.x);

    const scaleRatio = Math.pow(currentDistance / gesture.startDistance, TWO_HAND_SCALE_GAIN);
    const nextScale = BABYLON.Scalar.Clamp(gesture.startScale * scaleRatio, MIN_MAP_SCALE, MAX_MAP_SCALE);
    this.mapRoot.scaling.setAll(nextScale);

    // In XR, rotating the hands clockwise should feel like turning the map clockwise,
    // so invert the raw controller-vector delta before applying it to the map root.
    const yawDelta = (gesture.startYaw - currentYaw) * TWO_HAND_ROTATION_GAIN;
    const rotationDelta = BABYLON.Quaternion.FromEulerAngles(0, yawDelta, 0);
    this.mapRoot.rotationQuaternion = rotationDelta.multiply(gesture.startRotation);

    const scaledOffset = gesture.startOffset.scale(nextScale / gesture.startScale);
    const rotatedOffset = new BABYLON.Vector3();
    scaledOffset.rotateByQuaternionToRef(rotationDelta, rotatedOffset);
    const midpointDelta = currentMidpoint.subtract(gesture.startMidpoint).scale(TWO_HAND_TRANSLATION_GAIN);
    const amplifiedMidpoint = gesture.startMidpoint.add(midpointDelta);
    this.mapRoot.position.copyFrom(amplifiedMidpoint.add(rotatedOffset));
  }

  isInXr() {
    const state = this.xrHelper?.baseExperience?.state;
    return state === XR_STATES.IN_XR || state === XR_STATES.ENTERING_XR;
  }

  isActiveController(controller) {
    return !this.inputSourceVisualManager || this.inputSourceVisualManager.isActiveController(controller);
  }

  dropInactiveGrabs() {
    let changed = false;
    for (const entry of [...this.activeGrabs.values()]) {
      if (!this.isActiveController(entry.controller)) {
        this.activeGrabs.delete(entry.controller.uniqueId);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    this.twoHandGesture = null;
    if (this.activeGrabs.size === 1) {
      const [remaining] = this.activeGrabs.values();
      this.establishOneHandGesture(remaining);
      return;
    }
    this.oneHandGesture = null;
  }

  dispose() {
    for (const entry of this.controllers.values()) {
      if (entry.squeezeComponent && entry.squeezeObserver) {
        entry.squeezeComponent.onButtonStateChangedObservable?.remove(entry.squeezeObserver);
      }
      if (entry.motionControllerObserver) {
        entry.controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
      }
    }
    this.controllers.clear();
    this.activeGrabs.clear();
    if (this.controllerAddedObserver) {
      this.xrHelper?.input?.onControllerAddedObservable?.remove(this.controllerAddedObserver);
    }
    if (this.controllerRemovedObserver) {
      this.xrHelper?.input?.onControllerRemovedObservable?.remove(this.controllerRemovedObserver);
    }
    if (this.beforeRenderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
    }
  }
}

function findSqueezeComponent(motionController) {
  const componentIds = motionController.getComponentIds?.() ?? [];
  for (const componentId of componentIds) {
    const component = motionController.getComponent(componentId);
    const type = `${component?.type ?? ""}`.toLowerCase();
    const id = `${componentId}`.toLowerCase();
    if (type.includes("squeeze") || type.includes("grasp") || id.includes("squeeze") || id.includes("grasp")) {
      return component;
    }
  }
  return null;
}

function findTriggerFallbackComponent(motionController) {
  const componentIds = motionController.getComponentIds?.() ?? [];
  for (const componentId of componentIds) {
    const component = motionController.getComponent(componentId);
    const type = `${component?.type ?? ""}`.toLowerCase();
    const id = `${componentId}`.toLowerCase();
    if (type.includes("trigger") || id.includes("trigger")) {
      return component;
    }
  }
  return null;
}

function controllerAnchor(controller) {
  return controller?.grip ?? controller?.pointer ?? null;
}

function midpoint(left, right) {
  return new BABYLON.Vector3(
    (left.x + right.x) * 0.5,
    (left.y + right.y) * 0.5,
    (left.z + right.z) * 0.5,
  );
}
