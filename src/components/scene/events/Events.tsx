import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { VenueKey } from "../../../lib/events";
import { sceneNow } from "../clock";
import { usePixelAngle } from "../landmarks/common";
import { floodlitGround } from "../skyglow";
import { nztmToWorld, type TileIndex } from "../terrain/manifest";
import { lightVenue, type VenueLighting } from "./glow";
import { type VenueState, venueStates } from "./schedule";
import { Stadium, stadiumLit } from "./Stadium";
import { useEvents } from "./useEvents";
import { VENUE_SITES } from "./venues";

// Wellington's venues lit while something's on in them (lib/events.ts):
// the stadium's floodlights for a game or a concert, a theatre or concert
// hall glowing through a show. It only shows at night.

/** A hall with a show on: walls washed, every window lit. Eyeballed. */
const HALL: VenueLighting = { flood: 1.2, windows: 0.85, crown: 0.15 };

/** How each venue's lit, where it isn't a hall's way. */
const LIGHTING: Partial<Record<VenueKey, VenueLighting>> = {
  // The bowl aglow under its roof, the concourse lit.
  stadium: { flood: 0.4, windows: 0.7, crown: 1.2 },
  // No floodlights at the Basin: its games are played by day.
  basin: { flood: 0, windows: 0, crown: 0 },
};

/** The stadium's light in the haze, against the city at its brightest. */
const STADIUM_SKYGLOW = 0.8;

/** States are worked out this often, ms: things come up over minutes. */
const EVERY = 1_000;

// SAFETY: VENUE_SITES is keyed by VenueKey.
const VENUES = Object.keys(VENUE_SITES) as VenueKey[];

export function Events({ index }: { index: TileIndex }) {
  usePixelAngle();

  const events = useEvents();
  const states = useRef(new Map<VenueKey, VenueState>());
  const worked = useRef(-Infinity);

  useEffect(() => {
    // Asked again with the new listings.
    worked.current = -Infinity;
  }, [events]);

  useEffect(() => {
    const [e, n] = VENUE_SITES.stadium.centre;
    const [x, z] = nztmToWorld(index.manifest, e, n);

    floodlitGround.value.set(x, z, 0);
  }, [index]);

  useFrame(() => {
    const now = performance.now();

    if (now - worked.current < EVERY) return;
    worked.current = now;

    states.current = venueStates(events, sceneNow());

    for (const venue of VENUES) {
      const lit = states.current.get(venue)?.lit ?? 0;
      const { flood, windows, crown } = LIGHTING[venue] ?? HALL;

      lightVenue(venue, {
        flood: flood * lit,
        windows: windows * lit,
        crown: crown * lit,
      });
    }

    const stadium = states.current.get("stadium")?.lit ?? 0;
    stadiumLit.value = stadium;
    floodlitGround.value.z = stadium * STADIUM_SKYGLOW;
  });

  // Off when the layer goes, as it was.
  useEffect(
    () => () => {
      for (const venue of VENUES) {
        lightVenue(venue, { flood: 0, windows: 0, crown: 0 });
      }

      stadiumLit.value = 0;
      floodlitGround.value.z = 0;
    },
    []
  );

  return <Stadium index={index} />;
}
