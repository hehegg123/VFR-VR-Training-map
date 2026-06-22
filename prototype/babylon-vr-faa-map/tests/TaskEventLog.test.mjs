import assert from "node:assert/strict";
import test from "node:test";

import { TaskEventLog, TASK_EVENT_TYPES } from "../src/training/TaskEventLog.js";

test("records immutable in-memory task events with research context", () => {
  const log = new TaskEventLog({
    contextProvider: () => ({
      sectionId: "stlouis",
      linkedSessionId: "participant-12",
      taskSetId: "orientation",
      taskId: "task-one",
    }),
    now: () => new Date("2026-06-21T12:34:56.000Z"),
  });

  const event = log.record(TASK_EVENT_TYPES.TASK_VIEWED);
  assert.deepEqual(event, {
    type: "task_viewed",
    timestamp: "2026-06-21T12:34:56.000Z",
    taskSetId: "orientation",
    taskId: "task-one",
    sectionId: "stlouis",
    linkedSessionId: "participant-12",
  });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(log.getEvents().length, 1);
  log.clear();
  assert.equal(log.getEvents().length, 0);
  assert.throws(() => log.record("unknown"), /Unknown task event type/);
});
