import { resolveSectionAsset } from "../data/sectionRepository.js";
import {
  createFeatureSelection,
  createLabelSelection,
  selectionsEqual,
} from "../../../shared/selectionContract.js";

const LABEL_STYLES = {
  "airport-major": { fill: "#14365f", border: "#7dd3fc", text: "#ffffff" },
  "airport-minor": { fill: "#224c7c", border: "#93c5fd", text: "#ffffff" },
  "intersection-major": { fill: "#364152", border: "#fbbf24", text: "#f8fafc" },
  "intersection-minor": { fill: "#4b5563", border: "#fcd34d", text: "#f8fafc" },
  "navaid-vor": { fill: "#0f4f59", border: "#5eead4", text: "#ecfeff" },
  "navaid-dme": { fill: "#0e5560", border: "#67e8f9", text: "#ecfeff" },
  "navaid-ndb": { fill: "#1f5f67", border: "#99f6e4", text: "#ecfeff" },
  "victor-airway": { fill: "#102f57", border: "#fde68a", text: "#f8fafc" },
  "airspace-primary": { fill: "#6f1d67", border: "#f9a8d4", text: "#ffffff" },
  "airspace-secondary": { fill: "#87406f", border: "#fbcfe8", text: "#ffffff" },
};

const BASE_LABEL_FONT = "Segoe UI, Aptos, sans-serif";
const MIN_SCALE = 0.035;
const MAX_SCALE = 2.8;
const LABEL_PADDING_X = 12;
const LABEL_PADDING_Y = 8;
const LABEL_LINE_GAP = 16;

export class MapCanvasView {
  constructor(elements) {
    this.viewport = elements.mapViewport;
    this.baseCanvas = elements.baseCanvas;
    this.overlayCanvas = elements.overlayCanvas;
    this.labelCanvas = elements.labelCanvas;
    this.interactionCanvas = elements.interactionCanvas;
    this.baseCtx = this.baseCanvas.getContext("2d");
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.labelCtx = this.labelCanvas.getContext("2d");
    this.interactionCtx = this.interactionCanvas.getContext("2d");
    this.manifest = null;
    this.sectionMetrics = null;
    this.layers = new Map();
    this.imageCache = new Map();
    this.labelHitTargets = [];
    this.selection = null;
    this.eventSnapshot = null;
    this.view = {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    };
    this.dpr = window.devicePixelRatio || 1;
    this.dragState = null;
    this.renderHandle = 0;
    this.onSelectionChange = null;

    this.handleResize = this.handleResize.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleWheel = this.handleWheel.bind(this);

    window.addEventListener("resize", this.handleResize);
    this.interactionCanvas.addEventListener("pointerdown", this.handlePointerDown);
    this.interactionCanvas.addEventListener("pointermove", this.handlePointerMove);
    this.interactionCanvas.addEventListener("pointerup", this.handlePointerUp);
    this.interactionCanvas.addEventListener("pointerleave", this.handlePointerUp);
    this.interactionCanvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.handleResize();
  }

  async loadSection(manifest) {
    this.manifest = manifest;
    this.sectionMetrics = {
      pixelWidth: manifest.chart.pixelWidth,
      pixelHeight: manifest.chart.pixelHeight,
    };
    this.layers.clear();
    this.selection = null;
    this.eventSnapshot = null;

    for (const layerDef of manifest.layers) {
      const hydrated = this.hydrateLayerDefinition(layerDef);
      const layerState = {
        definition: hydrated,
        layerVisible: layerDef.defaultVisible !== false,
        labelsVisible: Boolean(layerDef.labelData) && layerDef.defaultLabels !== false,
        options: {
          extendedAirspaceLabels: false,
        },
        overlayPayload: null,
        labelPayload: null,
      };

      if (hydrated.overlayUrl) {
        const response = await fetch(hydrated.overlayUrl, { cache: "no-store" });
        layerState.overlayPayload = await response.json();
      }
      if (layerDef.labelData) {
        const response = await fetch(resolveSectionAsset(manifest, layerDef.labelData), { cache: "no-store" });
        layerState.labelPayload = await response.json();
      }
      this.layers.set(layerDef.id, layerState);
    }

    this.fitView();
  }

  hydrateLayerDefinition(layerDef) {
    const hydrated = { ...layerDef };
    if (layerDef.tilePyramid) {
      hydrated.tilePyramid = {
        ...layerDef.tilePyramid,
        levels: (layerDef.tilePyramid.levels ?? []).map((level) => ({
          ...level,
          tiles: (level.tiles ?? []).map((tile) => ({
            ...tile,
            url: resolveSectionAsset(this.manifest, tile.url),
          })),
        })),
      };
    }
    if (layerDef.overlayData) {
      hydrated.overlayUrl = resolveSectionAsset(this.manifest, layerDef.overlayData);
    }
    return hydrated;
  }

  setLayerVisible(layerId, visible) {
    const layer = this.layers.get(layerId);
    if (!layer) {
      return;
    }
    layer.layerVisible = visible;
    this.requestRender();
  }

  setLabelVisible(layerId, visible) {
    const layer = this.layers.get(layerId);
    if (!layer) {
      return;
    }
    layer.labelsVisible = visible;
    this.requestRender();
  }

  setLabelOptions(layerId, options = {}) {
    const layer = this.layers.get(layerId);
    if (!layer) {
      return;
    }
    layer.options = {
      ...layer.options,
      ...options,
    };
    this.requestRender();
  }

  fitView() {
    if (!this.sectionMetrics) {
      return;
    }

    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;
    const scale = Math.max(
      MIN_SCALE,
      Math.min(
        (width - 40) / this.sectionMetrics.pixelWidth,
        (height - 40) / this.sectionMetrics.pixelHeight,
      ),
    );
    this.view.scale = Math.min(scale, MAX_SCALE);
    this.view.offsetX = (width - this.sectionMetrics.pixelWidth * this.view.scale) / 2;
    this.view.offsetY = (height - this.sectionMetrics.pixelHeight * this.view.scale) / 2;
    this.requestRender();
  }

  setSelection(selection, { notify = true } = {}) {
    if (selectionsEqual(this.selection, selection)) {
      return;
    }
    this.selection = selection ?? null;
    this.requestRender();
    if (notify) {
      this.onSelectionChange?.(this.selection);
    }
  }

  setEventSnapshot(snapshot) {
    this.eventSnapshot = snapshot && !snapshot.disposed ? snapshot : null;
    this.requestRender();
  }

  handleResize() {
    this.dpr = window.devicePixelRatio || 1;
    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;
    for (const canvas of [this.baseCanvas, this.overlayCanvas, this.labelCanvas, this.interactionCanvas]) {
      canvas.width = Math.max(1, Math.round(width * this.dpr));
      canvas.height = Math.max(1, Math.round(height * this.dpr));
    }
    this.requestRender();
  }

  handlePointerDown(event) {
    this.interactionCanvas.setPointerCapture?.(event.pointerId);
    this.dragState = {
      pointerId: event.pointerId,
      startX: event.offsetX,
      startY: event.offsetY,
      originOffsetX: this.view.offsetX,
      originOffsetY: this.view.offsetY,
      moved: false,
    };
    this.interactionCanvas.classList.add("is-dragging");
  }

  handlePointerMove(event) {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.offsetX - this.dragState.startX;
    const dy = event.offsetY - this.dragState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      this.dragState.moved = true;
    }
    this.view.offsetX = this.dragState.originOffsetX + dx;
    this.view.offsetY = this.dragState.originOffsetY + dy;
    this.requestRender();
  }

  handlePointerUp(event) {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) {
      return;
    }
    const wasMoved = this.dragState.moved;
    this.dragState = null;
    this.interactionCanvas.classList.remove("is-dragging");
    if (!wasMoved) {
      this.handleClick(event.offsetX, event.offsetY);
    }
  }

  handleWheel(event) {
    event.preventDefault();
    if (!this.sectionMetrics) {
      return;
    }

    const zoomFactor = event.deltaY < 0 ? 1.12 : 0.9;
    const nextScale = clamp(this.view.scale * zoomFactor, MIN_SCALE, MAX_SCALE);
    const chartPoint = this.screenToChart(event.offsetX, event.offsetY);
    this.view.scale = nextScale;
    this.view.offsetX = event.offsetX - chartPoint.x * nextScale;
    this.view.offsetY = event.offsetY - chartPoint.y * nextScale;
    this.requestRender();
  }

  handleClick(screenX, screenY) {
    for (let index = this.labelHitTargets.length - 1; index >= 0; index -= 1) {
      const target = this.labelHitTargets[index];
      if (containsPoint(target.bounds, screenX, screenY)) {
        this.setSelection(target.selection, { notify: true });
        return;
      }
    }

    const airspaceLayer = this.layers.get("airspace");
    if (airspaceLayer?.layerVisible && airspaceLayer.overlayPayload?.interactionRegions?.length) {
      const chartPoint = this.screenToChart(screenX, screenY);
      const region = findInteractionRegion(airspaceLayer.overlayPayload.interactionRegions, chartPoint);
      if (region) {
        this.setSelection(
          createFeatureSelection({
            sectionId: this.manifest.id,
            layerId: "airspace",
            featureId: region.id,
            label: region.id,
          }),
          { notify: true },
        );
        return;
      }
    }

    this.setSelection(null, { notify: true });
  }

  requestRender() {
    if (this.renderHandle) {
      return;
    }
    this.renderHandle = requestAnimationFrame(() => {
      this.renderHandle = 0;
      this.render();
    });
  }

  render() {
    if (!this.manifest || !this.sectionMetrics) {
      return;
    }

    this.resetContext(this.baseCtx);
    this.resetContext(this.overlayCtx);
    this.resetContext(this.labelCtx);
    this.resetContext(this.interactionCtx);
    this.labelHitTargets = [];

    const baseLayer = this.layers.get("base");
    if (baseLayer?.layerVisible) {
      this.drawBaseLayer(baseLayer);
    }

    for (const [layerId, layerState] of this.layers.entries()) {
      if (layerId === "base" || !layerState.layerVisible || !layerState.overlayPayload) {
        continue;
      }
      this.drawOverlayLayer(layerId, layerState);
    }

    this.drawSelectedFeatureHighlight();
    this.drawWeatherEvents();

    for (const [layerId, layerState] of this.layers.entries()) {
      if (!layerState.labelsVisible || !layerState.labelPayload) {
        continue;
      }
      this.drawLabelLayer(layerId, layerState);
    }
    this.drawAircraftEvents();
  }

  resetContext(context) {
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.viewport.clientWidth, this.viewport.clientHeight);
    context.lineJoin = "round";
    context.lineCap = "round";
  }

  drawBaseLayer(layerState) {
    const level = pickBaseLevel(
      layerState.definition.tilePyramid,
      this.sectionMetrics.pixelWidth * this.view.scale,
    );
    const viewport = this.getChartViewport();
    for (const tile of level.tiles ?? []) {
      const [sourceX, sourceY, sourceWidth, sourceHeight] = tile.sourceRect;
      if (!rectsIntersect(viewport, {
        x0: sourceX,
        y0: sourceY,
        x1: sourceX + sourceWidth,
        y1: sourceY + sourceHeight,
      })) {
        continue;
      }

      const cacheEntry = this.getImage(tile.url);
      if (!cacheEntry.loaded) {
        continue;
      }

      const topLeft = this.chartToScreen(sourceX, sourceY);
      const width = sourceWidth * this.view.scale;
      const height = sourceHeight * this.view.scale;
      this.baseCtx.drawImage(cacheEntry.image, topLeft.x, topLeft.y, width, height);
    }
  }

  drawOverlayLayer(layerId, layerState) {
    const ctx = this.overlayCtx;
    const primitives = layerState.overlayPayload.primitives ?? {};
    drawOverlayPolygons(ctx, primitives.polygons ?? [], this.view);
    drawOverlayStrokes(ctx, primitives.strokes ?? [], this.view);
    drawOverlayCircles(ctx, primitives.circles ?? [], this.view);
    drawOverlayMarkers(ctx, primitives.markers ?? [], this.view);
    drawOverlayRunwayBars(ctx, primitives.runwayBars ?? [], this.view);
  }

  drawSelectedFeatureHighlight() {
    if (!this.selection || this.selection.layerId !== "airspace" || !this.selection.featureId) {
      return;
    }
    const airspaceLayer = this.layers.get("airspace");
    const region = airspaceLayer?.overlayPayload?.interactionRegions?.find((entry) => entry.id === this.selection.featureId);
    if (region) {
      drawSelectedAirspaceHighlight(this.interactionCtx, region, this.view);
    }
  }

  drawLabelLayer(layerId, layerState) {
    const visibleItems = this.selectVisibleLabelItems(layerState);
    const selectedFeatureId = this.selection?.layerId === layerId ? this.selection.featureId : null;
    const selectedLabelId = this.selection?.layerId === layerId ? this.selection.labelId : null;
    const labelBoxes = [];
    const ctx = this.labelCtx;

    for (const item of visibleItems) {
      const isSelected = item.id === selectedLabelId || (item.selectionId ?? item.id) === selectedFeatureId;
      const isPrimaryAirfieldLabel = layerId === "airspace" && item.labelGroup === "airfield";
      const lines = item.lines?.length ? item.lines : [item.text ?? item.id];
      const style = LABEL_STYLES[item.style] ?? LABEL_STYLES["intersection-minor"];
      const box = measureLabelBox(ctx, lines, item.x, item.y, this.view, isSelected);
      if (!isSelected && !isPrimaryAirfieldLabel && labelBoxes.some((existing) => boundsOverlap(existing.bounds, box.bounds))) {
        continue;
      }
      labelBoxes.push({ item, bounds: box.bounds });
      drawLabelCard(ctx, lines, box, style, isSelected);
      if (item.connector && Number.isFinite(item.anchorX) && Number.isFinite(item.anchorY)) {
        drawConnector(ctx, this.view, item.anchorX, item.anchorY, box);
      }
      this.labelHitTargets.push({
        bounds: box.bounds,
        selection: createLabelSelection({
          sectionId: this.manifest.id,
          layerId,
          labelId: item.id,
          featureId: item.selectionId ?? item.id,
          label: lines.join(" / "),
        }),
      });
    }
  }

  drawWeatherEvents() {
    const events = this.eventSnapshot?.activeEvents ?? [];
    for (const event of events) {
      if (event.type !== "weather") {
        continue;
      }
      drawWeatherEvent(this.overlayCtx, event, this.view, this.sectionMetrics, (target) => this.resolveTargetChartPoint(target));
    }
  }

  drawAircraftEvents() {
    const events = this.eventSnapshot?.activeEvents ?? [];
    const aircraftStates = new Map(
      (this.eventSnapshot?.aircraftStates ?? []).map((state) => [state.eventId, state]),
    );
    for (const event of events) {
      if (event.type !== "aircraft") {
        continue;
      }
      const state = aircraftStates.get(event.id);
      const renderedEvent = state
        ? {
            ...event,
            position: state.position ?? event.position,
            altitude: state.altitude ?? event.altitude,
            orientation: {
              ...event.orientation,
              headingDeg: state.headingDeg ?? event.orientation?.headingDeg ?? 0,
            },
          }
        : event;
      drawAircraftEvent(this.labelCtx, renderedEvent, this.view, this.sectionMetrics, (target) => this.resolveTargetChartPoint(target));
    }
  }

  resolveTargetChartPoint(target) {
    if (!target?.layerId || !target?.selectionId) {
      return null;
    }
    const layerState = this.layers.get(target.layerId);
    const labelItem = layerState?.labelPayload?.items?.find((item) =>
      item.id === target.selectionId || (item.selectionId ?? item.id) === target.selectionId);
    if (labelItem && Number.isFinite(labelItem.x) && Number.isFinite(labelItem.y)) {
      return { x: labelItem.x, y: labelItem.y };
    }
    const region = layerState?.overlayPayload?.interactionRegions?.find((entry) => entry.id === target.selectionId);
    if (region) {
      return centroidOfParts(region.parts ?? []);
    }
    return null;
  }

  selectVisibleLabelItems(layerState) {
    const items = [...(layerState.labelPayload?.items ?? [])];
    items.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
    const selectedFeatureId = this.selection?.layerId === layerState.definition.id ? this.selection.featureId : null;
    const selectedLabelId = this.selection?.layerId === layerState.definition.id ? this.selection.labelId : null;

    let filtered = items;
    if (layerState.definition.id === "airspace" && !layerState.options.extendedAirspaceLabels) {
      filtered = filtered.filter((item) => item.detailTier !== "extended");
    }

    const limit = layerState.options.extendedAirspaceLabels
      ? layerState.definition.extendedMaxVisibleLabels ?? layerState.definition.maxVisibleLabels ?? filtered.length
      : layerState.definition.maxVisibleLabels ?? filtered.length;
    const visible = filtered.slice(0, limit);
    const selectedItem = filtered.find((item) =>
      item.id === selectedLabelId || (item.selectionId ?? item.id) === selectedFeatureId);
    if (selectedItem && !visible.some((item) => item.id === selectedItem.id)) {
      visible.unshift(selectedItem);
    }
    return visible;
  }

  getImage(url) {
    if (this.imageCache.has(url)) {
      return this.imageCache.get(url);
    }
    const image = new Image();
    image.decoding = "async";
    const entry = {
      image,
      loaded: false,
    };
    image.addEventListener("load", () => {
      entry.loaded = true;
      this.requestRender();
    });
    image.src = url;
    this.imageCache.set(url, entry);
    return entry;
  }

  chartToScreen(x, y) {
    return {
      x: this.view.offsetX + x * this.view.scale,
      y: this.view.offsetY + y * this.view.scale,
    };
  }

  screenToChart(x, y) {
    return {
      x: (x - this.view.offsetX) / this.view.scale,
      y: (y - this.view.offsetY) / this.view.scale,
    };
  }

  getChartViewport() {
    return {
      x0: (0 - this.view.offsetX) / this.view.scale,
      y0: (0 - this.view.offsetY) / this.view.scale,
      x1: (this.viewport.clientWidth - this.view.offsetX) / this.view.scale,
      y1: (this.viewport.clientHeight - this.view.offsetY) / this.view.scale,
    };
  }
}

function drawOverlayPolygons(ctx, polygons, view) {
  for (const polygon of polygons) {
    const points = polygon.points ?? [];
    if (points.length < 3) {
      continue;
    }
    ctx.beginPath();
    points.forEach((point, index) => {
      const screen = chartPointToScreen(view, point[0], point[1]);
      if (index === 0) {
        ctx.moveTo(screen.x, screen.y);
      } else {
        ctx.lineTo(screen.x, screen.y);
      }
    });
    ctx.closePath();
    if (polygon.fill) {
      ctx.fillStyle = withAlpha(polygon.fill, polygon.fillAlpha ?? 1);
      ctx.fill();
    }
    if (polygon.stroke) {
      ctx.strokeStyle = withAlpha(polygon.stroke, polygon.strokeAlpha ?? 1);
      ctx.lineWidth = Math.max(1, (polygon.strokeWidthPx ?? 1) * view.scale);
      ctx.stroke();
    }
  }
}

function drawOverlayStrokes(ctx, strokes, view) {
  for (const stroke of strokes) {
    const points = stroke.points ?? [];
    if (points.length < 2) {
      continue;
    }
    ctx.save();
    if (stroke.dashPatternPx?.length) {
      ctx.setLineDash(stroke.dashPatternPx.map((value) => Math.max(1, value * view.scale)));
    }
    if (stroke.haloColor && stroke.haloWidthPx) {
      ctx.beginPath();
      tracePoints(ctx, points, view, stroke.closed);
      ctx.strokeStyle = withAlpha(stroke.haloColor, stroke.haloAlpha ?? stroke.alpha ?? 1);
      ctx.lineWidth = Math.max(2, stroke.haloWidthPx * view.scale);
      ctx.stroke();
    }
    ctx.beginPath();
    tracePoints(ctx, points, view, stroke.closed);
    ctx.strokeStyle = withAlpha(stroke.color, stroke.alpha ?? 1);
    ctx.lineWidth = Math.max(1, stroke.widthPx * view.scale);
    ctx.stroke();
    ctx.restore();
  }
}

function drawOverlayCircles(ctx, circles, view) {
  for (const circle of circles) {
    const center = chartPointToScreen(view, circle.center[0], circle.center[1]);
    const radius = Math.max(1, (circle.radiusPx ?? 0) * view.scale);
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    if (circle.fill) {
      ctx.fillStyle = withAlpha(circle.fill, circle.alpha ?? 1);
      ctx.fill();
    }
    if (circle.stroke) {
      ctx.strokeStyle = withAlpha(circle.stroke, circle.alpha ?? 1);
      ctx.lineWidth = Math.max(1, (circle.strokeWidthPx ?? 1) * view.scale);
      ctx.stroke();
    }
  }
}

function drawOverlayMarkers(ctx, markers, view) {
  for (const marker of markers) {
    const center = chartPointToScreen(view, marker.center[0], marker.center[1]);
    const halfSize = Math.max(2, (marker.sizePx ?? 8) * view.scale * 0.5);
    const width = Math.max(1, (marker.widthPx ?? 2) * view.scale);
    ctx.strokeStyle = withAlpha(marker.color, marker.alpha ?? 1);
    ctx.lineWidth = width;
    ctx.beginPath();
    if (marker.symbol === "plus") {
      ctx.moveTo(center.x - halfSize, center.y);
      ctx.lineTo(center.x + halfSize, center.y);
      ctx.moveTo(center.x, center.y - halfSize);
      ctx.lineTo(center.x, center.y + halfSize);
    } else {
      ctx.moveTo(center.x - halfSize, center.y - halfSize);
      ctx.lineTo(center.x + halfSize, center.y + halfSize);
      ctx.moveTo(center.x - halfSize, center.y + halfSize);
      ctx.lineTo(center.x + halfSize, center.y - halfSize);
    }
    ctx.stroke();
  }
}

function drawOverlayRunwayBars(ctx, bars, view) {
  for (const bar of bars) {
    const center = chartPointToScreen(view, bar.center[0], bar.center[1]);
    const length = Math.max(4, bar.lengthPx * view.scale);
    const width = Math.max(2, bar.widthPx * view.scale);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(((bar.angleDeg ?? 0) * Math.PI) / 180);
    if (bar.haloColor && bar.haloPaddingPx) {
      ctx.fillStyle = withAlpha(bar.haloColor, bar.alpha ?? 1);
      const haloPadding = bar.haloPaddingPx * view.scale;
      ctx.fillRect(
        -(length / 2) - haloPadding,
        -(width / 2) - haloPadding,
        length + haloPadding * 2,
        width + haloPadding * 2,
      );
    }
    ctx.fillStyle = withAlpha(bar.fill, bar.alpha ?? 1);
    ctx.fillRect(-(length / 2), -(width / 2), length, width);
    ctx.restore();
  }
}

function drawSelectedAirspaceHighlight(ctx, region, view) {
  for (const part of region.parts ?? []) {
    if (part.length < 3) {
      continue;
    }
    ctx.beginPath();
    tracePoints(ctx, part, view, true);
    ctx.fillStyle = "rgba(253, 224, 71, 0.18)";
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = 2.5;
    ctx.fill();
    ctx.stroke();
  }
}

function drawLabelCard(ctx, lines, box, style, selected) {
  ctx.save();
  ctx.fillStyle = `${style.fill}ee`;
  ctx.strokeStyle = selected ? "#fde047" : (style.border ?? "rgba(255,255,255,0.82)");
  ctx.lineWidth = selected ? 2.5 : 1.5;
  roundRect(ctx, box.bounds.x0, box.bounds.y0, box.width, box.height, 10);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = style.text;
  const baseFontSize = lines.length > 2 ? 11 : 12;
  lines.forEach((line, index) => {
    const y = box.bounds.y0 + LABEL_PADDING_Y + 10 + index * LABEL_LINE_GAP;
    const weight = index === 0 ? 700 : 500;
    ctx.font = `${weight} ${baseFontSize}px ${BASE_LABEL_FONT}`;
    ctx.fillText(line, box.centerX, y);
  });
  ctx.restore();
}

function drawConnector(ctx, view, anchorX, anchorY, box) {
  const anchor = chartPointToScreen(view, anchorX, anchorY);
  const dock = {
    x: box.centerX,
    y: box.bounds.y1,
  };
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(dock.x, dock.y);
  ctx.stroke();
  ctx.restore();
}

function drawWeatherEvent(ctx, event, view, sectionMetrics, resolveTarget) {
  const geometry = event.geometry;
  ctx.save();
  ctx.fillStyle = "rgba(14, 165, 233, 0.26)";
  ctx.strokeStyle = "rgba(3, 105, 161, 0.82)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 5]);

  let labelPoint = null;
  if (geometry?.type === "circle") {
    const center = normalizedToChartPoint(sectionMetrics, geometry.x, geometry.y);
    const screen = chartPointToScreen(view, center.x, center.y);
    const radius = Math.max(4, geometry.radius * sectionMetrics.pixelWidth * view.scale);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    labelPoint = center;
  } else if (geometry?.type === "polygon" && Array.isArray(geometry.points)) {
    const points = geometry.points.map((point) => normalizedToChartPoint(sectionMetrics, point[0], point[1]));
    if (points.length >= 3) {
      ctx.beginPath();
      points.forEach((point, index) => {
        const screen = chartPointToScreen(view, point.x, point.y);
        if (index === 0) {
          ctx.moveTo(screen.x, screen.y);
        } else {
          ctx.lineTo(screen.x, screen.y);
        }
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      labelPoint = centroidOfPoints(points);
    }
  } else {
    labelPoint = event.position
      ? normalizedToChartPoint(sectionMetrics, event.position.x, event.position.y)
      : resolveTarget(event.target);
    if (labelPoint) {
      const screen = chartPointToScreen(view, labelPoint.x, labelPoint.y);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, Math.max(16, 28 * view.scale), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.setLineDash([]);
  if (labelPoint && event.visual?.label) {
    drawEventLabel(ctx, view, labelPoint, `${event.visual.label} ${formatWeatherAltitude(event.altitude)}`, "#0369a1", "#e0f2fe");
  }
  ctx.restore();
}

function drawAircraftEvent(ctx, event, view, sectionMetrics, resolveTarget) {
  const chartPoint = event.position
    ? normalizedToChartPoint(sectionMetrics, event.position.x, event.position.y)
    : resolveTarget(event.target);
  if (!chartPoint) {
    return;
  }

  const screen = chartPointToScreen(view, chartPoint.x, chartPoint.y);
  const size = Math.max(12, 20 * Math.sqrt(view.scale));
  const headingDeg = Number(event.orientation?.headingDeg ?? 0);
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate((headingDeg * Math.PI) / 180);
  ctx.fillStyle = "#ef4444";
  ctx.strokeStyle = "#7f1d1d";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.62, size * 0.78);
  ctx.lineTo(0, size * 0.42);
  ctx.lineTo(-size * 0.62, size * 0.78);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  if (event.visual?.label) {
    drawEventLabel(
      ctx,
      view,
      chartPoint,
      `${event.visual.label} ${formatAircraftAltitude(event.altitude)} H${formatHeading(headingDeg)}`,
      "#7f1d1d",
      "#fee2e2",
      { offsetY: -34 },
    );
  }
}

function formatHeading(headingDeg) {
  const normalized = ((Number(headingDeg) % 360) + 360) % 360;
  return `${Math.round(normalized)}`.padStart(3, "0");
}

function drawEventLabel(ctx, view, chartPoint, text, fill, textColor, { offsetY = -26 } = {}) {
  const screen = chartPointToScreen(view, chartPoint.x, chartPoint.y);
  const label = `${text}`;
  ctx.save();
  ctx.font = `700 12px ${BASE_LABEL_FONT}`;
  const width = Math.max(72, ctx.measureText(label).width + 18);
  const height = 26;
  const x = screen.x - width / 2;
  const y = screen.y + offsetY - height / 2;
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, width, height, 8);
  ctx.fill();
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, screen.x, y + height / 2 + 0.5);
  ctx.restore();
}

function measureLabelBox(ctx, lines, chartX, chartY, view, selected) {
  const fontSize = selected ? 12.5 : 12;
  let maxWidth = 92;
  ctx.save();
  ctx.font = `700 ${fontSize}px ${BASE_LABEL_FONT}`;
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
  }
  ctx.restore();

  const width = maxWidth + LABEL_PADDING_X * 2;
  const height = lines.length * LABEL_LINE_GAP + LABEL_PADDING_Y * 2 + 4;
  const center = chartPointToScreen(view, chartX, chartY);
  return {
    centerX: center.x,
    centerY: center.y,
    width,
    height,
    bounds: {
      x0: center.x - width / 2,
      y0: center.y - height / 2,
      x1: center.x + width / 2,
      y1: center.y + height / 2,
    },
  };
}

function tracePoints(ctx, points, view, closed = false) {
  points.forEach((point, index) => {
    const screen = chartPointToScreen(view, point[0], point[1]);
    if (index === 0) {
      ctx.moveTo(screen.x, screen.y);
    } else {
      ctx.lineTo(screen.x, screen.y);
    }
  });
  if (closed && points.length > 2) {
    const screen = chartPointToScreen(view, points[0][0], points[0][1]);
    ctx.lineTo(screen.x, screen.y);
  }
}

function chartPointToScreen(view, x, y) {
  return {
    x: view.offsetX + x * view.scale,
    y: view.offsetY + y * view.scale,
  };
}

function normalizedToChartPoint(sectionMetrics, x, y) {
  return {
    x: x * sectionMetrics.pixelWidth,
    y: y * sectionMetrics.pixelHeight,
  };
}

function centroidOfParts(parts) {
  const points = parts.flatMap((part) => Array.isArray(part) ? part : []);
  return centroidOfPoints(points.map((point) => ({ x: point[0], y: point[1] })));
}

function centroidOfPoints(points) {
  const validPoints = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!validPoints.length) {
    return null;
  }
  const sum = validPoints.reduce((accumulator, point) => ({
    x: accumulator.x + point.x,
    y: accumulator.y + point.y,
  }), { x: 0, y: 0 });
  return {
    x: sum.x / validPoints.length,
    y: sum.y / validPoints.length,
  };
}

function formatAircraftAltitude(altitude) {
  const reference = altitude?.reference ?? "MSL";
  const value = Number.isFinite(Number(altitude?.valueFt)) ? Number(altitude.valueFt) : 1200;
  return `${Math.round(value)} ${reference}`;
}

function formatWeatherAltitude(altitude) {
  const reference = altitude?.reference ?? "MSL";
  const base = Number.isFinite(Number(altitude?.baseFt)) ? Number(altitude.baseFt) : 1000;
  const top = Number.isFinite(Number(altitude?.topFt)) ? Number(altitude.topFt) : 3000;
  return `${Math.round(base)}-${Math.round(Math.max(base, top))} ${reference}`;
}

function pickBaseLevel(tilePyramid, displayWidth) {
  const levels = [...(tilePyramid?.levels ?? [])].sort((left, right) => left.widthPx - right.widthPx);
  return levels.find((level) => level.widthPx >= displayWidth * 0.85) ?? levels[levels.length - 1];
}

function findInteractionRegion(regions, chartPoint) {
  return regions.find((region) =>
    (region.parts ?? []).some((part) => pointInPolygon(chartPoint.x, chartPoint.y, part)));
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function boundsOverlap(left, right) {
  return !(left.x1 < right.x0 || left.x0 > right.x1 || left.y1 < right.y0 || left.y0 > right.y1);
}

function containsPoint(bounds, x, y) {
  return x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1;
}

function rectsIntersect(left, right) {
  return !(left.x1 < right.x0 || left.x0 > right.x1 || left.y1 < right.y0 || left.y0 > right.y1);
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function withAlpha(hex, alpha) {
  const color = hex.replace("#", "");
  const normalized = color.length === 3
    ? color.split("").map((value) => value + value).join("")
    : color;
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
