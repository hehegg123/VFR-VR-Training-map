export function withBaseUrl(documentUrl, payload) {
  return {
    ...payload,
    __url: documentUrl.href,
    __baseUrl: new URL(".", documentUrl).href,
  };
}

export function cacheBust(url, version) {
  const busted = new URL(url);
  if (version) {
    busted.searchParams.set("v", version);
  }
  return busted;
}

export async function loadSectionIndex(indexUrl) {
  const response = await fetch(cacheBust(indexUrl, Date.now().toString()), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load section index: ${response.status}`);
  }

  const payload = await response.json();
  return withBaseUrl(indexUrl, payload);
}

export async function loadSectionManifest(indexUrl, sectionEntry) {
  const manifestUrl = new URL(sectionEntry.manifest, indexUrl);
  const response = await fetch(cacheBust(manifestUrl, Date.now().toString()), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load manifest for ${sectionEntry.id}: ${response.status}`);
  }

  const manifest = await response.json();
  return withBaseUrl(manifestUrl, manifest);
}

export function resolveSectionAsset(manifest, relativePath) {
  const assetUrl = new URL(relativePath, manifest.__baseUrl);
  return cacheBust(assetUrl, manifest.assetVersion ?? manifest.generatedAt ?? "").href;
}
