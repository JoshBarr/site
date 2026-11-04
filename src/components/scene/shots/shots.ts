// Set views of Wellington, picked from a list to frame a shot quickly. Each
// is a camera and what it looks at, as `?cam=` gives them: NZTM metres, and
// altitudes in the scene's (the DEM's, times the terrain's vertical scale).
// The orbit can't look up, so every target is level with its camera or below.
//
// Places are from OpenStreetMap; the framing of each is by eye.

type View = [
  easting: number,
  northing: number,
  altitude: number,
  targetEasting: number,
  targetNorthing: number,
  targetAltitude: number,
];

export interface Shot {
  /** For `?shot=`. */
  id: string;
  name: string;
  group: string;
  view: View;
}

export const SHOTS: Shot[] = [
  {
    id: "overview",
    name: "Overview",
    group: "City and harbour",
    view: [1752500, 5429000, 900, 1747500, 5428700, 150],
  },
  {
    id: "harbour",
    name: "Up the harbour",
    group: "City and harbour",
    view: [1753400, 5423500, 450, 1756240, 5430925, 30],
  },
  {
    id: "mt-victoria",
    name: "Mt Victoria lookout",
    group: "City and harbour",
    view: [1750231, 5426827, 250, 1748766, 5428194, 40],
  },
  {
    id: "oriental-bay",
    name: "Oriental Bay",
    group: "City and harbour",
    view: [1750395, 5427938, 35, 1750088, 5427300, 25],
  },
  {
    id: "waterfront",
    name: "Waterfront and Te Papa",
    group: "City and harbour",
    view: [1749761, 5427673, 60, 1749212, 5427462, 15],
  },
  {
    id: "petone",
    name: "Petone and the Hutt",
    group: "City and harbour",
    view: [1756000, 5431500, 250, 1757000, 5435500, 0],
  },
  {
    id: "west-wind",
    name: "West Wind",
    group: "Hills and coast",
    view: [1743000, 5432200, 450, 1741000, 5431300, 300],
  },
  {
    id: "brooklyn",
    name: "Brooklyn turbine",
    group: "Hills and coast",
    view: [1745980, 5425150, 480, 1746090, 5425263, 465],
  },
  {
    id: "kaukau",
    name: "Mt Kaukau lookout",
    group: "Hills and coast",
    view: [1749180, 5433550, 600, 1749500, 5428000, 0],
  },
  {
    id: "pencarrow",
    name: "Pencarrow Head",
    group: "Hills and coast",
    view: [1754100, 5419100, 140, 1754747, 5419749, 110],
  },
  {
    id: "airport",
    name: "Airport",
    group: "Transport",
    view: [1750700, 5425300, 250, 1751215, 5423400, 0],
  },
  {
    id: "runway-34",
    name: "Runway 34 approach",
    group: "Transport",
    view: [1751080, 5421500, 50, 1751215, 5423400, 0],
  },
  {
    id: "ngauranga",
    name: "Ngauranga interchange",
    group: "Transport",
    view: [1752100, 5431700, 120, 1751778, 5432019, 10],
  },
  {
    id: "interislander",
    name: "Interislander terminal",
    group: "Transport",
    view: [1750150, 5430050, 60, 1749683, 5430374, 10],
  },
  {
    id: "port",
    name: "CentrePort and Bluebridge",
    group: "Transport",
    view: [1750350, 5428650, 90, 1749500, 5428800, 10],
  },
  {
    id: "station",
    name: "Railway station",
    group: "Transport",
    view: [1749420, 5429402, 90, 1749070, 5428698, 5],
  },
  {
    id: "cable-car",
    name: "Cable car",
    group: "Transport",
    view: [1748030, 5428035, 175, 1748450, 5428150, 35],
  },
];

/** The camera's view now, while the scene's up. */
type ViewSource = () => View | null;

/** Takes the camera to a view: flying there, or cutting. */
type ViewSink = (view: View) => void;

let source: ViewSource | null = null;
let sink: ViewSink | null = null;

/** The scene's camera answers to these while mounted. */
export function connectCamera(get: ViewSource, go: ViewSink) {
  source = get;
  sink = go;

  return () => {
    if (source === get) source = null;

    if (sink === go) sink = null;
  };
}

export function goTo(shot: Shot) {
  sink?.(shot.view);
}

export const currentView = () => source?.() ?? null;

/** `?shot=<id>`, if it names one. */
export function shotFromUrl() {
  const id = new URLSearchParams(location.search).get("shot");

  return SHOTS.find((shot) => shot.id === id) ?? null;
}
