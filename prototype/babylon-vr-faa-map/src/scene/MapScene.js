import { LayerManager } from "./layers/LayerManager.js?v=20260616-label-diagnostics-v5";
import { VrControlPanel } from "./xr/VrControlPanel.js?v=20260816-forearm-panel-v2";
import { XrInputSourceVisualManager } from "./xr/XrInputSourceVisualManager.js?v=20260617-xr-input-visuals-v1";
import { XrMapManipulator } from "./xr/XrMapManipulator.js?v=20260617-xr-input-visuals-v1";

const VR_FRONT_EDGE_MARGIN_UNITS = 1.15;
const VR_EXTRA_FRONT_CLEARANCE_RATIO = 0.12;
const VR_BASE_VIEW_ELEVATION_DROP_UNITS = 0.9;
const VR_VIEW_ELEVATION_DROP_RATIO = 0.06;
const VR_MAX_VIEW_ELEVATION_DROP_UNITS = 1.35;
const VR_MIN_MAP_CENTER_HEIGHT = 0.42;
const XR_SUPPORT_CHECK_TIMEOUT_MS = 4000;
const XR_INITIALIZATION_TIMEOUT_MS = 12000;

export async function createMapScene(canvas) {
  const engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    antialias: true,
  });

  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.8, 0.86, 0.92, 1);

  const camera = new BABYLON.ArcRotateCamera(
    "main-camera",
    -Math.PI / 2.45,
    1.08,
    18,
    new BABYLON.Vector3(0, 1.15, 0),
    scene,
  );
  camera.lowerRadiusLimit = 4;
  camera.upperRadiusLimit = 38;
  camera.wheelDeltaPercentage = 0.01;
  camera.panningSensibility = 40;
  camera.attachControl(canvas, true);

  const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.9;

  const dir = new BABYLON.DirectionalLight("dir", new BABYLON.Vector3(-0.35, -1, -0.25), scene);
  dir.position = new BABYLON.Vector3(5, 10, 5);
  dir.intensity = 0.45;

  const floor = BABYLON.MeshBuilder.CreateGround("floor", { width: 80, height: 80 }, scene);
  const floorMaterial = new BABYLON.StandardMaterial("floor-material", scene);
  floorMaterial.diffuseColor = new BABYLON.Color3(0.69, 0.75, 0.8);
  floorMaterial.specularColor = BABYLON.Color3.Black();
  floor.material = floorMaterial;

  const mapRoot = new BABYLON.TransformNode("map-root", scene);
  mapRoot.position.y = 1.15;

  const layerManager = new LayerManager(scene, mapRoot);
  const xrAvailabilityObservers = new Set();
  const xrAvailability = await detectVrAvailability();
  let xrHelper = null;
  let vrControlPanel = null;
  let xrMapManipulator = null;
  let xrInputSourceVisualManager = null;
  let pendingVrControlPanelConfig = null;
  let pendingTaskSession = null;
  let pendingTaskEventLog = null;
  let xrInitializationPromise = Promise.resolve(null);

  if (xrAvailability.supported) {
    xrAvailability.initializing = true;
    xrAvailability.reason = "Immersive VR detected. Preparing WebXR controls...";
    xrInitializationPromise = withTimeout(
      scene.createDefaultXRExperienceAsync({
        floorMeshes: [floor],
        uiOptions: {
          sessionMode: "immersive-vr",
          referenceSpaceType: "local-floor",
        },
      }),
      XR_INITIALIZATION_TIMEOUT_MS,
      "WebXR setup timed out. Reload after confirming the headset runtime is active.",
    ).then((helper) => {
      xrHelper = helper;
      xrInputSourceVisualManager = new XrInputSourceVisualManager(scene, xrHelper);
      vrControlPanel = new VrControlPanel(scene, xrHelper, camera, xrInputSourceVisualManager);
      xrMapManipulator = new XrMapManipulator(scene, xrHelper, mapRoot, xrInputSourceVisualManager);
      if (pendingVrControlPanelConfig) {
        vrControlPanel.setConfig(pendingVrControlPanelConfig);
      }
      vrControlPanel.setTaskSession(pendingTaskSession, pendingTaskEventLog);
      xrAvailability.initializing = false;
      xrAvailability.ready = true;
      xrAvailability.reason = "Immersive VR is available.";
      notifyXrAvailabilityObservers(xrAvailabilityObservers, xrAvailability);
      return helper;
    }).catch((error) => {
      console.warn("XR unavailable", error);
      xrAvailability.supported = false;
      xrAvailability.initializing = false;
      xrAvailability.ready = false;
      xrAvailability.reason = error?.message ?? "WebXR initialization failed.";
      notifyXrAvailabilityObservers(xrAvailabilityObservers, xrAvailability);
      return null;
    });
  }

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  const controller = {
    engine,
    scene,
    layerManager,
    async enterVr() {
      if (xrAvailability.initializing) {
        await xrInitializationPromise;
      }
      if (!xrAvailability.supported) {
        throw new Error(xrAvailability.reason);
      }

      if (!xrHelper || !xrHelper.baseExperience) {
        throw new Error("WebXR initialized incompletely. Reload the page and try again.");
      }

      await xrHelper.baseExperience.enterXRAsync("immersive-vr", "local-floor");
      await waitForNextFrame();
      positionMapForInitialVrView(
        xrHelper,
        mapRoot,
        layerManager.getSectionMetrics(),
      );
    },
    hasXr() {
      return xrAvailability.supported && xrAvailability.ready;
    },
    getXrAvailability() {
      return { ...xrAvailability };
    },
    onXrAvailabilityChange(callback) {
      xrAvailabilityObservers.add(callback);
      return () => xrAvailabilityObservers.delete(callback);
    },
    setAirspaceAltitudeMode(enabled) {
      layerManager.setAirspaceAltitudeMode(enabled);
    },
    setVrControlPanel(config) {
      pendingVrControlPanelConfig = config ?? null;
      vrControlPanel?.setConfig(config ?? null);
    },
    setVrTaskSession(taskSession, taskEventLog = null) {
      pendingTaskSession = taskSession ?? null;
      pendingTaskEventLog = taskEventLog ?? null;
      vrControlPanel?.setTaskSession(pendingTaskSession, pendingTaskEventLog);
    },
    dispose() {
      xrAvailabilityObservers.clear();
      xrMapManipulator?.dispose();
      vrControlPanel?.dispose();
      xrInputSourceVisualManager?.dispose();
    },
  };

  return controller;
}

function positionMapForInitialVrView(xrHelper, mapRoot, sectionMetrics) {
  if (!mapRoot || !sectionMetrics) {
    return;
  }

  const xrCamera = xrHelper?.baseExperience?.camera;
  if (!xrCamera) {
    return;
  }

  const viewerPosition = xrCamera.globalPosition ?? xrCamera.position;
  if (!viewerPosition) {
    return;
  }

  const forward = xrCamera.getForwardRay?.(1)?.direction?.clone?.() ?? new BABYLON.Vector3(0, 0, 1);
  forward.y = 0;
  if (forward.lengthSquared() <= 1e-6) {
    forward.set(0, 0, 1);
  } else {
    forward.normalize();
  }

  const mapHalfDepth = (sectionMetrics.worldHeight ?? sectionMetrics.worldWidth ?? 8) * 0.5;
  const frontClearance = Math.max(
    VR_FRONT_EDGE_MARGIN_UNITS,
    (sectionMetrics.worldHeight ?? sectionMetrics.worldWidth ?? 8) * VR_EXTRA_FRONT_CLEARANCE_RATIO,
  );
  const centerDistance = mapHalfDepth + frontClearance;
  const verticalDrop = Math.min(
    VR_MAX_VIEW_ELEVATION_DROP_UNITS,
    VR_BASE_VIEW_ELEVATION_DROP_UNITS + ((sectionMetrics.worldHeight ?? sectionMetrics.worldWidth ?? 8) * VR_VIEW_ELEVATION_DROP_RATIO),
  );
  const nextCenterHeight = Math.max(VR_MIN_MAP_CENTER_HEIGHT, viewerPosition.y - verticalDrop);
  const nextCenter = new BABYLON.Vector3(
    viewerPosition.x + forward.x * centerDistance,
    nextCenterHeight,
    viewerPosition.z + forward.z * centerDistance,
  );

  mapRoot.position.copyFrom(nextCenter);
  mapRoot.rotationQuaternion ??= BABYLON.Quaternion.Identity();
  mapRoot.rotationQuaternion = BABYLON.Quaternion.FromEulerAngles(
    0,
    Math.atan2(forward.x, forward.z),
    0,
  );
}

function waitForNextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function detectVrAvailability() {
  const availability = {
    supported: false,
    initializing: false,
    ready: false,
    reason: "",
  };

  if (!window.isSecureContext) {
    availability.reason = "VR entry requires a secure context. Open the prototype from localhost or HTTPS.";
    return availability;
  }

  if (!navigator.xr || typeof navigator.xr.isSessionSupported !== "function") {
    availability.reason = "This browser does not expose the WebXR API.";
    return availability;
  }

  try {
    const immersiveVrSupported = await withTimeout(
      navigator.xr.isSessionSupported("immersive-vr"),
      XR_SUPPORT_CHECK_TIMEOUT_MS,
      "The browser did not finish checking immersive-vr support.",
    );
    if (!immersiveVrSupported) {
      availability.reason =
        "This browser/device does not support immersive-vr right now. If you're on desktop, make sure a VR headset runtime is active; on mobile, use a browser with WebXR VR support.";
      return availability;
    }
  } catch (error) {
    availability.reason = error?.message ?? "The browser could not confirm immersive-vr support.";
    return availability;
  }

  availability.supported = true;
  availability.reason = "Immersive VR detected.";
  return availability;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function notifyXrAvailabilityObservers(observers, availability) {
  const snapshot = { ...availability };
  for (const callback of observers) {
    callback(snapshot);
  }
}
