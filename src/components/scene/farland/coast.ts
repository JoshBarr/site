import { smoothstep, texture } from "three/tsl";
import type { Texture } from "three/webgpu";

// The land past the terrain's root that nothing draws: the North Island
// north and east of it, and the South Island past the far land's mesh.
// The sea runs on out past the root, and would be drawn over them, or stop
// at a coast with nothing on it: it fades into the haze short of them
// instead, as the map does at the root's edge. scripts/farland/build_farland.py
// writes the map (COAST_SIZE and COAST_CELL there): centred on the scene's
// origin, row 0 its northern edge, black on such land and white 20 km and
// more from any.

export const COAST_URL = "/farland/coast.png";

/** The map's side, m. */
const COAST_EXTENT = 256 * 2000;

/**
 * How open the sea at world `xz` is: 1 well off any land that nothing
 * draws, 0 by it.
 */
export function openSea(coast: Texture, xz) {
  return smoothstep(0, 1, texture(coast, xz.div(COAST_EXTENT).add(0.5)).r);
}
