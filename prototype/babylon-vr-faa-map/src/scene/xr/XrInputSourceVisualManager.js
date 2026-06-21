const UNKNOWN_HAND = "none";

export class XrInputSourceVisualManager {
  constructor(scene, xrHelper) {
    this.scene = scene;
    this.xrHelper = xrHelper;
    this.sequence = 0;
    this.entries = new Map();
    this.activeByHandedness = new Map();

    this.controllerAddedObserver = xrHelper?.input?.onControllerAddedObservable?.add((controller) => {
      this.registerController(controller);
    }) ?? null;
    this.controllerRemovedObserver = xrHelper?.input?.onControllerRemovedObservable?.add((controller) => {
      this.unregisterController(controller);
    }) ?? null;
    this.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
      this.refresh();
    });

    for (const controller of xrHelper?.input?.controllers ?? []) {
      this.registerController(controller);
    }
  }

  registerController(controller) {
    if (!controller?.uniqueId) {
      return;
    }

    let entry = this.entries.get(controller.uniqueId);
    if (!entry) {
      entry = {
        controller,
        handedness: controllerHandedness(controller),
        kind: controllerKind(controller),
        sequence: ++this.sequence,
        motionControllerObserver: null,
      };
      this.entries.set(controller.uniqueId, entry);
    } else {
      entry.controller = controller;
      entry.handedness = controllerHandedness(controller);
      entry.kind = controllerKind(controller);
      entry.sequence = ++this.sequence;
    }

    if (!entry.motionControllerObserver) {
      entry.motionControllerObserver = controller.onMotionControllerInitObservable?.add(() => {
        this.applyVisualState();
      }) ?? null;
    }

    this.recomputeActiveControllers();
    this.applyVisualState();
  }

  unregisterController(controller) {
    if (!controller?.uniqueId) {
      return;
    }

    const entry = this.entries.get(controller.uniqueId);
    if (entry?.motionControllerObserver) {
      controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
    }

    this.setControllerVisualEnabled(controller, false);
    this.entries.delete(controller.uniqueId);
    this.recomputeActiveControllers();
    this.applyVisualState();
  }

  refresh() {
    let changed = false;
    const liveControllers = new Set();

    for (const controller of this.xrHelper?.input?.controllers ?? []) {
      if (!controller?.uniqueId) {
        continue;
      }
      liveControllers.add(controller.uniqueId);
      const entry = this.entries.get(controller.uniqueId);
      if (!entry) {
        this.registerController(controller);
        changed = true;
        continue;
      }

      const nextKind = controllerKind(controller);
      const nextHandedness = controllerHandedness(controller);
      entry.controller = controller;
      if (entry.kind !== nextKind || entry.handedness !== nextHandedness) {
        entry.kind = nextKind;
        entry.handedness = nextHandedness;
        entry.sequence = ++this.sequence;
        changed = true;
      }
    }

    for (const [controllerId, entry] of this.entries) {
      if (!liveControllers.has(controllerId)) {
        this.setControllerVisualEnabled(entry.controller, false);
        if (entry.motionControllerObserver) {
          entry.controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
        }
        this.entries.delete(controllerId);
        changed = true;
      }
    }

    if (changed) {
      this.recomputeActiveControllers();
    }
    this.applyVisualState();
  }

  getActiveController(handedness) {
    const activeId = this.activeByHandedness.get(handedness ?? UNKNOWN_HAND);
    return activeId ? this.entries.get(activeId)?.controller ?? null : null;
  }

  isActiveController(controller) {
    if (!controller?.uniqueId) {
      return false;
    }
    const handedness = controllerHandedness(controller);
    return this.activeByHandedness.get(handedness) === controller.uniqueId;
  }

  recomputeActiveControllers() {
    this.activeByHandedness.clear();
    const bestByHandedness = new Map();

    for (const entry of this.entries.values()) {
      const current = bestByHandedness.get(entry.handedness);
      if (!current || entry.sequence > current.sequence) {
        bestByHandedness.set(entry.handedness, entry);
      }
    }

    for (const [handedness, entry] of bestByHandedness) {
      this.activeByHandedness.set(handedness, entry.controller.uniqueId);
    }
  }

  applyVisualState() {
    for (const entry of this.entries.values()) {
      this.setControllerVisualEnabled(entry.controller, this.isActiveController(entry.controller));
    }
  }

  setControllerVisualEnabled(controller, enabled) {
    for (const node of collectControllerVisualNodes(controller)) {
      if (typeof node.setEnabled === "function") {
        node.setEnabled(enabled);
      } else if ("isVisible" in node) {
        node.isVisible = enabled;
      }
    }
  }

  dispose() {
    for (const entry of this.entries.values()) {
      if (entry.motionControllerObserver) {
        entry.controller.onMotionControllerInitObservable?.remove(entry.motionControllerObserver);
      }
      this.setControllerVisualEnabled(entry.controller, true);
    }
    this.entries.clear();
    this.activeByHandedness.clear();
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

function controllerHandedness(controller) {
  return controller?.inputSource?.handedness ?? UNKNOWN_HAND;
}

function controllerKind(controller) {
  return controller?.inputSource?.hand ? "hand" : "controller";
}

function collectControllerVisualNodes(controller) {
  const nodes = new Set();
  addNode(nodes, controller?.motionController?.rootMesh);
  addNode(nodes, controller?.pointer);
  addNode(nodes, controller?.grip);

  for (const mesh of controller?.motionController?.meshes ?? []) {
    addNode(nodes, mesh);
  }

  for (const value of Object.values(controller ?? {})) {
    collectNodeLikeValue(nodes, value, 0);
  }

  return nodes;
}

function collectNodeLikeValue(nodes, value, depth) {
  if (!value || depth > 1) {
    return;
  }
  if (isBabylonNodeLike(value)) {
    addNode(nodes, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isBabylonNodeLike(item)) {
        addNode(nodes, item);
      }
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const key of ["rootMesh", "mesh", "meshes", "jointMeshes", "_jointMeshes", "_mesh"]) {
    collectNodeLikeValue(nodes, value[key], depth + 1);
  }
}

function isBabylonNodeLike(value) {
  return Boolean(value && typeof value === "object" && (
    typeof value.setEnabled === "function" ||
    typeof value.getChildren === "function" ||
    "isVisible" in value
  ));
}

function addNode(nodes, node) {
  if (!isBabylonNodeLike(node)) {
    return;
  }
  nodes.add(node);
  for (const child of node.getChildren?.() ?? []) {
    addNode(nodes, child);
  }
}
