import { resolveSectionAsset } from "./sectionRepository.js";

export const TASK_SET_SCHEMA = "faa-vr-task-set-v1";

export class TaskSetRepository {
  constructor(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("TaskSetRepository requires a fetch implementation.");
    }
    // Invoke browser-native fetch as a plain closure so class method dispatch
    // cannot replace the Window/global receiver.
    this.fetchImpl = (url, options) => fetchImpl.call(globalThis, url, options);
  }

  async load(manifest, entry) {
    validateManifestEntry(manifest, entry);
    const url = resolveSectionAsset(manifest, entry.data);
    let response;
    try {
      response = await this.fetchImpl(url, { cache: "no-store" });
    } catch (error) {
      throw new Error(`Failed to load task set ${entry.id} from ${url}: ${error?.message ?? error}`);
    }
    if (!response?.ok) {
      throw new Error(`Failed to load task set ${entry.id} from ${url}: HTTP ${response?.status ?? "unknown"}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Failed to parse task set ${entry.id} from ${url}: ${error?.message ?? error}`);
    }
    validateTaskSet(payload, manifest, entry);
    return payload;
  }
}

export function validateTaskSet(payload, manifest, entry) {
  const errors = [];
  const layerIds = new Set((manifest?.layers ?? []).map((layer) => layer?.id).filter(isNonemptyString));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid task set ${entry?.id ?? "<unknown>"}: payload must be an object.`);
  }
  if (payload.schema !== TASK_SET_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(TASK_SET_SCHEMA)}`);
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
  if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) {
    errors.push("tasks must be a nonempty array");
  } else {
    validateTasks(payload.tasks, layerIds, errors);
  }
  if (errors.length) {
    throw new Error(`Invalid task set ${entry.id}:\n- ${errors.join("\n- ")}`);
  }
  return payload;
}

function validateManifestEntry(manifest, entry) {
  if (!manifest || typeof manifest !== "object" || !isNonemptyString(manifest.id) || !isNonemptyString(manifest.__baseUrl)) {
    throw new Error("Cannot load task set: section manifest is missing id or __baseUrl.");
  }
  if (!entry || typeof entry !== "object" || !isNonemptyString(entry.id) || !isNonemptyString(entry.data)) {
    throw new Error("Cannot load task set: manifest entry must contain nonempty id and data fields.");
  }
}

function validateTasks(tasks, layerIds, errors) {
  const taskIds = new Set();
  tasks.forEach((task, taskIndex) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      errors.push(`tasks[${taskIndex}] must be an object`);
      return;
    }
    const taskLabel = isNonemptyString(task.id) ? `task ${JSON.stringify(task.id)}` : `tasks[${taskIndex}]`;
    if (!isNonemptyString(task.id)) {
      errors.push(`${taskLabel}.id must be a nonempty string`);
    } else if (taskIds.has(task.id)) {
      errors.push(`${taskLabel} duplicates an earlier task id`);
    } else {
      taskIds.add(task.id);
    }
    if (!isNonemptyString(task.title)) {
      errors.push(`${taskLabel}.title must be a nonempty string`);
    }
    if (!isNonemptyString(task.instructions)) {
      errors.push(`${taskLabel}.instructions must be a nonempty string`);
    }
    if (task.completionMode !== "manual") {
      errors.push(`${taskLabel}.completionMode must be "manual"`);
    }
    validateRecommendedLayers(task.recommendedLayers, taskLabel, layerIds, errors);
    validateTargets(task.targets, taskLabel, layerIds, errors);
  });
}

function validateRecommendedLayers(recommendedLayers, taskLabel, layerIds, errors) {
  if (recommendedLayers === undefined) {
    return;
  }
  if (!Array.isArray(recommendedLayers)) {
    errors.push(`${taskLabel}.recommendedLayers must be an array`);
    return;
  }
  recommendedLayers.forEach((layerId, index) => {
    if (!isNonemptyString(layerId)) {
      errors.push(`${taskLabel}.recommendedLayers[${index}] must be a nonempty string`);
    } else if (!layerIds.has(layerId)) {
      errors.push(`${taskLabel}.recommendedLayers[${index}] references unknown layer ${JSON.stringify(layerId)}`);
    }
  });
}

function validateTargets(targets, taskLabel, layerIds, errors) {
  if (targets === undefined) {
    return;
  }
  if (!Array.isArray(targets)) {
    errors.push(`${taskLabel}.targets must be an array`);
    return;
  }
  targets.forEach((target, index) => {
    const targetLabel = `${taskLabel}.targets[${index}]`;
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      errors.push(`${targetLabel} must be an object`);
      return;
    }
    if (!isNonemptyString(target.layerId)) {
      errors.push(`${targetLabel}.layerId must be a nonempty string`);
    } else if (!layerIds.has(target.layerId)) {
      errors.push(`${targetLabel}.layerId references unknown layer ${JSON.stringify(target.layerId)}`);
    }
    if (!isNonemptyString(target.selectionId)) {
      errors.push(`${targetLabel}.selectionId must be a nonempty string`);
    }
  });
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
