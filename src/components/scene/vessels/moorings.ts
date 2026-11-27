import type { Place } from "./berths";

/**
 * How full each place's berths are: the share with a boat in at their last
 * check in Ethos GIS's survey of hulls, counted once on 2026-11-27 (boats /
 * berths). Checks run from December 2024 to November 2026. The survey writes
 * down only the boats it finds, so a berth with no check is taken as empty;
 * some may just not have been looked at, most likely the swing moorings at
 * Mana and Paremata.
 */
export const OCCUPANCY: Record<Place, number> = {
  "Chaffers Marina berth": 155 / 177,
  "Clyde Quay pole": 47 / 47,
  "Clyde Quay swing": 10 / 10,
  "Evans Bay berth": 144 / 148,
  "Evans Bay swing": 25 / 43,
  "Seaview Marina berth": 288 / 371,
  "Mana berth": 297 / 325,
  "Mana swing": 1 / 18,
  "Paremata pole": 20 / 20,
  "Paremata swing": 1 / 3,
};

/** Of the boats in, how many are yachts; the rest are launches. A guess. */
export const SAILING = 0.65;
