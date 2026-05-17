import {
  pixelsToWorldPoint,
  pixelsToWorldUnits,
  pixelsToWorldVector2,
} from "./geometry/projector.js";

const FEATURE_SURFACE_EPSILON = 0.0014;
const FEATURE_OUTLINE_EPSILON = 0.0022;

export class VectorOverlayLayer {
  constructor(scene, parent, definition, sectionMetrics, overlayPayload, orderIndex) {
    this.scene = scene;
    this.parent = parent;
    this.definition = definition;
    this.sectionMetrics = sectionMetrics;
    this.overlayPayload = overlayPayload;
    this.orderIndex = orderIndex;
    this.root = null;
    this.materialCache = new Map();
    this.childMeshes = [];
    this.selectionRegions = new Map();
    this.selectedSelectionId = null;
  }

  async load() {
    this.root = new BABYLON.TransformNode(`vector-layer-${this.definition.id}`, this.scene);
    this.root.parent = this.parent;
    this.root.position.y = this.definition.id === "base" ? 0 : 0.02 + this.orderIndex * 0.01;

    const groups = new Map();
    const primitives = this.overlayPayload.primitives ?? {};

    this.buildPolygons(groups, primitives.polygons ?? []);
    this.buildStrokes(groups, primitives.strokes ?? []);
    this.buildCircles(groups, primitives.circles ?? []);
    this.buildMarkers(groups, primitives.markers ?? []);
    this.buildRunwayBars(groups, primitives.runwayBars ?? []);

    this.flushGroups(groups);
    if (this.definition.id === "airspace") {
      this.buildInteractionRegions(this.overlayPayload.interactionRegions ?? []);
    }
    this.setVisible(this.definition.defaultVisible !== false);
  }

  buildPolygons(groups, polygons) {
    for (const polygon of polygons) {
      const points = (polygon.points ?? []).map((point) =>
        pixelsToWorldVector2(this.sectionMetrics, point[0], point[1]),
      );
      if (points.length < 3) {
        continue;
      }

      const builder = new BABYLON.PolygonMeshBuilder(
        `polygon-${this.definition.id}-${polygon.id}`,
        points,
        this.scene,
        window.earcut,
      );
      if (polygon.fill) {
        const mesh = builder.build(false, 0);
        mesh.rotation.x = 0;
        mesh.position.y = 0;
        mesh.isPickable = false;
        mesh.material = this.getMaterial({
          key: `fill:${polygon.fill}:${polygon.fillAlpha ?? 1}`,
          color: polygon.fill,
          alpha: polygon.fillAlpha ?? 1,
        });
        this.pushGroupMesh(groups, `fill:${polygon.fill}:${polygon.fillAlpha ?? 1}`, mesh);
      }

      if (polygon.stroke) {
        this.buildStrokePath(groups, polygon, polygon.points ?? [], {
          key: `stroke:${polygon.stroke}:${polygon.strokeWidthPx}:${polygon.strokeAlpha ?? 1}`,
          color: polygon.stroke,
          widthPx: polygon.strokeWidthPx,
          alpha: polygon.strokeAlpha ?? 1,
          closed: true,
          allowMerge: this.definition.polygonStrokeMerge ?? true,
        }, polygon.dashPatternPx ?? null);
      }
    }
  }

  buildStrokes(groups, strokes) {
    for (const stroke of strokes) {
      this.buildStrokePath(groups, stroke, stroke.points ?? [], {
        key: `stroke:${stroke.color}:${stroke.widthPx}:${stroke.alpha ?? 1}`,
        color: stroke.color,
        widthPx: stroke.widthPx,
        alpha: stroke.alpha ?? 1,
        closed: stroke.closed,
        haloColor: stroke.haloColor,
        haloWidthPx: stroke.haloWidthPx,
        haloAlpha: stroke.haloAlpha,
        allowMerge: this.definition.strokeSegmentMerge ?? false,
      }, stroke.dashPatternPx ?? null);
    }
  }

  buildStrokePath(groups, stroke, pixelPoints, style, dashPattern = null) {
    if (!pixelPoints || pixelPoints.length < 2) {
      return;
    }

    if (this.definition.strokeRenderMode === "lines" && !style.haloColor) {
      this.buildLinePath(groups, stroke, pixelPoints, style, dashPattern);
      return;
    }

    const subpaths = dashPattern
      ? createDashedSubpaths(pixelPoints, dashPattern)
      : [pixelPoints];

    if (style.haloColor && style.haloWidthPx) {
      for (const subpath of subpaths) {
        this.buildStrokePath(groups, stroke, subpath, {
          key: `stroke-halo:${style.haloColor}:${style.haloWidthPx}:${style.haloAlpha ?? 1}`,
          color: style.haloColor,
          widthPx: style.haloWidthPx,
          alpha: style.haloAlpha ?? 1,
          closed: style.closed,
          allowMerge: style.allowMerge,
        });
      }
    }

    for (const subpath of subpaths) {
      this.buildStrokeSegments(groups, stroke, subpath, style);
    }
  }

  buildLinePath(groups, stroke, pixelPoints, style, dashPattern = null) {
    const basePoints = pixelPoints.map((point) =>
      pixelsToWorldPoint(this.sectionMetrics, point[0], point[1], 0),
    );
    if (basePoints.length < 2) {
      return;
    }

    const points = [...basePoints];
    if (style.closed && points.length > 2) {
      points.push(basePoints[0].clone());
    }

    let mesh = null;
    if (dashPattern && dashPattern.length >= 2) {
      mesh = BABYLON.MeshBuilder.CreateDashedLines(
        `${stroke.id}-${style.key}`,
        {
          points,
          dashSize: pixelsToWorldUnits(this.sectionMetrics, dashPattern[0]),
          gapSize: pixelsToWorldUnits(this.sectionMetrics, dashPattern[1]),
          dashNb: Math.max(points.length * 2, 32),
        },
        this.scene,
      );
    } else {
      mesh = BABYLON.MeshBuilder.CreateLines(
        `${stroke.id}-${style.key}`,
        { points },
        this.scene,
      );
    }

    mesh.isPickable = false;
    mesh.position.y += 0.0008;
    mesh.color = BABYLON.Color3.FromHexString(style.color);
    mesh.alpha = style.alpha ?? 1;
    this.pushGroupMesh(groups, style.key, mesh, { allowMerge: false });
  }

  buildStrokeSegments(groups, stroke, pixelPoints, style) {
    if (!pixelPoints || pixelPoints.length < 2) {
      return;
    }

    const points = pixelPoints.map((point) =>
      pixelsToWorldPoint(this.sectionMetrics, point[0], point[1], 0),
    );
    const pairs = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      pairs.push([points[index], points[index + 1]]);
    }
    if (style.closed && points.length > 2) {
      pairs.push([points[points.length - 1], points[0]]);
    }

    const strokeRenderer = this.definition.strokePresentation === "tube"
      ? createTubeSegment
      : createStripSegment;
    const widthScale = this.definition.strokeWidthScale ?? 1;
    const strokeWidth = pixelsToWorldUnits(this.sectionMetrics, style.widthPx) * widthScale;
    const minTubeRadius = this.definition.minStrokeRadiusWorld ?? 0.0025;

    for (let index = 0; index < pairs.length; index += 1) {
      const mesh = strokeRenderer(
        this.scene,
        `${stroke.id}-${style.key}-${index}`,
        pairs[index][0],
        pairs[index][1],
        strokeWidth,
        minTubeRadius,
      );
      mesh.isPickable = false;
      mesh.material = this.getMaterial({
        key: style.key,
        color: style.color,
        alpha: style.alpha,
      });
      this.pushGroupMesh(groups, style.key, mesh, { allowMerge: style.allowMerge ?? false });
    }
  }

  buildCircles(groups, circles) {
    for (const circle of circles) {
      const center = pixelsToWorldPoint(this.sectionMetrics, circle.center[0], circle.center[1], 0);
      const radius = pixelsToWorldUnits(this.sectionMetrics, circle.radiusPx ?? 0);
      const strokeWidth = pixelsToWorldUnits(this.sectionMetrics, circle.strokeWidthPx ?? 0);

      if (circle.stroke) {
        const outer = BABYLON.MeshBuilder.CreateDisc(
          `circle-outer-${circle.id}`,
          { radius: radius, tessellation: 24, sideOrientation: BABYLON.Mesh.DOUBLESIDE },
          this.scene,
        );
        outer.rotation.x = Math.PI / 2;
        outer.position = center.clone();
        outer.position.y += 0.0006;
        outer.isPickable = false;
        outer.material = this.getMaterial({
          key: `circle-stroke:${circle.stroke}:${circle.alpha ?? 1}`,
          color: circle.stroke,
          alpha: circle.alpha ?? 1,
        });
        this.pushGroupMesh(groups, `circle-stroke:${circle.stroke}:${circle.alpha ?? 1}`, outer);

        if (circle.fill) {
          const innerRadius = Math.max(radius - strokeWidth, radius * 0.1);
          const inner = BABYLON.MeshBuilder.CreateDisc(
            `circle-inner-${circle.id}`,
            { radius: innerRadius, tessellation: 24, sideOrientation: BABYLON.Mesh.DOUBLESIDE },
            this.scene,
          );
          inner.rotation.x = Math.PI / 2;
          inner.position = center.clone();
          inner.position.y += 0.0012;
          inner.isPickable = false;
          inner.material = this.getMaterial({
            key: `circle-fill:${circle.fill}:${circle.alpha ?? 1}`,
            color: circle.fill,
            alpha: circle.alpha ?? 1,
          });
          this.pushGroupMesh(groups, `circle-fill:${circle.fill}:${circle.alpha ?? 1}`, inner);
        }
        continue;
      }

      const disc = BABYLON.MeshBuilder.CreateDisc(
        `circle-${circle.id}`,
        { radius, tessellation: 24, sideOrientation: BABYLON.Mesh.DOUBLESIDE },
        this.scene,
      );
      disc.rotation.x = Math.PI / 2;
      disc.position = center.clone();
      disc.position.y += 0.001;
      disc.isPickable = false;
      disc.material = this.getMaterial({
        key: `circle-fill:${circle.fill}:${circle.alpha ?? 1}`,
        color: circle.fill ?? "#ffffff",
        alpha: circle.alpha ?? 1,
      });
      this.pushGroupMesh(groups, `circle-fill:${circle.fill}:${circle.alpha ?? 1}`, disc);
    }
  }

  buildMarkers(groups, markers) {
    for (const marker of markers) {
      const center = pixelsToWorldPoint(this.sectionMetrics, marker.center[0], marker.center[1], 0);
      const halfSize = pixelsToWorldUnits(this.sectionMetrics, (marker.sizePx ?? 0) / 2);
      const width = pixelsToWorldUnits(this.sectionMetrics, marker.widthPx ?? 0);
      const segments = [];

      if (marker.symbol === "plus") {
        segments.push([
          center.add(new BABYLON.Vector3(-halfSize, 0, 0)),
          center.add(new BABYLON.Vector3(halfSize, 0, 0)),
        ]);
        segments.push([
          center.add(new BABYLON.Vector3(0, 0, -halfSize)),
          center.add(new BABYLON.Vector3(0, 0, halfSize)),
        ]);
      } else {
        segments.push([
          center.add(new BABYLON.Vector3(-halfSize, 0, -halfSize)),
          center.add(new BABYLON.Vector3(halfSize, 0, halfSize)),
        ]);
        segments.push([
          center.add(new BABYLON.Vector3(-halfSize, 0, halfSize)),
          center.add(new BABYLON.Vector3(halfSize, 0, -halfSize)),
        ]);
      }

      const materialKey = `marker:${marker.color}:${marker.alpha ?? 1}`;
      for (let index = 0; index < segments.length; index += 1) {
        const mesh = createStripSegment(
          this.scene,
          `marker-${marker.id}-${index}`,
          segments[index][0],
          segments[index][1],
          width,
        );
        mesh.isPickable = false;
        mesh.material = this.getMaterial({
          key: materialKey,
          color: marker.color,
          alpha: marker.alpha ?? 1,
        });
        this.pushGroupMesh(groups, materialKey, mesh, { allowMerge: false });
      }
    }
  }

  buildRunwayBars(groups, runwayBars) {
    for (const bar of runwayBars) {
      const center = pixelsToWorldPoint(this.sectionMetrics, bar.center[0], bar.center[1], 0);
      const length = pixelsToWorldUnits(this.sectionMetrics, bar.lengthPx);
      const width = pixelsToWorldUnits(this.sectionMetrics, bar.widthPx);
      const rotation = -toRadians(bar.angleDeg ?? 0);

      if (bar.haloColor && bar.haloPaddingPx) {
        const halo = BABYLON.MeshBuilder.CreateGround(
          `runway-halo-${bar.id}`,
          {
            width: length + pixelsToWorldUnits(this.sectionMetrics, bar.haloPaddingPx * 2),
            height: width + pixelsToWorldUnits(this.sectionMetrics, bar.haloPaddingPx * 2),
          },
          this.scene,
        );
        halo.position = center.clone();
        halo.position.y += 0.0004;
        halo.rotation.y = rotation;
        halo.isPickable = false;
        halo.material = this.getMaterial({
          key: `runway-halo:${bar.haloColor}`,
          color: bar.haloColor,
          alpha: bar.alpha ?? 1,
        });
        this.pushGroupMesh(groups, `runway-halo:${bar.haloColor}`, halo);
      }

      const mesh = BABYLON.MeshBuilder.CreateGround(
        `runway-${bar.id}`,
        { width: length, height: width },
        this.scene,
      );
      mesh.position = center.clone();
      mesh.position.y += 0.0011;
      mesh.rotation.y = rotation;
      mesh.isPickable = false;
      mesh.material = this.getMaterial({
        key: `runway:${bar.fill}:${bar.alpha ?? 1}`,
        color: bar.fill,
        alpha: bar.alpha ?? 1,
      });
      this.pushGroupMesh(groups, `runway:${bar.fill}:${bar.alpha ?? 1}`, mesh);
    }
  }

  pushGroupMesh(groups, key, mesh, options = {}) {
    if (!groups.has(key)) {
      groups.set(key, {
        meshes: [],
        allowMerge: options.allowMerge ?? true,
      });
    }
    const group = groups.get(key);
    group.meshes.push(mesh);
    group.allowMerge = group.allowMerge && (options.allowMerge ?? true);
  }

  flushGroups(groups) {
    for (const group of groups.values()) {
      const { meshes, allowMerge } = group;
      if (meshes.length === 0) {
        continue;
      }

      if (!allowMerge) {
        for (const mesh of meshes) {
          mesh.parent = this.root;
          mesh.isPickable = false;
          this.childMeshes.push(mesh);
        }
        continue;
      }

      let merged = null;
      if (meshes.length === 1) {
        merged = meshes[0];
      } else {
        for (const mesh of meshes) {
          bakeMeshWorldTransform(mesh);
        }
        merged = BABYLON.Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
      }

      if (!merged) {
        continue;
      }

      merged.parent = this.root;
      merged.isPickable = false;
      this.childMeshes.push(merged);
    }
  }

  buildInteractionRegions(regions) {
    for (const region of regions) {
      const entry = {
        id: region.id,
        pickMeshes: [],
        highlightMeshes: [],
      };

      for (const [partIndex, part] of (region.parts ?? []).entries()) {
        const points2d = part.map((point) => pixelsToWorldVector2(this.sectionMetrics, point[0], point[1]));
        if (points2d.length < 3) {
          continue;
        }

        const pickBuilder = new BABYLON.PolygonMeshBuilder(
          `airspace-pick-${region.id}-${partIndex}`,
          points2d,
          this.scene,
          window.earcut,
        );
        const pickMesh = pickBuilder.build(false, 0);
        pickMesh.parent = this.root;
        pickMesh.position.y = 0.006;
        pickMesh.isPickable = true;
        pickMesh.material = this.getInvisiblePickMaterial();
        pickMesh.metadata = {
          interactiveLayerId: "airspace",
          interactiveRole: "geometry",
          selectionId: region.id,
        };
        entry.pickMeshes.push(pickMesh);

        const highlightBuilder = new BABYLON.PolygonMeshBuilder(
          `airspace-highlight-${region.id}-${partIndex}`,
          points2d,
          this.scene,
          window.earcut,
        );
        const fillMesh = highlightBuilder.build(false, 0);
        fillMesh.parent = this.root;
        fillMesh.position.y = FEATURE_SURFACE_EPSILON;
        fillMesh.isPickable = false;
        fillMesh.isVisible = false;
        fillMesh.material = this.getAirspaceHighlightMaterial(region);
        entry.highlightMeshes.push(fillMesh);

        const linePoints = part.map((point) =>
          pixelsToWorldPoint(this.sectionMetrics, point[0], point[1], FEATURE_OUTLINE_EPSILON));
        if (linePoints.length >= 2) {
          linePoints.push(linePoints[0].clone());
          const outline = BABYLON.MeshBuilder.CreateLines(
            `airspace-highlight-outline-${region.id}-${partIndex}`,
            { points: linePoints },
            this.scene,
          );
          outline.parent = this.root;
          outline.isPickable = false;
          outline.isVisible = false;
          outline.color = BABYLON.Color3.FromHexString("#fde047");
          outline.alpha = 1;
          entry.highlightMeshes.push(outline);
        }
      }

      if (entry.pickMeshes.length || entry.highlightMeshes.length) {
        this.selectionRegions.set(region.id, entry);
      }
    }
  }

  getMaterial({ key, color, alpha }) {
    if (this.materialCache.has(key)) {
      return this.materialCache.get(key);
    }

    const material = new BABYLON.StandardMaterial(`material-${this.definition.id}-${key}`, this.scene);
    const opaqueMode = this.definition.materialMode === "opaque";
    material.diffuseColor = BABYLON.Color3.FromHexString(color);
    material.emissiveColor = BABYLON.Color3.FromHexString(color);
    material.specularColor = BABYLON.Color3.Black();
    material.alpha = opaqueMode ? 1 : alpha;
    material.backFaceCulling = false;
    material.disableLighting = true;
    material.transparencyMode = opaqueMode
      ? BABYLON.Material.MATERIAL_OPAQUE
      : BABYLON.Material.MATERIAL_ALPHABLEND;
    material.forceDepthWrite = opaqueMode;
    material.needDepthPrePass = opaqueMode;
    material.zOffset = opaqueMode ? -2 : -1;

    this.materialCache.set(key, material);
    return material;
  }

  getInvisiblePickMaterial() {
    return this.getMaterial({
      key: "airspace-pick:invisible",
      color: "#000000",
      alpha: 0.001,
    });
  }

  getAirspaceHighlightMaterial(region) {
    const color = highlightColorForAirspaceType(region.airspaceType, region.kind);
    return this.getMaterial({
      key: `airspace-highlight:${color}`,
      color,
      alpha: 0.22,
    });
  }

  setSelection(selectionId) {
    this.selectedSelectionId = selectionId;
    for (const [regionId, region] of this.selectionRegions.entries()) {
      const selected = Boolean(selectionId) && regionId === selectionId;
      for (const mesh of region.highlightMeshes) {
        mesh.isVisible = selected;
      }
    }
  }

  setVisible(visible) {
    this.root?.setEnabled(visible);
  }

  dispose() {
    for (const region of this.selectionRegions.values()) {
      for (const mesh of region.pickMeshes) {
        mesh.dispose(false, true);
      }
      for (const mesh of region.highlightMeshes) {
        mesh.dispose(false, true);
      }
    }
    this.selectionRegions.clear();
    for (const mesh of this.childMeshes) {
      mesh.dispose(false, true);
    }
    this.childMeshes = [];
    for (const material of this.materialCache.values()) {
      material.dispose(false, true);
    }
    this.materialCache.clear();
    this.root?.dispose(false, true);
  }
}

function bakeMeshWorldTransform(mesh) {
  mesh.computeWorldMatrix(true);
  mesh.bakeCurrentTransformIntoVertices();
  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);
  mesh.scaling.set(1, 1, 1);
  mesh.rotationQuaternion = null;
}

function createStripSegment(scene, name, start, end, width) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  const mesh = BABYLON.MeshBuilder.CreateGround(
    name,
    {
      width: Math.max(length, width),
      height: width,
    },
    scene,
  );
  mesh.position = new BABYLON.Vector3((start.x + end.x) / 2, 0, (start.z + end.z) / 2);
  mesh.rotation.y = Math.atan2(dz, dx);
  return mesh;
}

function createTubeSegment(scene, name, start, end, width, minRadius = 0.0025) {
  return BABYLON.MeshBuilder.CreateTube(
    name,
    {
      path: [start, end],
      radius: Math.max(width * 0.5, minRadius),
      tessellation: 10,
      cap: BABYLON.Mesh.CAP_ROUND,
      sideOrientation: BABYLON.Mesh.DOUBLESIDE,
    },
    scene,
  );
}

function createDashedSubpaths(points, dashPattern) {
  const [dashLength, gapLength] = dashPattern;
  if (!dashLength || points.length < 2) {
    return [points];
  }

  const subpaths = [];
  let drawing = true;
  let phaseRemaining = dashLength;
  let currentPath = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    let start = { x: points[index][0], y: points[index][1] };
    const end = { x: points[index + 1][0], y: points[index + 1][1] };
    let segmentLength = distance2d(start, end);

    while (segmentLength > 1e-6) {
      const step = Math.min(phaseRemaining, segmentLength);
      const t = step / segmentLength;
      const split = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      };

      if (drawing) {
        if (currentPath.length === 0) {
          currentPath.push([start.x, start.y]);
        }
        currentPath.push([split.x, split.y]);
      }

      phaseRemaining -= step;
      segmentLength -= step;
      start = split;

      if (phaseRemaining <= 1e-6) {
        if (drawing && currentPath.length > 1) {
          subpaths.push(currentPath);
          currentPath = [];
        }
        drawing = !drawing;
        phaseRemaining = drawing ? dashLength : gapLength;
      }
    }
  }

  if (drawing && currentPath.length > 1) {
    subpaths.push(currentPath);
  }

  return subpaths;
}

function distance2d(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy);
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function highlightColorForAirspaceType(type, kind) {
  if (kind === "special") {
    return "#f59e0b";
  }
  if (type === "CLASS_B" || type === "CLASS_C" || type === "CLASS_D") {
    return "#60a5fa";
  }
  return "#f472b6";
}
