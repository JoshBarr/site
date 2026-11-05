import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import {
  Box3,
  DirectionalLight,
  Light,
  PerspectiveCamera,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import {
  abs,
  cameraPosition,
  dot,
  float,
  fog,
  max,
  mix,
  positionWorld,
  positionWorldDirection,
  smoothstep,
} from "three/tsl";
import {
  clearAround,
  clearRadius,
  hazeColor,
  hazeDensity,
  hazeDensityForVisibility,
  hazeTransmittance,
  hazeTransmittanceBetween,
  outsideClearing,
  phase,
} from "./haze";
import { hazeGlowAtNight } from "./skyglow";
import { Conditions, lowCloudBase, useConditions } from "./weather";
import { loadManifest, nztmToWorld, TileIndex } from "./terrain/manifest";
import { addLoadingSource, track } from "./loading";
import { SceneLoading } from "./SceneLoading";
import { Travelling } from "./time/Travelling";
import {
  HeightQuery,
  Terrain,
  TERRAIN_DESKTOP,
  TERRAIN_MOBILE,
} from "./terrain/Terrain";
import { SunPosition, sunDirection, sunPosition } from "./sun";
import * as environment from "./environment";
import { Ocean, OCEAN_DESKTOP, OCEAN_MOBILE } from "./ocean/Ocean";
import { useTide } from "./ocean/tide";
import { Quakes } from "./quakes/Quakes";
import { OceanConditions, significantHeight } from "./ocean/spectrum";
import { Clouds } from "./clouds/Clouds";
import { CLOUDS_DESKTOP, CLOUDS_MOBILE } from "./clouds/cloudNode";
import { Landmarks } from "./landmarks/Landmarks";
import {
  Buildings,
  BUILDINGS_DESKTOP,
  BUILDINGS_MOBILE,
} from "./buildings/Buildings";
import { windowsLitAt } from "./buildings/material";
import { Trees, TREES_DESKTOP, TREES_MOBILE } from "./trees/Trees";
import { Vessels } from "./vessels/Vessels";
import { Flights } from "./flights/Flights";
import { Railway } from "./trains/Railway";
import { CableCar } from "./cablecar/CableCar";
import { Buses } from "./buses/Buses";
import { Traffic } from "./traffic/Traffic";
import { AirfieldLights } from "./airport/AirfieldLights";
import { Sky } from "./sky/Sky";
import { sight } from "./sky/orbits";
import { Telescope } from "./scope/Telescope";
import {
  announce,
  drawVignette,
  getActive,
  LOWEST,
  pose,
  satelliteFor,
  scope,
  setVignette,
  subscribeActive,
} from "./scope/scope";
import { cloudsSeen } from "./clouds/density";
import { updateLens } from "./lens";
import { DEFAULT_FOV, flightFor, FollowRig, smootherstep } from "./follow/rig";
import { groundAlong } from "./ground";
import {
  followVehicle,
  Following,
  getSnapshot,
  setReach,
  stop as stopFollowing,
  vehiclesAt,
} from "./follow/store";
import { DEPTH_POINTS, sceneDepthsAt } from "./sceneDepth";
import { connectCamera, shotFromUrl } from "./shots/shots";
import { useRenderer } from "./renderer";
import { sceneShown, useInView } from "./visibility";
import { typing, Walk } from "./walk";
import {
  EDGE_SPEED,
  edgeCursor,
  edgePan,
  getMapView,
  MAP_DISTANCE,
  MAP_POLAR_ANGLE,
  MAP_ZOOM,
  subscribeMapView,
  setMapView,
  toggleMapView,
  useMapView,
} from "./mapView";
import { sceneNow, useSeek } from "./clock";
import { attachInspector, showStats, Stats, switchedOff } from "./stats";

// Over the harbour, looking west across Te Aro to Kelburn.
const START_POSITION: [number, number] = [1752500, 5429000];
const START_ALTITUDE = 900;
const START_TARGET: [number, number] = [1747500, 5428700];
const TARGET_ALTITUDE = 150;

/** Starting under a lower deck, this far beneath its base, m. */
const DECK_CLEARANCE = 100;

/** The usual start, or under the low cloud if its base is lower. */
function startAltitude(deck: number | null) {
  return deck === null
    ? START_ALTITUDE
    : Math.min(START_ALTITUDE, deck - DECK_CLEARANCE);
}

/** Sky samples reach this far for the city's glow, m. */
const SKYGLOW_DISTANCE = 20000;

/**
 * Haze over everything (fog on every material, and the sky), plus a fade
 * toward the edges of the terrain root so the map dissolves instead of ending.
 * At night the city lights it from below.
 */
function Atmosphere({
  rootSize,
  conditions,
}: {
  rootSize: number;
  conditions: Conditions;
}) {
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    hazeDensity.value = hazeDensityForVisibility(conditions.visibility);
  }, [conditions.visibility]);

  useEffect(() => {
    const half = rootSize / 2;
    const edge = max(abs(positionWorld.x), abs(positionWorld.z));
    const edgeFade = smoothstep(half * 0.6, half * 0.95, edge);
    const haze = float(1).sub(hazeTransmittance(cameraPosition, positionWorld));

    const fogColor = hazeColor(positionWorld.sub(cameraPosition)).add(
      hazeGlowAtNight(cameraPosition, positionWorld)
    );

    scene.fogNode = fog(
      fogColor,
      max(haze, edgeFade).mul(outsideClearing(positionWorld))
    );

    // Sky: zenith to horizon, hazier toward the horizon, glowing and with a
    // small disc toward the sun. Under a deck it goes flat grey: the clouds
    // hide it, but the water's reflection (which leaves them out) shows it.
    const direction = positionWorldDirection;
    const toward = dot(direction, environment.sunDirection);

    const gradient = mix(
      environment.skyHorizon,
      mix(environment.skyZenith, environment.skyHorizon, environment.overcast),
      smoothstep(0, 0.35, direction.y)
    );

    const horizon = float(1).sub(smoothstep(0, 0.25, max(direction.y, 0)));

    const disc = smoothstep(0.99996, 0.99999, toward).mul(
      environment.sunIntensity.mul(3)
    );

    const far = cameraPosition.add(direction.mul(SKYGLOW_DISTANCE));

    scene.backgroundNode = mix(gradient, hazeColor(direction), horizon.mul(0.8))
      .add(phase(toward, 0.7).mul(environment.sunIntensity).mul(0.15))
      .add(disc)
      .add(
        hazeGlowAtNight(cameraPosition, far).mul(
          float(1).sub(hazeTransmittance(cameraPosition, far))
        )
      );

    return () => {
      scene.fogNode = null;
      scene.backgroundNode = null;
    };
  }, [scene, rootSize]);

  return null;
}

/** Keep the camera at least this far above the ground. */
const GROUND_CLEARANCE = 3;

/** And this far above the tallest wave crests. */
const SEA_CLEARANCE = 1.5;

/** Near plane as a fraction of height above the ground or sea, clamped. */
const NEAR_FRACTION = 0.2;
const NEAR_MIN = 0.3;
const NEAR_MAX = 5;

/** Highest the camera may go: clear of the low deck on most overcast days. */
const CEILING = 4000;
const MIN_DISTANCE = 10;
const MAX_DISTANCE = 14000;
const MAX_POLAR_ANGLE = Math.PI * 0.5;

/**
 * After the layers have put their vehicles where they are this frame, so a
 * followed one sits still in the shot, and before the clouds render it.
 */
const CAMERA_PRIORITY = 0.5;

/** Before the controls update, so a step's in this frame's view. */
const WALK_PRIORITY = -2;

/** A press moving less than this, pixels, and let go within CLICK_TIME, ms, is a click. */
const CLICK_SLOP = 6;
const CLICK_TIME = 500;

/** Pixels from a vehicle that a tap picks it: fingers are blunter than a mouse. */
const TAP_REACH = 24;

/**
 * Something drawn nearer than a vehicle by more than half its length, and
 * this fraction of the way to it (the depth buffer's coarse far off), hides
 * it from clicks.
 */
const HIDDEN_BY = 0.02;

/**
 * Clicks pass over vehicles fainter than this through the haze: what's left
 * of them is only their trail.
 */
const FAINTEST = 0.15;

/** How often to look whether the followed vehicle is hidden, s. */
const PROBE = 0.25;

/** Of a followed vehicle's length, the radius cleared of fog around it. */
const CLEARING = 0.7;

/**
 * Handing back from somewhere out of the orbit's bounds (following an
 * aircraft off the map, or up at its cruise), the view's flown back in:
 * looking as it was, from no further than this off, m, and this far inside
 * the bounds, as a fraction of their size.
 */
const RETURN_DISTANCE = 3000;
const RETURN_INSET = 0.04;

/** Camera and target, from where they were to a set view, and how far in. */
interface ViewFlight {
  from: [Vector3, Vector3];
  to: [Vector3, Vector3];
  /** Seconds. */
  time: number;
  duration: number;
  /** Height of the arc flown, m. */
  arc: number;
  /**
   * Once it's there, or stopped on the way: putting the orbit's bounds and
   * limits back, say, flying in from outside them.
   */
  arrive?: () => void;
}

const flown: [Vector3, Vector3] = [new Vector3(), new Vector3()];

/** Where the pivot's going, looking around a vehicle, and by how much. */
const carried: [Vector3, Vector3] = [new Vector3(), new Vector3()];

/** What the map view's aimed at. */
const onGround = new Vector3();

/** Which way's ahead and to the right, walking. */
const walked: [Vector3, Vector3] = [new Vector3(), new Vector3()];

/**
 * Handing back from following, the orbit target's on the ground no nearer
 * than the first, m, or the second ahead if the view misses the ground within
 * the third.
 */
const HAND_BACK: [number, number, number] = [MIN_DISTANCE * 2, 2000, 8000];

/** Seconds for the pivot to settle most of the way onto a vehicle looked around. */
const PIVOT = 0.6;

/**
 * Looking around a vehicle in the air, lowest the camera may look up at it
 * from. One on the ground is looked at from no lower than itself.
 */
const LOOK_POLAR_ANGLE = Math.PI * 0.95;

const keyOf = ({ category, id }: Following) => `${category}:${id}`;

type Controller = React.ComponentRef<typeof CameraControls>;

const { ACTION } = CameraControlsImpl;

/**
 * Looking around a vehicle every drag turns about it: panning off it would
 * only be pulled back onto it.
 */
/** Where the scope has the camera. */
const posed = pose();

/** The controls' limits and gestures, to put back as they were. */
function limitsOf(c: Controller) {
  return {
    minDistance: c.minDistance,
    maxDistance: c.maxDistance,
    maxPolarAngle: c.maxPolarAngle,
    boundaryEnclosesCamera: c.boundaryEnclosesCamera,
    mouseButtons: { ...c.mouseButtons },
    touches: { ...c.touches },
  };
}

function turnAbout(c: Controller, around: boolean) {
  c.mouseButtons.right = around ? ACTION.ROTATE : ACTION.TRUCK;
  c.touches.two = around ? ACTION.TOUCH_DOLLY_ROTATE : ACTION.TOUCH_DOLLY_TRUCK;
  c.touches.three = around ? ACTION.TOUCH_ROTATE : ACTION.TOUCH_TRUCK;
}

/**
 * In map view every drag slides the map across the ground, up the view going
 * north, and nothing turns it; the bounds hold what it's aimed at, not the
 * camera, which is far above their ceiling.
 */
function panOnly(c: Controller, map: boolean) {
  c.mouseButtons.left = map ? ACTION.TRUCK : ACTION.ROTATE;
  c.touches.one = map ? ACTION.TOUCH_TRUCK : ACTION.TOUCH_ROTATE;
  c.verticalDragToForward = map;
  c.boundaryEnclosesCamera = !map;
  // Zooming in on what's under the mouse, to look at it closely.
  c.dollyToCursor = map;
}

/** Where the camera is for the map view of the ground at `aim`, and that. */
function mapView(aim: Vector3): [Vector3, Vector3] {
  const target = aim.clone();

  return [
    new Vector3(
      target.x,
      target.y + MAP_DISTANCE * Math.cos(MAP_POLAR_ANGLE),
      target.z + MAP_DISTANCE * Math.sin(MAP_POLAR_ANGLE)
    ),
    target,
  ];
}

/**
 * Coming down from the map view: this far from the ground it was aimed at,
 * m, looking north, this far from straight down.
 */
const LEAVE_MAP_DISTANCE = 3000;
const LEAVE_MAP_POLAR_ANGLE = (66 * Math.PI) / 180;

/** In map view the keys walk this fraction as fast: it's far above the ground. */
const MAP_WALK = 0.15;

/** Seconds to get most of the way up to the edge's panning speed, or to stop. */
const EDGE_EASE = 0.12;

/**
 * Keeps the orbit target well inside the terrain so the edge fade stays
 * distant, and the camera above ground. Following a vehicle, the follow rig
 * has the camera instead, without those limits, until it's stopped. Touching
 * the map then turns and zooms about the vehicle, carried along with it.
 */
function Controls({
  index,
  heightAt,
  sea,
  deck,
}: {
  index: TileIndex;
  heightAt: React.RefObject<HeightQuery | null>;
  sea: OceanConditions;
  /** Base of the low cloud, m, or null under a clear sky. */
  deck: number | null;
}) {
  const { manifest } = index;
  const half = manifest.rootSize / 2;

  const [position, target] = useMemo(() => {
    // ?cam=E,N,alt,targetE,targetN,targetAlt (NZTM metres) for sharing views,
    // or ?shot=<id> for one of the set ones.
    const cam = new URLSearchParams(location.search)
      .get("cam")
      ?.split(",")
      .map(Number);

    const [pe, pn, pAlt, te, tn, tAlt] =
      cam?.length === 6 && cam.every(Number.isFinite)
        ? cam
        : (shotFromUrl()?.view ?? [
            ...START_POSITION,
            startAltitude(deck),
            ...START_TARGET,
            TARGET_ALTITUDE,
          ]);

    const [px, pz] = nztmToWorld(manifest, pe, pn);
    const [tx, tz] = nztmToWorld(manifest, te, tn);

    return [new Vector3(px, pAlt, pz), new Vector3(tx, tAlt, tz)];
  }, [manifest, deck]);

  const boundary = useMemo(
    () =>
      new Box3(
        // North (negative z) is held furthest from the edge: that's where
        // the land runs off the map.
        new Vector3(-half * 0.6, 0, -half * 0.45),
        new Vector3(half * 0.6, CEILING, half * 0.6)
      ),
    [half]
  );

  // Vehicles out of bounds can't be picked: the camera couldn't stay there.
  useEffect(() => {
    setReach(
      (x, z) =>
        x >= boundary.min.x &&
        x <= boundary.max.x &&
        z >= boundary.min.z &&
        z <= boundary.max.z
    );

    return () => setReach(() => true);
  }, [boundary]);

  /** A little inside the bounds, to fly back into. */
  const inside = useMemo(() => {
    const size = boundary.getSize(new Vector3()).multiplyScalar(RETURN_INSET);

    return new Box3(
      boundary.min.clone().add(size),
      boundary.max.clone().sub(size)
    );
  }, [boundary]);

  const controls = useRef<Controller>(null);
  const orbit = useMemo(() => new Vector3(), []);
  const renderer = useRenderer();

  const connected = useThree((state) => state.events.connected);
  const events = connected instanceof HTMLElement ? connected : undefined;

  // Crests rarely top the significant height, so that's enough headroom.
  const seaFloor = useRef(0);
  seaFloor.current = SEA_CLEARANCE + significantHeight(sea);

  const rig = useMemo(
    () =>
      new FollowRig(
        (e, n) => nztmToWorld(manifest, e, n),
        (x, z) =>
          Math.max(
            (heightAt.current?.(x, z) ?? 0) + GROUND_CLEARANCE,
            seaFloor.current
          )
      ),
    [manifest, heightAt]
  );

  /** Whether the rig has the camera. */
  const followingRef = useRef(false);

  /**
   * Looking around the followed vehicle by hand: which it is, and how far
   * off it the pivot still is, from where the rig was aiming.
   */
  const lookingAround = useRef<{ key: string; offset: Vector3 } | null>(null);

  /** Whether the view's been set, and since moved by hand. */
  const placed = useRef(false);
  const touched = useRef(false);

  /** Flying to a set view, picked from the shot panel. */
  const flight = useRef<ViewFlight | null>(null);

  /** Walking about from the keyboard. */
  const walk = useMemo(() => new Walk(), []);

  // Back to orbiting, from where the follow rig left the camera.
  const handBack = useCallback(() => {
    const c = controls.current;

    if (!c || !followingRef.current) return;
    followingRef.current = false;
    lookingAround.current = null;
    const { camera } = c;
    c.minDistance = MIN_DISTANCE;
    c.maxDistance = MAX_DISTANCE;
    c.maxPolarAngle = MAX_POLAR_ANGLE;
    c.boundaryEnclosesCamera = true;
    c.enabled = true;
    turnAbout(c, false);

    // Orbiting the ground it was looking at, the way it does anywhere else:
    // the controls pan and zoom by how far off the target is, so one left at
    // the vehicle (often in the air, or under the road beyond it) drags the
    // land at a crawl and stops the zoom short. Looking at the sky, a point
    // well ahead, no higher than the camera.
    camera.getWorldDirection(orbit);

    const hit = heightAt.current
      ? groundAlong(camera.position, orbit, heightAt.current, HAND_BACK[2])
      : null;

    const distance =
      hit === null
        ? HAND_BACK[1]
        : Math.min(Math.max(hit, HAND_BACK[0]), HAND_BACK[2]);

    orbit.multiplyScalar(distance).add(camera.position);
    orbit.y = Math.min(orbit.y, camera.position.y);
    const from = camera.position.clone();
    const { x, y, z } = from;

    if (boundary.containsPoint(from) && boundary.containsPoint(orbit)) {
      c.setBoundary(boundary);
      c.setLookAt(x, y, z, orbit.x, orbit.y, orbit.z, false);

      return;
    }

    // Out of bounds, the controls would snap the camera back in on the
    // next drag. Flown in instead, looking the same way, the bounds put on
    // once it's there.
    const target = inside.clampPoint(orbit, new Vector3());
    const back = from.clone().sub(orbit);
    back.setLength(Math.min(back.length(), RETURN_DISTANCE));
    const to = inside.clampPoint(back.add(target), new Vector3());
    const ground = heightAt.current?.(to.x, to.z) ?? 0;
    to.y = Math.max(to.y, ground + GROUND_CLEARANCE, target.y + MIN_DISTANCE);
    c.setBoundary();
    c.setLookAt(x, y, z, orbit.x, orbit.y, orbit.z, false);

    if (getSnapshot().cut) {
      c.setLookAt(to.x, to.y, to.z, target.x, target.y, target.z, false);
      c.setBoundary(boundary);

      return;
    }

    flight.current = {
      from: [from, orbit.clone()],
      to: [to, target],
      time: 0,
      ...flightFor(from.distanceTo(to)),
      arrive: () => c.setBoundary(boundary),
    };
  }, [boundary, inside, orbit, heightAt]);

  // Stops any flight to a view where it is, the orbit's bounds back on if
  // it was flying back into them.
  const land = useCallback(() => {
    const f = flight.current;
    flight.current = null;
    f?.arrive?.();
  }, []);

  // Turning about the followed vehicle by hand, from where the rig had the
  // camera, the pivot sliding over onto the vehicle from what it aimed at.
  const lookAround = useCallback(() => {
    const c = controls.current;
    const { following } = getSnapshot();

    // Not while flying in: a press then (often the one shutting a panel)
    // would leave the camera wherever on the way it had got to.
    if (
      !c ||
      !following ||
      !followingRef.current ||
      rig.arriving ||
      lookingAround.current
    ) {
      return false;
    }

    const { position: p, target: t } = rig.shot;
    lookingAround.current = {
      key: keyOf(following),
      offset: t.clone().sub(rig.at),
    };
    c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
    // No nearer than a length off its middle.
    c.minDistance = Math.max(rig.length, MIN_DISTANCE);
    c.maxDistance = MAX_DISTANCE;
    c.enabled = true;
    turnAbout(c, true);

    return true;
  }, [rig]);

  // A press that turned out to be a click, not a drag: the rig has the
  // camera back, from where it is, which is where the rig left it.
  const putBack = useCallback(() => {
    const c = controls.current;

    if (!c || !lookingAround.current) return;
    lookingAround.current = null;
    c.minDistance = 0;
    c.maxDistance = Infinity;
    c.maxPolarAngle = Math.PI;
    c.enabled = false;
    turnAbout(c, false);
  }, []);

  // Up to the map view, or back down from it, as it's switched: flown there
  // (or cut), free of the orbit's limits on the way and under the view's
  // own once it's there. The ground aimed at stays in the middle.
  const switchView = useCallback(
    (map: boolean, fly = true) => {
      const c = controls.current;

      if (!c) return;
      touched.current = true;

      if (map) {
        stopFollowing();
        handBack();
      }

      land();
      panOnly(c, map);

      // Clicking a vehicle on the map: the rig has the camera now.
      if (!map && getSnapshot().following) return;

      const aim = c.getTarget(new Vector3());
      const target = inside.clampPoint(aim, new Vector3());
      target.y = Math.max(heightAt.current?.(target.x, target.z) ?? 0, 0);

      const to: [Vector3, Vector3] = map
        ? mapView(target)
        : [
            new Vector3(
              0,
              Math.cos(LEAVE_MAP_POLAR_ANGLE),
              Math.sin(LEAVE_MAP_POLAR_ANGLE)
            )
              .multiplyScalar(LEAVE_MAP_DISTANCE)
              .add(target),
            target,
          ];

      const settle = () => {
        c.minDistance = map ? MAP_ZOOM[0] : MIN_DISTANCE;
        c.maxDistance = map ? MAP_ZOOM[1] : MAX_DISTANCE;
        c.setBoundary(boundary);
      };

      c.setBoundary();
      c.minDistance = 0;
      c.maxDistance = Infinity;
      const [p, t] = to;

      if (!fly || getSnapshot().cut) {
        c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
        settle();

        return;
      }

      const from = c.camera.position.clone();
      flight.current = {
        from: [from, aim],
        to,
        time: 0,
        ...flightFor(from.distanceTo(p)),
        arrive: settle,
      };
    },
    [boundary, inside, heightAt, handBack, land]
  );

  useEffect(
    () => subscribeMapView(() => switchView(getMapView())),
    [switchView]
  );

  /** The mouse at the edge of the view in map view: which way it's panning. */
  const edge = useRef({ right: 0, up: 0 });
  const edgeMoving = useRef({ right: 0, up: 0 });

  // Touching the map while following looks around the vehicle, and carries
  // on as that drag or zoom: this runs before the controls see the event.
  useEffect(() => {
    const element = events ?? renderer.domElement;

    const take = () => {
      touched.current = true;
      land();

      return lookAround();
    };

    const keys = (e: KeyboardEvent) => {
      // Not when it shut a panel or a menu (Base UI prevents the default).
      if (e.key === "Escape" && !e.defaultPrevented) stopFollowing();

      // Walking, unless typing, or the page is scrolled off the scene.
      // Nor arrows a menu, a list or a toggle group has used.
      if (
        e.defaultPrevented ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        typing(e.target) ||
        !sceneShown()
      ) {
        return;
      }

      // M in and out of the map view.
      if (e.code === "KeyM") {
        if (!e.repeat) toggleMapView();

        return;
      }

      if (!walk.press(e.code)) return;

      e.preventDefault();
      touched.current = true;
      land();
      stopFollowing();
    };

    const keyUp = (e: KeyboardEvent) => walk.release(e.code);

    const still = () => {
      edge.current = { right: 0, up: 0 };
    };

    const blur = () => {
      walk.clear();
      still();
    };

    // Clicking a vehicle (not dragging, and with one finger) follows it.
    // Presses end on the window: they may be let go off the map.
    const pointers = new Set<number>();
    let disposed = false;

    let press: {
      x: number;
      y: number;
      time: number;
      /** Whether it took the camera from the rig to look around. */
      took: boolean;
    } | null = null;

    // The nearest vehicle to the pointer that isn't behind anything.
    const vehicleUnder = async (e: PointerEvent) => {
      const camera = controls.current?.camera;

      // Nothing on the map to pick while it's looking through the telescope.
      if (!(camera instanceof PerspectiveCamera) || scope.active) return null;
      const rect = element.getBoundingClientRect();

      const sightings = vehiclesAt(
        camera,
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((e.clientY - rect.top) / rect.height) * 2,
        rect.height,
        e.pointerType === "touch" ? TAP_REACH : undefined,
        (at) => hazeTransmittanceBetween(camera.position, at) > FAINTEST
      ).slice(0, DEPTH_POINTS);

      if (!sightings.length) return null;
      const scene = await sceneDepthsAt(renderer, camera, sightings);

      const seen = sightings.find(
        ({ depth, length }, i) =>
          !scene || scene[i] >= depth - length / 2 - depth * HIDDEN_BY
      );

      return seen?.vehicle ?? null;
    };

    const down = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      still();
      const took = take();
      press =
        pointers.size === 1 && e.button === 0
          ? { x: e.clientX, y: e.clientY, time: e.timeStamp, took }
          : null;
    };

    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      const p = press;
      press = null;

      if (
        !p ||
        Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP ||
        e.timeStamp - p.time > CLICK_TIME
      ) {
        return;
      }

      // Only a click: the rig carries on as it was.
      if (p.took) putBack();

      vehicleUnder(e).then((vehicle) => {
        if (vehicle && !disposed) followVehicle(vehicle);
      }, console.error);
    };

    const cancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      press = null;
    };

    // A hand over anything that can be clicked. One look at a time: the
    // latest move waits for it.
    let looking = false;
    let waiting: PointerEvent | null = null;

    const hover = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || pointers.size || disposed) return;

      // At the edge in map view, the mouse pans: the cursor points the way.
      if (getMapView() && sceneShown()) {
        const rect = element.getBoundingClientRect();

        edge.current = edgePan(
          e.clientX - rect.left,
          e.clientY - rect.top,
          rect.width,
          rect.height
        );

        const cursor = edgeCursor(edge.current);

        if (cursor) {
          element.style.cursor = cursor;

          return;
        }
      } else {
        still();
      }

      if (looking) {
        waiting = e;

        return;
      }

      looking = true;
      vehicleUnder(e)
        .then((vehicle) => {
          if (pointers.size || disposed || edgeCursor(edge.current)) return;
          element.style.cursor = vehicle ? "pointer" : "";
        }, console.error)
        .finally(() => {
          looking = false;
          const next = waiting;
          waiting = null;

          if (next) hover(next);
        });
    };

    element.addEventListener("pointerdown", down, { capture: true });
    window.addEventListener("pointerup", up, { capture: true });
    window.addEventListener("pointercancel", cancel, { capture: true });
    element.addEventListener("pointermove", hover);
    element.addEventListener("pointerleave", still);
    element.addEventListener("wheel", take, { capture: true });
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);

    return () => {
      element.removeEventListener("pointerdown", down, { capture: true });
      window.removeEventListener("pointerup", up, { capture: true });
      window.removeEventListener("pointercancel", cancel, { capture: true });
      element.removeEventListener("pointermove", hover);
      element.removeEventListener("pointerleave", still);
      element.removeEventListener("wheel", take, { capture: true });
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
      walk.clear();
      still();
      disposed = true;
      element.style.cursor = "";
    };
  }, [events, renderer, lookAround, putBack, walk, land]);

  // Set views, picked from the shot panel, and the view now, for copying.
  useEffect(
    () =>
      connectCamera(
        () => {
          const c = controls.current;

          if (!c) return null;
          const [oe, on] = manifest.origin;
          const { x, y, z } = c.camera.position;
          const t = c.getTarget(new Vector3());

          return [x + oe, on - z, y, t.x + oe, on - t.z, t.y];
        },
        ([pe, pn, pAlt, te, tn, tAlt]) => {
          const c = controls.current;

          if (!c) return;
          touched.current = true;
          stopFollowing();
          setMapView(false);
          handBack();
          land();
          const [px, pz] = nztmToWorld(manifest, pe, pn);
          const [tx, tz] = nztmToWorld(manifest, te, tn);

          if (getSnapshot().cut) {
            flight.current = null;
            c.setLookAt(px, pAlt, pz, tx, tAlt, tz, false);

            return;
          }

          // Flown here frame by frame, not by the controls' own transition:
          // lifting the camera off a hill on the way would end that early.
          const from = c.camera.position.clone();
          const to = new Vector3(px, pAlt, pz);
          flight.current = {
            from: [from, c.getTarget(new Vector3())],
            to: [to, new Vector3(tx, tAlt, tz)],
            time: 0,
            ...flightFor(from.distanceTo(to)),
          };
        }
      ),
    [manifest, handBack, land]
  );

  // Where the view starts, and again (gliding there) if the forecast arrives
  // with a lower deck, until the map's been touched or a vehicle followed.
  useEffect(() => {
    const c = controls.current;

    if (!c) return;

    c.setBoundary(boundary);

    if (touched.current || followingRef.current) return;

    // ?map starts in the map view, over the same ground.
    const map = getMapView();
    panOnly(c, map);
    c.minDistance = map ? MAP_ZOOM[0] : MIN_DISTANCE;
    c.maxDistance = map ? MAP_ZOOM[1] : MAX_DISTANCE;
    const [p, t] = map ? mapView(target) : [position, target];
    c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, placed.current);
    placed.current = true;
  }, [boundary, position, target]);

  // Jumping in time, what's followed is gone (or somewhere else), and the
  // rig would hold the camera on nothing until it gave up. Let it go, and
  // the view stays where it is whatever the weather then.
  const { epoch } = useSeek();
  const firstEpoch = useRef(epoch);

  useEffect(() => {
    if (epoch === firstEpoch.current) return;
    touched.current = true;
    stopFollowing();
  }, [epoch]);

  // Walked across the ground the way it faces, before the controls place the
  // camera this frame. Once the rig's let go, if it had the camera. In map
  // view, slower, and panned by the mouse at the edge too.
  useFrame((_, delta) => {
    const c = controls.current;

    if (!c) return;
    const { camera } = c;
    const ground = heightAt.current?.(camera.position.x, camera.position.z);
    const height = camera.position.y - Math.max(ground ?? 0, seaFloor.current);
    const map = getMapView();

    // In map view what it's aimed at rides over the ground: zoomed in close,
    // the camera keeps clear of the hills, and zooming to the mouse (which
    // slides the aim across the view, up or down too) leaves it on the land.
    // Eased there by the controls.
    if (map && !flight.current && !followingRef.current) {
      const t = c.getTarget(onGround);
      const under = Math.max(heightAt.current?.(t.x, t.z) ?? 0, 0);

      if (Math.abs(under - t.y) > 0.5) c.moveTo(t.x, under, t.z, true);
    }

    const walking = walk.step(delta, map ? height * MAP_WALK : height);

    // Not while flying up to it: the mouse may be resting at the edge.
    const want = map && !flight.current ? edge.current : { right: 0, up: 0 };
    const pan = edgeMoving.current;
    const ease = 1 - Math.exp(-delta / EDGE_EASE);
    pan.right += (want.right - pan.right) * ease;
    pan.up += (want.up - pan.up) * ease;

    if (!want.right && Math.abs(pan.right) < 0.01) pan.right = 0;

    if (!want.up && Math.abs(pan.up) < 0.01) pan.up = 0;

    const panning = pan.right || pan.up;
    const reach = EDGE_SPEED * c.distance * delta;

    const step =
      walking || panning
        ? {
            forward: (walking?.forward ?? 0) + pan.up * reach,
            right: (walking?.right ?? 0) + pan.right * reach,
            // It faces north, always.
            turn: map ? 0 : (walking?.turn ?? 0),
          }
        : null;

    if (!step || followingRef.current) return;

    if (panning) {
      touched.current = true;
      land();
    }

    const ahead = walked[0].set(0, 0, -1).applyQuaternion(camera.quaternion);
    ahead.y = 0;

    // Looking straight down, ahead is the top of the view.
    if (ahead.lengthSq() < 1e-6) {
      ahead.set(0, 1, 0).applyQuaternion(camera.quaternion).setY(0);
    }

    ahead.normalize();
    const right = walked[1].set(-ahead.z, 0, ahead.x);

    const to = c
      .getTarget(orbit)
      .addScaledVector(ahead, step.forward)
      .addScaledVector(right, step.right);

    // Over the ground at the height it's eased to so far, in map view, so it
    // keeps easing rather than jumping with every bump.
    if (map) to.y = c.getTarget(onGround, false).y;

    c.moveTo(to.x, to.y, to.z, false);

    if (step.turn) c.rotate(step.turn, 0, false);
  }, WALK_PRIORITY);

  /**
   * As the scope found the controls: whether the follow rig had the camera,
   * and if not, the limits it was under (the map view's, say).
   */
  const scopeFrom = useRef<{
    rig: boolean;
    limits: ReturnType<typeof limitsOf>;
  } | null>(null);

  // Following a satellite, through a telescope: the camera comes down off
  // its view to the ground, turns up to the satellite and zooms in on it,
  // and back out and up onto the view when it's let go. Whether the scope
  // had the camera this frame.
  const scopeTo = useCallback(
    (c: Controller, camera: PerspectiveCamera, delta: number) => {
      const { following } = getSnapshot();
      const now = sceneNow();

      const satellite =
        following?.category === "satellite" ? satelliteFor(following.id) : null;

      // Down behind the hills, or its orbit's gone: back to the view.
      const up =
        satellite !== null && (sight(satellite, now)?.elevation ?? -1) > LOWEST;

      if (following?.category === "satellite" && !up) stopFollowing();

      if (!up && !scope.active) return false;

      if (!scope.active) {
        scopeFrom.current = { rig: followingRef.current, limits: limitsOf(c) };
        followingRef.current = true;
        touched.current = true;
        lookingAround.current = null;
        land();
        c.setBoundary();
        c.boundaryEnclosesCamera = false;
        c.minDistance = 0;
        c.maxDistance = Infinity;
        c.maxPolarAngle = Math.PI;
        c.enabled = false;
        const { x, z } = camera.position;
        const ground = heightAt.current?.(x, z) ?? 0;

        scope.begin(
          camera.position,
          c.getTarget(orbit),
          camera.fov,
          Math.max(ground + GROUND_CLEARANCE, seaFloor.current)
        );
      }

      rig.release();
      scope.step(delta, up ? satellite : null, now);
      announce();
      drawVignette();
      cloudsSeen.value = scope.clouds;
      clearRadius.value = 0;
      clearAround.value.set(0, -1e7, 0);

      const {
        position: p,
        quaternion,
        fov,
        aim,
      } = scope.active
        ? scope.pose(now, delta, posed)
        : { ...posed, position: scope.position, aim: scope.target };

      camera.position.copy(p);

      if (scope.active) {
        camera.quaternion.copy(quaternion);
        // Low down, near in, as the controls have it.
        const height = p.y - scope.floor + GROUND_CLEARANCE;
        camera.near = Math.min(
          Math.max(height * NEAR_FRACTION, NEAR_MIN),
          NEAR_MAX
        );
        camera.fov = fov;
      } else {
        camera.lookAt(aim);
        camera.fov = scope.fov;
      }

      camera.updateProjectionMatrix();
      c.setLookAt(p.x, p.y, p.z, aim.x, aim.y, aim.z, false);
      updateLens(renderer, camera, aim, delta);

      const from = scopeFrom.current;

      if (scope.active || !from) return true;
      scopeFrom.current = null;

      // Back on the view it left. On to a vehicle, the rig flies there from
      // here; the rig's before, handed back as from it.
      if (getSnapshot().following) return true;

      if (from.rig) {
        handBack();

        return true;
      }

      // Free before: as it was.
      followingRef.current = false;
      const { mouseButtons, touches, ...limits } = from.limits;
      Object.assign(c, limits);
      Object.assign(c.mouseButtons, mouseButtons);
      Object.assign(c.touches, touches);
      c.enabled = true;
      c.setBoundary(boundary);
      c.setLookAt(p.x, p.y, p.z, aim.x, aim.y, aim.z, false);

      return true;
    },
    [rig, orbit, handBack, land, boundary, heightAt, renderer]
  );

  // Every PROBE seconds, whether what's followed is hidden behind something,
  // from the depth the scene was drawn with: its middle and ends, two of
  // three behind something nearer and it is. The rig lifts over it.
  const probing = useRef({ wait: 0, busy: false });

  const probe = useCallback(
    (camera: PerspectiveCamera, delta: number, byHand: boolean) => {
      const p = probing.current;
      p.wait -= delta;

      if (p.busy || p.wait > 0 || byHand || !rig.ground) return;
      p.wait = PROBE;
      const reach = rig.length * 0.4;
      const ahead = [Math.sin(rig.facing), -Math.cos(rig.facing)];

      const points = [-1, 0, 1].flatMap((end) => {
        const at = new Vector3(
          rig.at.x + ahead[0] * reach * end,
          rig.at.y,
          rig.at.z + ahead[1] * reach * end
        );

        const depth = -at.clone().applyMatrix4(camera.matrixWorldInverse).z;
        at.project(camera);

        return depth > 0 && Math.abs(at.x) < 1 && Math.abs(at.y) < 1
          ? [{ x: at.x, y: at.y, depth }]
          : [];
      });

      if (!points.length) return;
      p.busy = true;
      sceneDepthsAt(renderer, camera, points)
        .then((scene) => {
          if (!scene) return;

          const hidden = points.filter(
            ({ depth }, i) =>
              scene[i] < depth - rig.length / 2 - depth * HIDDEN_BY
          ).length;

          rig.hidden(hidden * 3 >= points.length * 2, PROBE);
        }, console.error)
        .finally(() => {
          p.busy = false;
        });
    },
    [rig, renderer]
  );

  useFrame((_, delta) => {
    const c = controls.current;

    if (!c || !heightAt.current) return;

    const { camera } = c;

    // The Canvas's camera, which is a perspective one.
    if (!(camera instanceof PerspectiveCamera)) return;

    if (scopeTo(c, camera, delta)) return;

    const shot = rig.update(camera, delta);
    const { following } = getSnapshot();

    // On to another vehicle: the rig has the camera again.
    if (
      lookingAround.current &&
      following &&
      lookingAround.current.key !== keyOf(following)
    ) {
      lookingAround.current = null;
      followingRef.current = false;
    }

    const around = shot && lookingAround.current;

    if (around) {
      // Carried along with it, turned about it by hand.
      c.maxPolarAngle = rig.ground ? MAX_POLAR_ANGLE : LOOK_POLAR_ANGLE;
      around.offset.multiplyScalar(Math.exp(-delta / PIVOT));
      const pivot = carried[0].copy(rig.at).add(around.offset);
      const move = carried[1].subVectors(pivot, c.getTarget(orbit, false));
      c.moveTo(pivot.x, pivot.y, pivot.z, false);
      // The controls have already placed it this frame.
      camera.position.add(move);
    } else if (shot) {
      if (!followingRef.current) {
        // Picked from the map view: down out of it, after the vehicle.
        setMapView(false);
        // Out of the orbit's limits: landings are watched from the ground,
        // looking up, and aircraft fly off the edge of the map.
        followingRef.current = true;
        // Not to be put back at the start by a later forecast.
        touched.current = true;
        c.setBoundary();
        c.boundaryEnclosesCamera = false;
        c.minDistance = 0;
        c.maxDistance = Infinity;
        c.maxPolarAngle = Math.PI;
        c.enabled = false;
        turnAbout(c, false);
      }

      // Straight onto the camera for this frame, and into the controls so
      // they hold it there through the next.
      const { position: p, target: t } = shot;
      camera.position.copy(p);
      camera.lookAt(t);
      c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
    } else {
      handBack();
    }

    // The followed vehicle out of the fog, and over anything hiding it.
    if (shot && rig.tracking) {
      clearAround.value.copy(rig.at);
      clearRadius.value = rig.length * CLEARING;
      probe(camera, delta, Boolean(around));
    } else {
      clearRadius.value = 0;
      clearAround.value.set(0, -1e7, 0);
    }

    const f = flight.current;

    if (shot) {
      flight.current = null;
    } else if (f) {
      // Over the top, turning to the view in the first half of the way.
      f.time += delta;
      const u = Math.min(f.time / f.duration, 1);
      const s = smootherstep(u);
      const p = flown[0].lerpVectors(f.from[0], f.to[0], s);
      p.y += f.arc * Math.sin(Math.PI * s);

      const t = flown[1].lerpVectors(
        f.from[1],
        f.to[1],
        smootherstep(Math.min(u * 2, 1))
      );

      camera.position.copy(p);
      camera.lookAt(t);
      c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);

      if (u === 1) land();
    }

    // The lens goes back to the scene's when the rig lets go.
    const fov = shot?.fov ?? DEFAULT_FOV;

    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = shot
        ? fov
        : camera.fov + (fov - camera.fov) * Math.min(delta * 3, 1);
      camera.updateProjectionMatrix();
    }

    // What the camera's aimed at: the rig's, unless the controls have it.
    const aim = shot && !around ? shot.target : c.getTarget(orbit);
    const ground = heightAt.current(camera.position.x, camera.position.z);

    if (ground === undefined) return;
    const floor = Math.max(ground + GROUND_CLEARANCE, seaFloor.current);
    const allowed = Math.max(floor, camera.position.y);

    if (camera.position.y !== allowed) {
      const { x, z } = camera.position;

      // The controls only move the camera when they update, and they've
      // already done that this frame: without lifting it here too, every
      // frame of a drag into a hillside renders from under the ground.
      if (!shot || around) c.setPosition(x, allowed, z, false);
      camera.position.y = allowed;
      camera.lookAt(aim);
    }

    // Pull the near plane in when low so nearby waves and ground aren't cut
    // off, and push it out when high to keep depth precision for the distance.
    const near = Math.min(
      Math.max((allowed - ground) * NEAR_FRACTION, NEAR_MIN),
      NEAR_MAX
    );

    if (Math.abs(camera.near - near) > camera.near * 0.1) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }

    updateLens(renderer, camera, aim, delta);
  }, CAMERA_PRIORITY);

  return (
    <CameraControls
      ref={controls}
      makeDefault
      minDistance={MIN_DISTANCE}
      maxDistance={MAX_DISTANCE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      boundaryEnclosesCamera
    />
  );
}

const SUN_DISTANCE = 20000;

/** Width of the shadow-mapped square, centred on SHADOW_CENTRE. */
const SHADOW_EXTENT = 32000;

/** Middle of the high-detail core (NZTM). */
const SHADOW_CENTRE: [number, number] = [1745500, 5429000];

/** Lights are filtered by camera layers too; the reflection needs them. */
const litForReflections = (light: Light | null) =>
  light?.layers.enable(environment.REFLECTION_LAYER);

// Stand-in until the night sky exists: low light from the north-east.
const MOON: [number, number, number] = [0.5, 0.4, -0.75];

/**
 * Night falls through civil twilight, from the sun going behind the hills:
 * sun altitude, degrees. The lights come on one by one through it, and the
 * city's glow in the haze and clouds grows with them.
 */
const DUSK = [4, -6];

/**
 * 0 by day to 1 at night: how far through lighting-up. Each window and lamp
 * has its own moment in it to switch on.
 */
function nightFor(altitude: number) {
  const [start, end] = DUSK;
  const t = Math.min(Math.max((altitude - start) / (end - start), 0), 1);

  return t * t * (3 - 2 * t);
}

/**
 * How often the scene's clock moves on, ms. The sun creeps under a tenth of
 * a degree between ticks, and each re-renders its shadow map.
 */
const CLOCK_TICK = 20000;

/**
 * The scene's moment, as a Date for the sun and the lights: its clock
 * (./clock.ts), read every CLOCK_TICK and whenever it's set.
 */
function useSceneTime() {
  const seek = useSeek();
  const [time, setTime] = useState(() => new Date(sceneNow()));

  useEffect(() => {
    // Held still (?freeze), the same time isn't a new one.
    const tick = () =>
      setTime((last) => {
        const now = sceneNow();

        return last.getTime() === now ? last : new Date(now);
      });

    tick();
    // From the clock, not a count of ticks: background tabs skip them.
    const id = setInterval(tick, CLOCK_TICK);

    return () => clearInterval(id);
  }, [seek]);

  return time;
}

/** Sun at its real position over Wellington. */
function Sun({
  index,
  mobile,
  cloudCover,
  position,
}: {
  index: TileIndex;
  mobile: boolean;
  cloudCover: number;
  position: SunPosition;
}) {
  const light = useRef<DirectionalLight>(environment.sunLight);

  const centre = useMemo(() => {
    const [x, z] = nztmToWorld(index.manifest, ...SHADOW_CENTRE);

    return new Vector3(x, 0, z);
  }, [index]);

  const { direction, intensity } = useMemo(() => {
    if (position.altitude < 0) {
      return { direction: MOON, intensity: 0.4 };
    }

    // Fade in through the first few degrees above the horizon.
    const fade = Math.min(1, position.altitude / 6);

    return { direction: sunDirection(position), intensity: 3 * fade };
  }, [position]);

  // Under a full deck the sun barely gets through; light goes flat.
  const lit = intensity * (1 - 0.85 * environment.overcastFor(cloudCover));

  useEffect(() => {
    environment.sunDirection.value.set(...direction);
    environment.sunIntensity.value = lit / 3;
  }, [direction, lit]);

  // The sun moves as the scene's clock runs; its shadows follow.
  useEffect(() => {
    light.current.shadow.needsUpdate = true;
  }, [direction]);

  // One shadow map over the core, independent of the camera. The terrain and
  // sun barely change, so it re-renders only when casters (a cheap stand-in
  // on SHADOW_LAYER) finish loading, not every frame.
  useEffect(() => {
    const sun = light.current;
    const half = SHADOW_EXTENT / 2;
    sun.target.position.copy(centre);
    sun.target.updateMatrixWorld();
    sun.layers.enable(environment.REFLECTION_LAYER);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(mobile ? 2048 : 4096);
    Object.assign(sun.shadow.camera, {
      left: -half,
      right: half,
      top: half,
      bottom: -half,
      near: 1,
      far: SUN_DISTANCE * 3,
    });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.camera.layers.set(environment.SHADOW_LAYER);
    // The casters are coarser than the surface they shade.
    sun.shadow.normalBias = 8;
    sun.shadow.bias = -0.0002;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
  }, [mobile, centre]);

  const casterVersion = useRef(-1);
  useFrame(() => {
    if (environment.shadowCasters.version !== casterVersion.current) {
      casterVersion.current = environment.shadowCasters.version;
      light.current.shadow.needsUpdate = true;
    }
  });

  const [sunX, sunY, sunZ] = direction.map(
    (v, i) => centre.getComponent(i) + v * SUN_DISTANCE
  );

  return (
    <primitive
      object={environment.sunLight}
      name="sun"
      position={[sunX, sunY, sunZ]}
      intensity={lit}
    />
  );
}

/**
 * Sea state from the wind. Fetch, the open water the wind has blown across,
 * depends on where it comes from: southerlies arrive off the Southern Ocean,
 * northerlies through Cook Strait.
 */
function seaConditions({ wind }: Conditions): OceanConditions {
  const southerly = wind.direction > 120 && wind.direction < 240;

  return {
    windSpeed: wind.speed,
    windDirection: wind.direction,
    fetch: southerly ? 500000 : 80000,
    swell: southerly ? 0.6 : 0.3,
  };
}

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    setMobile(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  return mobile;
}

/**
 * The layers, in the order they're put in the scene, one a frame after the
 * terrain, the clouds (which draw the frame) and the camera. Each builds its
 * shaders and geometry on its first frame: all at once, that frame took
 * 300–600 ms and the load stuttered; one at a time, it's a few shorter ones.
 */
export const LAYERS = [
  "ocean",
  "buildings",
  "trees",
  "landmarks",
  "airfield",
  "sky",
  "quakes",
  "railway",
  "vessels",
  "cablecar",
  "traffic",
  "buses",
  "flights",
] as const;

type Layer = (typeof LAYERS)[number];

/**
 * Which of LAYERS are in the scene yet: one more each frame, counted as
 * loading until they all are, so the first view doesn't settle without them.
 */
function useLayers() {
  const [count, setCount] = useState(0);
  const left = useRef<number>(LAYERS.length);

  useEffect(() => addLoadingSource(() => (left.current > 0 ? 1 : 0)), []);

  useFrame(() => {
    if (count >= LAYERS.length) return;
    left.current = LAYERS.length - count - 1;
    setCount(count + 1);
  });

  return (layer: Layer) => LAYERS.indexOf(layer) < count && !switchedOff(layer);
}

/** Everything in the Canvas: Wellington at `time`, under `conditions`. */
export function Scene({
  index,
  conditions,
  time,
  mobile,
}: {
  index: TileIndex;
  conditions: Conditions;
  time: Date;
  mobile: boolean;
}) {
  const heightAt = useRef<HeightQuery | null>(null);
  const sun = useMemo(() => sunPosition(time), [time]);
  const sea = useMemo(() => seaConditions(conditions), [conditions]);
  const lights = nightFor(sun.altitude);
  const deck = conditions.cloudCover > 0 ? lowCloudBase(conditions) : null;
  const skylight = environment.skylightFor(conditions.cloudCover, 1 - lights);

  useEffect(() => {
    environment.skylight.value = skylight;
  }, [skylight]);

  useTide();

  const setHeightQuery = useCallback((query: HeightQuery | null) => {
    heightAt.current = query;
  }, []);

  // The scene never moves. Recomposing its matrix each frame would make
  // three recompute every object's world matrix too, frozen tiles included;
  // anything that moves still updates its own.
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    scene.matrixAutoUpdate = false;
  }, [scene]);

  const shown = useLayers();
  const watching = useSyncExternalStore(subscribeActive, getActive, getActive);

  // Looking down on the map, through where the clouds would be.
  const map = useMapView();

  return (
    <>
      <ambientLight ref={litForReflections} intensity={skylight} />
      <Atmosphere rootSize={index.manifest.rootSize} conditions={conditions} />
      <Sun
        index={index}
        mobile={mobile}
        cloudCover={conditions.cloudCover}
        position={sun}
      />
      {shown("sky") && <Sky time={time} sunAltitude={sun.altitude} />}
      {watching && <Telescope />}
      {!switchedOff("terrain") && (
        <Terrain
          onHeightQuery={setHeightQuery}
          index={index}
          quality={mobile ? TERRAIN_MOBILE : TERRAIN_DESKTOP}
        />
      )}
      {shown("ocean") && (
        <Suspense fallback={null}>
          <Ocean
            conditions={sea}
            index={index}
            quality={mobile ? OCEAN_MOBILE : OCEAN_DESKTOP}
          />
        </Suspense>
      )}
      {shown("quakes") && <Quakes index={index} />}
      {shown("landmarks") && (
        <Landmarks
          index={index}
          wind={conditions.wind}
          lights={lights}
          shadowMapSize={mobile ? 2048 : 4096}
        />
      )}
      {shown("buildings") && (
        <Buildings
          terrain={index}
          quality={mobile ? BUILDINGS_MOBILE : BUILDINGS_DESKTOP}
          lights={lights}
          occupancy={windowsLitAt(time)}
        />
      )}
      {shown("trees") && (
        <Trees
          terrain={index}
          quality={mobile ? TREES_MOBILE : TREES_DESKTOP}
          wind={conditions.wind}
        />
      )}
      {shown("airfield") && <AirfieldLights index={index} lights={lights} />}
      {shown("vessels") && <Vessels index={index} sea={sea} lights={lights} />}
      {shown("railway") && <Railway index={index} lights={lights} />}
      {shown("cablecar") && <CableCar index={index} lights={lights} />}
      {shown("traffic") && (
        <Traffic index={index} lights={lights} time={time} />
      )}
      {shown("buses") && (
        <Buses index={index} heightAt={heightAt} lights={lights} />
      )}
      {shown("flights") && (
        <Flights
          index={index}
          heightAt={heightAt}
          lights={lights}
          windFrom={conditions.wind.direction}
        />
      )}
      <Clouds
        conditions={conditions}
        quality={mobile ? CLOUDS_MOBILE : CLOUDS_DESKTOP}
        night={lights}
        hidden={map}
      />
      <Controls index={index} heightAt={heightAt} sea={sea} deck={deck} />
    </>
  );
}

/**
 * Frames a second while the scene's hidden, still loading. Enough to stream
 * in the view and build its shaders, which happen as frames are drawn,
 * without drawing sixty frames a second nobody sees.
 */
const HIDDEN_FPS = 10;

/** Draws a frame `fps` times a second, for a Canvas on demand. */
function Ticker({ fps }: { fps: number }) {
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const id = setInterval(() => invalidate(), 1000 / fps);

    return () => clearInterval(id);
  }, [invalidate, fps]);

  return null;
}

/** The Canvas's camera; the controls move its near plane with height. */
export const CAMERA = { fov: DEFAULT_FOV, near: 5, far: 80000 };

export const WellingtonScene: React.FC<{
  /** False clears the sky (and its rain) whatever the forecast says. */
  clouds?: boolean;
  /** Kept out of sight, still loading; it fades up when this turns false. */
  hidden?: boolean;
  /** Called once the first view has loaded. */
  onSettled?: () => void;
}> = ({ clouds = true, hidden = false, onSettled }) => {
  const [index, setIndex] = useState<TileIndex | null>(null);
  const mobile = useIsMobile();
  const forecast = useConditions();

  const conditions = useMemo(
    () =>
      clouds ? forecast : { ...forecast, cloudCover: 0, precipitation: 0 },
    [forecast, clouds]
  );

  const time = useSceneTime();
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [stats] = useState(showStats);
  const inView = useInView(canvas);

  useEffect(() => {
    track(loadManifest()).then(setIndex, (e) => console.error(e));
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <Canvas
        ref={setCanvas}
        style={{
          opacity: hidden ? 0 : 1,
          pointerEvents: hidden ? "none" : undefined,
          transition: "opacity 1.6s ease",
        }}
        // Scrolled past, the scene stops drawing; hidden, it barely does.
        frameloop={!inView ? "never" : hidden ? "demand" : "always"}
        shadows="percentage"
        // With 4× MSAA in the scene pass, 2× buys little over 1.5× at
        // nearly twice the fill.
        dpr={[1, 1.5]}
        gl={async (props) => {
          const renderer = new WebGPURenderer({
            // SAFETY: R3F's props are for a WebGLRenderer, and WebGPURenderer
            // takes the same ones; the types differ only in which declaration
            // of OffscreenCanvas each was built against.
            ...(props as any),
            antialias: true,
            // ?webgl tests the fallback path browsers without WebGPU get.
            forceWebGL: new URLSearchParams(location.search).has("webgl"),
          });

          await renderer.init();

          if (stats) await attachInspector(renderer);

          return renderer;
        }}
        camera={CAMERA}
      >
        {index && (
          <Scene
            index={index}
            conditions={conditions}
            time={time}
            mobile={mobile}
          />
        )}
        {stats && <Stats />}
        {hidden && inView && <Ticker fps={HIDDEN_FPS} />}
      </Canvas>
      {/* The long lens's dark edges, zoomed in on a satellite. */}
      <div
        ref={setVignette}
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at center, transparent 45%, rgba(0, 0, 0, 0.6) 100%)",
          opacity: 0,
          pointerEvents: "none",
        }}
      />
      <SceneLoading
        started={index !== null}
        hidden={hidden}
        onSettled={onSettled}
      />
      <Travelling hidden={hidden} />
    </div>
  );
};
