import {
  pixelsToWorldPoint,
  pixelsToWorldUnits,
} from "./geometry/projector.js";
import { DEFAULT_WORLD_UNITS_PER_FOOT, altitudeFeetToWorld } from "./geometry/altitudeScale.js";

const EVENT_BASE_ELEVATION = 0.065;
const DEFAULT_AIRCRAFT_ALTITUDE_FT = 1200;
const DEFAULT_WEATHER_BASE_FT = 1000;
const DEFAULT_WEATHER_TOP_FT = 3000;
const MIN_WEATHER_THICKNESS_WORLD = 0.12;
const CLOUD_PUFF_COUNT = 9;
const DEFAULT_AIRCRAFT_MODEL_URL = new URL("../../../assets/models/airplane_crj-900_cityjet.glb", import.meta.url).href;
const DEFAULT_AIRCRAFT_MODEL_LENGTH_WORLD = 0.14;

export class EventOverlayLayer {
  constructor(scene, parent, sectionMetrics, resolveTargetPoint = null, altitudeConfig = {}) {
    this.scene = scene;
    this.parent = parent;
    this.sectionMetrics = sectionMetrics;
    this.resolveTargetPoint = resolveTargetPoint;
    this.altitudeConfig = {
      worldUnitsPerFoot: DEFAULT_WORLD_UNITS_PER_FOOT,
      ...altitudeConfig,
    };
    this.root = new BABYLON.TransformNode("event-overlay-root", scene);
    this.root.parent = parent;
    this.meshes = [];
    this.nodes = [];
    this.materials = [];
    this.textures = [];
    this.renderGeneration = 0;
    this.currentEventSetId = null;
    this.eventRoots = new Map();
    this.aircraftNodes = new Map();
  }

  setSnapshot(snapshot) {
    if (!snapshot || snapshot.disposed) {
      if (this.currentEventSetId !== null || this.eventRoots.size > 0) {
        this.clear();
      }
      return;
    }

    if (snapshot.eventSetId !== this.currentEventSetId) {
      this.clear();
      this.currentEventSetId = snapshot.eventSetId;
      const generation = this.renderGeneration;
      const aircraftStates = new Map(
        (snapshot.aircraftStates ?? []).map((state) => [state.eventId, state]),
      );
      for (const event of snapshot.events ?? []) {
        const eventRoot = new BABYLON.TransformNode(`event-root-${event.id}`, this.scene);
        eventRoot.parent = this.root;
        this.nodes.push(eventRoot);
        this.eventRoots.set(event.id, eventRoot);
        if (event.type === "weather") {
          this.renderWeather(event, eventRoot);
        } else if (event.type === "aircraft") {
          this.renderAircraft(event, aircraftStates.get(event.id), generation, eventRoot);
        }
      }
    }

    const activeEventIds = new Set(snapshot.activeEventIds ?? []);
    for (const [eventId, eventRoot] of this.eventRoots) {
      eventRoot.setEnabled(activeEventIds.has(eventId));
    }
    this.updateAircraftStates(snapshot);
  }

  updateAircraftStates(snapshot) {
    const eventsById = new Map((snapshot.events ?? []).map((event) => [event.id, event]));
    for (const state of snapshot.aircraftStates ?? []) {
      const event = eventsById.get(state.eventId);
      const node = this.aircraftNodes.get(state.eventId);
      if (event && node) {
        this.updateAircraftTransform(event, state, node);
      }
    }
  }

  updateAircraftTransform(event, state, node) {
    const position = state?.position ?? event.position;
    const altitude = state?.altitude ?? event.altitude;
    const point = this.resolveEventPoint(
      { ...event, position, altitude },
      this.aircraftElevation({ altitude }),
    );
    if (!point) {
      return;
    }
    node.position.copyFrom(point);
    node.rotation.y = toRadians(
      Number(state?.headingDeg ?? event.orientation?.headingDeg ?? 0)
        + Number(event.visual?.headingOffsetDeg ?? 0),
    );
  }

  renderWeather(event, eventRoot) {
    const geometry = event.geometry;
    const altitude = weatherAltitudeRange(event, this.altitudeConfig.worldUnitsPerFoot);
    const baseY = EVENT_BASE_ELEVATION + altitude.baseY;
    const topY = Math.max(EVENT_BASE_ELEVATION + altitude.topY, baseY + MIN_WEATHER_THICKNESS_WORLD);
    const centerY = (baseY + topY) / 2;
    const height = topY - baseY;
    let labelPoint = null;
    let footprint = null;
    if (geometry?.type === "circle") {
      const center = this.normalizedToWorld(geometry.x, geometry.y, centerY);
      const radius = pixelsToWorldUnits(this.sectionMetrics, geometry.radius * this.sectionMetrics.pixelWidth);
      footprint = { center, radius };
      labelPoint = center.clone();
      labelPoint.y = topY + 0.14;
    } else if (geometry?.type === "polygon" && Array.isArray(geometry.points)) {
      const points = geometry.points.map((point) =>
        normalizedToWorldVector2(this.sectionMetrics, point[0], point[1]));
      if (points.length >= 3) {
        const builder = new BABYLON.PolygonMeshBuilder(`event-weather-${event.id}`, points, this.scene, window.earcut);
        const mesh = builder.build(false, height);
        mesh.parent = eventRoot;
        mesh.position.y = topY;
        mesh.isPickable = false;
        mesh.material = this.createMaterial(
          `event-weather-volume-material-${event.id}`,
          "#0ea5e9",
          event.visual?.opacity ?? 0.22,
        );
        this.meshes.push(mesh);
        labelPoint = centroidWorldPoint(points, topY + 0.14);
        footprint = { center: centroidWorldPoint(points, centerY), radius: approximateRadius(points) };
      }
    } else {
      const center = this.resolveEventPoint(event, centerY);
      if (center) {
        footprint = { center, radius: 0.42 };
        labelPoint = center.clone();
        labelPoint.y = topY + 0.14;
      }
    }

    if (footprint) {
      this.createCloudVolume(event, footprint.center, footprint.radius, baseY, topY, eventRoot);
    }
    if (labelPoint && event.visual?.label) {
      this.createBillboardLabel(
        `event-weather-label-${event.id}`,
        `${event.visual.label} ${formatAltitudeRange(event.altitude)}`,
        labelPoint,
        "#0369a1",
        "#e0f2fe",
        eventRoot,
      );
    }
  }

  renderAircraft(event, state, generation, eventRoot) {
    this.aircraftNodes.set(event.id, eventRoot);
    this.updateAircraftTransform(event, state, eventRoot);
    this.createAircraftModel(event, eventRoot, generation);

    if (event.visual?.label) {
      this.createBillboardLabel(
        `event-aircraft-label-${event.id}`,
        `${event.visual.label} ${formatAltitudeValue(state?.altitude ?? event.altitude)}`,
        new BABYLON.Vector3(0, 0.14, 0),
        "#7f1d1d",
        "#fee2e2",
        eventRoot,
      );
    }
  }

  async createAircraftModel(event, node, generation) {
    const scale = Number.isFinite(Number(event.visual?.scale)) ? Number(event.visual.scale) : 1;
    const placeholder = this.createProceduralAircraftModel(event, node, scale);

    if (event.visual?.model !== "procedural-aircraft") {
      const loaded = await this.tryAttachAircraftModel(event, node, scale, generation);
      if (loaded) {
        this.disposeAircraftPlaceholder(placeholder);
        return;
      }
    }

    if (generation !== this.renderGeneration || !this.root || node.isDisposed()) {
      this.disposeAircraftPlaceholder(placeholder);
      return;
    }
  }

  createProceduralAircraftModel(event, node, scale) {
    const material = this.createMaterial(`event-aircraft-material-${event.id}`, "#ef4444", 0.95);
    const darkMaterial = this.createMaterial(`event-aircraft-tail-material-${event.id}`, "#991b1b", 0.95);
    const lengthScale = (DEFAULT_AIRCRAFT_MODEL_LENGTH_WORLD / 0.28) * scale;
    const body = BABYLON.MeshBuilder.CreateBox(
      `event-aircraft-body-${event.id}`,
      { width: 0.055 * lengthScale, height: 0.035 * lengthScale, depth: 0.24 * lengthScale },
      this.scene,
    );
    const wings = BABYLON.MeshBuilder.CreateBox(
      `event-aircraft-wings-${event.id}`,
      { width: 0.28 * lengthScale, height: 0.018 * lengthScale, depth: 0.045 * lengthScale },
      this.scene,
    );
    const tail = BABYLON.MeshBuilder.CreateBox(
      `event-aircraft-tail-${event.id}`,
      { width: 0.16 * lengthScale, height: 0.018 * lengthScale, depth: 0.035 * lengthScale },
      this.scene,
    );
    const nose = BABYLON.MeshBuilder.CreateCylinder(
      `event-aircraft-nose-${event.id}`,
      { height: 0.052 * lengthScale, diameterTop: 0, diameterBottom: 0.055 * lengthScale, tessellation: 12 },
      this.scene,
    );

    for (const mesh of [body, wings, tail, nose]) {
      mesh.parent = node;
      mesh.isPickable = false;
      mesh.material = mesh === tail ? darkMaterial : material;
      this.meshes.push(mesh);
    }
    body.position.z = 0;
    wings.position.z = -0.015 * lengthScale;
    tail.position.z = 0.105 * lengthScale;
    nose.position.z = -0.146 * lengthScale;
    nose.rotation.x = Math.PI / 2;
    return { meshes: [body, wings, tail, nose], materials: [material, darkMaterial] };
  }

  disposeAircraftPlaceholder(placeholder) {
    if (!placeholder) {
      return;
    }
    const placeholderMeshes = new Set(placeholder.meshes ?? []);
    const placeholderMaterials = new Set(placeholder.materials ?? []);
    for (const mesh of placeholderMeshes) {
      mesh.dispose(false, true);
    }
    for (const material of placeholderMaterials) {
      material.dispose(false, true);
    }
    this.meshes = this.meshes.filter((mesh) => !placeholderMeshes.has(mesh));
    this.materials = this.materials.filter((material) => !placeholderMaterials.has(material));
  }

  async tryAttachAircraftModel(event, node, scale, generation) {
    const modelUrl = event.visual?.modelUrl ?? DEFAULT_AIRCRAFT_MODEL_URL;
    if (!modelUrl || !BABYLON.SceneLoader?.ImportMeshAsync) {
      return false;
    }

    let result;
    try {
      result = await BABYLON.SceneLoader.ImportMeshAsync("", "", modelUrl, this.scene);
    } catch (error) {
      console.warn(`Unable to load aircraft model for event ${event.id}; using generated fallback.`, error);
      return false;
    }

    const importedMeshes = (result.meshes ?? []).filter((mesh) => mesh instanceof BABYLON.AbstractMesh);
    const importedTransformNodes = (result.transformNodes ?? []).filter((transformNode) => transformNode !== node);
    if (generation !== this.renderGeneration || !this.root || node.isDisposed()) {
      disposeImportedAircraft(result);
      return false;
    }
    const geometryMeshes = importedMeshes.filter((mesh) => Number(mesh.getTotalVertices?.() ?? 0) > 0);
    if (!geometryMeshes.length) {
      disposeImportedAircraft(result);
      return false;
    }

    const modelRoot = new BABYLON.TransformNode(`event-aircraft-model-root-${event.id}`, this.scene);
    modelRoot.parent = node;
    this.nodes.push(modelRoot);
    for (const transformNode of importedTransformNodes) {
      if (!transformNode.parent) {
        transformNode.parent = modelRoot;
      }
      this.nodes.push(transformNode);
    }
    for (const mesh of importedMeshes) {
      if (!mesh.parent) {
        mesh.parent = modelRoot;
      }
      mesh.isPickable = false;
      this.meshes.push(mesh);
    }

    normalizeAircraftModel(modelRoot, geometryMeshes, scale);
    return true;
  }

  createCloudVolume(event, center, radius, baseY, topY, eventRoot) {
    const material = this.createMaterial(
      `event-cloud-material-${event.id}`,
      "#e0f2fe",
      event.visual?.opacity ?? 0.55,
    );
    const outline = BABYLON.MeshBuilder.CreateCylinder(
      `event-cloud-volume-${event.id}`,
      {
        height: topY - baseY,
        diameter: radius * 2,
        tessellation: 36,
      },
      this.scene,
    );
    outline.parent = eventRoot;
    outline.position = center.clone();
    outline.position.y = (baseY + topY) / 2;
    outline.isPickable = false;
    outline.material = this.createMaterial(`event-cloud-volume-material-${event.id}`, "#38bdf8", 0.12);
    this.meshes.push(outline);

    for (let index = 0; index < CLOUD_PUFF_COUNT; index += 1) {
      const angle = (index / CLOUD_PUFF_COUNT) * Math.PI * 2;
      const ring = index % 3;
      const radial = ring === 0 ? 0 : radius * (ring === 1 ? 0.35 : 0.62);
      const yRatio = CLOUD_PUFF_COUNT === 1 ? 0.5 : index / (CLOUD_PUFF_COUNT - 1);
      const puff = BABYLON.MeshBuilder.CreateSphere(
        `event-cloud-puff-${event.id}-${index}`,
        {
          segments: 12,
          diameter: Math.max(0.12, radius * (ring === 0 ? 0.7 : 0.46)),
        },
        this.scene,
      );
      puff.parent = eventRoot;
      puff.position = new BABYLON.Vector3(
        center.x + Math.cos(angle) * radial,
        baseY + (topY - baseY) * yRatio,
        center.z + Math.sin(angle) * radial,
      );
      puff.scaling.y = 0.58;
      puff.isPickable = false;
      puff.material = material;
      this.meshes.push(puff);
    }
  }

  aircraftElevation(event) {
    const altitudeFt = Number.isFinite(Number(event.altitude?.valueFt))
      ? Number(event.altitude.valueFt)
      : DEFAULT_AIRCRAFT_ALTITUDE_FT;
    return EVENT_BASE_ELEVATION + altitudeFeetToWorld(altitudeFt, this.altitudeConfig.worldUnitsPerFoot);
  }

  resolveEventPoint(event, elevation) {
    if (event.position) {
      return this.normalizedToWorld(event.position.x, event.position.y, elevation);
    }
    if (event.target && this.resolveTargetPoint) {
      const chartPoint = this.resolveTargetPoint(event.target);
      if (chartPoint) {
        return pixelsToWorldPoint(this.sectionMetrics, chartPoint.x, chartPoint.y, elevation);
      }
    }
    return null;
  }

  normalizedToWorld(x, y, elevation) {
    return pixelsToWorldPoint(
      this.sectionMetrics,
      x * this.sectionMetrics.pixelWidth,
      y * this.sectionMetrics.pixelHeight,
      elevation,
    );
  }

  createBillboardLabel(name, text, point, background, color, parent = this.root) {
    const width = 360;
    const height = 88;
    const texture = new BABYLON.DynamicTexture(`${name}-texture`, { width, height }, this.scene, false);
    const context = texture.getContext();
    context.clearRect(0, 0, width, height);
    context.fillStyle = background;
    roundRect(context, 8, 8, width - 16, height - 16, 18);
    context.fill();
    context.fillStyle = color;
    context.font = `700 ${fitCanvasFont(context, `${text}`, 28, width - 36)}px Segoe UI, Arial, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(`${text}`, width / 2, height / 2 + 2);
    texture.update();

    const material = new BABYLON.StandardMaterial(`${name}-material`, this.scene);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.diffuseColor = BABYLON.Color3.White();
    material.emissiveColor = BABYLON.Color3.White();
    material.specularColor = BABYLON.Color3.Black();
    material.backFaceCulling = false;

    const plane = BABYLON.MeshBuilder.CreatePlane(name, { width: 0.72, height: 0.25 }, this.scene);
    plane.parent = parent;
    plane.position = point.clone();
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    plane.material = material;
    this.meshes.push(plane);
    this.materials.push(material);
    this.textures.push(texture);
  }

  createMaterial(name, hexColor, alpha) {
    const material = new BABYLON.StandardMaterial(name, this.scene);
    material.diffuseColor = BABYLON.Color3.FromHexString(hexColor);
    material.emissiveColor = BABYLON.Color3.FromHexString(hexColor);
    material.specularColor = BABYLON.Color3.Black();
    material.alpha = alpha;
    material.backFaceCulling = false;
    material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    material.disableLighting = true;
    this.materials.push(material);
    return material;
  }

  clear({ invalidatePendingLoads = true } = {}) {
    if (invalidatePendingLoads) {
      this.renderGeneration += 1;
    }
    for (const mesh of this.meshes) {
      mesh.dispose(false, true);
    }
    for (const node of this.nodes) {
      node.dispose(false, true);
    }
    for (const material of this.materials) {
      material.dispose(false, true);
    }
    for (const texture of this.textures) {
      texture.dispose();
    }
    this.meshes = [];
    this.nodes = [];
    this.materials = [];
    this.textures = [];
    this.currentEventSetId = null;
    this.eventRoots.clear();
    this.aircraftNodes.clear();
  }

  dispose() {
    this.clear();
    this.root?.dispose(false, true);
    this.root = null;
  }
}

function normalizedToWorldVector2(sectionMetrics, x, y) {
  const point = pixelsToWorldPoint(
    sectionMetrics,
    x * sectionMetrics.pixelWidth,
    y * sectionMetrics.pixelHeight,
    0,
  );
  return new BABYLON.Vector2(point.x, point.z);
}

function centroidWorldPoint(points, elevation) {
  if (!points.length) {
    return null;
  }
  const sum = points.reduce((accumulator, point) => ({
    x: accumulator.x + point.x,
    y: accumulator.y + point.y,
  }), { x: 0, y: 0 });
  return new BABYLON.Vector3(sum.x / points.length, elevation, sum.y / points.length);
}

function approximateRadius(points) {
  if (!points.length) {
    return 0.42;
  }
  const center = centroidWorldPoint(points, 0);
  if (!center) {
    return 0.42;
  }
  return Math.max(
    0.2,
    ...points.map((point) => Math.hypot(point.x - center.x, point.y - center.z)),
  );
}

function weatherAltitudeRange(event, worldUnitsPerFoot) {
  const baseFt = Number.isFinite(Number(event.altitude?.baseFt)) ? Number(event.altitude.baseFt) : DEFAULT_WEATHER_BASE_FT;
  const topFt = Number.isFinite(Number(event.altitude?.topFt)) ? Number(event.altitude.topFt) : DEFAULT_WEATHER_TOP_FT;
  return {
    baseY: altitudeFeetToWorld(baseFt, worldUnitsPerFoot),
    topY: altitudeFeetToWorld(Math.max(baseFt, topFt), worldUnitsPerFoot),
  };
}

function formatAltitudeValue(altitude) {
  const reference = altitude?.reference ?? "MSL";
  const value = Number.isFinite(Number(altitude?.valueFt)) ? Number(altitude.valueFt) : DEFAULT_AIRCRAFT_ALTITUDE_FT;
  return `${Math.round(value)} ${reference}`;
}

function formatAltitudeRange(altitude) {
  const reference = altitude?.reference ?? "MSL";
  const base = Number.isFinite(Number(altitude?.baseFt)) ? Number(altitude.baseFt) : DEFAULT_WEATHER_BASE_FT;
  const top = Number.isFinite(Number(altitude?.topFt)) ? Number(altitude.topFt) : DEFAULT_WEATHER_TOP_FT;
  return `${Math.round(base)}-${Math.round(Math.max(base, top))} ${reference}`;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function normalizeAircraftModel(modelRoot, meshes, scale) {
  const bounds = combinedBoundingBoxInModelSpace(modelRoot, meshes);
  if (!bounds) {
    return;
  }
  const size = bounds.max.subtract(bounds.min);
  const longestAxis = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(longestAxis) || longestAxis <= 0) {
    return;
  }
  const targetLength = DEFAULT_AIRCRAFT_MODEL_LENGTH_WORLD * scale;
  const scaleFactor = targetLength / longestAxis;
  const center = bounds.min.add(size.scale(0.5));
  modelRoot.scaling.setAll(scaleFactor);
  modelRoot.position.copyFrom(center.scale(-scaleFactor));
}

function combinedBoundingBoxInModelSpace(modelRoot, meshes) {
  modelRoot.computeWorldMatrix(true);
  const inverseModelWorld = modelRoot.getWorldMatrix().clone().invert();
  let min = null;
  let max = null;
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    const boundingBox = mesh.getBoundingInfo?.().boundingBox;
    if (!boundingBox) {
      continue;
    }
    for (const corner of boundingBox.vectorsWorld ?? []) {
      const localCorner = BABYLON.Vector3.TransformCoordinates(corner, inverseModelWorld);
      min = min ? BABYLON.Vector3.Minimize(min, localCorner) : localCorner.clone();
      max = max ? BABYLON.Vector3.Maximize(max, localCorner) : localCorner.clone();
    }
  }
  return min && max ? { min, max } : null;
}

function disposeImportedAircraft(result) {
  for (const mesh of result?.meshes ?? []) {
    mesh.dispose?.(false, true);
  }
  for (const transformNode of result?.transformNodes ?? []) {
    transformNode.dispose?.(false, true);
  }
  for (const animationGroup of result?.animationGroups ?? []) {
    animationGroup.dispose?.();
  }
}

function fitCanvasFont(context, text, initialSize, maxWidth) {
  let size = initialSize;
  while (size > 16) {
    context.font = `700 ${size}px Segoe UI, Arial, sans-serif`;
    if (context.measureText(text).width <= maxWidth) {
      return size;
    }
    size -= 1;
  }
  return 16;
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
