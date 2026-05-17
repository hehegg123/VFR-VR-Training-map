import { AppShell } from "./app/AppShell.js?v=20260516-label-style-v3";

const shell = new AppShell({
  canvas: document.getElementById("renderCanvas"),
  sectionGroup: document.getElementById("sectionGroup"),
  sectionSelect: document.getElementById("sectionSelect"),
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

shell.start();
