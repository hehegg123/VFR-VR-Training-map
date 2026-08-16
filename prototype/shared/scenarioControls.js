export function buildScenarioControls(snapshot, onCommand) {
  if (!snapshot?.scenarioStatus || snapshot.scenarioStatus === "unavailable") {
    return null;
  }

  const group = document.createElement("section");
  group.className = "event-group scenario-controls";

  const heading = document.createElement("h3");
  heading.textContent = "Scenario";
  const title = document.createElement("strong");
  title.className = "scenario-title";
  title.textContent = snapshot.eventSetTitle;

  const readout = document.createElement("div");
  readout.className = "scenario-readout";
  for (const [field, label] of [
    ["elapsed", "Elapsed"],
    ["separation", "Separation"],
    ["status", "Conflict"],
  ]) {
    const item = document.createElement("p");
    const term = document.createElement("span");
    term.textContent = label;
    const value = document.createElement("strong");
    value.dataset.scenarioField = field;
    item.append(term, value);
    readout.append(item);
  }

  const transport = document.createElement("div");
  transport.className = "scenario-button-row";
  for (const [command, label] of [["start", "Start"], ["pause", "Pause"], ["reset", "Reset"]]) {
    transport.append(createCommandButton(command, label, onCommand));
  }

  const actions = document.createElement("div");
  actions.className = "scenario-action-list";
  actions.append(
    createCommandButton("action", "Flight A: Turn Right Heading 130.", onCommand, "flight-a-turn-right-130"),
    createCommandButton("action", "Resume Route", onCommand, "flight-a-resume-route"),
  );

  group.append(heading, title, readout, transport, actions);
  updateScenarioControls(group, snapshot);
  return group;
}

export function updateScenarioControls(container, snapshot) {
  if (!container || !snapshot?.scenarioStatus || snapshot.scenarioStatus === "unavailable") {
    return;
  }
  setField(container, "elapsed", formatElapsed(snapshot.scenarioElapsedSec));
  setField(container, "separation", formatSeparation(snapshot.conflict));
  const status = container.querySelector('[data-scenario-field="status"]');
  if (status) {
    status.textContent = formatConflictState(snapshot.conflictState);
    status.dataset.state = snapshot.conflictState;
  }

  const appliedActionIds = new Set(
    (snapshot.appliedScenarioActions ?? []).map((action) => action.id),
  );
  setDisabled(container, "start", !["ready", "paused"].includes(snapshot.scenarioStatus));
  setDisabled(container, "pause", snapshot.scenarioStatus !== "running");
  setDisabled(
    container,
    "reset",
    snapshot.scenarioStatus === "ready"
      && snapshot.scenarioElapsedSec === 0
      && appliedActionIds.size === 0,
  );
  setDisabled(
    container,
    "action",
    snapshot.scenarioStatus !== "running"
      || !["conflict-predicted", "loss-of-separation"].includes(snapshot.conflictState)
      || appliedActionIds.has("flight-a-turn-right-130"),
    "flight-a-turn-right-130",
  );
  setDisabled(
    container,
    "action",
    snapshot.scenarioStatus !== "running"
      || !appliedActionIds.has("flight-a-turn-right-130")
      || snapshot.conflictState !== "resolved"
      || appliedActionIds.has("flight-a-resume-route"),
    "flight-a-resume-route",
  );
}

export function createScenarioSyncSnapshot(snapshot) {
  return {
    eventSetId: snapshot.eventSetId,
    scenarioStatus: snapshot.scenarioStatus,
    scenarioElapsedSec: snapshot.scenarioElapsedSec,
    activeEventIds: [...(snapshot.activeEventIds ?? [])],
    aircraftStates: (snapshot.aircraftStates ?? []).map((state) => ({
      ...state,
      position: state.position ? { ...state.position } : null,
      altitude: state.altitude ? { ...state.altitude } : null,
    })),
    conflictState: snapshot.conflictState,
    conflict: snapshot.conflict ? { ...snapshot.conflict } : null,
    appliedScenarioActions: (snapshot.appliedScenarioActions ?? []).map((action) => ({ ...action })),
  };
}

function createCommandButton(command, label, onCommand, actionId = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button-secondary";
  button.textContent = label;
  button.dataset.scenarioCommand = command;
  if (actionId) {
    button.dataset.scenarioActionId = actionId;
  }
  button.addEventListener("click", () => onCommand(command, actionId));
  return button;
}

function setField(container, field, text) {
  const element = container.querySelector(`[data-scenario-field="${field}"]`);
  if (element) {
    element.textContent = text;
  }
}

function setDisabled(container, command, disabled, actionId = null) {
  const selector = actionId
    ? `[data-scenario-command="${command}"][data-scenario-action-id="${actionId}"]`
    : `[data-scenario-command="${command}"]`;
  const button = container.querySelector(selector);
  if (button) {
    button.disabled = disabled;
  }
}

function formatElapsed(seconds) {
  const wholeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${`${wholeSeconds % 60}`.padStart(2, "0")}`;
}

function formatSeparation(conflict) {
  if (!conflict) {
    return "Unavailable";
  }
  return `${conflict.horizontalSeparationNm.toFixed(1)} NM / ${Math.round(conflict.verticalSeparationFt)} ft`;
}

function formatConflictState(state) {
  return ({
    normal: "Normal",
    "conflict-predicted": "Conflict predicted",
    "loss-of-separation": "Loss of separation",
    resolved: "Resolved",
  })[state] ?? "Unavailable";
}
