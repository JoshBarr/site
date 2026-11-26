import type { CloudOver } from "../cloudLight";
import { overcastFor } from "../environment";
import { type Conditions, lowCloudBase } from "../weather";
import { throughCloud } from "./density";

// The sky's cloud, shared out into the layers the march draws (./density.ts)
// from what the weather says of it.

/**
 * A layer above one as cloudy hides how much it adds: it's taken as this
 * share of its cover.
 */
const HIDDEN = 0.5;

const unit = (value: number) => Math.min(Math.max(value, 0), 1);

/** A layer's (base, top, coverage, density): its uniform's `shape`. */
type Shape = [number, number, number, number];

export interface CloudShapes {
  low: Shape;
  mid: Shape;
  /** (altitude, coverage, -, -). */
  cirrus: Shape;
  /** 0..1, how close the whole sky is to a grey lid. */
  overcast: number;
  /** 0..1, how far the low layer's closed into a deck. */
  lid: number;
}

/**
 * Shares the cover out into the layers. Observed (the airport's METAR), the
 * lowest layer's the low cloud, on its base, and those above it the
 * cumulus: each counts the cloud under it too, so what a layer adds is its
 * share of the sky those under it leave. Forecast, there's only the total
 * cover and a cloud base: low cloud sits on the base (often wrapping the
 * hills), cumulus above it. Either way a cirrus sheet's nearly always
 * faintly there. Not `shown`, the sky's no less overcast, but there's no
 * cloud to see.
 */
export function shapesFor(conditions: Conditions, shown: boolean): CloudShapes {
  const total = unit(conditions.cloudCover);
  const observed = conditions.layers;
  const [lowest, ...above] = observed ?? [];
  const cover = shown ? total : 0;
  const lowSky = observed ? (lowest?.cover ?? 0) : total;
  const lowCover = shown ? lowSky : 0;
  // Observed, only the lowest layer overcast closes it into a deck.
  const lid = overcastFor(lowSky);
  const base = lowCloudBase(conditions);
  // A full deck is thick; broken cloud is shallower.
  const lowTop = base + 250 + 600 * lowCover + 400 * lid;
  const highest = above.at(-1);
  let mid: Shape;

  if (observed && highest) {
    const adds =
      highest.cover > lowSky && lowSky < 1
        ? (highest.cover - lowSky) / (1 - lowSky)
        : highest.cover * HIDDEN;

    const midBase = Math.max(above[0].base, lowTop + 100);
    const midTop = Math.max(midBase + 900 + 1200 * adds, highest.base + 600);

    mid = [midBase, midTop, shown ? adds * 0.7 : 0, 0.8];
  } else {
    // Observed with nothing above the lowest, there's only a trace.
    const midCover = observed ? cover * 0.1 : cover * 0.4;
    const midBase = Math.max(lowTop + 400, 1800);

    mid = [midBase, midBase + 900 + 1200 * cover, midCover, 0.8];
  }

  return {
    low: [base, lowTop, lowCover * 0.95, 1],
    mid,
    // No cover at all is a clear sky, cirrus too.
    cirrus: [7500, cover > 0 ? 0.15 + 0.45 * cover : 0, 0, 0],
    overcast: overcastFor(total),
    lid,
  };
}

/**
 * The same sky as the light meets it (see ../cloudLight.ts), the higher
 * layer first: hidden or not, the cloud's still over the scene. The cirrus
 * is left out: it's thin enough to cast no shadow.
 */
export function cloudsOver(conditions: Conditions): CloudOver[] {
  const { low, mid, lid } = shapesFor(conditions, true);

  const over = ([base, top, cover, density]: Shape, closed = 0): CloudOver => ({
    // A deck's closed over the gaps its cover leaves.
    cover: unit(cover) + (1 - unit(cover)) * closed,
    passes: throughCloud(top - base, density),
  });

  return [over(mid), over(low, lid)];
}
