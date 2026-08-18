import assert from "node:assert/strict";
import test from "node:test";

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  clone() {
    return new Vector3(this.x, this.y, this.z);
  }

  copyFrom(other) {
    this.x = other.x;
    this.y = other.y;
    this.z = other.z;
    return this;
  }
}

class TransformNode {
  constructor(name) {
    this.name = name;
    this.parent = null;
    this.position = new Vector3();
    this.rotation = { x: 0, y: 0, z: 0 };
    this.enabled = true;
    this.disposed = false;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }

  isDisposed() {
    return this.disposed;
  }

  dispose() {
    this.disposed = true;
  }
}

globalThis.BABYLON = { TransformNode, Vector3 };

const { EventOverlayLayer } = await import("../src/scene/layers/EventOverlayLayer.js");

test("reuses aircraft nodes across timeline frames and disposes them on unload", () => {
  const layer = new EventOverlayLayer(
    {},
    new TransformNode("map-root"),
    { pixelWidth: 1000, pixelHeight: 800, worldWidth: 10, worldHeight: 8 },
    null,
    { worldUnitsPerFoot: 0.001 },
  );
  let aircraftModelCreations = 0;
  let weatherCreations = 0;
  layer.createAircraftModel = () => {
    aircraftModelCreations += 1;
  };
  layer.renderWeather = () => {
    weatherCreations += 1;
  };

  layer.setSnapshot(snapshot("running", 0, { x: 0.2, y: 0.7 }, 45));
  const aircraftNode = layer.aircraftNodes.get("flight-a");
  assert.ok(aircraftNode);
  assert.equal(aircraftModelCreations, 1);
  assert.equal(weatherCreations, 1);
  assert.equal(layer.eventRoots.get("weather-one").enabled, false);

  layer.setSnapshot(snapshot("running", 10, { x: 0.6, y: 0.3 }, 90, ["flight-a", "weather-one"]));
  assert.equal(layer.aircraftNodes.get("flight-a"), aircraftNode);
  assert.equal(aircraftModelCreations, 1);
  assert.equal(weatherCreations, 1);
  assertVector(aircraftNode.position, { x: 1, y: 31.065, z: 1.6 });
  assert.equal(aircraftNode.rotation.y, Math.PI / 2);
  assert.equal(layer.eventRoots.get("weather-one").enabled, true);

  layer.setSnapshot(snapshot("paused", 10, { x: 0.6, y: 0.3 }, 90));
  assertVector(aircraftNode.position, { x: 1, y: 31.065, z: 1.6 });
  layer.setSnapshot(snapshot("ready", 0, { x: 0.2, y: 0.7 }, 45));
  assertVector(aircraftNode.position, { x: -3, y: 31.065, z: -1.6 });
  assert.equal(aircraftModelCreations, 1);

  layer.setSnapshot({ ...snapshot("ready", 0, { x: 0.4, y: 0.4 }, 0), eventSetId: "replacement" });
  assert.equal(aircraftNode.disposed, true);
  const replacementNode = layer.aircraftNodes.get("flight-a");
  assert.notEqual(replacementNode, aircraftNode);
  assert.equal(aircraftModelCreations, 2);

  layer.setSnapshot(null);
  assert.equal(replacementNode.disposed, true);
  assert.equal(layer.aircraftNodes.size, 0);
});

test("shows a procedural aircraft immediately while the headset loads the GLB model", async () => {
  const layer = new EventOverlayLayer(
    {},
    new TransformNode("map-root"),
    { pixelWidth: 1000, pixelHeight: 800, worldWidth: 10, worldHeight: 8 },
  );
  const event = { id: "flight-a", visual: { model: "crj-900-cityjet", scale: 1 } };
  const node = new TransformNode("event-root-flight-a");
  const placeholder = { meshes: [{}], materials: [{}] };
  let placeholderCreated = false;
  let placeholderDisposed = false;
  let finishModelLoad;

  layer.createProceduralAircraftModel = () => {
    placeholderCreated = true;
    return placeholder;
  };
  layer.tryAttachAircraftModel = () => new Promise((resolve) => {
    finishModelLoad = resolve;
  });
  layer.disposeAircraftPlaceholder = (candidate) => {
    assert.equal(candidate, placeholder);
    placeholderDisposed = true;
  };

  const loading = layer.createAircraftModel(event, node, layer.renderGeneration);
  assert.equal(placeholderCreated, true);
  assert.equal(placeholderDisposed, false);

  finishModelLoad(true);
  await loading;
  assert.equal(placeholderDisposed, true);
  layer.dispose();
});

test("procedural and imported aircraft share a compact physical target size", () => {
  const originalMeshBuilder = BABYLON.MeshBuilder;
  const dimensions = [];
  BABYLON.MeshBuilder = {
    CreateBox(name, options) {
      dimensions.push(options.width, options.height, options.depth);
      return fakeMesh(name);
    },
    CreateCylinder(name, options) {
      dimensions.push(options.height, options.diameterBottom);
      return fakeMesh(name);
    },
  };

  try {
    const layer = new EventOverlayLayer(
      {},
      new TransformNode("map-root"),
      { pixelWidth: 1000, pixelHeight: 800, worldWidth: 10, worldHeight: 8 },
    );
    layer.createMaterial = (name) => ({ name, dispose() {} });
    const result = layer.createProceduralAircraftModel(
      { id: "flight-a" },
      new TransformNode("event-root-flight-a"),
      1,
    );

    assert.equal(result.meshes.length, 4);
    assert.ok(Math.max(...dimensions) <= 0.14 + 1e-9);
    layer.dispose();
  } finally {
    BABYLON.MeshBuilder = originalMeshBuilder;
  }
});

function snapshot(status, elapsedSec, position, headingDeg, activeEventIds = ["flight-a"]) {
  return {
    eventSetId: "conflict-scenario",
    eventSetTitle: "Conflict Scenario",
    sectionId: "daytona",
    scenarioStatus: status,
    scenarioElapsedSec: elapsedSec,
    activeEventIds,
    events: [
      {
        id: "flight-a",
        type: "aircraft",
        title: "Flight A",
        position: { x: 0.2, y: 0.7 },
        altitude: { valueFt: 31000, reference: "MSL" },
        orientation: { headingDeg: 45 },
        visual: {},
      },
      {
        id: "weather-one",
        type: "weather",
        title: "Weather",
        geometry: { type: "circle", x: 0.5, y: 0.5, radius: 0.1 },
      },
    ],
    aircraftStates: [
      {
        eventId: "flight-a",
        position,
        altitude: { valueFt: 31000, reference: "MSL" },
        headingDeg,
      },
    ],
  };
}

function assertVector(actual, expected) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
  assert.ok(Math.abs(actual.z - expected.z) < 1e-9);
}

function fakeMesh(name) {
  return {
    name,
    parent: null,
    position: new Vector3(),
    rotation: { x: 0, y: 0, z: 0 },
    dispose() {},
  };
}
