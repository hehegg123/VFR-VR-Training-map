export function pixelsToWorldPoint(sectionMetrics, pixelX, pixelY, elevation = 0) {
  const xRatio = pixelX / sectionMetrics.pixelWidth;
  const yRatio = pixelY / sectionMetrics.pixelHeight;
  const worldX = (xRatio - 0.5) * sectionMetrics.worldWidth;
  const worldZ = (0.5 - yRatio) * sectionMetrics.worldHeight;
  return new BABYLON.Vector3(worldX, elevation, worldZ);
}

export function pixelsToWorldVector2(sectionMetrics, pixelX, pixelY) {
  const point = pixelsToWorldPoint(sectionMetrics, pixelX, pixelY, 0);
  return new BABYLON.Vector2(point.x, point.z);
}

export function pixelsToWorldUnits(sectionMetrics, pixelAmount) {
  return (pixelAmount / sectionMetrics.pixelWidth) * sectionMetrics.worldWidth;
}
