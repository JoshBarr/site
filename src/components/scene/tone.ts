import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
  type ToneMapping,
} from "three/webgpu";

// How the frame's light is mapped to the screen. ACES was only ever React
// Three Fiber's default; ?tone= tries the others, and ?exposure= sets the
// exposure outright.

const CURVES = {
  // Each curve's exposure puts a mid grey (0.18) where ACES puts it, at 127
  // of 255, so the scene's constants, all tuned under ACES, still hold
  // there. Worked out from three's own curves, for a grey.
  aces: [ACESFilmicToneMapping, 1],
  agx: [AgXToneMapping, 0.99],
  neutral: [NeutralToneMapping, 1.41],
} satisfies Record<string, [ToneMapping, number]>;

type Curve = keyof typeof CURVES;

const isCurve = (name: string | null): name is Curve =>
  name !== null && Object.hasOwn(CURVES, name);

/** The tone mapping and exposure the page asks for: ACES at 1 unless it says. */
function toneMapping() {
  const params = new URLSearchParams(location.search);
  const asked = params.get("tone");
  const [curve, matched] = CURVES[isCurve(asked) ? asked : "aces"];
  const exposure = Number(params.get("exposure"));

  return {
    toneMapping: curve,
    exposure: params.has("exposure") && exposure > 0 ? exposure : matched,
  };
}

/**
 * Sets `renderer`'s tone mapping as the page asks. After React Three Fiber
 * has set its own (in onCreated), or it puts back ACES.
 */
export function applyToneMapping(renderer: {
  toneMapping: ToneMapping;
  toneMappingExposure: number;
}) {
  const { toneMapping: curve, exposure } = toneMapping();

  renderer.toneMapping = curve;
  renderer.toneMappingExposure = exposure;
}
