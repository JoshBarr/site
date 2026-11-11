// Shoots the scene from the fixed views in ./views.mjs, for before/after
// sheets (see ./compare.mjs).
//
//   node scripts/shots/shoot.mjs before
//   node scripts/shots/shoot.mjs after --params "tone=agx" --only overview
//
// Writes .cache/shots/<run>/<view>.png. Needs `next dev` on port 3100 (or
// --base) and Chrome installed: headless Chrome draws no WebGPU frames, so a
// real window is opened, off screen.
//
// The live layers' /api/* answers are recorded once from production
// (--record, or whenever one's missing) into .cache/shots/api/, and replayed
// from there after, so the vehicles are where they were last time.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { VIEWS } from "./views.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Where /api/* is recorded from. */
const LIVE = "https://www.joshbarr.com";

/** The page's size, CSS px. */
const WIDTH = 1280;
const HEIGHT = 800;

/**
 * After the first view's settled, nothing may load for this long, ms: the
 * layers mount one a frame, and the city's buildings wait for the first view.
 */
const QUIET = 3000;

/** Then the cloud's history and the trails, ms. */
const SETTLE = 4000;

/** Longest to wait for the first view, ms. */
const LOAD_TIMEOUT = 120_000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string", default: "http://localhost:3100" },
    params: { type: "string", default: "" },
    only: { type: "string" },
    record: { type: "boolean", default: false },
    scale: { type: "string", default: "1" },
  },
});

const run = positionals[0] ?? new Date().toISOString().replace(/[:.]/g, "-");
const root = join(".cache", "shots");
const out = join(root, run);
const api = join(root, "api");

await mkdir(out, { recursive: true });

await mkdir(api, { recursive: true });

const only = values.only?.split(",");

const views = only
  ? VIEWS.filter(({ name }) => only.some((part) => name.includes(part)))
  : VIEWS;

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: false,
  args: ["--enable-unsafe-webgpu", "--window-position=-2400,0"],
});

const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: Number(values.scale),
});

/** An /api/* answer from the recording, recorded first if it's missing. */
await context.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());

  const key = createHash("sha1")
    .update(url.pathname + url.search)
    .digest("hex");

  const file = join(api, `${key}.json`);

  if (values.record || !existsSync(file)) {
    try {
      const response = await fetch(LIVE + url.pathname + url.search);

      await writeFile(
        file,
        JSON.stringify({
          url: url.pathname + url.search,
          status: response.status,
          type: response.headers.get("content-type") ?? "application/json",
          body: await response.text(),
        })
      );
    } catch (e) {
      console.warn(`  ${url.pathname}: ${e.message}`);

      return route.fulfill({ status: 502, body: "" });
    }
  }

  const { status, type, body } = JSON.parse(await readFile(file, "utf8"));

  return route.fulfill({ status, contentType: type, body });
});

const extra = values.params ? `&${values.params}` : "";
const shot = [];

/** Waits until nothing's loaded for QUIET ms. */
const quiet = (page) =>
  page.waitForFunction(
    (quiet) => {
      const status = document.querySelector("[role=status][data-settled]");
      const now = performance.now();
      const state = (window.__shotQuiet ??= { since: now });

      if (!status || status.getAttribute("data-loads") !== "0") {
        state.since = now;
      }

      return now - state.since >= quiet;
    },
    QUIET,
    { timeout: LOAD_TIMEOUT, polling: 100 }
  );

// The first load in a browser compiles every shader and, the first time,
// records the API: shot, it would differ from the rest.
{
  const page = await context.newPage();

  await page.goto(`${values.base}/scene?${views[0].query}${extra}`);
  await quiet(page).catch(() => {});
  await page.close();
}

for (const { name, query } of views) {
  const page = await context.newPage();
  const url = `${values.base}/scene?${query}${extra}`;
  const started = Date.now();

  page.on("pageerror", (e) => console.warn(`  ${name}: ${e.message}`));

  page.on("console", (message) => {
    if (message.type() === "error") {
      console.warn(`  ${name}: ${message.text().slice(0, 300)}`);
    }
  });

  try {
    await page.goto(url);
    await quiet(page);
    await page.waitForTimeout(SETTLE);

    // Only the scene: the controls, and Next's dev badge, sit over it.
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas");

      for (const element of document.querySelectorAll("body *")) {
        if (!element.contains(canvas) && !canvas.contains(element)) {
          element.style.visibility = "hidden";
        }
      }
    });
    await page
      .locator("canvas")
      .first()
      .screenshot({
        path: join(out, `${name}.png`),
      });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`${name}  ${seconds} s`);
    shot.push({ name, url });
  } catch (e) {
    console.error(`${name}: ${e.message}`);
  }

  await page.close();
}

await writeFile(
  join(out, "run.json"),
  JSON.stringify({ when: new Date().toISOString(), extra, shot }, null, 2)
);

await browser.close();

console.log(`\n${shot.length} of ${views.length} in ${out}`);
