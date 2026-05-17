import {
  loadSectionIndex as loadSharedSectionIndex,
  loadSectionManifest as loadSharedSectionManifest,
  resolveSectionAsset,
} from "../../../shared/sectionRepository.js";

const indexUrl = new URL("../../data/index.json", import.meta.url);

export async function loadSectionIndex() {
  return loadSharedSectionIndex(indexUrl);
}

export async function loadSectionManifest(sectionEntry) {
  return loadSharedSectionManifest(indexUrl, sectionEntry);
}

export { resolveSectionAsset };
