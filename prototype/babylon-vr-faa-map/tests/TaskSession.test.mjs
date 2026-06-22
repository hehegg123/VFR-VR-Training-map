import assert from "node:assert/strict";
import test from "node:test";

import { TaskSession } from "../src/training/TaskSession.js";


test("tracks navigation, completion, and observable snapshots", () => {
  const session = new TaskSession(taskSet());
  const snapshots = [];
  const unsubscribe = session.subscribe((snapshot) => snapshots.push(snapshot));

  assert.equal(session.currentTask.id, "one");
  session.setCurrentTaskCompleted();
  session.next();
  assert.equal(session.currentTask.id, "two");
  assert.deepEqual(session.getSnapshot().completedTaskIds, ["one"]);
  session.previous();
  assert.equal(session.currentTask.id, "one");
  assert.equal(snapshots.length, 4);

  unsubscribe();
  session.next();
  assert.equal(snapshots.length, 4);
});

test("dispose notifies subscribers and blocks further mutation", () => {
  const session = new TaskSession(taskSet());
  let disposedSnapshot = null;
  session.subscribe((snapshot) => {
    if (snapshot.disposed) {
      disposedSnapshot = snapshot;
    }
  });
  session.dispose();
  assert.equal(disposedSnapshot.disposed, true);
  assert.throws(() => session.next(), /disposed/);
});

test("manual completion advances to the next incomplete task and stops on the final task", () => {
  const session = new TaskSession({
    ...taskSet(),
    tasks: [
      { id: "one", title: "One", instructions: "First", completionMode: "manual" },
      { id: "two", title: "Two", instructions: "Second", completionMode: "manual" },
      { id: "three", title: "Three", instructions: "Third", completionMode: "manual" },
    ],
  });

  session.setTaskCompleted("two");
  session.goToTask("one");
  session.completeCurrentAndAdvance();
  assert.equal(session.currentTask.id, "three");
  assert.deepEqual(session.getSnapshot().completedTaskIds, ["two", "one"]);

  session.completeCurrentAndAdvance();
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.currentTask.id, "three");
  assert.equal(snapshot.currentTaskIndex, 2);
  assert.deepEqual(new Set(snapshot.completedTaskIds), new Set(["one", "two", "three"]));
});

function taskSet() {
  return {
    id: "example",
    title: "Example",
    tasks: [
      { id: "one", title: "One", instructions: "First", completionMode: "manual" },
      { id: "two", title: "Two", instructions: "Second", completionMode: "manual" },
    ],
  };
}
