import { http, HttpResponse } from "msw/http";
import { server } from "../msw";

// eBird's checklist feed, checklists and taxonomy, as it answers.

type Loc = { id: string; name: string; lat: number; lng: number };

/** A hotspot on the south coast. */
export const OWHIRO: Loc = {
  id: "L601122",
  name: "Wellington--Owhiro Bay and Coast",
  lat: -41.3449,
  lng: 174.7603,
};

/** Plimmerton's rocks, a hotspot up the coast. */
export const PLIMMERTON: Loc = {
  id: "L4492625",
  name: "Plimmerton--Fire Station Rocks",
  lat: -41.0814,
  lng: 174.8667,
};

/** Someone's own spot in Newlands: not a hotspot. */
export const GARDEN: Loc = {
  id: "L79979107",
  name: "Auto selected -41.22264, 174.82237",
  lat: -41.222641,
  lng: 174.822369,
};

/** Masterton, over the hill in the Wairarapa: off the map. */
export const MASTERTON: Loc = {
  id: "L1234567",
  name: "Masterton--Henley Lake",
  lat: -40.9531,
  lng: 175.6602,
};

/** A checklist, as eBird's feed lists it. */
export const listed = (subId: string, loc: Loc, numSpecies = 2) => ({
  subId,
  numSpecies,
  userDisplayName: "A Birder",
  isoObsDate: "2026-11-02 08:00",
  loc: {
    locId: loc.id,
    name: loc.name,
    lat: loc.lat,
    lng: loc.lng,
    isHotspot: !loc.name.startsWith("Auto selected"),
  },
});

/** A checklist, as eBird gives it. */
export const checklist = (
  subId: string,
  obsDt: string,
  obs: [string, number | null][],
  extra: {
    groupId?: string;
    protocolId?: string;
    effortDistanceKm?: number;
    obsTimeValid?: boolean;
  } = {}
) => ({
  subId,
  protocolId: "P22",
  durationHrs: 1.5,
  effortDistanceKm: 2.1,
  obsDt,
  obsTimeValid: true,
  userDisplayName: "A Birder",
  obs: obs.map(([speciesCode, count]) => ({
    speciesCode,
    ...(count === null
      ? { present: true, howManyStr: "X" }
      : {
          howManyAtleast: count,
          howManyAtmost: count,
          howManyStr: `${count}`,
        }),
  })),
  ...extra,
});

const TAXA = new Map<string, [string, string, string]>([
  ["kelgul", ["Kelp Gull", "Larus dominicanus", "larida1"]],
  ["silgul2", ["Silver Gull", "Chroicocephalus novaehollandiae", "larida1"]],
  ["whfter1", ["White-fronted Tern", "Sterna striata", "larida1"]],
  ["flushe1", ["Fluttering Shearwater", "Puffinus gavia", "procel3"]],
  ["tui1", ["Tui", "Prosthemadera novaeseelandiae", "meliph3"]],
]);

/** What was asked of eBird, path and query. */
export const asked: string[] = [];

/**
 * eBird, listing `list` (newest first) and giving `checklists` by id; a
 * checklist not given is a 404. `status` for the list call's.
 */
export function ebird(
  list: unknown[],
  checklists: { subId: string }[],
  status = 200
) {
  asked.length = 0;

  const byId = new Map(checklists.map((c) => [c.subId, c]));

  const keyed = (request: Request) =>
    request.headers.get("x-ebirdapitoken") === "ebird-key";

  server.use(
    http.get("https://api.ebird.org/v2/product/lists/NZ-WGN", ({ request }) => {
      const url = new URL(request.url);

      asked.push(url.pathname + url.search);

      if (!keyed(request)) return new HttpResponse(null, { status: 403 });

      return status === 200
        ? HttpResponse.json(list)
        : new HttpResponse(null, { status });
    }),
    http.get(
      "https://api.ebird.org/v2/product/checklist/view/:subId",
      ({ request, params }) => {
        asked.push(new URL(request.url).pathname);

        if (!keyed(request)) return new HttpResponse(null, { status: 403 });

        const found = byId.get(String(params.subId));

        return found
          ? HttpResponse.json(found)
          : new HttpResponse(null, { status: 404 });
      }
    ),
    http.get("https://api.ebird.org/v2/ref/taxonomy/ebird", ({ request }) => {
      const url = new URL(request.url);

      asked.push(url.pathname + url.search);

      const codes = url.searchParams.get("species")?.split(",") ?? [];

      return HttpResponse.json(
        codes.flatMap((code) => {
          const taxon = TAXA.get(code);

          if (!taxon) return [];

          const [comName, sciName, familyCode] = taxon;

          return [{ speciesCode: code, comName, sciName, familyCode }];
        })
      );
    })
  );
}
