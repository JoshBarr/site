import React from "react";

// Where the Wellington scene's data comes from, and the attribution each
// source asks for: shown in the scene's Info panel.
// A new data source goes here.

type Licence = { name: string; href: string };

export type Credit = {
  /** What the scene takes from it, as it'd read mid-sentence. */
  what: string;
  /** Who to credit, linked, and how they ask to be named. */
  who: { name: string; href: string }[];
  licence?: Licence;
};

const CC_BY: Licence = {
  name: "CC BY 4.0",
  href: "https://creativecommons.org/licenses/by/4.0/",
};

const CC_BY_NZ: Licence = {
  name: "CC BY 3.0 NZ",
  href: "https://creativecommons.org/licenses/by/3.0/nz/",
};

const CC_BY_SA: Licence = {
  name: "CC BY-SA 4.0",
  href: "https://creativecommons.org/licenses/by-sa/4.0/",
};

const ODBL: Licence = {
  name: "ODbL",
  href: "https://opendatacommons.org/licenses/odbl/1-0/",
};

/** What the scene's built from: the ground, the city, the map. */
export const MAP_CREDITS: Credit[] = [
  {
    what: "elevation, tree canopy and building heights",
    who: [
      {
        name: "Toitū Te Whenua Land Information New Zealand",
        href: "https://data.linz.govt.nz",
      },
    ],
    licence: CC_BY,
  },
  {
    what: "the sea floor, and the South Island on the horizon",
    who: [{ name: "NIWA", href: "https://koordinates.com/layer/8678/" }],
    licence: CC_BY_NZ,
  },
  {
    what: "3D buildings",
    who: [
      {
        name: "© Wellington City Council and AAM Ltd",
        href: "https://data-wcc.opendata.arcgis.com",
      },
    ],
    licence: CC_BY,
  },
  {
    what: "pylons and power lines",
    who: [
      {
        name: "Transpower New Zealand",
        href: "https://data-transpower.opendata.arcgis.com",
      },
    ],
    licence: CC_BY,
  },
  {
    what: "map data and building footprints",
    who: [
      {
        name: "© OpenStreetMap contributors",
        href: "https://www.openstreetmap.org/copyright",
      },
    ],
    licence: ODBL,
  },
  {
    what: "stars",
    who: [
      { name: "d3-celestial", href: "https://github.com/ofrohn/d3-celestial" },
      {
        name: "the HYG database",
        href: "https://www.astronexus.com/projects/hyg",
      },
    ],
    licence: CC_BY_SA,
  },
];

/** What moves in it, live. */
export const LIVE_CREDITS: Credit[] = [
  {
    what: "weather",
    who: [{ name: "MetService", href: "https://www.metservice.com" }],
  },
  {
    what: "Wellington Airport's observations",
    who: [
      {
        name: "NOAA's Aviation Weather Center",
        href: "https://aviationweather.gov",
      },
    ],
  },
  {
    what: "where the cloud is, from Himawari-9",
    who: [
      { name: "JMA", href: "https://www.jma.go.jp/jma/indexe.html" },
      { name: "CIRA's SLIDER", href: "https://slider.cira.colostate.edu" },
    ],
  },
  {
    what: "rain gauges",
    who: [
      {
        name: "Greater Wellington Regional Council",
        href: "https://www.gw.govt.nz/environment/environmental-data/",
      },
    ],
  },
  {
    // Served without a licence said; GWRC's terms for it are unconfirmed.
    what: "the sea off Baring Head, by its wave buoy",
    who: [
      {
        name: "Greater Wellington Regional Council",
        href: "https://www.gw.govt.nz/environment/environmental-data-and-information/",
      },
    ],
  },
  {
    // Its website's terms reserve its contents: no open licence.
    what: "the HVDC link's transfer and the North Island's load",
    who: [
      {
        name: "Transpower New Zealand",
        href: "https://www.transpower.co.nz/system-operator/live-system-and-market-data/consolidated-live-data",
      },
    ],
  },
  {
    // Only once the poller has a key for it (lib/gridFlow.ts).
    what: "substation loads and wind farm output",
    who: [
      {
        name: "Electricity Authority",
        href: "https://www.emi.ea.govt.nz",
      },
    ],
    licence: CC_BY,
  },
  {
    // RainViewer's terms ask for its name and this link; the radars are
    // MetService's.
    what: "rain radar",
    who: [
      { name: "RainViewer", href: "https://www.rainviewer.com/" },
      { name: "MetService", href: "https://www.metservice.com" },
    ],
  },
  {
    what: "ship positions",
    who: [
      { name: "Open Waters AIS", href: "https://openwaters.io/ais/" },
      { name: "AISHub", href: "https://www.aishub.net" },
    ],
  },
  {
    // The berths and how full each place was; the boats in them are made up.
    what: "marina berths and moorings",
    who: [{ name: "Ethos GIS", href: "https://www.ethosgis.com" }],
  },
  {
    what: "aircraft positions",
    who: [{ name: "adsb.lol", href: "https://adsb.lol" }],
    licence: ODBL,
  },
  {
    what: "flight routes",
    who: [{ name: "adsb.im", href: "https://adsb.im" }],
  },
  {
    what: "train and bus positions, bus routes and the cable car's timetable",
    who: [{ name: "Metlink", href: "https://opendata.metlink.org.nz" }],
    licence: CC_BY,
  },
  {
    // The speed limits are its National Speed Limit Register's. NZTA
    // doesn't publish what its lane signs show: the scene estimates it from
    // the register and the speeds (traffic/signs/limits.ts).
    what: "traffic speeds and counts, message signs, speed limits (the motorway's lane signs estimated from them)",
    who: [
      {
        name: "NZTA",
        href: "https://www.nzta.govt.nz/traffic-and-travel-information/use-our-data/",
      },
    ],
    licence: CC_BY,
  },
  {
    what: "earthquakes and the tide",
    who: [{ name: "GeoNet", href: "https://www.geonet.org.nz" }],
    licence: CC_BY,
  },
  {
    what: "satellite orbits",
    who: [{ name: "CelesTrak", href: "https://celestrak.org" }],
  },
  {
    what: "what's on at the venues",
    who: [
      { name: "Eventfinda", href: "https://www.eventfinda.co.nz" },
      { name: "TheSportsDB", href: "https://www.thesportsdb.com" },
    ],
  },
  {
    what: "where the flocks gather, from birders' checklists",
    who: [{ name: "eBird", href: "https://ebird.org" }],
  },
  {
    what: "public holidays",
    who: [{ name: "Nager.Date", href: "https://date.nager.at" }],
  },
];

/** "A, B and C". */
const and = (parts: React.ReactNode[]) =>
  parts.map((part, i) => (
    <React.Fragment key={i}>
      {i > 0 && (i === parts.length - 1 ? " and " : ", ")}
      {part}
    </React.Fragment>
  ));

/** Its sources, linked: "Open Waters AIS and AISHub". */
export const Sources: React.FC<{ credit: Credit; linkClass?: string }> = ({
  credit,
  linkClass,
}) => (
  <>
    {and(
      credit.who.map(({ name, href }) => (
        <a key={href} className={linkClass} href={href}>
          {name}
        </a>
      ))
    )}
  </>
);

export const LicenceLink: React.FC<{
  licence: Licence;
  linkClass?: string;
}> = ({ licence, linkClass }) => (
  <a className={linkClass} href={licence.href}>
    {licence.name}
  </a>
);
