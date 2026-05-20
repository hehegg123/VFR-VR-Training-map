import { pixelsToWorldPoint, pixelsToWorldVector2 } from "./geometry/projector.js";

const DEFAULT_WORLD_UNITS_PER_FOOT = 0.00008;
const DEFAULT_MIN_THICKNESS_WORLD = 0.06;
const TOP_OUTLINE_EPSILON = 0.003;
const MAX_PROXY_POINTS_PER_PART = 96;
const PROXY_SIMPLIFY_TOLERANCE_PX = 6;

export class AirspaceAltitudeOverlay {
  constructor(scene, parent, sectionMetrics, config = {}) {
    this.scene = scene;
    this.parent = parent;
    this.sectionMetrics = sectionMetrics;
    this.config = {
      worldUnitsPerFoot: DEFAULT_WORLD_UNITS_PER_FOOT,
      minThicknessWorldUnits: DEFAULT_MIN_THICKNESS_WORLD,
      ...config,
    };
    this.root = new BABYLON.TransformNode("airspace-altitude-root", scene);
    this.root.parent = parent;
    this.root.setEnabled(false);
    this.enabled = false;
    this.layerVisible = true;
    this.selectedRegionId = null;
    this.regionById = new Map();
    this.regionMeshCache = new Map();
    this.activeEntryKey = null;
    this.materialCache = new Map();
  }

  setRegions(regions = []) {
    this.disposeCachedMeshes();
    this.regionById = new Map(regions.map((region) => [region.id, region]));
    this.refresh();
  }

  setConfig(config = {}) {
    this.config = {
      ...this.config,
      ...config,
    };
    this.disposeCachedMeshes();
    this.refresh();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.refresh();
  }

  setLayerVisible(visible) {
    this.layerVisible = Boolean(visible);
    this.refresh();
  }

  setSelection(regionId) {
    this.selectedRegionId = regionId;
    this.refresh();
  }

  refresh() {
    const selectedRegion = this.selectedRegionId ? this.regionById.get(this.selectedRegionId) : null;
    const regions = this.resolveActiveRegions(selectedRegion);
    if (!this.enabled || !this.layerVisible || !regions.length) {
      this.hideActiveEntry();
      this.root.setEnabled(false);
      return;
    }

    const entryKey = activeEntryKeyForRegions(regions);
    if (this.activeEntryKey === entryKey) {
      this.root.setEnabled(true);
      return;
    }

    this.hideActiveEntry();
    const entry = this.getOrBuildRegionEntry(entryKey, regions);
    if (!entry) {
      this.root.setEnabled(false);
      return;
    }
    entry.node.setEnabled(true);
    this.activeEntryKey = entryKey;
    this.root.setEnabled(true);
  }

  getVolumeMaterial(color) {
    const key = `volume:${color.fill}:${color.alpha}`;
    if (this.materialCache.has(key)) {
      return this.materialCache.get(key);
    }

    const material = new BABYLON.StandardMaterial(`airspace-altitude-material-${key}`, this.scene);
    const fillColor = BABYLON.Color3.FromHexString(color.fill);
    material.diffuseColor = fillColor;
    material.emissiveColor = fillColor.scale(0.45);
    material.specularColor = BABYLON.Color3.Black();
    material.alpha = color.alpha;
    material.backFaceCulling = false;
    material.needDepthPrePass = false;
    material.disableLighting = true;
    material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    material.zOffset = -1;
    material.freeze();

    this.materialCache.set(key, material);
    return material;
  }

  resolveActiveRegions(selectedRegion) {
    if (!isAltitudeEligibleRegion(selectedRegion)) {
      return [];
    }

    if (shouldExpandFamilyByShelf(selectedRegion)) {
      const familyRegions = [...this.regionById.values()]
        .filter((region) =>
          region.familyKey === selectedRegion.familyKey
          && region.airspaceType === selectedRegion.airspaceType
          && region.kind === "shelf"
          && isAltitudeEligibleRegion(region)
        )
        .sort((left, right) =>
          (right.priority ?? 0) - (left.priority ?? 0)
          || `${left.id}`.localeCompare(`${right.id}`)
        );
      if (familyRegions.length) {
        return familyRegions;
      }
    }

    return [selectedRegion];
  }

  getOrBuildRegionEntry(entryKey, regions) {
    if (this.regionMeshCache.has(entryKey)) {
      return this.regionMeshCache.get(entryKey);
    }
    const entry = this.buildRegionEntry(entryKey, regions);
    if (entry) {
      this.regionMeshCache.set(entryKey, entry);
    }
    return entry;
  }

  buildRegionEntry(entryKey, regions) {
    const node = new BABYLON.TransformNode(`airspace-altitude-region-${entryKey}`, this.scene);
    node.parent = this.root;
    node.setEnabled(false);
    let meshCount = 0;

    for (const region of regions) {
      const floorFt = Number(region.floorFt ?? 0);
      const ceilingFt = Number(region.proxyCeilingFt ?? region.ceilingFt ?? 0);
      const baseY = floorFt * this.config.worldUnitsPerFoot;
      const topY = Math.max(
        ceilingFt * this.config.worldUnitsPerFoot,
        baseY + (this.config.minThicknessWorldUnits ?? DEFAULT_MIN_THICKNESS_WORLD),
      );
      const height = topY - baseY;
      const color = altitudeColorForRegion(region);

      for (const [partIndex, rawPart] of (region.parts ?? []).entries()) {
        const part = simplifyPolygonPoints(rawPart);
        const points2d = part.map((point) => pixelsToWorldVector2(this.sectionMetrics, point[0], point[1]));
        if (points2d.length < 3) {
          continue;
        }

        const builder = new BABYLON.PolygonMeshBuilder(
          `airspace-altitude-${entryKey}-${region.id}-${partIndex}`,
          points2d,
          this.scene,
          window.earcut,
        );
        const volume = builder.build(false, height);
        volume.parent = node;
        volume.position.y = topY;
        volume.isPickable = false;
        volume.renderingGroupId = 2;
        volume.material = this.getVolumeMaterial(color);
        meshCount += 1;

        const topOutlinePoints = part.map((point) =>
          pixelsToWorldPoint(this.sectionMetrics, point[0], point[1], topY + TOP_OUTLINE_EPSILON),
        );
        if (topOutlinePoints.length >= 2) {
          topOutlinePoints.push(topOutlinePoints[0].clone());
          const topOutline = BABYLON.MeshBuilder.CreateLines(
            `airspace-altitude-top-outline-${entryKey}-${region.id}-${partIndex}`,
            { points: topOutlinePoints },
            this.scene,
          );
          topOutline.parent = node;
          topOutline.isPickable = false;
          topOutline.color = BABYLON.Color3.FromHexString(color.edge);
          topOutline.alpha = 0.95;
          topOutline.renderingGroupId = 2;
          meshCount += 1;
        }
      }
    }

    if (!meshCount) {
      node.dispose(false, true);
      return null;
    }

    return { node };
  }

  hideActiveEntry() {
    if (!this.activeEntryKey) {
      return;
    }
    this.regionMeshCache.get(this.activeEntryKey)?.node.setEnabled(false);
    this.activeEntryKey = null;
  }

  disposeCachedMeshes() {
    this.hideActiveEntry();
    for (const entry of this.regionMeshCache.values()) {
      entry.node.dispose(false, true);
    }
    this.regionMeshCache.clear();
  }

  dispose() {
    this.disposeCachedMeshes();
    for (const material of this.materialCache.values()) {
      material.dispose(false, true);
    }
    this.materialCache.clear();
    this.root?.dispose(false, true);
  }
}

function isAltitudeEligibleRegion(region) {
  if (!region) {
    return false;
  }
  if (!["airfield", "shelf"].includes(region.kind)) {
    return false;
  }
  return Number.isFinite(Number(region.floorFt)) && Number.isFinite(Number(region.proxyCeilingFt ?? region.ceilingFt));
}

function shouldExpandFamilyByShelf(region) {
  return Boolean(
    region
    && region.kind === "airfield"
    && region.familyKey
    && ["CLASS_B", "CLASS_C"].includes(region.airspaceType),
  );
}

function activeEntryKeyForRegions(regions) {
  if (regions.length === 1) {
    return regions[0].id;
  }
  const familyKey = regions[0]?.familyKey;
  if (familyKey) {
    return `family:${familyKey}`;
  }
  return `group:${regions.map((region) => region.id).sort().join("|")}`;
}

function altitudeColorForRegion(region) {
  if (region.kind === "special") {
    return { fill: "#f59e0b", edge: "#fef08a", base: "#fcd34d", alpha: 0.2 };
  }
  if (["CLASS_B", "CLASS_C", "CLASS_D"].includes(region.airspaceType)) {
    return { fill: "#60a5fa", edge: "#dbeafe", base: "#93c5fd", alpha: 0.22 };
  }
  return { fill: "#f472b6", edge: "#fbcfe8", base: "#f9a8d4", alpha: 0.2 };
}

function simplifyPolygonPoints(points) {
  const normalized = normalizeRingPoints(points);
  if (normalized.length <= 8) {
    return normalized;
  }

  const startIndex = farthestPointIndex(normalized);
  const rotated = normalized.slice(startIndex).concat(normalized.slice(0, startIndex));
  const openPath = [...rotated, rotated[0]];
  let simplified = simplifyDouglasPeucker(openPath, PROXY_SIMPLIFY_TOLERANCE_PX).slice(0, -1);
  simplified = removeCollinearRingPoints(simplified);
  simplified = capPointCount(simplified, MAX_PROXY_POINTS_PER_PART);
  return simplified.length >= 3 ? simplified : normalized;
}

function normalizeRingPoints(points) {
  const normalized = [];
  for (const point of points ?? []) {
    if (!Array.isArray(point) || point.length < 2) {
      continue;
    }
    if (!normalized.length || distanceSquared(normalized[normalized.length - 1], point) > 1) {
      normalized.push([point[0], point[1]]);
    }
  }
  if (normalized.length > 1 && distanceSquared(normalized[0], normalized[normalized.length - 1]) <= 1) {
    normalized.pop();
  }
  return normalized;
}

function farthestPointIndex(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  let bestIndex = 0;
  let bestDistance = -1;
  points.forEach(([x, y], index) => {
    const distance = (x - cx) ** 2 + (y - cy) ** 2;
    if (distance > bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function simplifyDouglasPeucker(points, tolerance) {
  if (points.length <= 2) {
    return points;
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;

  while (stack.length) {
    const [startIndex, endIndex] = stack.pop();
    let maxDistanceSq = -1;
    let splitIndex = -1;
    const start = points[startIndex];
    const end = points[endIndex];
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distanceSq = pointSegmentDistanceSquared(points[index], start, end);
      if (distanceSq > maxDistanceSq) {
        maxDistanceSq = distanceSq;
        splitIndex = index;
      }
    }

    if (splitIndex !== -1 && maxDistanceSq > toleranceSq) {
      keep[splitIndex] = 1;
      stack.push([startIndex, splitIndex], [splitIndex, endIndex]);
    }
  }

  return points.filter((_, index) => keep[index]);
}

function pointSegmentDistanceSquared(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) {
    return distanceSquared(point, start);
  }
  const t = Math.max(0, Math.min(1, (((point[0] - start[0]) * dx) + ((point[1] - start[1]) * dy)) / ((dx * dx) + (dy * dy))));
  const px = start[0] + (dx * t);
  const py = start[1] + (dy * t);
  return ((point[0] - px) ** 2) + ((point[1] - py) ** 2);
}

function removeCollinearRingPoints(points) {
  if (points.length <= 3) {
    return points;
  }

  const filtered = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const area = Math.abs(
      (previous[0] * (current[1] - next[1]))
      + (current[0] * (next[1] - previous[1]))
      + (next[0] * (previous[1] - current[1])),
    );
    if (area > 4) {
      filtered.push(current);
    }
  }
  return filtered.length >= 3 ? filtered : points;
}

function capPointCount(points, maxPoints) {
  if (points.length <= maxPoints) {
    return points;
  }
  const stride = Math.ceil(points.length / maxPoints);
  const capped = [];
  for (let index = 0; index < points.length; index += stride) {
    capped.push(points[index]);
  }
  return capped.length >= 3 ? capped : points;
}

function distanceSquared(a, b) {
  return ((a[0] - b[0]) ** 2) + ((a[1] - b[1]) ** 2);
}
