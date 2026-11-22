import type { DirectionFace, SpeedFace } from "./file";
import { layOutDirection, LETTER, type Slot } from "./layout";

// The fixed signs' faces, painted into one sheet with the canvas's 2D
// drawing. New Zealand's are white on green for directions, with a red
// shield for a state highway and a red ring round a speed limit; here
// they're black and white, like the rest of the scene (the user's call):
// white on black for directions, a white shield, a black ring. The
// lettering is the system's sans, not the signs' own face, which isn't to
// hand.

const WHITE = "#f4f6f4";
const BLACK = "#141414";

const FACE = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** A capital's height over the font's size, for those faces. */
const CAPITAL_OF_EM = 0.72;

/** Drawn this far past each slot, px, so the sheet's smaller copies don't bleed. */
export const GUTTER = 4;

type Context = CanvasRenderingContext2D;

/** An arrow pointing up, `size` tall, about its middle. */
function arrow(context: Context, size: number) {
  const head = size * 0.5;
  const shaft = size * 0.17;

  context.beginPath();
  context.moveTo(0, -size / 2);
  context.lineTo(head * 0.82, -size / 2 + head);
  context.lineTo(shaft / 2, -size / 2 + head * 0.78);
  context.lineTo(shaft / 2, size / 2);
  context.lineTo(-shaft / 2, size / 2);
  context.lineTo(-shaft / 2, -size / 2 + head * 0.78);
  context.lineTo(-head * 0.82, -size / 2 + head);
  context.closePath();
  context.fill();
}

const TURNED = {
  ahead: 0,
  left: -Math.PI / 4,
  right: Math.PI / 4,
  down: Math.PI,
};

/** A state highway's shield, its number in it. */
function shield(
  context: Context,
  x: number,
  y: number,
  width: number,
  height: number,
  number: string
) {
  const round = width * 0.16;

  context.fillStyle = WHITE;
  context.beginPath();
  context.moveTo(x + round, y);
  context.lineTo(x + width - round, y);
  context.quadraticCurveTo(x + width, y, x + width, y + round);
  context.lineTo(x + width, y + height * 0.5);
  context.quadraticCurveTo(
    x + width,
    y + height * 0.86,
    x + width / 2,
    y + height
  );
  context.quadraticCurveTo(x, y + height * 0.86, x, y + height * 0.5);
  context.lineTo(x, y + round);
  context.quadraticCurveTo(x, y, x + round, y);
  context.closePath();
  context.fill();

  context.fillStyle = BLACK;
  context.font = `700 ${height * 0.62}px ${FACE}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(number, x + width / 2, y + height * 0.44, width * 0.8);
}

/** A direction panel, filling `slot`. */
export function paintDirection(
  context: Context,
  face: DirectionFace,
  capital: number,
  slot: Slot
) {
  const layout = layOutDirection(face, capital);
  const k = slot.width / layout.width;
  const unit = capital * k;

  context.save();
  context.fillStyle = BLACK;
  context.fillRect(
    slot.x - GUTTER,
    slot.y - GUTTER,
    slot.width + GUTTER * 2,
    slot.height + GUTTER * 2
  );
  context.translate(slot.x, slot.y);

  context.strokeStyle = WHITE;
  context.lineWidth = unit * 0.16;
  context.beginPath();
  context.roundRect(
    unit * 0.22,
    unit * 0.22,
    slot.width - unit * 0.44,
    slot.height - unit * 0.44,
    unit * 0.5
  );
  context.stroke();

  context.fillStyle = WHITE;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";

  for (const line of layout.text) {
    context.font = `600 ${(line.capital * k) / CAPITAL_OF_EM}px ${FACE}`;
    context.fillText(
      line.text,
      line.x * k,
      line.y * k,
      line.text.length * LETTER * line.capital * k
    );
  }

  for (const s of layout.shields) {
    shield(context, s.x * k, s.y * k, s.width * k, s.height * k, s.number);
  }

  context.fillStyle = WHITE;

  for (const a of layout.arrows) {
    context.save();
    context.translate(a.x * k, a.y * k);
    context.rotate(TURNED[a.way]);
    arrow(context, a.size * k);
    context.restore();
  }

  context.restore();
}

/** A speed limit's disc, filling `slot`. */
export function paintSpeed(context: Context, face: SpeedFace, slot: Slot) {
  const across = slot.width;
  const [x, y] = [slot.x + across / 2, slot.y + across / 2];

  context.save();
  context.fillStyle = WHITE;
  context.fillRect(
    slot.x - GUTTER,
    slot.y - GUTTER,
    across + GUTTER * 2,
    across + GUTTER * 2
  );
  context.strokeStyle = BLACK;
  context.lineWidth = across * 0.105;
  context.beginPath();
  context.arc(x, y, across * (0.5 - 0.0525) - 1, 0, Math.PI * 2);
  context.stroke();

  const text = String(face.limit);

  context.fillStyle = BLACK;
  context.font = `700 ${across * (text.length > 2 ? 0.4 : 0.5)}px ${FACE}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, x, y + across * 0.025, across * 0.68);
  context.restore();
}
