export const TASK_EVENT_TYPES = Object.freeze({
  TASK_SET_LOADED: "task_set_loaded",
  INSTRUCTIONS_TAB_OPENED: "instructions_tab_opened",
  TASK_VIEWED: "task_viewed",
  PREVIOUS_SELECTED: "previous_selected",
  TASK_COMPLETED: "task_completed",
  TASK_SET_COMPLETED: "task_set_completed",
  TASK_SESSION_CLEARED: "task_session_cleared",
});

const VALID_EVENT_TYPES = new Set(Object.values(TASK_EVENT_TYPES));

export class TaskEventLog {
  constructor({ contextProvider = () => ({}), now = () => new Date() } = {}) {
    this.contextProvider = contextProvider;
    this.now = now;
    this.events = [];
  }

  record(type, details = {}) {
    if (!VALID_EVENT_TYPES.has(type)) {
      throw new RangeError(`Unknown task event type: ${type}`);
    }
    const context = this.contextProvider?.() ?? {};
    const timestamp = this.now();
    const event = Object.freeze({
      type,
      timestamp: timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString(),
      taskSetId: details.taskSetId ?? context.taskSetId ?? null,
      taskId: details.taskId ?? context.taskId ?? null,
      sectionId: details.sectionId ?? context.sectionId ?? null,
      linkedSessionId: details.linkedSessionId ?? context.linkedSessionId ?? null,
      ...(details.reason ? { reason: details.reason } : {}),
    });
    this.events.push(event);
    return event;
  }

  getEvents() {
    return [...this.events];
  }

  clear() {
    this.events.length = 0;
  }
}
