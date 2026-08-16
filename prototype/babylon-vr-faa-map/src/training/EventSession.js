const CONFLICT_PREDICTION_STEP_SEC = 0.5;
const DIVERGENCE_SAMPLE_SEC = 1;
const SEPARATION_EPSILON_NM = 1e-6;

export class EventSession {
  constructor(eventSet, { now = defaultNow } = {}) {
    if (!eventSet || !Array.isArray(eventSet.events) || eventSet.events.length === 0) {
      throw new TypeError("EventSession requires an event set with at least one event.");
    }
    if (typeof now !== "function") {
      throw new TypeError("EventSession now option must be a function.");
    }
    this.eventSet = eventSet;
    this.now = now;
    this.enabledEventIds = new Set(
      eventSet.events.filter((event) => event.defaultEnabled === true).map((event) => event.id),
    );
    this.scenarioStatus = eventSet.scenario ? "ready" : "unavailable";
    this.scenarioElapsedSec = 0;
    this.scenarioStartedAtMs = null;
    this.appliedScenarioActions = [];
    this.conflictWasActive = false;
    this.conflictResolved = false;
    this.authoritativeScenarioSnapshot = null;
    this.subscribers = new Set();
    this.disposed = false;
  }

  getSnapshot() {
    const authoritative = this.authoritativeScenarioSnapshot;
    const elapsedSec = authoritative?.scenarioElapsedSec ?? this.getScenarioElapsedSec();
    const scenarioStatus = authoritative?.scenarioStatus ?? this.getScenarioStatus(elapsedSec);
    const activeEvents = this.eventSet.events.filter((event) => this.enabledEventIds.has(event.id));
    const aircraftStates = authoritative?.aircraftStates ?? this.evaluateAircraftStates(elapsedSec);
    const conflict = authoritative?.conflict ?? this.evaluateConflict(elapsedSec, aircraftStates);
    return {
      eventSetId: this.eventSet.id,
      eventSetTitle: this.eventSet.title,
      sectionId: this.eventSet.sectionId,
      events: this.eventSet.events,
      activeEventIds: [...this.enabledEventIds],
      activeEvents,
      scenarioStatus,
      scenarioElapsedSec: elapsedSec,
      scenarioDurationSec: this.eventSet.scenario?.durationSec ?? null,
      aircraftStates,
      conflictState: conflict?.state ?? authoritative?.conflictState ?? "unavailable",
      conflict,
      scenarioActions: this.eventSet.scenario?.actions ?? [],
      appliedScenarioActions: (
        authoritative?.appliedScenarioActions ?? this.appliedScenarioActions
      ).map((action) => ({ ...action })),
      authoritative: Boolean(authoritative),
      disposed: this.disposed,
    };
  }

  applyAuthoritativeScenarioSnapshot(snapshot) {
    this.assertActive();
    this.assertScenario();
    if (!snapshot || snapshot.eventSetId !== this.eventSet.id) {
      throw new Error("Authoritative scenario snapshot does not match this event set.");
    }
    this.authoritativeScenarioSnapshot = {
      eventSetId: snapshot.eventSetId,
      scenarioStatus: snapshot.scenarioStatus,
      scenarioElapsedSec: Number(snapshot.scenarioElapsedSec) || 0,
      aircraftStates: (snapshot.aircraftStates ?? []).map(cloneAircraftState),
      conflictState: snapshot.conflictState ?? snapshot.conflict?.state ?? "normal",
      conflict: snapshot.conflict ? { ...snapshot.conflict } : null,
      appliedScenarioActions: (snapshot.appliedScenarioActions ?? []).map((action) => ({ ...action })),
    };
    if (Array.isArray(snapshot.activeEventIds)) {
      const validIds = new Set(this.eventSet.events.map((event) => event.id));
      this.enabledEventIds = new Set(snapshot.activeEventIds.filter((eventId) => validIds.has(eventId)));
    }
    this.notify();
  }

  clearAuthoritativeScenarioSnapshot({ notify = false } = {}) {
    if (!this.authoritativeScenarioSnapshot) {
      return false;
    }
    this.authoritativeScenarioSnapshot = null;
    if (notify) {
      this.notify();
    }
    return true;
  }

  applyScenarioAction(actionId) {
    this.assertActive();
    this.assertScenario();
    this.authoritativeScenarioSnapshot = null;
    const action = this.eventSet.scenario.actions?.find((candidate) => candidate.id === actionId);
    if (!action) {
      throw new RangeError(`Unknown scenario action: ${actionId}`);
    }
    if (this.appliedScenarioActions.some((applied) => applied.id === actionId)) {
      return false;
    }
    if (
      action.type === "resumeRoute"
      && !this.appliedScenarioActions.some((applied) =>
        applied.type === "turnHeading" && applied.aircraftId === action.aircraftId)
    ) {
      throw new Error(`Cannot resume route for ${action.aircraftId} before a heading is assigned.`);
    }

    const elapsedSec = this.getScenarioElapsedSec();
    const conflictBeforeAction = this.evaluateConflict(elapsedSec, this.evaluateAircraftStates(elapsedSec));
    if (
      action.type === "turnHeading"
      && !["conflict-predicted", "loss-of-separation"].includes(conflictBeforeAction?.state)
    ) {
      throw new Error(`Cannot assign a conflict heading to ${action.aircraftId} before an alert is active.`);
    }
    if (action.type === "resumeRoute" && conflictBeforeAction?.state !== "resolved") {
      throw new Error(`Cannot resume route for ${action.aircraftId} until the conflict is resolved.`);
    }
    if (["conflict-predicted", "loss-of-separation"].includes(conflictBeforeAction?.state)) {
      this.conflictWasActive = true;
    }
    this.appliedScenarioActions.push({
      ...action,
      appliedAtSec: elapsedSec,
    });
    this.notify();
    return true;
  }

  startScenario() {
    this.assertActive();
    this.assertScenario();
    this.authoritativeScenarioSnapshot = null;
    const elapsedSec = this.getScenarioElapsedSec();
    const status = this.getScenarioStatus(elapsedSec);
    if (status === "running" || status === "completed") {
      return false;
    }
    this.scenarioElapsedSec = elapsedSec;
    this.scenarioStartedAtMs = this.now();
    this.scenarioStatus = "running";
    this.notify();
    return true;
  }

  pauseScenario() {
    this.assertActive();
    this.assertScenario();
    this.authoritativeScenarioSnapshot = null;
    const elapsedSec = this.getScenarioElapsedSec();
    if (this.getScenarioStatus(elapsedSec) !== "running") {
      return false;
    }
    this.scenarioElapsedSec = elapsedSec;
    this.scenarioStartedAtMs = null;
    this.scenarioStatus = "paused";
    this.notify();
    return true;
  }

  resetScenario() {
    this.assertActive();
    this.assertScenario();
    const changed = this.scenarioStatus !== "ready"
      || this.scenarioElapsedSec !== 0
      || this.scenarioStartedAtMs !== null
      || this.appliedScenarioActions.length > 0
      || this.authoritativeScenarioSnapshot !== null;
    if (!changed) {
      return false;
    }
    this.scenarioStatus = "ready";
    this.scenarioElapsedSec = 0;
    this.scenarioStartedAtMs = null;
    this.appliedScenarioActions = [];
    this.conflictWasActive = false;
    this.conflictResolved = false;
    this.authoritativeScenarioSnapshot = null;
    this.notify();
    return true;
  }

  subscribe(listener) {
    this.assertActive();
    if (typeof listener !== "function") {
      throw new TypeError("EventSession subscriber must be a function.");
    }
    this.subscribers.add(listener);
    listener(this.getSnapshot());
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener) {
    this.subscribers.delete(listener);
  }

  setEventEnabled(eventId, enabled = true) {
    this.assertActive();
    if (!this.eventSet.events.some((event) => event.id === eventId)) {
      throw new RangeError(`Unknown event: ${eventId}`);
    }
    const nextEnabled = Boolean(enabled);
    const changed = nextEnabled
      ? !this.enabledEventIds.has(eventId)
      : this.enabledEventIds.has(eventId);
    if (!changed) {
      return false;
    }
    if (nextEnabled) {
      this.enabledEventIds.add(eventId);
    } else {
      this.enabledEventIds.delete(eventId);
    }
    this.notify();
    return true;
  }

  applyEnabledEventIds(eventIds) {
    this.assertActive();
    const validEventIds = new Set(this.eventSet.events.map((event) => event.id));
    const nextEnabled = new Set((eventIds ?? []).filter((eventId) => validEventIds.has(eventId)));
    const previous = [...this.enabledEventIds].sort().join("\u0000");
    const next = [...nextEnabled].sort().join("\u0000");
    if (previous === next) {
      return false;
    }
    this.enabledEventIds = nextEnabled;
    this.notify();
    return true;
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
      throw new Error("EventSession has been disposed.");
    }
  }

  assertScenario() {
    if (!this.eventSet.scenario) {
      throw new Error("EventSession does not contain a scenario timeline.");
    }
  }

  getScenarioElapsedSec() {
    if (!this.eventSet.scenario) {
      return 0;
    }
    let elapsedSec = this.scenarioElapsedSec;
    if (this.scenarioStatus === "running" && this.scenarioStartedAtMs !== null) {
      elapsedSec += Math.max(0, this.now() - this.scenarioStartedAtMs) / 1000;
    }
    return clamp(elapsedSec, 0, this.eventSet.scenario.durationSec);
  }

  getScenarioStatus(elapsedSec) {
    if (!this.eventSet.scenario) {
      return "unavailable";
    }
    if (elapsedSec >= this.eventSet.scenario.durationSec) {
      return "completed";
    }
    return this.scenarioStatus;
  }

  evaluateAircraftStates(elapsedSec) {
    return this.eventSet.events
      .filter((event) => event.type === "aircraft")
      .map((event) => evaluateScenarioAircraftState(
        event,
        elapsedSec,
        this.eventSet.scenario,
        this.appliedScenarioActions,
      ));
  }

  evaluateConflict(elapsedSec, aircraftStates = this.evaluateAircraftStates(elapsedSec)) {
    const scenario = this.eventSet.scenario;
    const coordinateScale = scenario?.coordinateScale;
    const separationMinimums = scenario?.separation;
    if (
      !scenario
      || aircraftStates.length < 2
      || !isPositiveNumber(coordinateScale?.widthNm)
      || !isPositiveNumber(coordinateScale?.heightNm)
      || !isPositiveNumber(separationMinimums?.horizontalNm)
      || !isPositiveNumber(separationMinimums?.verticalFt)
    ) {
      return null;
    }

    const current = calculateSeparation(aircraftStates[0], aircraftStates[1], coordinateScale);
    const predictionEndSec = Math.min(
      scenario.durationSec,
      elapsedSec + scenario.alertLookaheadSec,
    );
    let predictedMinimum = { ...current, timeSec: elapsedSec };
    let predictedViolation = false;
    for (
      let sampleTimeSec = elapsedSec + CONFLICT_PREDICTION_STEP_SEC;
      sampleTimeSec <= predictionEndSec + 1e-9;
      sampleTimeSec += CONFLICT_PREDICTION_STEP_SEC
    ) {
      const futureStates = this.evaluateAircraftStates(Math.min(sampleTimeSec, predictionEndSec));
      const future = calculateSeparation(futureStates[0], futureStates[1], coordinateScale);
      if (future.horizontalNm < predictedMinimum.horizontalNm) {
        predictedMinimum = { ...future, timeSec: Math.min(sampleTimeSec, predictionEndSec) };
      }
      if (violatesSeparation(future, separationMinimums)) {
        predictedViolation = true;
      }
    }

    const currentViolation = violatesSeparation(current, separationMinimums);
    const previousTimeSec = Math.max(0, elapsedSec - DIVERGENCE_SAMPLE_SEC);
    const previousStates = this.evaluateAircraftStates(previousTimeSec);
    const previous = calculateSeparation(previousStates[0], previousStates[1], coordinateScale);
    const safelyDiverging = elapsedSec > 0
      && current.horizontalNm > previous.horizontalNm + SEPARATION_EPSILON_NM;
    const interventionApplied = this.appliedScenarioActions.some((action) => action.type === "turnHeading");
    const newlyResolved = this.conflictWasActive
      && interventionApplied
      && !currentViolation
      && !predictedViolation
      && safelyDiverging;
    if (newlyResolved) {
      this.conflictResolved = true;
    }
    const resolved = this.conflictResolved;
    const activeIntervention = this.conflictWasActive && interventionApplied && !resolved;

    let state = "normal";
    if (currentViolation) {
      state = "loss-of-separation";
    } else if (resolved) {
      state = "resolved";
    } else if (predictedViolation || activeIntervention) {
      state = "conflict-predicted";
    }

    return {
      state,
      aircraftIds: aircraftStates.slice(0, 2).map((aircraft) => aircraft.eventId),
      horizontalSeparationNm: current.horizontalNm,
      verticalSeparationFt: current.verticalFt,
      predictedMinimumHorizontalNm: predictedMinimum.horizontalNm,
      predictedAtSec: predictedMinimum.timeSec,
      horizontalMinimumNm: separationMinimums.horizontalNm,
      verticalMinimumFt: separationMinimums.verticalFt,
      lookaheadSec: scenario.alertLookaheadSec,
      safelyDiverging,
    };
  }
}

export function evaluateAircraftState(event, elapsedSec) {
  const routePoints = event.route?.points;
  if (!Array.isArray(routePoints) || routePoints.length < 2) {
    return {
      eventId: event.id,
      position: event.position ? { ...event.position } : null,
      altitude: event.altitude ? { ...event.altitude } : null,
      headingDeg: normalizeHeading(event.orientation?.headingDeg ?? 0),
    };
  }

  const first = routePoints[0];
  const last = routePoints[routePoints.length - 1];
  if (elapsedSec <= first.timeSec) {
    return routePointState(event.id, first, first.headingDeg ?? segmentHeading(first, routePoints[1]));
  }
  if (elapsedSec >= last.timeSec) {
    return routePointState(
      event.id,
      last,
      last.headingDeg ?? segmentHeading(routePoints[routePoints.length - 2], last),
    );
  }

  const endIndex = routePoints.findIndex((point) => elapsedSec <= point.timeSec);
  const start = routePoints[endIndex - 1];
  const end = routePoints[endIndex];
  const segmentDurationSec = end.timeSec - start.timeSec;
  const progress = segmentDurationSec > 0
    ? (elapsedSec - start.timeSec) / segmentDurationSec
    : 0;
  const movementHeading = segmentHeading(start, end);

  return {
    eventId: event.id,
    position: {
      x: lerp(start.position.x, end.position.x, progress),
      y: lerp(start.position.y, end.position.y, progress),
    },
    altitude: interpolateAltitude(start.altitude, end.altitude, progress),
    headingDeg: interpolateHeading(start.headingDeg, end.headingDeg, progress, movementHeading),
  };
}

export function evaluateScenarioAircraftState(event, elapsedSec, scenario, appliedActions = []) {
  const aircraftActions = appliedActions
    .filter((action) => action.aircraftId === event.id && action.appliedAtSec <= elapsedSec)
    .sort((left, right) => left.appliedAtSec - right.appliedAtSec);
  const turn = aircraftActions.find((action) => action.type === "turnHeading");
  if (!turn) {
    return evaluateAircraftState(event, elapsedSec);
  }

  const coordinateScale = scenario?.coordinateScale;
  if (!isPositiveNumber(coordinateScale?.widthNm) || !isPositiveNumber(coordinateScale?.heightNm)) {
    return evaluateAircraftState(event, elapsedSec);
  }
  const turnOrigin = evaluateAircraftState(event, turn.appliedAtSec);
  const speedNmPerSec = routeSpeedAtTime(event, turn.appliedAtSec, coordinateScale);
  const resume = aircraftActions.find((action) =>
    action.type === "resumeRoute" && action.appliedAtSec >= turn.appliedAtSec);
  if (!resume || elapsedSec <= resume.appliedAtSec) {
    return projectAircraftState(
      turnOrigin,
      turn.headingDeg,
      speedNmPerSec * (elapsedSec - turn.appliedAtSec),
      coordinateScale,
    );
  }

  const resumeOrigin = projectAircraftState(
    turnOrigin,
    turn.headingDeg,
    speedNmPerSec * (resume.appliedAtSec - turn.appliedAtSec),
    coordinateScale,
  );
  return evaluateRouteRejoin(
    event,
    resumeOrigin,
    resume.appliedAtSec,
    elapsedSec,
    speedNmPerSec,
    coordinateScale,
  );
}

function routeSpeedAtTime(event, elapsedSec, coordinateScale) {
  const points = event.route?.points ?? [];
  if (points.length < 2) {
    return 0;
  }
  let endIndex = points.findIndex((point) => elapsedSec < point.timeSec);
  if (endIndex <= 0) {
    endIndex = Math.min(1, points.length - 1);
  }
  if (endIndex < 0) {
    endIndex = points.length - 1;
  }
  const start = points[endIndex - 1];
  const end = points[endIndex];
  const durationSec = end.timeSec - start.timeSec;
  return durationSec > 0
    ? normalizedDistanceNm(start.position, end.position, coordinateScale) / durationSec
    : 0;
}

function projectAircraftState(origin, headingDeg, distanceNm, coordinateScale) {
  const radians = toRadians(headingDeg);
  return {
    eventId: origin.eventId,
    position: {
      x: origin.position.x + (Math.sin(radians) * distanceNm) / coordinateScale.widthNm,
      y: origin.position.y - (Math.cos(radians) * distanceNm) / coordinateScale.heightNm,
    },
    altitude: origin.altitude ? { ...origin.altitude } : null,
    headingDeg: normalizeHeading(headingDeg),
  };
}

function evaluateRouteRejoin(event, origin, resumeTimeSec, elapsedSec, speedNmPerSec, coordinateScale) {
  const remainingPoints = (event.route?.points ?? []).filter((point) => point.timeSec > resumeTimeSec);
  if (!remainingPoints.length || speedNmPerSec <= 0) {
    return origin;
  }
  let remainingDistanceNm = speedNmPerSec * (elapsedSec - resumeTimeSec);
  let current = origin;
  for (const point of remainingPoints) {
    const segmentDistanceNm = normalizedDistanceNm(current.position, point.position, coordinateScale);
    const headingDeg = physicalHeading(current.position, point.position, coordinateScale);
    if (remainingDistanceNm <= segmentDistanceNm) {
      const progress = segmentDistanceNm > 0 ? remainingDistanceNm / segmentDistanceNm : 1;
      return {
        eventId: event.id,
        position: {
          x: lerp(current.position.x, point.position.x, progress),
          y: lerp(current.position.y, point.position.y, progress),
        },
        altitude: interpolateAltitude(current.altitude, point.altitude, progress),
        headingDeg,
      };
    }
    remainingDistanceNm -= segmentDistanceNm;
    current = routePointState(event.id, point, headingDeg);
  }
  return current;
}

function calculateSeparation(first, second, coordinateScale) {
  const firstAltitudeFt = altitudeFeet(first.altitude);
  const secondAltitudeFt = altitudeFeet(second.altitude);
  return {
    horizontalNm: normalizedDistanceNm(first.position, second.position, coordinateScale),
    verticalFt: Number.isFinite(firstAltitudeFt) && Number.isFinite(secondAltitudeFt)
      ? Math.abs(firstAltitudeFt - secondAltitudeFt)
      : Number.POSITIVE_INFINITY,
  };
}

function normalizedDistanceNm(first, second, coordinateScale) {
  if (!first || !second) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(
    (second.x - first.x) * coordinateScale.widthNm,
    (second.y - first.y) * coordinateScale.heightNm,
  );
}

function physicalHeading(first, second, coordinateScale) {
  const eastNm = (second.x - first.x) * coordinateScale.widthNm;
  const northNm = -(second.y - first.y) * coordinateScale.heightNm;
  return normalizeHeading((Math.atan2(eastNm, northNm) * 180) / Math.PI);
}

function altitudeFeet(altitude) {
  const value = Number(altitude?.valueFt);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function violatesSeparation(separation, minimums) {
  return separation.horizontalNm < minimums.horizontalNm
    && separation.verticalFt < minimums.verticalFt;
}

function routePointState(eventId, point, headingDeg) {
  return {
    eventId,
    position: { ...point.position },
    altitude: point.altitude ? { ...point.altitude } : null,
    headingDeg: normalizeHeading(headingDeg),
  };
}

function cloneAircraftState(state) {
  return {
    ...state,
    position: state?.position ? { ...state.position } : null,
    altitude: state?.altitude ? { ...state.altitude } : null,
  };
}

function interpolateAltitude(start, end, progress) {
  if (!start && !end) {
    return null;
  }
  if (!start) {
    return { ...end };
  }
  if (!end) {
    return { ...start };
  }
  return {
    ...start,
    valueFt: lerp(start.valueFt, end.valueFt, progress),
    reference: start.reference ?? end.reference,
  };
}

function interpolateHeading(start, end, progress, fallback) {
  if (!Number.isFinite(start) && !Number.isFinite(end)) {
    return fallback;
  }
  if (!Number.isFinite(start)) {
    return normalizeHeading(end);
  }
  if (!Number.isFinite(end)) {
    return normalizeHeading(start);
  }
  const delta = ((end - start + 540) % 360) - 180;
  return normalizeHeading(start + delta * progress);
}

function segmentHeading(start, end) {
  const deltaX = end.position.x - start.position.x;
  const deltaY = end.position.y - start.position.y;
  if (deltaX === 0 && deltaY === 0) {
    return 0;
  }
  // Normalized map y increases southward, so north is the negative y axis.
  return normalizeHeading((Math.atan2(deltaX, -deltaY) * 180) / Math.PI);
}

function normalizeHeading(value) {
  const heading = Number(value);
  return Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : 0;
}

function lerp(start, end, progress) {
  return start + (end - start) * progress;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function isPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
