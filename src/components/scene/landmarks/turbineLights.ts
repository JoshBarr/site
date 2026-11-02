import type { ObstructionLight } from "./ObstructionLights";
import { nacelleTop, towerTop } from "./turbineGeometry";
import type { TurbineModel } from "./turbineModels";

type Point = [number, number, number];

/** Flashing red lights on the nacelles of every turbine in a farm. */
export function turbineLights(
  model: TurbineModel,
  positions: Point[]
): ObstructionLight[] {
  const height = towerTop(model) + nacelleTop(model) + 0.4;

  return positions.map(([x, y, z]) => ({
    position: [x, y + height, z],
    flashing: true,
  }));
}
