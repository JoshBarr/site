import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Matrix3 } from "three/webgpu";
import { sceneNow } from "../clock";
import { equatorial, planets, PLANETS, skyRotation } from "./ephemeris";
import {
  createSkyGroup,
  createSkySprites,
  limitingMagnitude,
  limitingMagnitudeFor,
  SKY_PRIORITY,
} from "./skySprites";
import { STARS } from "./stars";
import { Satellites } from "./Satellites";
import { switchedOff } from "../stats";

// The night sky: the major constellations' stars and the planets Mercury
// to Saturn, where they are over Wellington at the scene's time, and the
// satellites passing over. Small points, coming out as the sky darkens.

const STAR_COUNT = STARS.length / 3;

const rotation = new Matrix3();

function useStars() {
  const { group, sprite, points } = useMemo(() => {
    const group = createSkyGroup();

    const { sprite, points } = createSkySprites(
      STAR_COUNT + PLANETS.length,
      STAR_COUNT
    );

    for (let i = 0; i < STAR_COUNT; i++) {
      const [ra, dec, magnitude] = STARS.slice(i * 3, i * 3 + 3);

      points.setXYZW(i, ...equatorial(ra, dec), magnitude);
    }

    sprite.count = STAR_COUNT + PLANETS.length;
    sprite.name = "stars";
    group.add(sprite);

    return { group, sprite, points };
  }, []);

  useEffect(() => () => sprite.material.dispose(), [sprite]);

  return { group, points };
}

/** The stars, planets and satellites, at the scene's time. */
export function Sky({
  time,
  sunAltitude,
}: {
  time: Date;
  /** Degrees: the stars come out as it sinks. */
  sunAltitude: number;
}) {
  const { group, points } = useStars();

  useEffect(() => {
    limitingMagnitude.value = limitingMagnitudeFor(sunAltitude);
  }, [sunAltitude]);

  // The planets creep along: placed again as the scene's clock ticks.
  useEffect(() => {
    planets(time.getTime()).forEach(({ direction, magnitude }, i) => {
      points.setXYZW(STAR_COUNT + i, ...direction, magnitude);
    });

    points.needsUpdate = true;
  }, [time, points]);

  useFrame(({ camera }) => {
    skyRotation(sceneNow(), rotation);
    group.matrix.setFromMatrix3(rotation).setPosition(camera.position);
    group.updateMatrixWorld(true);
  }, SKY_PRIORITY);

  return (
    <>
      <primitive object={group} />
      {!switchedOff("satellites") && <Satellites />}
    </>
  );
}
