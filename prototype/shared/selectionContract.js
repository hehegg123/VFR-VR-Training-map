export function createFeatureSelection({ sectionId, layerId, featureId, label = null }) {
  return {
    sectionId,
    kind: "feature",
    layerId,
    featureId,
    labelId: null,
    label: label ?? featureId,
  };
}

export function createLabelSelection({
  sectionId,
  layerId,
  labelId,
  featureId = null,
  label = null,
}) {
  return {
    sectionId,
    kind: "label",
    layerId,
    featureId,
    labelId,
    label: label ?? labelId ?? featureId,
  };
}

export function normalizeSelection(selection) {
  if (!selection) {
    return null;
  }

  return {
    sectionId: selection.sectionId ?? null,
    kind: selection.kind ?? null,
    layerId: selection.layerId ?? null,
    featureId: selection.featureId ?? null,
    labelId: selection.labelId ?? null,
    label: selection.label ?? null,
  };
}

export function selectionsEqual(left, right) {
  const normalizedLeft = normalizeSelection(left);
  const normalizedRight = normalizeSelection(right);

  if (!normalizedLeft && !normalizedRight) {
    return true;
  }
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft.sectionId === normalizedRight.sectionId
    && normalizedLeft.kind === normalizedRight.kind
    && normalizedLeft.layerId === normalizedRight.layerId
    && normalizedLeft.featureId === normalizedRight.featureId
    && normalizedLeft.labelId === normalizedRight.labelId;
}

export function createSelectionSyncPayload(selection, { sessionId, sourceClientId }) {
  const normalized = normalizeSelection(selection);
  if (!normalized) {
    return {
      type: "selection-sync",
      sessionId,
      sourceClientId,
      sectionId: null,
      kind: "clear",
      layerId: null,
      featureId: null,
      labelId: null,
      label: null,
    };
  }

  return {
    type: "selection-sync",
    sessionId,
    sourceClientId,
    sectionId: normalized.sectionId,
    kind: normalized.kind,
    layerId: normalized.layerId,
    featureId: normalized.featureId,
    labelId: normalized.labelId,
    label: normalized.label,
  };
}

export function selectionFromSyncPayload(payload) {
  if (!payload || payload.kind === "clear") {
    return null;
  }

  return normalizeSelection(payload);
}
