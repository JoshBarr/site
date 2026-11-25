import { GANNET_MOST, gannetForm, isGannet } from "./gannet";
import {
  GOOSE_BEAT,
  GOOSE_MOST,
  GOOSE_SPAN,
  gooseForm,
  isGoose,
} from "./goose";
import {
  HERON_BEAT,
  HERON_MOST,
  HERON_SPAN,
  heronForm,
  isHeron,
} from "./heron";
import { isKaka, KAKA_BEAT, KAKA_MOST, KAKA_SPAN, kakaForm } from "./kaka";
import { isKereru, KERERU_MOST, kereruForm } from "./kereru";
import type { Form } from "./model";
import {
  isRockPigeon,
  ROCK_PIGEON_MOST,
  ROCK_PIGEON_SPAN,
  rockPigeonForm,
} from "./rockPigeon";
import { isTui, TUI_MOST, TUI_SPAN, tuiForm } from "./tui";

// The birds with shapes of their own: those nothing else here looks like.
// The rest (the gulls, the small dark birds of the gardens) are drawn as
// the one plain bird, in their kind's two greys.

/** A species drawn in a shape of its own. */
export interface Own {
  /** What its mesh is called in the scene. */
  name: string;
  /** Whether a flock of `species` (eBird's English name) is of it. */
  is: (species: string) => boolean;
  form: () => Form;
  /** Drawn at once at most: beyond these, they're drawn as other birds. */
  most: number;
  /** Its wingspan, m, and wingbeats a second, where not its kind's. */
  span?: number;
  beat?: number;
}

export const OWN: Own[] = [
  { name: "kererū", is: isKereru, form: kereruForm, most: KERERU_MOST },
  {
    name: "kākā",
    is: isKaka,
    form: kakaForm,
    most: KAKA_MOST,
    span: KAKA_SPAN,
    beat: KAKA_BEAT,
  },
  { name: "tūī", is: isTui, form: tuiForm, most: TUI_MOST, span: TUI_SPAN },
  {
    name: "geese",
    is: isGoose,
    form: gooseForm,
    most: GOOSE_MOST,
    span: GOOSE_SPAN,
    beat: GOOSE_BEAT,
  },
  { name: "tākapu", is: isGannet, form: gannetForm, most: GANNET_MOST },
  {
    name: "rock pigeons",
    is: isRockPigeon,
    form: rockPigeonForm,
    most: ROCK_PIGEON_MOST,
    span: ROCK_PIGEON_SPAN,
  },
  {
    name: "herons",
    is: isHeron,
    form: heronForm,
    most: HERON_MOST,
    span: HERON_SPAN,
    beat: HERON_BEAT,
  },
];

/** Which of them a flock of `species` is, by its place in OWN; or -1. */
export const ownOf = (species: string) =>
  OWN.findIndex((own) => own.is(species));
