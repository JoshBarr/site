// A before/after sheet from two runs of ./shoot.mjs: for each view the two
// shots side by side over where they differ, and the share of pixels that
// differ by more than 8 levels.
//
//   node scripts/shots/compare.mjs before after
//
// Writes .cache/shots/<before>-vs-<after>/: one PNG per view and index.html
// to page through them. Two runs of unchanged code still differ a little
// (the waves and the cloud's jitter never repeat), so the share is a guide
// for review, not a pass or fail.

import { readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

/** Levels (of 255) a pixel must change by to count. */
const THRESHOLD = 8;

/** How much the difference is brightened, to be seen. */
const GAIN = 4;

/** Each panel's width in the sheet, px. */
const PANEL = 960;

const [before, after] = process.argv.slice(2);

if (!before || !after) {
  console.error("usage: compare.mjs <before run> <after run>");
  process.exit(1);
}

const root = join(".cache", "shots");
const out = join(root, `${before}-vs-${after}`);

await mkdir(out, { recursive: true });

const raw = async (file) =>
  sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });

/** A strip of text over a panel, as an SVG. */
const label = (text, width) =>
  Buffer.from(
    `<svg width="${width}" height="28"><rect width="100%" height="100%" fill="#000"/>` +
      `<text x="8" y="19" font-family="Menlo, monospace" font-size="14" fill="#eee">${text}</text></svg>`
  );

const names = (await readdir(join(root, before)))
  .filter((file) => file.endsWith(".png"))
  .map((file) => file.slice(0, -4))
  .filter((name) => existsSync(join(root, after, `${name}.png`)))
  .sort();

const rows = [];

for (const name of names) {
  const a = await raw(join(root, before, `${name}.png`));
  const b = await raw(join(root, after, `${name}.png`));
  const { width, height, channels } = a.info;

  if (b.info.width !== width || b.info.height !== height) {
    console.warn(`${name}: sizes differ, skipped`);
    continue;
  }

  const diff = Buffer.alloc(width * height);
  let changed = 0;

  for (let i = 0, p = 0; p < diff.length; i += channels, p++) {
    let most = 0;

    for (let c = 0; c < 3; c++) {
      most = Math.max(most, Math.abs(a.data[i + c] - b.data[i + c]));
    }

    if (most > THRESHOLD) changed++;
    diff[p] = Math.min(255, most * GAIN);
  }

  const share = (changed / diff.length) * 100;
  const panelHeight = Math.round((height * PANEL) / width);

  const panel = (input, options) =>
    sharp(input, options).resize(PANEL, panelHeight).png().toBuffer();

  const panels = [
    await panel(join(root, before, `${name}.png`)),
    await panel(join(root, after, `${name}.png`)),
    await panel(diff, { raw: { width, height, channels: 1 } }),
  ];

  const captions = [
    before,
    after,
    `|Δ| > ${THRESHOLD}: ${share.toFixed(2)}%  (×${GAIN})`,
  ];

  await sharp({
    create: {
      width: PANEL * 3,
      height: panelHeight + 28,
      channels: 3,
      background: "#000",
    },
  })
    .composite(
      panels.flatMap((input, i) => [
        { input: label(captions[i], PANEL), left: PANEL * i, top: 0 },
        { input, left: PANEL * i, top: 28 },
      ])
    )
    .png()
    .toFile(join(out, `${name}.png`));

  rows.push({ name, share });
  console.log(`${share.toFixed(2).padStart(6)}%  ${name}`);
}

await writeFile(
  join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>${before} vs ${after}</title>
<style>body{background:#111;color:#ddd;font:14px Menlo,monospace;margin:16px}
img{width:100%;display:block;margin:4px 0 24px}</style>
<h1>${before} vs ${after}</h1>
${rows
  .map(
    ({ name, share }) =>
      `<h2>${name} — ${share.toFixed(2)}%</h2><img src="${name}.png" loading="lazy">`
  )
  .join("\n")}`
);

console.log(`\n${out}/index.html`);
