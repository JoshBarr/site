import React from "react";

// Where the Wellington scene's data comes from, and the attribution each
// source asks for: shown in the scene's Info panel and the homepage footer.
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
    what: "map data and building footprints",
    who: [
      {
        name: "© OpenStreetMap contributors",
        href: "https://www.openstreetmap.org/copyright",
      },
    ],
    licence: ODBL,
  },
];

/** What moves in it, live. */
export const LIVE_CREDITS: Credit[] = [
  {
    what: "weather",
    who: [{ name: "MetService", href: "https://www.metservice.com" }],
  },
  {
    what: "ship positions",
    who: [
      { name: "Open Waters AIS", href: "https://openwaters.io/ais/" },
      { name: "AISHub", href: "https://www.aishub.net" },
    ],
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
    what: "traffic speeds and counts",
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
    what: "public holidays",
    who: [{ name: "Nager.Date", href: "https://date.nager.at" }],
  },
];

const CREDITS = [...MAP_CREDITS, ...LIVE_CREDITS];

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

/** All of it as a sentence, for a page's footer. */
export const CreditsSentence: React.FC<{ linkClass?: string }> = ({
  linkClass,
}) => (
  <>
    The Wellington scene is adapted from:{" "}
    {CREDITS.map((credit, i) => (
      <React.Fragment key={credit.what}>
        {i > 0 && "; "}
        {credit.what} from <Sources credit={credit} linkClass={linkClass} />
        {credit.licence && (
          <>
            , <LicenceLink licence={credit.licence} linkClass={linkClass} />
          </>
        )}
      </React.Fragment>
    ))}
    .
  </>
);
