// Builds public/roads/signs.json: the signs along State Highways 1 and 2
// that there's evidence for, placed on the carriageways of
// public/roads/roads.json (so run this after build_roads.mjs), and
// scripts/traffic/signs.evidence.json: what each was made from, and what was
// left out and why.
//
//   node scripts/traffic/build_signs.mjs [--osm cached.json] [--nzta cached.json]
//     [--nslr cached.json] [--save-nslr cached.json]
//
// Electronic signs are NZTA's variable message signs (traffic API, CC BY
// 4.0): each has a position and the way its traffic runs, and its text
// comes live by its id. Fixed signs are OpenStreetMap's (© OpenStreetMap
// contributors, ODbL): `destination` tags record what a road's signposted
// as, so each road leaving a carriageway with them gets a direction sign
// where it leaves, lane by lane where `destination:lanes` says; speed
// limit signs stand where roads.json's limits (OSM `maxspeed`) change, if
// NZTA's National Speed Limit Register (CC BY 4.0) doesn't say otherwise.
// Gantries are OSM's `man_made=gantry` ways, end to end, and where NZTA has
// two message signs facing each other's traffic at one spot over the lanes,
// one gantry across both carriageways carries them. On the Wellington urban
// motorway's gantries, in the register's variable limit, a lane sign hangs
// over each lane: NZTA's lane control signs, which no feed reports, so the
// scene estimates what they show. Nothing's worded from a guess: a sign with no legend
// on record is left out.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { toNztm } from "../lib/geo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const ROADS = path.join(ROOT, "public/roads/roads.json");
const OUT = path.join(ROOT, "public/roads/signs.json");
const EVIDENCE = path.join(HERE, "signs.evidence.json");

/** Round the carriageways: south, west, north, east. */
const BOUNDS = [-41.36, 174.72, -40.94, 175.2];

const QUERY = `[out:json][timeout:180];
(
  way["highway"]["destination"](${BOUNDS});
  way["highway"]["destination:lanes"](${BOUNDS});
  way["man_made"="gantry"](${BOUNDS});
);
out body geom;`;

/** Within bounds: west, south, east, north. */
const NZTA =
  "http://trafficnz.info/service/traffic/rest/4/signs/vms/withinbounds/" +
  [BOUNDS[1], BOUNDS[0], BOUNDS[3], BOUNDS[2]].join("/");

/** Lanes, m, as roads.ts has them. */
const LANE = 3.5;
const TOWN_LANE = 3.2;

/** Bits of a span's flags, as roads.json has them. */
const TUNNEL = 1;
const TWO_WAY = 4;

/**
 * A message sign's on a carriageway if it's no further left of its kerb
 * than this, m (a mast on the verge), or right of its lanes than this (one
 * in the median).
 */
const VERGE = 12;
const MEDIAN = 4;

/**
 * Message signs this near along one carriageway, m, are drawn as one: an
 * old sign's record beside its replacement's, or two boards on one mount.
 */
const SAME_SIGN = 30;

/** A message sign this near a gantry, m, hangs from it. */
const ON_GANTRY = 20;

/** A way starting this near a carriageway's line, m, leaves from it. */
const ON_LINE = 6;

/** A way that ends this far off the carriageway, m, has left it. */
const LEFT = 5;

/**
 * A gantry this far before where a road leaves, m, carries its sign; or
 * this far after, if it stands clear of the lanes on that side.
 */
const GANTRY_BEFORE = 150;
const GANTRY_AFTER = 200;

/**
 * Message signs over the lanes this near each other, m, facing each other's
 * traffic, hang from one gantry across both carriageways: at Placemakers and
 * the Rail Crossing, the council's 3D models of them span both.
 */
const PAIRED = 60;

/**
 * Lane control signs: NZTA's, "mounted on gantries and bridges straddling
 * the motorway" on SH1 from the Terrace Tunnel to Ngauranga Gorge, in the
 * register's variable limit, which runs on up the gorge to Johnsonville.
 * South of this northing, NZTM m: Johnsonville.
 */
const LANE_SIGNS_NORTH = 5436500;
const LANE_SIGN_ROADS = ["SH1N", "SH1S"];

/**
 * North of this northing, NZTM m, the Ngauranga interchange, SH1's the
 * gorge: open road.
 */
const NGAURANGA = 5432800;

/**
 * Which stretch a lane sign's on, by its register zone and where it is:
 * each runs its variable limit its own way (the scene estimates it).
 */
function laneZone(zone, [, northing]) {
  if (/TERRACE TUNNEL/.test(zone.speedLimitZoneName)) return "tunnel";

  return northing > NGAURANGA ||
    /NEWLANDS TO NGAURANGA|JOHNSONVILLE/.test(zone.speedLimitZoneName)
    ? "gorge"
    : "motorway";
}

/** An arm from one post reaches this far at most, m: longer has a post at each end. */
const SELF_STANDING = 12;

/** Posts stand this far off the kerb, m: direction signs, speed signs, masts. */
const DIRECTION_OFF = 3;
const SPEED_OFF = 1.8;
const MAST_OFF = 2.5;

/** The register's asked what's in force this far past a change of limit, m. */
const CHECK_PAST = 80;

const NSLR =
  "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/SpeedLimitZoneFull__View/FeatureServer/0/query";

/** A speed limit kept for less than this, m, is a tagging blip: no sign. */
const LIMIT_RUN = 300;

/** At this limit, km/h, and over, message signs are the big motorway ones. */
const BIG_FROM = 80;

async function loadJson(flag, fetchIt) {
  const cached = process.argv.indexOf(flag);

  if (cached > 0)
    return JSON.parse(await readFile(process.argv[cached + 1], "utf8"));

  return fetchIt();
}

const loadOsm = () =>
  loadJson("--osm", async () => {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "User-Agent": "joshbarr.com scene builder",
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ data: QUERY }),
    });

    if (!response.ok) throw new Error(`overpass: ${response.status}`);

    return response.json();
  });

const loadNzta = () =>
  loadJson("--nzta", async () => {
    const response = await fetch(NZTA, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) throw new Error(`nzta: ${response.status}`);

    return response.json();
  });

const round = (v, places = 1) => Number(v.toFixed(places));

// --- The carriageways, as roads.json has them. ---

const roads = JSON.parse(await readFile(ROADS, "utf8"));

const carriageways = Object.entries(roads.carriageways).map(([name, file]) => {
  const count = file.points.length / 3;
  const e = new Float64Array(count);
  const n = new Float64Array(count);
  const s = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    e[i] = file.points[i * 3];
    n[i] = file.points[i * 3 + 1];

    if (i) s[i] = s[i - 1] + Math.hypot(e[i] - e[i - 1], n[i] - n[i - 1]);
  }

  const lanes = new Uint8Array(count);
  const total = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const limit = new Uint8Array(count);
  file.spans.forEach(([from, l, t, f, maxspeed], k) => {
    const to = file.spans[k + 1]?.[0] ?? count;

    for (let i = from; i < to; i++) {
      lanes[i] = l;
      total[i] = t;
      flags[i] = f;
      limit[i] = maxspeed;
    }
  });

  return { name, count, e, n, s, lanes, total, flags, limit };
});

const byName = new Map(carriageways.map((c) => [c.name, c]));
const length = (c) => c.s[c.count - 1];
const laneWidth = (c, i) => (c.limit[i] > 50 ? LANE : TOWN_LANE);

/** Across from the road's line to the kerb of this way's lanes, m (right's positive). */
const kerb = (c, i) => (-c.total[i] * laneWidth(c, i)) / 2;

/**
 * Where on carriageway `c` is nearest a point: how far along, how far to
 * the right of its line, how far off, its bearing there (degrees from
 * north), and the segment.
 */
function project(c, [e, n]) {
  let best = null;

  for (let i = 0; i < c.count - 1; i++) {
    const te = c.e[i + 1] - c.e[i];
    const tn = c.n[i + 1] - c.n[i];
    const l = Math.hypot(te, tn);

    if (l < 1e-6) continue;
    const de = e - c.e[i];
    const dn = n - c.n[i];
    const along = Math.min(Math.max((de * te + dn * tn) / l, 0), l);
    const off = Math.hypot(de - (te * along) / l, dn - (tn * along) / l);

    if (!best || off < best.off) {
      best = {
        s: c.s[i] + along,
        lateral: (de * tn - dn * te) / l,
        off,
        bearing: ((Math.atan2(te, tn) * 180) / Math.PI + 360) % 360,
        i,
      };
    }
  }

  return best;
}

/** The point `s` along carriageway `c`, `lateral` to the right of its line. */
function pointAt(c, s, lateral) {
  let i = 0;

  while (i < c.count - 2 && c.s[i + 1] <= s) i++;
  const span = c.s[i + 1] - c.s[i] || 1;
  const t = Math.min(Math.max((s - c.s[i]) / span, 0), 1);
  const te = (c.e[i + 1] - c.e[i]) / span;
  const tn = (c.n[i + 1] - c.n[i]) / span;

  return [
    round(c.e[i] + (c.e[i + 1] - c.e[i]) * t + tn * lateral),
    round(c.n[i] + (c.n[i + 1] - c.n[i]) * t - te * lateral),
  ];
}

const turn = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const [osm, nzta] = await Promise.all([loadOsm(), loadNzta()]);

const structures = [];
const evidence = {};
const omitted = [];

// --- Gantries: OSM's, where they stand over a carriageway. ---

/**
 * Each with its ends, and for each carriageway it reaches over: where along,
 * and from how far to how far across.
 */
/**
 * The carriageways a beam from end to end reaches over: for each, where
 * along, from how far to how far across, its lanes' edges, and each end
 * projected onto it.
 */
const overOf = (ends) =>
  carriageways.flatMap((c) => {
    const [a, b] = ends.map((end) => project(c, end));
    const i = a.i;
    const left = kerb(c, i);
    const right = left + c.lanes[i] * laneWidth(c, i);
    const from = Math.min(a.lateral, b.lateral);
    const to = Math.max(a.lateral, b.lateral);

    // Over at least a metre of its lanes, and square to it.
    if (Math.min(to, right) - Math.max(from, left) < 1) return [];

    if (Math.abs(a.s - b.s) > 15 || Math.max(a.off, b.off) > 60) return [];

    return [{ c, s: (a.s + b.s) / 2, i, from, to, left, right, a, b }];
  });

const gantries = osm.elements
  .filter((el) => el.type === "way" && el.tags?.man_made === "gantry")
  .map((el) => {
    const ends = [el.geometry[0], el.geometry.at(-1)].map((p) =>
      toNztm(p.lat, p.lon)
    );

    return { id: el.id, ends, over: overOf(ends), panels: [], notes: [] };
  });

/** How far a point is from a gantry's beam, m. */
function offBeam({ ends: [a, b] }, [e, n]) {
  const te = b[0] - a[0];
  const tn = b[1] - a[1];
  const l = Math.hypot(te, tn) || 1;

  const along = Math.min(
    Math.max(((e - a[0]) * te + (n - a[1]) * tn) / l, 0),
    l
  );

  return Math.hypot(e - a[0] - (te * along) / l, n - a[1] - (tn * along) / l);
}

/** How far along a gantry's beam (0 at its first end, 1 at its last) is `lateral` across a carriageway it's over. */
const alongBeam = (span, lateral) =>
  Math.min(
    Math.max(
      (lateral - span.a.lateral) / (span.b.lateral - span.a.lateral || 1),
      0.08
    ),
    0.92
  );

// --- Message signs: NZTA's, where they're on a carriageway. ---

/** Which way a sign's traffic runs, by NZTA's word for it. */
const NOMINAL = { Northbound: "N", Southbound: "S", Southwest: "S" };
const COMPASS = { Eastbound: 90, Westbound: 270 };

const messageSigns = [];

for (const sign of nzta.response.vms) {
  const at = toNztm(sign.latitude, sign.longitude);
  const what = `NZTA VMS ${sign.id} "${sign.name.trim()}" (${sign.direction})`;

  const near = carriageways
    .map((c) => ({ c, ...project(c, at) }))
    .filter(({ off }) => off < 60)
    .sort((a, b) => a.off - b.off);

  if (!near.length) {
    omitted.push({ what, why: "not on State Highway 1 or 2 as drawn" });
    continue;
  }

  const nominal = NOMINAL[sign.direction];
  const compass = COMPASS[sign.direction];

  const facing = near.filter(({ c, bearing }) =>
    nominal
      ? c.name.endsWith(nominal)
      : compass === undefined || turn(bearing, compass) < 90
  );

  const fits = facing.find(({ c, lateral, i }) => {
    const left = kerb(c, i);

    return (
      lateral > left - VERGE &&
      lateral < left + c.lanes[i] * laneWidth(c, i) + MEDIAN
    );
  });

  if (!fits) {
    omitted.push({
      what,
      why: facing.length
        ? `${Math.abs(facing[0].lateral).toFixed(0)} m ${facing[0].lateral < 0 ? "left" : "right"} of ${facing[0].c.name}'s line: on a ramp or street beside it, which isn't drawn`
        : "no carriageway runs its way there",
    });
    continue;
  }

  messageSigns.push({ sign, at, what, ...fits });
}

// One sign's old and new records sit at one place: the lately changed first.
messageSigns.sort(
  (a, b) =>
    a.c.name.localeCompare(b.c.name) ||
    a.s - b.s ||
    b.sign.lastMessageUpdate.localeCompare(a.sign.lastMessageUpdate)
);

const messageGroups = [];
const arms = [];

for (const found of messageSigns) {
  const group = messageGroups.find(
    (g) => g[0].c === found.c && Math.abs(g[0].s - found.s) < SAME_SIGN
  );

  if (group) group.push(found);
  else messageGroups.push([found]);
}

for (const group of messageGroups) {
  group.sort((a, b) =>
    b.sign.lastMessageUpdate.localeCompare(a.sign.lastMessageUpdate)
  );
  const [{ c, s, lateral, i, at }] = group;
  const ids = group.map(({ sign }) => sign.id);
  const left = kerb(c, i);
  const right = left + c.lanes[i] * laneWidth(c, i);
  const size = c.limit[i] >= BIG_FROM ? "large" : "small";
  const face = { kind: "vms", ids, size };

  const notes = group.map(
    ({ what, sign }) =>
      `${what} at ${sign.latitude}, ${sign.longitude}: ${c.name} ${s.toFixed(0)} m along, ${lateral.toFixed(1)} m right of its line`
  );

  const gantry = gantries.find(
    (g) => offBeam(g, at) < ON_GANTRY && g.over.some((span) => span.c === c)
  );

  if (gantry) {
    const span = gantry.over.find((over) => over.c === c);

    gantry.panels.push({
      on: c.name,
      s: round(span.s, 0),
      t: round(alongBeam(span, (span.left + span.right) / 2), 3),
      face,
    });
    gantry.notes.push(
      ...notes,
      `hung from OSM gantry way ${gantry.id}, ${offBeam(gantry, at).toFixed(0)} m from NZTA's position, over the middle of ${c.name}'s lanes`
    );
    continue;
  }

  const id = `vms-${ids[0]}`;

  if (lateral < left - 1) {
    // On the verge: a mast where NZTA says it is.
    const foot = at.map((v) => round(v));

    structures.push({
      id,
      kind: "post",
      on: c.name,
      s: round(s, 0),
      a: foot,
      b: foot,
      panels: [{ on: c.name, s: round(s, 0), t: 0, face }],
    });
    evidence[id] = [...notes, "a mast on the verge, at NZTA's position"];
  } else {
    arms.push({ id, c, s, i, left, right, lateral, at, face, notes });
  }
}

// Over the lanes, and no gantry mapped: two facing each other's traffic at
// one spot share a gantry across both carriageways; the rest are arms out
// from the kerb.
const paired = new Set();

for (const arm of arms) {
  if (paired.has(arm)) continue;

  const other = arms
    .filter(
      (o) =>
        !paired.has(o) &&
        o !== arm &&
        o.c.name.slice(0, -1) === arm.c.name.slice(0, -1) &&
        o.c.name !== arm.c.name &&
        Math.hypot(o.at[0] - arm.at[0], o.at[1] - arm.at[1]) < PAIRED
    )
    .sort(
      (a, b) =>
        Math.hypot(a.at[0] - arm.at[0], a.at[1] - arm.at[1]) -
        Math.hypot(b.at[0] - arm.at[0], b.at[1] - arm.at[1])
    )[0];

  if (other) {
    paired.add(arm).add(other);

    // Kerb to kerb: from outside this carriageway's lanes, square across to
    // outside the other's.
    const across = project(other.c, pointAt(arm.c, arm.s, 0));

    const ends = [
      pointAt(arm.c, arm.s, arm.left - MAST_OFF),
      pointAt(other.c, across.s, kerb(other.c, across.i) - MAST_OFF),
    ];

    const over = overOf(ends);
    const id = `gantry-${arm.id}-${other.id.replace(/^vms-/, "")}`;

    const panels = [arm, other].flatMap(({ c, face }) => {
      const span = over.find((o) => o.c === c);

      return span
        ? [
            {
              on: c.name,
              s: round(span.s, 0),
              t: round(alongBeam(span, (span.left + span.right) / 2), 3),
              face,
            },
          ]
        : [];
    });

    gantries.push({
      id,
      ends,
      over,
      panels,
      made: true,
      notes: [
        ...arm.notes,
        ...other.notes,
        `NZTA's signs face each other's traffic ${Math.hypot(other.at[0] - arm.at[0], other.at[1] - arm.at[1]).toFixed(0)} m apart over the lanes, and OSM has no gantry there: one gantry across both carriageways, kerb to kerb (the council's 3D model there spans both; where its legs stand is a guess)`,
      ],
    });
    continue;
  }

  const { id, c, s, left, right, lateral, face, notes } = arm;
  const reach = Math.min(Math.max(lateral, left + 1.5), right - 1.5);

  structures.push({
    id,
    kind: "cantilever",
    on: c.name,
    s: round(s, 0),
    a: pointAt(c, s, left - MAST_OFF),
    b: pointAt(c, s, reach),
    panels: [{ on: c.name, s: round(s, 0), t: 1, face }],
  });
  evidence[id] = [
    ...notes,
    "NZTA's position is over the lanes and OSM has no gantry there: drawn on an arm from the left kerb (the mounting's a guess)",
  ];
}

// --- Direction signs: where a road with OSM destinations leaves. ---

/**
 * Mappers' slips in OSM's destinations, put right: each is a place whose
 * name isn't in doubt. Noted in the evidence where one's applied.
 */
const SPELLINGS = {
  "Harbour Veiw": "Harbour View",
  "Hebden Crescenct": "Hebden Crescent",
  Paramata: "Paremata",
};

const split = (value) =>
  (value ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => SPELLINGS[part] ?? part);

const respelt = (way) =>
  Object.keys(SPELLINGS).some((slip) =>
    (way.tags.destination ?? "").includes(slip)
  )
    ? " (OSM's misspelling put right)"
    : "";

/** "SH 1" and "SH1" alike. */
const shields = (value) =>
  split(value).map((ref) => ref.replace(/\s+/g, "").toUpperCase());

const tagsOf = (way, prefix) =>
  Object.entries(way.tags)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

/** Each tagged way with where it starts, runs and ends by each carriageway. */
const tagged = osm.elements
  .filter(
    (el) =>
      el.type === "way" &&
      el.tags?.highway &&
      (el.tags.destination || el.tags["destination:lanes"])
  )
  .map((way) => {
    const line = way.geometry.map((p) => toNztm(p.lat, p.lon));

    const bearing =
      ((Math.atan2(line[1][0] - line[0][0], line[1][1] - line[0][1]) * 180) /
        Math.PI +
        360) %
      360;

    return { way, line, bearing };
  });

/** Ways along carriageway `c`, start to end on its line, and those leaving it. */
function waysOn(c) {
  const along = [];
  const leaving = [];

  for (const { way, line, bearing } of tagged) {
    const start = project(c, line[0]);

    if (start.off > ON_LINE || turn(bearing, start.bearing) > 60) continue;
    const middle = project(c, line[line.length >> 1]);
    const end = project(c, line.at(-1));

    if (end.off < 2 && middle.off < 2) {
      along.push({ way, from: start.s, to: end.s });
    } else if (end.off > LEFT) {
      // Which side it first leaves by: a ramp may curl back over or under.
      const first = line
        .map((point) => project(c, point))
        .find(({ off }) => off > LEFT);

      leaving.push({ way, s: start.s, i: start.i, side: first.lateral });
    }
  }

  along.sort((a, b) => a.from - b.from);
  leaving.sort((a, b) => a.s - b.s);

  return { along, leaving };
}

const claimed = new Set();
const directionPosts = [];

const TURNS = {
  slight_left: "left",
  left: "left",
  slight_right: "right",
  right: "right",
};

/**
 * The panels for lanes signed apart, left to right: lanes side by side
 * with one legend share a panel, and a lane signed for both its
 * neighbours' (an either-way lane) is counted with each instead of having
 * its own. Each with the lanes it's over, first to last.
 */
function lanePanels(way) {
  const perLane = way.tags["destination:lanes"].split("|").map(split);

  const refs = (way.tags["destination:ref:lanes"] ?? "")
    .split("|")
    .map(shields);

  const arrows = (
    way.tags["destination:arrow:lanes"] ??
    way.tags["turn:lanes"] ??
    ""
  )
    .split("|")
    .map((lane) => lane.split(";").filter(Boolean));

  const groups = [];

  perLane.forEach((lines, lane) => {
    const before = groups.at(-1);

    if (before && before.lines.join("|") === lines.join("|")) before.to = lane;
    else groups.push({ lines, from: lane, to: lane });
  });

  const either = (group, k) => {
    const [before, after] = [groups[k - 1], groups[k + 1]];

    return (
      before &&
      after &&
      group.from === group.to &&
      group.lines.join("|") === [...before.lines, ...after.lines].join("|")
    );
  };

  return groups.flatMap((group, k) => {
    if (!group.lines.length || either(group, k)) return [];
    // Half an either-way lane each side counts as this panel's.
    const from = group.from - (k > 1 && either(groups[k - 1], k - 1) ? 0.5 : 0);

    const to =
      group.to +
      1 +
      (k < groups.length - 2 && either(groups[k + 1], k + 1) ? 0.5 : 0);

    const turns = new Set(arrows.slice(group.from, group.to + 1).flat());

    const arrow =
      [...turns].map((turn) => TURNS[turn]).find(Boolean) ??
      (turns.size ? "ahead" : "down");

    return [
      {
        from,
        to,
        face: {
          kind: "direction",
          lines: group.lines,
          arrow,
          lanes: group.to - group.from + 1,
          ...(refs[group.from]?.length && { refs: refs[group.from] }),
        },
      },
    ];
  });
}

for (const c of carriageways) {
  const { along, leaving } = waysOn(c);

  // Lanes signed apart: panels over each, where a gantry stands in the stretch.
  const stretches = [];

  for (const a of along) {
    const lanes = a.way.tags["destination:lanes"];

    if (!lanes) continue;
    const before = stretches.at(-1);

    if (before && before.lanes === lanes && a.from - before.to < 20) {
      before.to = a.to;
    } else {
      stretches.push({ lanes, from: a.from, to: a.to, way: a.way });
    }
  }

  /** Where such a stretch that's on a gantry ends: the road leaving there is signed already. */
  const forks = [];

  for (const { way, from, to } of stretches) {
    const what = `OSM way ${way.id} along ${c.name} from ${from.toFixed(0)} m: ${tagsOf(way, "destination")}${way.tags["turn:lanes"] ? `, turn:lanes=${way.tags["turn:lanes"]}` : ""}`;

    // The last gantry along it: the nearest to where the lanes part.
    const gantry = gantries
      .filter((g) =>
        g.over.some(
          (span) => span.c === c && span.s > from - 30 && span.s < to + 30
        )
      )
      .sort((a, b) => spanOn(b, c).s - spanOn(a, c).s)
      .at(0);

    if (!gantry) {
      omitted.push({
        what,
        why: "lanes signed apart, but no gantry's mapped along them to hang the panels from",
      });
      continue;
    }

    const span = spanOn(gantry, c);
    const panels = lanePanels(way);
    const lanes = way.tags["destination:lanes"].split("|").length;
    const width = (span.right - span.left) / lanes;

    for (const panel of panels) {
      gantry.panels.push({
        on: c.name,
        s: round(span.s, 0),
        t: round(
          alongBeam(span, span.left + ((panel.from + panel.to) / 2) * width),
          3
        ),
        face: panel.face,
      });
    }

    gantry.notes.push(
      what,
      `put on OSM gantry way ${gantry.id}, ${span.s.toFixed(0)} m along ${c.name}, in the stretch so signed: that this gantry carries these is inferred`
    );
    forks.push(to);
  }

  // Roads leaving: a sign where each does.
  let last = null;

  for (const { way, s, i, side } of leaving) {
    const destinations = split(way.tags.destination);

    if (!destinations.length || claimed.has(way.id)) continue;

    if (s < 30 || s > length(c) - 30) continue;

    const legend = destinations.join("|");

    // A slip road in two pieces is one road.
    if (last && last.legend === legend && s - last.s < 150) continue;
    last = { legend, s };
    claimed.add(way.id);

    if (forks.some((fork) => Math.abs(fork - s) < 40)) continue;

    const face = {
      kind: "direction",
      lines: destinations,
      arrow: side < 0 ? "left" : "right",
      ...(way.tags["destination:street"] && {
        street: way.tags["destination:street"],
      }),
      ...(shields(way.tags["destination:ref"]).length && {
        refs: shields(way.tags["destination:ref"]),
      }),
      ...(way.tags["destination:symbol"] && {
        symbol: way.tags["destination:symbol"],
      }),
    };

    const note = `OSM way ${way.id} (${way.tags.highway}) leaves ${c.name} ${s.toFixed(0)} m along, to the ${face.arrow}: ${tagsOf(way, "destination")}${respelt(way)}`;

    // The carriageway going on, if it's signed too.
    const on = along.find(
      (a) => Math.abs(a.from - s) < 20 && split(a.way.tags.destination).length
    );

    const ahead = on && {
      kind: "direction",
      lines: split(on.way.tags.destination),
      arrow: "ahead",
      ...(shields(on.way.tags["destination:ref"]).length && {
        refs: shields(on.way.tags["destination:ref"]),
      }),
      ...(on.way.tags["destination:symbol"] && {
        symbol: on.way.tags["destination:symbol"],
      }),
    };

    const left = kerb(c, i);
    const right = left + c.lanes[i] * laneWidth(c, i);

    // A gantry just before it, or just after and clear of the lanes on its side.
    const gantry = gantries
      .filter((g) =>
        g.over.concat(reaches(g, c)).some((span) => {
          if (span.c !== c) return false;

          if (span.s <= s + 20) return s - span.s < GANTRY_BEFORE;

          return (
            span.s - s < GANTRY_AFTER &&
            (side < 0 ? span.to <= left + 1 : span.from >= right - 1)
          );
        })
      )
      .sort(
        (a, b) => Math.abs(spanOn(a, c).s - s) - Math.abs(spanOn(b, c).s - s)
      )
      .at(0);

    if (gantry) {
      const span = spanOn(gantry, c);
      const before = span.s <= s + 20;
      const over = gantry.over.includes(span);

      // Over the lanes before it: over the lane by that side's kerb. Else mid-beam.
      const across =
        before && over
          ? side < 0
            ? left + 1.75
            : right - 1.75
          : (span.from + span.to) / 2;

      gantry.panels.push({
        on: c.name,
        s: round(span.s, 0),
        t: round(alongBeam(span, across), 3),
        face,
      });
      gantry.notes.push(
        note,
        `put on OSM gantry way ${gantry.id}, ${Math.abs(span.s - s).toFixed(0)} m ${before ? "before" : "after"} where it leaves: that this gantry carries this sign is inferred`
      );

      // The way on, over the rest of the lanes, if the gantry reaches them.
      const rest = side < 0 ? right - 1.75 : left + 1.75;

      if (ahead && before && span.from < rest && span.to > rest) {
        gantry.panels.push({
          on: c.name,
          s: round(span.s, 0),
          t: round(alongBeam(span, rest), 3),
          face: ahead,
        });
        gantry.notes.push(
          `OSM way ${on.way.id} carries on along ${c.name}: ${tagsOf(on.way, "destination")}`
        );
      }

      continue;
    }

    directionPosts.push({ c, s, i, face, note });
  }
}

/** A gantry's span over carriageway `c`, or beside it. */
function spanOn(gantry, c) {
  return gantry.over.find((span) => span.c === c) ?? reaches(gantry, c)[0];
}

/**
 * A gantry that stands beside carriageway `c` without reaching over its
 * lanes (over a slip road leaving it): its span by `c`, if within 30 m.
 */
function reaches(gantry, c) {
  if (gantry.over.some((span) => span.c === c)) return [];
  const [a, b] = gantry.ends.map((end) => project(c, end));

  if (Math.max(a.off, b.off) > 30 || Math.abs(a.s - b.s) > 15) return [];
  const i = a.i;
  const left = kerb(c, i);

  return [
    {
      c,
      s: (a.s + b.s) / 2,
      from: Math.min(a.lateral, b.lateral),
      to: Math.max(a.lateral, b.lateral),
      left,
      right: left + c.lanes[i] * laneWidth(c, i),
      a,
      b,
    },
  ];
}

/**
 * Where a post `lateral` across from carriageway `c` can stand by `s`: there,
 * or, where the road bends too tightly for a foot that far across to be by
 * it (a roundabout), back along its approach to where it can, up to
 * POST_BACK. Its place, and the segment there (`i`, where it doesn't move).
 */
const POST_BACK = 100;

/** A post's foot is by its place if it projects back within this, m. */
const POST_BY = 1.5;

function postPlace(c, s, i0, lateral) {
  const segment = (at) => {
    let i = 0;

    while (i < c.count - 2 && c.s[i + 1] <= at) i++;

    return i;
  };

  for (let back = 0; back <= POST_BACK; back += 2) {
    const at = Math.max(s - back, 0);
    const i = back ? segment(at) : i0;
    const foot = pointAt(c, at, lateral(i));

    if (Math.abs(project(c, foot).s - at) < POST_BY) return { s: at, i, foot };
  }

  return { s, i: i0, foot: pointAt(c, s, lateral(i0)) };
}

for (const directionPost of directionPosts) {
  const { c, face } = directionPost;
  const id = `exit-${c.name}-${directionPost.s.toFixed(0)}`;

  const { s, foot } = postPlace(
    c,
    directionPost.s,
    directionPost.i,
    (i) => kerb(c, i) - DIRECTION_OFF
  );

  const note =
    s < directionPost.s - 0.5
      ? `${directionPost.note}; stood ${(directionPost.s - s).toFixed(0)} m back on the approach, the road bending too tightly where it leaves`
      : directionPost.note;

  structures.push({
    id,
    kind: "post",
    on: c.name,
    s: round(s, 0),
    a: foot,
    b: foot,
    panels: [{ on: c.name, s: round(s, 0), t: 0, face }],
  });
  evidence[id] = [
    note,
    "stood on the left verge where the road leaves: OSM records what the sign says, not where its board stands",
  ];
}

// --- Gantries with something to carry. ---

for (const gantry of gantries) {
  const what = gantry.made ? gantry.id : `OSM gantry way ${gantry.id}`;

  if (!gantry.panels.length) {
    omitted.push({
      what,
      why: gantry.over.length
        ? `over ${gantry.over.map(({ c, s }) => `${c.name} at ${s.toFixed(0)} m`).join(" and ")}, but nothing on record says what it carries`
        : "not over State Highway 1 or 2 as drawn",
    });
    continue;
  }

  // Whichever carriageway it's over most of, to stand it on; or the one it's beside.
  const [span] = gantry.over.length
    ? [...gantry.over].sort((a, b) => b.to - b.from - (a.to - a.from))
    : reaches(gantry, byName.get(gantry.panels[0].on));

  // Both ends clear of the lanes it's over: a post at each. Else an arm
  // from the end further from the road's line. One over no lanes of ours
  // (over a slip road) has two posts if it's long enough to need them.
  const spansAll = gantry.over.length
    ? gantry.over.every(
        ({ from, to, left, right }) => from < left + 0.5 && to > right - 0.5
      )
    : span.to - span.from > SELF_STANDING;

  const footFirst =
    spansAll || Math.abs(span.a.lateral) > Math.abs(span.b.lateral);

  const [a, b] = (footFirst ? gantry.ends : [...gantry.ends].reverse()).map(
    (end) => end.map((v) => round(v))
  );

  const id = gantry.made ? gantry.id : `gantry-${gantry.id}`;

  structures.push({
    id,
    kind: spansAll ? "gantry" : "cantilever",
    on: span.c.name,
    s: round(span.s, 0),
    a,
    b,
    panels: gantry.panels.map((panel) => ({
      ...panel,
      t: footFirst ? panel.t : round(1 - panel.t, 3),
    })),
  });
  evidence[id] = [
    ...(gantry.made ? [] : [`${what}, end to end`]),
    ...gantry.notes,
  ];
}

// --- Speed limit signs: where roads.json's limit changes. ---

/**
 * The speed limits in force at a point, from NZTA's National Speed Limit
 * Register (CC BY 4.0): each zone's limit, name and whether it's variable.
 */
async function registered([e, n]) {
  const key = `${e},${n}`;

  if (nslr.cache[key]) return nslr.cache[key];

  const response = await fetch(NSLR, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      geometry: key,
      geometryType: "esriGeometryPoint",
      inSR: "2193",
      spatialRel: "esriSpatialRelIntersects",
      distance: "4",
      units: "esriSRUnit_Meter",
      outFields:
        "speedLimitZoneId,speedCategoryName,speedLimitZoneValue,speedLimitZoneName,whenEffective,whenIneffective",
      returnGeometry: "false",
      f: "json",
    }),
  });

  if (!response.ok) throw new Error(`nslr: ${response.status}`);
  const body = await response.json();

  if (body.error) throw new Error(`nslr: ${body.error.message}`);
  nslr.cache[key] = body.features.map(({ attributes }) => attributes);
  nslr.fetched = true;

  return nslr.cache[key];
}

const nslr = {
  cache: await loadJson("--nslr", async () => ({})),
  fetched: false,
};

const now = Date.now();

for (const c of carriageways) {
  // Stretches of one limit, short ones folded into the stretch before.
  const runs = [];

  for (let i = 0; i < c.count - 1; i++) {
    const run = runs.at(-1);

    if (run && run.limit === c.limit[i]) run.to = i + 1;
    else runs.push({ limit: c.limit[i], from: i, to: i + 1 });
  }

  // A short stretch between two of the same limit is a blip in the
  // tagging (a few metres of a roundabout's limit): theirs.
  for (let k = 1; k < runs.length - 1;) {
    const [before, run, after] = [runs[k - 1], runs[k], runs[k + 1]];

    if (
      before.limit === after.limit &&
      c.s[run.to] - c.s[run.from] < LIMIT_RUN / 10
    ) {
      before.to = after.to;
      runs.splice(k, 2);
    } else {
      k++;
    }
  }

  const kept = [];

  for (const run of runs) {
    const before = kept.at(-1);

    if (before && before.limit === run.limit) before.to = run.to;
    else if (c.s[run.to] - c.s[run.from] >= LIMIT_RUN || !before)
      kept.push({ ...run });
    else before.to = run.to;
  }

  for (let k = 1; k < kept.length; k++) {
    const { limit, from } = kept[k];
    const what = `${c.name}: roads.json's limit (OSM maxspeed) goes ${kept[k - 1].limit} → ${limit} km/h ${c.s[from].toFixed(0)} m along`;

    if (c.flags[from] & TUNNEL) {
      omitted.push({ what, why: "in a tunnel" });
      continue;
    }

    // What the register has in force a little past it.
    const zones = (
      await registered(pointAt(c, c.s[from] + CHECK_PAST, 0))
    ).filter(
      (zone) =>
        zone.whenEffective <= now &&
        (zone.whenIneffective === null || zone.whenIneffective > now)
    );

    const zone = zones.find((z) => Number(z.speedLimitZoneValue) === limit);

    const named = (z) =>
      `${z.speedLimitZoneValue} km/h ${z.speedCategoryName.toLowerCase()} zone "${z.speedLimitZoneName}" (${z.speedLimitZoneId})`;

    if (zones.some((z) => z.speedCategoryName === "Variable")) {
      omitted.push({
        what,
        why: `the register has a variable limit there (${zones.map(named).join("; ")}): its signs are electronic, and no feed says what they show`,
      });
      continue;
    }

    if (zones.length && !zone) {
      omitted.push({
        what,
        why: `the register disagrees: ${zones.map(named).join("; ")}`,
      });
      continue;
    }

    const id = `speed-${c.name}-${c.s[from].toFixed(0)}`;
    const foot = pointAt(c, c.s[from], kerb(c, from) - SPEED_OFF);

    structures.push({
      id,
      kind: "post",
      on: c.name,
      s: round(c.s[from], 0),
      a: foot,
      b: foot,
      panels: [
        {
          on: c.name,
          s: round(c.s[from], 0),
          t: 0,
          face: { kind: "speed", limit },
        },
      ],
    });
    evidence[id] = [
      what,
      zone
        ? `the National Speed Limit Register agrees ${CHECK_PAST} m on: ${named(zone)}`
        : `the National Speed Limit Register has no zone in force ${CHECK_PAST} m on (it lags changes): OSM's word alone`,
      `stood on the left verge where the limit changes${c.flags[from] & TWO_WAY ? "" : " (the sign across the carriageway from it isn't drawn)"}`,
    ];
  }
}

// --- Lane signs: one over each lane, on the urban motorway's gantries. ---

let laneSigns = 0;

for (const structure of structures) {
  if (structure.kind !== "gantry") continue;

  for (const span of overOf([structure.a, structure.b])) {
    const { c, s, i, left, a, b } = span;
    const at = pointAt(c, s, 0);

    if (!LANE_SIGN_ROADS.includes(c.name) || at[1] > LANE_SIGNS_NORTH) continue;

    // Its lanes are signed for where they go already.
    if (
      structure.panels.some(
        ({ on, face }) => on === c.name && face.kind === "direction"
      )
    ) {
      continue;
    }

    const variable = (await registered(at)).find(
      (zone) =>
        zone.speedCategoryName === "Variable" &&
        zone.whenEffective <= now &&
        (zone.whenIneffective === null || zone.whenIneffective > now)
    );

    if (!variable) continue;
    const width = laneWidth(c, i);
    let count = 0;

    for (let lane = 0; lane < c.lanes[i]; lane++) {
      const lateral = left + (lane + 0.5) * width;
      const t = (lateral - a.lateral) / (b.lateral - a.lateral || 1);

      if (t <= 0.02 || t >= 0.98) continue;
      structure.panels.push({
        on: c.name,
        s: round(s, 0),
        t: round(t, 3),
        face: { kind: "lane", zone: laneZone(variable, at) },
      });
      count++;
    }

    if (!count) continue;
    laneSigns += count;
    evidence[structure.id].push(
      `${count} lane signs over ${c.name}'s lanes: in the register's variable limit (${variable.speedLimitZoneName}), on the motorway NZTA's lane control signs hang over (Terrace Tunnel to Ngauranga Gorge); no feed says what they show, so the scene estimates it from NZTA's speeds as the ${laneZone(variable, at)} runs`
    );
  }
}

if (nslr.fetched) {
  const save = process.argv.indexOf("--save-nslr");

  if (save > 0)
    await writeFile(process.argv[save + 1], JSON.stringify(nslr.cache));
}

structures.sort((a, b) => a.on.localeCompare(b.on) || a.s - b.s);

const json = JSON.stringify({ structures });

await writeFile(OUT, json);

await writeFile(
  EVIDENCE,
  `${JSON.stringify({ evidence, omitted }, null, 2)}\n`
);

const count = (kind) =>
  structures.reduce(
    (n, { panels }) =>
      n + panels.filter(({ face }) => face.kind === kind).length,
    0
  );

console.log(
  `${structures.length} structures (${structures.filter(({ kind }) => kind !== "post").length} gantries and arms): ` +
    `${count("vms")} message signs, ${count("direction")} direction panels, ${count("speed")} speed limits, ${laneSigns} lane signs; ` +
    `${omitted.length} left out; ${(json.length / 1024).toFixed(0)} KB`
);
