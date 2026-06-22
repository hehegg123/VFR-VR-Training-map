import {
  createSelectionSyncPayload,
  selectionFromSyncPayload,
} from "./selectionContract.js";

const DEFAULT_CHANNEL_NAMESPACE = "faa-map-link-v1";
const DEFAULT_STORAGE_KEY = "faa-map-link-session-id";

function fallbackUuid() {
  return `client-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function createClientId(appId) {
  if (globalThis.crypto?.randomUUID) {
    return `${appId}-${globalThis.crypto.randomUUID()}`;
  }
  return `${appId}-${fallbackUuid()}`;
}

export function generateSessionId(sectionId = "stlouis") {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${sectionId}-review-${suffix}`;
}

export function readSavedSessionId(storageKey = DEFAULT_STORAGE_KEY) {
  try {
    return globalThis.localStorage?.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

export class BroadcastLinkSession {
  constructor({
    appId,
    channelNamespace = DEFAULT_CHANNEL_NAMESPACE,
    storageKey = DEFAULT_STORAGE_KEY,
  }) {
    this.appId = appId;
    this.channelNamespace = channelNamespace;
    this.storageKey = storageKey;
    this.clientId = createClientId(appId);
    this.sessionId = "";
    this.channel = null;
    this.onSelection = null;
    this.onToggle = null;
    this.onInstruction = null;
    this.onStatusChange = null;
  }

  connect(sessionId, { onSelection, onToggle, onInstruction, onStatusChange } = {}) {
    this.disconnect();
    this.sessionId = sessionId;
    this.onSelection = onSelection ?? null;
    this.onToggle = onToggle ?? null;
    this.onInstruction = onInstruction ?? null;
    this.onStatusChange = onStatusChange ?? null;
    this.channel = new BroadcastChannel(`${this.channelNamespace}:${sessionId}`);
    this.channel.onmessage = (event) => {
      const payload = event.data;
      if (!payload) {
        return;
      }
      if (payload.sourceClientId === this.clientId) {
        return;
      }
      if (payload.type === "selection-sync") {
        this.onSelection?.(selectionFromSyncPayload(payload));
        return;
      }
      if (payload.type === "toggle-sync") {
        this.onToggle?.(toggleFromSyncPayload(payload));
        return;
      }
      if (payload.type === "instruction-sync") {
        this.onInstruction?.(instructionFromSyncPayload(payload));
      }
    };
    try {
      globalThis.localStorage?.setItem(this.storageKey, sessionId);
    } catch {
      // Ignore localStorage failures in restricted contexts.
    }
    this.notifyStatus();
  }

  disconnect() {
    this.channel?.close();
    this.channel = null;
    this.sessionId = "";
    this.notifyStatus();
  }

  isConnected() {
    return Boolean(this.channel && this.sessionId);
  }

  publishSelection(selection) {
    if (!this.channel || !this.sessionId) {
      return;
    }
    this.channel.postMessage(
      createSelectionSyncPayload(selection, {
        sessionId: this.sessionId,
        sourceClientId: this.clientId,
      }),
    );
  }

  publishToggle(toggle) {
    if (!this.channel || !this.sessionId) {
      return;
    }
    this.channel.postMessage(
      createToggleSyncPayload(toggle, {
        sessionId: this.sessionId,
        sourceClientId: this.clientId,
      }),
    );
  }

  publishInstruction(instruction) {
    if (!this.channel || !this.sessionId) {
      return;
    }
    this.channel.postMessage(
      createInstructionSyncPayload(instruction, {
        sessionId: this.sessionId,
        sourceClientId: this.clientId,
      }),
    );
  }

  notifyStatus() {
    this.onStatusChange?.({
      connected: this.isConnected(),
      sessionId: this.sessionId,
      clientId: this.clientId,
    });
  }
}

function createToggleSyncPayload(toggle, { sessionId, sourceClientId }) {
  return {
    type: "toggle-sync",
    sessionId,
    sourceClientId,
    sectionId: toggle.sectionId ?? null,
    layerId: toggle.layerId ?? null,
    target: toggle.target ?? null,
    checked: Boolean(toggle.checked),
  };
}

function toggleFromSyncPayload(payload) {
  if (!payload) {
    return null;
  }
  return {
    sectionId: payload.sectionId ?? null,
    layerId: payload.layerId ?? null,
    target: payload.target ?? null,
    checked: Boolean(payload.checked),
  };
}

function createInstructionSyncPayload(instruction, { sessionId, sourceClientId }) {
  return {
    type: "instruction-sync",
    sessionId,
    sourceClientId,
    action: instruction.action ?? null,
    sectionId: instruction.sectionId ?? null,
    taskSetId: instruction.taskSetId ?? null,
  };
}

function instructionFromSyncPayload(payload) {
  if (!payload) {
    return null;
  }
  return {
    action: payload.action ?? null,
    sectionId: payload.sectionId ?? null,
    taskSetId: payload.taskSetId ?? null,
  };
}
