// Wind turbine types around Wellington: their shape and how they run.
//
// Frames: a turbine stands at its origin with y up. The nacelle frame turns
// with the yaw; its +z points into the wind, toward the rotor.

export interface TurbineModel {
  name: string;
  /** Rotor centre above the ground, m. */
  hubHeight: number;
  /** Blade tip radius, m. */
  rotorRadius: number;
  /** Where the blades leave the spinner, m from the axis. */
  rootRadius: number;
  /** Widest chord, m, and where along the blade (fraction of the radius). */
  maxChord: number;
  maxChordAt: number;
  towerBaseRadius: number;
  towerTopRadius: number;
  /** Rotor centre above the yaw bearing (tower top), m. */
  hubAbove: number;
  /** Rotor plane ahead of the tower axis, m. */
  overhang: number;
  /** Shaft tilt (nose up) and blade cone (tips upwind), radians. */
  tilt: number;
  cone: number;
  nacelle: "box" | "egg";
  colour: string;

  /** Variable-speed range, rpm. */
  minRpm: number;
  maxRpm: number;
  /** Tip speed ratio held below rated speed. */
  tipSpeedRatio: number;
  /** Hub-height wind speeds, m/s. */
  cutIn: number;
  rated: number;
  cutOut: number;
  /**
   * Enercon's storm control: rather than stopping at cut-out, the rotor slows
   * steadily until this speed, then idles.
   */
  stormEnd?: number;
  /** Nacelle slew rate, degrees per second. */
  yawRate: number;
}

/**
 * Siemens SWT-2.3-82 VS: West Wind (68 m hub) and Mill Creek. 82.4 m rotor,
 * 6–18 rpm, pitch regulated. Light grey (RAL 7035).
 */
export const SWT_2_3_82: TurbineModel = {
  name: "Siemens SWT-2.3-82 VS",
  hubHeight: 68,
  rotorRadius: 41.2,
  rootRadius: 1.4,
  maxChord: 3.1,
  maxChordAt: 0.2,
  towerBaseRadius: 2.1,
  towerTopRadius: 1.2,
  hubAbove: 2.1,
  overhang: 4.4,
  tilt: (6 * Math.PI) / 180,
  cone: (2 * Math.PI) / 180,
  nacelle: "box",
  colour: "#d6d9d4",

  minRpm: 6,
  maxRpm: 17,
  tipSpeedRatio: 8,
  cutIn: 4,
  rated: 13.5,
  cutOut: 25,
  yawRate: 0.5,
};

/**
 * Enercon E-44 at Brooklyn since 2016: 44 m rotor, 45 m hub (67 m to the
 * tip), the "egg" nacelle around a direct-drive ring generator, 12–34.5 rpm.
 */
export const E_44: TurbineModel = {
  name: "Enercon E-44",
  hubHeight: 45,
  rotorRadius: 22,
  rootRadius: 1.3,
  maxChord: 2.1,
  maxChordAt: 0.14,
  towerBaseRadius: 1.65,
  towerTopRadius: 1.0,
  hubAbove: 1.9,
  overhang: 3.3,
  tilt: (4 * Math.PI) / 180,
  cone: (1.5 * Math.PI) / 180,
  nacelle: "egg",
  colour: "#dfe1dc",

  minRpm: 12,
  maxRpm: 34.5,
  tipSpeedRatio: 8,
  cutIn: 3,
  rated: 16.5,
  cutOut: 25,
  stormEnd: 34,
  yawRate: 0.8,
};

/** Wind shear exponent: speed grows as height^α over open hills. */
const SHEAR = 0.143;
/** Height the forecast wind is given at, m. */
const REFERENCE_HEIGHT = 10;

export function windAtHub(model: TurbineModel, surfaceWind: number) {
  return surfaceWind * (model.hubHeight / REFERENCE_HEIGHT) ** SHEAR;
}

/** Fully feathered: blades edge-on to the wind. */
export const FEATHERED = (85 * Math.PI) / 180;
/** Slow freewheeling while parked or waiting for wind. */
const IDLE_RPM = 1;

/**
 * Where the controller wants the rotor for a steady hub wind: rpm and blade
 * pitch (radians). `running` is whether it's generating.
 */
export function operatingPoint(
  model: TurbineModel,
  wind: number,
  running: boolean
) {
  if (!running) {
    return {
      rpm: IDLE_RPM * Math.min(wind / model.cutIn, 1),
      pitch: FEATHERED,
    };
  }

  // Below rated: hold the tip speed ratio, within the speed range.
  const omega = (model.tipSpeedRatio * wind) / model.rotorRadius;
  let rpm = Math.min(
    Math.max((omega * 60) / (2 * Math.PI), model.minRpm),
    model.maxRpm
  );

  // Above rated: speed held, blades pitch out to shed power. Roughly 25° by
  // cut-out.
  const excess = Math.max(wind - model.rated, 0);
  let pitch = (excess / (model.cutOut - model.rated)) * ((25 * Math.PI) / 180);

  if (model.stormEnd && wind > model.cutOut) {
    const t = Math.min(
      (wind - model.cutOut) / (model.stormEnd - model.cutOut),
      1
    );
    rpm = rpm * (1 - t) + IDLE_RPM * t;
    pitch = pitch * (1 - t) + FEATHERED * t;
  }

  return { rpm, pitch };
}

/**
 * Start/stop decisions on a slowly averaged wind, with hysteresis so a
 * turbine near a threshold doesn't hunt.
 */
export function shouldRun(
  model: TurbineModel,
  averageWind: number,
  running: boolean
) {
  // Storm control keeps an Enercon turning through the storm.
  const stop = model.stormEnd ?? model.cutOut;
  if (running) {
    return averageWind > model.cutIn - 0.5 && averageWind < stop;
  }
  return averageWind > model.cutIn && averageWind < stop - 4;
}
