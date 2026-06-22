import assert from "node:assert/strict";
import test from "node:test";

import { TaskSetRepository } from "../src/data/TaskSetRepository.js";


const manifest = {
  id: "stlouis",
  assetVersion: "test-version",
  __baseUrl: "https://example.test/data/sections/stlouis/",
  layers: [{ id: "base" }, { id: "airspace" }],
};
const entry = { id: "example", title: "Example", data: "tasks/example.json" };

test("loads and validates a task set through the section asset resolver", async () => {
  let requestedUrl = null;
  const repository = new TaskSetRepository(async (url, options) => {
    requestedUrl = url;
    assert.deepEqual(options, { cache: "no-store" });
    return { ok: true, status: 200, json: async () => validPayload() };
  });
  const payload = await repository.load(manifest, entry);
  assert.equal(payload.id, "example");
  assert.equal(requestedUrl, "https://example.test/data/sections/stlouis/tasks/example.json?v=test-version");
});

test("reports a clear missing-file error", async () => {
  const repository = new TaskSetRepository(async () => ({ ok: false, status: 404 }));
  await assert.rejects(repository.load(manifest, entry), /Failed to load task set example.*HTTP 404/);
});

test("preserves the global receiver required by browser-native fetch", async () => {
  let receiver = null;
  function receiverSensitiveFetch() {
    receiver = this;
    return Promise.resolve({ ok: true, status: 200, json: async () => validPayload() });
  }
  const repository = new TaskSetRepository(receiverSensitiveFetch);
  await repository.load(manifest, entry);
  assert.equal(receiver, globalThis);
});

test("reports invalid schema, IDs, tasks, layers, and targets", async () => {
  const invalid = validPayload();
  invalid.schema = "wrong-schema";
  invalid.id = "wrong-id";
  invalid.sectionId = "daytona";
  invalid.tasks[0].instructions = "";
  invalid.tasks[0].recommendedLayers = ["unknown"];
  invalid.tasks[0].targets = [{ layerId: "unknown", selectionId: "" }];
  invalid.tasks.push({ ...invalid.tasks[0], instructions: "Duplicate" });
  const repository = new TaskSetRepository(async () => ({ ok: true, status: 200, json: async () => invalid }));
  await assert.rejects(repository.load(manifest, entry), (error) => {
    assert.match(error.message, /schema must be/);
    assert.match(error.message, /id must match manifest id/);
    assert.match(error.message, /sectionId must be/);
    assert.match(error.message, /instructions must be a nonempty string/);
    assert.match(error.message, /duplicates an earlier task id/);
    assert.match(error.message, /unknown layer/);
    assert.match(error.message, /selectionId must be a nonempty string/);
    return true;
  });
});

function validPayload() {
  return {
    schema: "faa-vr-task-set-v1",
    id: "example",
    sectionId: "stlouis",
    title: "Example",
    tasks: [{
      id: "task-one",
      title: "Task One",
      instructions: "Select the airspace.",
      completionMode: "manual",
      recommendedLayers: ["base", "airspace"],
      targets: [{ layerId: "airspace", selectionId: "STL-CLASS_B" }],
    }],
  };
}
