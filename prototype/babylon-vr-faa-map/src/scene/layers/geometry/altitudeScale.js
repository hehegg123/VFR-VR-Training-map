export const DEFAULT_WORLD_UNITS_PER_FOOT = 0.00008;

export function altitudeFeetToWorld(feet, worldUnitsPerFoot = DEFAULT_WORLD_UNITS_PER_FOOT) {
  const numericFeet = Number(feet);
  return Number.isFinite(numericFeet) ? numericFeet * worldUnitsPerFoot : 0;
}
