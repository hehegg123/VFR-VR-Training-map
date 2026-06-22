import { AppShell } from "./app/AppShell.js?v=20260621-instruction-workflow-v1";

const shell = new AppShell({
  canvas: document.getElementById("renderCanvas"),
  sectionGroup: document.getElementById("sectionGroup"),
  sectionSelect: document.getElementById("sectionSelect"),
  instructionGroup: document.getElementById("instructionGroup"),
  instructionSelect: document.getElementById("instructionSelect"),
  resetTaskSessionButton: document.getElementById("resetTaskSessionButton"),
  sectionNote: document.getElementById("sectionNote"),
  layerControls: document.getElementById("layerControls"),
  linkSessionInput: document.getElementById("linkSessionInput"),
  startLinkButton: document.getElementById("startLinkButton"),
  disconnectLinkButton: document.getElementById("disconnectLinkButton"),
  linkStatus: document.getElementById("linkStatus"),
  enterVrButton: document.getElementById("enterVrButton"),
  statusLine: document.getElementById("statusLine"),
  sectionQuality: document.getElementById("sectionQuality"),
  xrHint: document.getElementById("xrHint"),
});

globalThis.faaInstructionResearch = Object.freeze({
  getEvents: () => shell.taskEventLog.getEvents(),
});

shell.start();
