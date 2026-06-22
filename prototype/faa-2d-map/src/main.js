import { AppShell } from "./app/AppShell.js?v=20260621-instruction-control-v2";

const shell = new AppShell({
  baseCanvas: document.getElementById("baseCanvas"),
  overlayCanvas: document.getElementById("overlayCanvas"),
  labelCanvas: document.getElementById("labelCanvas"),
  interactionCanvas: document.getElementById("interactionCanvas"),
  mapViewport: document.getElementById("mapViewport"),
  fitViewButton: document.getElementById("fitViewButton"),
  sectionGroup: document.getElementById("sectionGroup"),
  sectionSelect: document.getElementById("sectionSelect"),
  instructionGroup: document.getElementById("instructionGroup"),
  instructionSelect: document.getElementById("instructionSelect"),
  resetTaskSessionButton: document.getElementById("resetTaskSessionButton"),
  instructionStatus: document.getElementById("instructionStatus"),
  sectionNote: document.getElementById("sectionNote"),
  layerControls: document.getElementById("layerControls"),
  linkSessionInput: document.getElementById("linkSessionInput"),
  startLinkButton: document.getElementById("startLinkButton"),
  disconnectLinkButton: document.getElementById("disconnectLinkButton"),
  linkStatus: document.getElementById("linkStatus"),
  statusLine: document.getElementById("statusLine"),
  sectionQuality: document.getElementById("sectionQuality"),
});

shell.start();
