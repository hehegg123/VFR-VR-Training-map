export class TaskSession {
  constructor(taskSet) {
    if (!taskSet || !Array.isArray(taskSet.tasks) || taskSet.tasks.length === 0) {
      throw new TypeError("TaskSession requires a task set with at least one task.");
    }
    this.taskSet = taskSet;
    this.currentTaskIndex = 0;
    this.completedTaskIds = new Set();
    this.subscribers = new Set();
    this.disposed = false;
  }

  get currentTask() {
    return this.taskSet.tasks[this.currentTaskIndex] ?? null;
  }

  getSnapshot() {
    return {
      taskSetId: this.taskSet.id,
      taskSetTitle: this.taskSet.title,
      currentTask: this.currentTask,
      currentTaskIndex: this.currentTaskIndex,
      taskCount: this.taskSet.tasks.length,
      completedTaskIds: [...this.completedTaskIds],
      canGoPrevious: this.currentTaskIndex > 0,
      canGoNext: this.currentTaskIndex < this.taskSet.tasks.length - 1,
      disposed: this.disposed,
    };
  }

  subscribe(listener) {
    this.assertActive();
    if (typeof listener !== "function") {
      throw new TypeError("TaskSession subscriber must be a function.");
    }
    this.subscribers.add(listener);
    listener(this.getSnapshot());
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener) {
    this.subscribers.delete(listener);
  }

  goToTask(taskIdOrIndex) {
    this.assertActive();
    const nextIndex = typeof taskIdOrIndex === "number"
      ? taskIdOrIndex
      : this.taskSet.tasks.findIndex((task) => task.id === taskIdOrIndex);
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= this.taskSet.tasks.length) {
      throw new RangeError(`Unknown task: ${taskIdOrIndex}`);
    }
    if (nextIndex !== this.currentTaskIndex) {
      this.currentTaskIndex = nextIndex;
      this.notify();
    }
    return this.currentTask;
  }

  next() {
    this.assertActive();
    if (this.currentTaskIndex >= this.taskSet.tasks.length - 1) {
      return this.currentTask;
    }
    return this.goToTask(this.currentTaskIndex + 1);
  }

  previous() {
    this.assertActive();
    if (this.currentTaskIndex <= 0) {
      return this.currentTask;
    }
    return this.goToTask(this.currentTaskIndex - 1);
  }

  setTaskCompleted(taskId, completed = true) {
    this.assertActive();
    if (!this.taskSet.tasks.some((task) => task.id === taskId)) {
      throw new RangeError(`Unknown task: ${taskId}`);
    }
    const changed = completed
      ? !this.completedTaskIds.has(taskId)
      : this.completedTaskIds.has(taskId);
    if (!changed) {
      return;
    }
    if (completed) {
      this.completedTaskIds.add(taskId);
    } else {
      this.completedTaskIds.delete(taskId);
    }
    this.notify();
  }

  setCurrentTaskCompleted(completed = true) {
    if (this.currentTask) {
      this.setTaskCompleted(this.currentTask.id, completed);
    }
  }

  completeCurrentAndAdvance() {
    this.assertActive();
    const currentTask = this.currentTask;
    if (!currentTask) {
      return null;
    }

    this.completedTaskIds.add(currentTask.id);
    const nextIncompleteIndex = this.taskSet.tasks.findIndex((task, index) => (
      index > this.currentTaskIndex && !this.completedTaskIds.has(task.id)
    ));
    if (nextIncompleteIndex >= 0) {
      this.currentTaskIndex = nextIncompleteIndex;
    }
    this.notify();
    return this.currentTask;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.notify();
    this.subscribers.clear();
  }

  notify() {
    const snapshot = this.getSnapshot();
    for (const listener of [...this.subscribers]) {
      listener(snapshot);
    }
  }

  assertActive() {
    if (this.disposed) {
      throw new Error("TaskSession has been disposed.");
    }
  }
}
