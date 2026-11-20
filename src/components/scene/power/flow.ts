import { useEffect, useState } from "react";
import type { GridFlow } from "../../../lib/gridFlow";
import { layerUrl, sceneNow, useSeek } from "../clock";
import { arrive } from "../time/jump";
import { sceneShown } from "../visibility";
import { SUBSTATIONS } from "./feed";

// What the grid's carrying (lib/gridFlow.ts), as the scene shows it: which
// way the HVDC link's sending and how hard, how hard each substation's
// lines are working, and how much of what they could the wind farms are
// sending out. All of it's only seen once the grid's lit (energise.ts),
// bar the link's quiet running lights at night and the turbines' turning.

/** /api/grid is asked every five minutes: the poller asks as often. */
const POLL = 5 * 60_000;

/**
 * The link's transfer's posted for each half hour, half an hour or more
 * after: older than this, ms, and it's not known.
 */
const LINK_STALE = 2 * 3600_000;

/** Loads and the farms' output are five-minutely: this old, they're not known. */
const LOAD_STALE = 45 * 60_000;

/** The most the link sends north, MW (it's 850 south): pole 2 and pole 3. */
const LINK_MOST = 1200;

/**
 * The North Island's load on a summer's night and at a winter evening's
 * peak, MW, about: where between says how hard every substation's working
 * when theirs aren't known. From memory of Transpower's load charts, not
 * measured.
 */
const ISLAND_LEAST = 1800;
const ISLAND_MOST = 4600;

/** A substation over what it's taken to peak at is no brighter than this. */
const OVER = 1.2;

/** Meridian's farms, MW: 62 and 26 turbines of 2.3. */
const WEST_WIND = 142.6;
const MILL_CREEK = 59.8;

export interface Carried {
  /**
   * The HVDC link: `heading` 1 sending north to Haywards, -1 south, and
   * `transfer` how much of what it can, 0..1. Null when it's not known.
   */
  link: { heading: 1 | -1; transfer: number } | null;
  /**
   * How hard each of SUBSTATIONS is working, in their order: 0 idle, 1 its
   * most. All 1 when nothing's known.
   */
  levels: number[];
  /** How much of what each wind farm can send it's sending, 0..1; null unknown. */
  farms: { westWind: number | null; millCreek: number | null };
}

/**
 * URL overrides, for trying it out:
 *   ?hvdc=-600    the link's transfer, MW: northward positive
 *   ?load=40      every substation's load, percent of its most
 *   ?farms=75     the wind farms' output, percent of what they can
 */
export interface Tried {
  hvdc?: number;
  load?: number;
  farms?: number;
}

export function tried(search: string): Tried {
  const params = new URLSearchParams(search);

  const number = (name: string) => {
    const value = Number(params.get(name));

    return params.get(name) && Number.isFinite(value) ? value : undefined;
  };

  return { hvdc: number("hvdc"), load: number("load"), farms: number("farms") };
}

const within = (value: number, most = 1) => Math.min(Math.max(value, 0), most);

/** What `flow` (as /api/grid has it) comes to at `now`, with what's `tried`. */
export function carried(
  flow: GridFlow | null,
  now: number,
  { hvdc, load, farms }: Tried = {}
): Carried {
  const fresh = <T extends { time: number }>(
    reading: T | null,
    stale: number
  ) => (reading && now - reading.time < stale ? reading : null);

  const transfer = hvdc ?? fresh(flow?.hvdc ?? null, LINK_STALE)?.mw;
  const sites = fresh(flow?.sites ?? null, LOAD_STALE);
  const island = fresh(flow?.northIsland ?? null, LOAD_STALE);

  // With no substation's known, the island's load stands for them all.
  const everywhere =
    load !== undefined
      ? within(load / 100, OVER)
      : island
        ? within(
            (island.mw - ISLAND_LEAST) / (ISLAND_MOST - ISLAND_LEAST),
            OVER
          )
        : 1;

  const output = (mw: number | undefined, most: number) =>
    farms !== undefined
      ? within(farms / 100)
      : mw === undefined
        ? null
        : within(mw / most);

  const westWind = output(sites?.generation.WWD, WEST_WIND);

  return {
    link:
      transfer === undefined
        ? null
        : {
            heading: transfer < 0 ? -1 : 1,
            transfer: within(Math.abs(transfer) / LINK_MOST),
          },
    levels: SUBSTATIONS.map(({ code, most, sends }) => {
      if (sends) return westWind ?? everywhere;

      const taken = load === undefined ? sites?.load[code] : undefined;

      return taken === undefined ? everywhere : within(taken / most, OVER);
    }),
    farms: { westWind, millCreek: output(sites?.generation.WIL, MILL_CREEK) },
  };
}

/** Whether two readings of the grid come to the same thing drawn. */
const same = (a: Carried, b: Carried) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * What the grid's carrying at the scene's time (../clock.ts), asked for
 * again as it runs on and when it's set. Until it's heard from, and when
 * what's known has gone stale, nothing's known: the link's not, every
 * substation's taken to be at its most, and the farms go by the wind.
 */
export function useGridFlow(): Carried {
  const seek = useSeek();

  const [known, setKnown] = useState(() =>
    carried(null, 0, tried(globalThis.location?.search ?? ""))
  );

  useEffect(() => {
    const overrides = tried(location.search);
    const arrived = arrive();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let asked = false;
    let flow: GridFlow | null = null;

    const poll = async () => {
      if (sceneShown() || !asked) {
        const url = layerUrl("/api/grid", 60_000);

        asked = true;

        try {
          const response = url ? await fetch(url) : null;

          if (response?.ok) flow = await response.json();
        } catch (e) {
          console.error("[grid]", e);
        }

        if (!stopped) {
          // Worked out again even with nothing new: what's known goes stale.
          const next = carried(flow, sceneNow(), overrides);

          setKnown((shown) => (same(shown, next) ? shown : next));
        }

        arrived();
      }

      if (!stopped) timer = setTimeout(poll, POLL);
    };

    poll();

    return () => {
      stopped = true;
      arrived();
      clearTimeout(timer);
    };
  }, [seek]);

  return known;
}
