import { resolveSectionAsset } from "./sectionRepository.js";

export const EVENT_SET_SCHEMA = "faa-vr-event-set-v1";
const SUPPORTED_EVENT_TYPES = new Set(["aircraft", "weather"]);

export class EventSetRepository {
  constructor(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("EventSetRepository requires a fetch implementation.");
    }
    this.fetchImpl = (url, options) => fetchImpl.call(globalThis, url, options);
  }

  async load(manifest, entry) {
    validateManifestEntry(manifest, entry);
    const url = resolveSectionAsset(manifest, entry.data);
    let response;
    try {
      response = await this.fetchImpl(url, { cache: "no-store" });
    } catch (error) {
      throw new Error(`Failed to load event set ${entry.id} from ${url}: ${error?.message ?? error}`);
    }
    if (!response?.ok) {
      throw new Error(`Failed to load event set ${entry.id} from ${url}: HTTP ${response?.status ?? "unknown"}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Failed to parse event set ${entry.id} from ${url}: ${error?.message ?? error}`);
    }
    validateEventSet(payload, manifest, entry);
    return payload;
  }
}

export function validateEventSet(payload, manifest, entry) {
  const errors = [];
  const layerIds = new Set((manifest?.layers ?? []).map((layer) => layer?.id).filter(isNonemptyString));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid event set ${entry?.id ?? "<unknown>"}: payload must be an object.`);
  }
  if (payload.schema !== EVENT_SET_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(EVENT_SET_SCHEMA)}`);
  }
  if (payload.id !== entry.id) {
    errors.push(`id must match manifest id ${JSON.stringify(entry.id)}, found ${JSON.stringify(payload.id)}`);
  }
  if (payload.sectionId !== manifest.id) {
    errors.push(`sectionId must be ${JSON.stringify(manifest.id)}, found ${JSON.stringify(payload.sectionId)}`);
  }
  if (!isNonemptyString(payload.title)) {
    errors.push("title must be a nonempty string");
  }
  validateScenario(payload.scenario, errors);
  if (!Array.isArray(payload.events) || payload.events.length === 0) {
    errors.push("events must be a nonempty array");
  } else {
    validateEvents(payload.events, layerIds, errors, payload.scenario);
    validateScenarioActionTargets(payload.scenario, payload.events, errors);
  }
  if (errors.length) {
    throw new Error(`Invalid event set ${entry.id}:\n- ${errors.join("\n- ")}`);
  }
  return payload;
}

function validateManifestEntry(manifest, entry) {
  if (!manifest || typeof manifest !== "object" || !isNonemptyString(manifest.id) || !isNonemptyString(manifest.__baseUrl)) {
    throw new Error("Cannot load event set: section manifest is missing id or __baseUrl.");
  }
  if (!entry || typeof entry !== "object" || !isNonemptyString(entry.id) || !isNonemptyString(entry.data)) {
    throw new Error("Cannot load event set: manifest entry must contain nonempty id and data fields.");
  }
}

function validateScenario(scenario, errors) {
  if (scenario === undefined) {
    return;
  }
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
    errors.push("scenario must be an object");
    return;
  }
  if (!isPositiveNumber(scenario.durationSec)) {
    errors.push("scenario.durationSec must be a positive finite number");
  }
  if (!isNonnegativeNumber(scenario.alertLookaheadSec)) {
    errors.push("scenario.alertLookaheadSec must be a finite nonnegative number");
  }
  validateCoordinateScale(scenario.coordinateScale, errors);
  validateSeparation(scenario.separation, "scenario.separation", errors);
  if (scenario.metadata !== undefined && (!scenario.metadata || typeof scenario.metadata !== "object" || Array.isArray(scenario.metadata))) {
    errors.push("scenario.metadata must be an object when provided");
  }
  validateScenarioActions(scenario.actions, errors);
}

function validateCoordinateScale(coordinateScale, errors) {
  if (!coordinateScale || typeof coordinateScale !== "object" || Array.isArray(coordinateScale)) {
    errors.push("scenario.coordinateScale must be an object");
    return;
  }
  if (!isPositiveNumber(coordinateScale.widthNm)) {
    errors.push("scenario.coordinateScale.widthNm must be a positive finite number");
  }
  if (!isPositiveNumber(coordinateScale.heightNm)) {
    errors.push("scenario.coordinateScale.heightNm must be a positive finite number");
  }
}

function validateSeparation(separation, label, errors) {
  if (!separation || typeof separation !== "object" || Array.isArray(separation)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (!isPositiveNumber(separation.horizontalNm)) {
    errors.push(`${label}.horizontalNm must be a positive finite number`);
  }
  if (!isPositiveNumber(separation.verticalFt)) {
    errors.push(`${label}.verticalFt must be a positive finite number`);
  }
}

function validateScenarioActions(actions, errors) {
  if (actions === undefined) {
    return;
  }
  if (!Array.isArray(actions)) {
    errors.push("scenario.actions must be an array when provided");
    return;
  }
  const actionIds = new Set();
  actions.forEach((action, index) => {
    const label = isNonemptyString(action?.id) ? `scenario action ${JSON.stringify(action.id)}` : `scenario.actions[${index}]`;
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      errors.push(`${label} must be an object`);
      return;
    }
    if (!isNonemptyString(action.id)) {
      errors.push(`${label}.id must be a nonempty string`);
    } else if (actionIds.has(action.id)) {
      errors.push(`${label} duplicates an earlier scenario action id`);
    } else {
      actionIds.add(action.id);
    }
    if (!isNonemptyString(action.title)) {
      errors.push(`${label}.title must be a nonempty string`);
    }
    if (!["turnHeading", "resumeRoute"].includes(action.type)) {
      errors.push(`${label}.type must be "turnHeading" or "resumeRoute"`);
    }
    if (!isNonemptyString(action.aircraftId)) {
      errors.push(`${label}.aircraftId must be a nonempty string`);
    }
    if (action.type === "turnHeading" && !isHeadingDegrees(action.headingDeg)) {
      errors.push(`${label}.headingDeg must be a finite heading in degrees from 0 to less than 360`);
    }
  });
}

function validateScenarioActionTargets(scenario, events, errors) {
  const actions = scenario?.actions;
  if (!Array.isArray(actions) || !Array.isArray(events)) {
    return;
  }
  const aircraftIds = new Set(
    events
      .filter((event) => event?.type === "aircraft" && isNonemptyString(event.id))
      .map((event) => event.id),
  );
  for (const action of actions) {
    if (isNonemptyString(action?.aircraftId) && !aircraftIds.has(action.aircraftId)) {
      errors.push(`scenario action ${JSON.stringify(action.id ?? "<unknown>")}.aircraftId must reference an aircraft event id`);
    }
  }
}

function validateEvents(events, layerIds, errors, scenario = null) {
  const eventIds = new Set();
  events.forEach((event, eventIndex) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      errors.push(`events[${eventIndex}] must be an object`);
      return;
    }
    const eventLabel = isNonemptyString(event.id) ? `event ${JSON.stringify(event.id)}` : `events[${eventIndex}]`;
    if (!isNonemptyString(event.id)) {
      errors.push(`${eventLabel}.id must be a nonempty string`);
    } else if (eventIds.has(event.id)) {
      errors.push(`${eventLabel} duplicates an earlier event id`);
    } else {
      eventIds.add(event.id);
    }
    if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
      errors.push(`${eventLabel}.type must be "aircraft" or "weather"`);
    }
    if (!isNonemptyString(event.title)) {
      errors.push(`${eventLabel}.title must be a nonempty string`);
    }
    if (event.triggerMode !== "manual") {
      errors.push(`${eventLabel}.triggerMode must be "manual"`);
    }
    if (typeof event.defaultEnabled !== "boolean") {
      errors.push(`${eventLabel}.defaultEnabled must be a boolean`);
    }
    const hasRoute = event.route !== undefined;
    if (!event.position && !event.target && !event.geometry && !hasRoute) {
      errors.push(`${eventLabel} must define position, target, geometry, or route`);
    }
    if (event.type === "aircraft" && !event.position && !event.target && !hasRoute) {
      errors.push(`${eventLabel} aircraft events must define position, target, or route`);
    }
    validatePosition(event.position, eventLabel, errors);
    validateTarget(event.target, eventLabel, layerIds, errors);
    validateGeometry(event.geometry, eventLabel, errors);
    validateAltitude(event.altitude, event.type, eventLabel, errors);
    validateRoute(event.route, event.type, eventLabel, errors, scenario);
  });
}

function validatePosition(position, eventLabel, errors) {
  if (position === undefined) {
    return;
  }
  if (!position || typeof position !== "object" || Array.isArray(position)) {
    errors.push(`${eventLabel}.position must be an object`);
    return;
  }
  if (!isNormalizedNumber(position.x)) {
    errors.push(`${eventLabel}.position.x must be a normalized number from 0 to 1`);
  }
  if (!isNormalizedNumber(position.y)) {
    errors.push(`${eventLabel}.position.y must be a normalized number from 0 to 1`);
  }
}

function validateRoute(route, eventType, eventLabel, errors, scenario = null) {
  if (route === undefined) {
    return;
  }
  if (eventType !== "aircraft") {
    errors.push(`${eventLabel}.route is only supported for aircraft events`);
    return;
  }
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    errors.push(`${eventLabel}.route must be an object`);
    return;
  }
  if (!Array.isArray(route.points) || route.points.length < 2) {
    errors.push(`${eventLabel}.route.points must contain at least two timed points`);
    return;
  }
  let previousTime = -Infinity;
  route.points.forEach((point, index) => {
    const pointLabel = `${eventLabel}.route.points[${index}]`;
    if (!point || typeof point !== "object" || Array.isArray(point)) {
      errors.push(`${pointLabel} must be an object`);
      return;
    }
    if (!isNonnegativeNumber(point.timeSec)) {
      errors.push(`${pointLabel}.timeSec must be a finite nonnegative number`);
    } else {
      if (point.timeSec <= previousTime) {
        errors.push(`${pointLabel}.timeSec must be greater than the previous route point timeSec`);
      }
      if (isPositiveNumber(scenario?.durationSec) && point.timeSec > scenario.durationSec) {
        errors.push(`${pointLabel}.timeSec must not exceed scenario.durationSec`);
      }
      previousTime = point.timeSec;
    }
    validatePosition(point.position, pointLabel, errors);
    if (point.altitude === undefined) {
      errors.push(`${pointLabel}.altitude must be provided for route-based aircraft events`);
    } else {
      validateAltitude(point.altitude, "aircraft", pointLabel, errors);
    }
    if (point.headingDeg !== undefined && !isHeadingDegrees(point.headingDeg)) {
      errors.push(`${pointLabel}.headingDeg must be a finite heading in degrees from 0 to less than 360`);
    }
  });
}

function validateTarget(target, eventLabel, layerIds, errors) {
  if (target === undefined) {
    return;
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    errors.push(`${eventLabel}.target must be an object`);
    return;
  }
  if (!isNonemptyString(target.layerId)) {
    errors.push(`${eventLabel}.target.layerId must be a nonempty string`);
  } else if (!layerIds.has(target.layerId)) {
    errors.push(`${eventLabel}.target.layerId references unknown layer ${JSON.stringify(target.layerId)}`);
  }
  if (!isNonemptyString(target.selectionId)) {
    errors.push(`${eventLabel}.target.selectionId must be a nonempty string`);
  }
}

function validateGeometry(geometry, eventLabel, errors) {
  if (geometry === undefined) {
    return;
  }
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) {
    errors.push(`${eventLabel}.geometry must be an object`);
    return;
  }
  if (geometry.type === "circle") {
    if (!isNormalizedNumber(geometry.x)) {
      errors.push(`${eventLabel}.geometry.x must be a normalized number from 0 to 1`);
    }
    if (!isNormalizedNumber(geometry.y)) {
      errors.push(`${eventLabel}.geometry.y must be a normalized number from 0 to 1`);
    }
    if (!isPositiveNormalizedNumber(geometry.radius)) {
      errors.push(`${eventLabel}.geometry.radius must be a positive normalized number no larger than 1`);
    }
    return;
  }
  if (geometry.type === "polygon") {
    if (!Array.isArray(geometry.points) || geometry.points.length < 3) {
      errors.push(`${eventLabel}.geometry.points must contain at least three normalized points`);
      return;
    }
    geometry.points.forEach((point, index) => {
      if (!Array.isArray(point) || point.length !== 2 || !isNormalizedNumber(point[0]) || !isNormalizedNumber(point[1])) {
        errors.push(`${eventLabel}.geometry.points[${index}] must be [x, y] normalized numbers`);
      }
    });
    return;
  }
  errors.push(`${eventLabel}.geometry.type must be "circle" or "polygon"`);
}

function validateAltitude(altitude, eventType, eventLabel, errors) {
  if (altitude === undefined) {
    return;
  }
  if (!altitude || typeof altitude !== "object" || Array.isArray(altitude)) {
    errors.push(`${eventLabel}.altitude must be an object`);
    return;
  }
  if (!["MSL", "AGL"].includes(altitude.reference)) {
    errors.push(`${eventLabel}.altitude.reference must be "MSL" or "AGL"`);
  }
  if (eventType === "aircraft") {
    if (altitude.valueFt !== undefined && !isNonnegativeNumber(altitude.valueFt)) {
      errors.push(`${eventLabel}.altitude.valueFt must be a finite nonnegative number`);
    }
    return;
  }
  if (eventType === "weather") {
    if (altitude.baseFt !== undefined && !isNonnegativeNumber(altitude.baseFt)) {
      errors.push(`${eventLabel}.altitude.baseFt must be a finite nonnegative number`);
    }
    if (altitude.topFt !== undefined && !isNonnegativeNumber(altitude.topFt)) {
      errors.push(`${eventLabel}.altitude.topFt must be a finite nonnegative number`);
    }
    if (isNonnegativeNumber(altitude.baseFt) && isNonnegativeNumber(altitude.topFt) && altitude.topFt < altitude.baseFt) {
      errors.push(`${eventLabel}.altitude.topFt must be greater than or equal to baseFt`);
    }
  }
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNormalizedNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveNormalizedNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

function isNonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isHeadingDegrees(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 360;
}
