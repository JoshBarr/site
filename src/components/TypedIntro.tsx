import React, { useEffect, useRef } from "react";

interface Run {
  text: string;
  className?: string;
  /** Can end a line after it. */
  breakAfter?: boolean;
}

/**
 * The heading, a sentence to a line, in runs typed into their own elements:
 * the name mustn't break at its hyphens, and the slash is dimmed as in
 * "Aotearoa/New Zealand" and can end a line. The invitation is set apart.
 */
const SENTENCES: { runs: Run[]; className?: string }[] = [
  {
    runs: [
      // A no-break space keeps the dash off the start of a line.
      {
        text: "I'm Josh – a designer, software engineer and guitarist from ",
      },
      { text: "Te Whanganui-a-Tara", className: "hero__name" },
      { text: "/", className: "dim", breakAfter: true },
      { text: "Wellington." },
    ],
  },
  {
    runs: [{ text: " Take a look around my hometown." }],
    className: "hero__invitation",
  },
];

const TEXT = SENTENCES.flatMap(({ runs }) => runs)
  .map(({ text }) => text)
  .join("");

/** Before the first letter, and after the last before `onTyped`, ms. */
const START = 600;
const HOLD = 900;

/**
 * 0..1, the same for a letter every time, so the page and the server's
 * render of it agree.
 */
function jitter(i: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453;

  return x - Math.floor(x);
}

/** How long to wait after typing the `i`th letter, ms: a beat at punctuation. */
function pause(i: number) {
  const c = TEXT[i];

  if (c === ".") return 320;

  if (c === "," || c === "–") return 120;

  return 22 + jitter(i) * 25;
}

/** When each letter is typed, ms after the heading appears. */
const TYPED_AT: number[] = [];

for (let i = 0, at = START; i < TEXT.length; at += pause(i), i++) {
  TYPED_AT.push(Math.round(at));
}

/** Until `onTyped`, ms after the last letter's typed. */
const AFTER_LAST = pause(TEXT.length - 1) + HOLD;

/** From the heading appearing to `onTyped`, ms. */
const TYPING_TIME = TYPED_AT[TYPED_AT.length - 1] + AFTER_LAST;

const Caret = () => <span className="hero__caret" />;

/** The CSS custom properties that time a letter, and its caret. */
function timing(at: number, next: number | undefined) {
  // SAFETY: React's style type lists no custom properties, but passes
  // "--" names through to the element as they are.
  return {
    "--at": `${at}ms`,
    "--for": next === undefined ? undefined : `${next - at}ms`,
  } as React.CSSProperties;
}

/**
 * The sentences, every letter laid out from the start so lines don't rewrap
 * as they're typed. Each letter appears at its time, with a caret after it
 * until the next, by CSS animations: they run off the main thread, so the
 * scene starting up beneath can't make the typing stutter.
 */
function sentences(last: React.Ref<HTMLSpanElement>) {
  let i = 0;

  return SENTENCES.map(({ runs, className }, s) => (
    <span key={s} className={`hero__sentence ${className ?? ""}`} aria-hidden>
      {s === 0 && (
        <span className="hero__start" style={timing(0, TYPED_AT[0])}>
          <Caret />
        </span>
      )}
      {runs.map(({ text, className, breakAfter }, r) => (
        <React.Fragment key={r}>
          <span className={className}>
            {[...text].map((c) => {
              const n = i++;
              const isLast = n === TEXT.length - 1;

              return (
                <span
                  key={n}
                  ref={isLast ? last : undefined}
                  className={`hero__letter${isLast ? " hero__letter--last" : ""}`}
                  style={timing(TYPED_AT[n], TYPED_AT[n + 1])}
                >
                  {c}
                  <Caret />
                </span>
              );
            })}
          </span>
          {breakAfter && <wbr />}
        </React.Fragment>
      ))}
    </span>
  ));
}

/** When the typing started and when `onTyped` follows it, on performance.now()'s clock. */
export interface TypingTime {
  from: number;
  to: number;
}

/**
 * The homepage's heading, typed out over the scene while it loads.
 * `onTyped` and `onTyping` must be stable: a new one starts the wait over.
 */
export const TypedIntro: React.FC<{
  /** Fades it out. */
  hidden: boolean;
  /** Starts typed out, without typing or calling `onTyped`. */
  typed?: boolean;
  /** Called a beat after the last letter. */
  onTyped: () => void;
  /** Called once it's known when the typing started and will end. */
  onTyping?: (time: TypingTime) => void;
}> = ({ hidden, typed = false, onTyped, onTyping }) => {
  const last = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (typed) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const after = (ms: number) => {
      if (!cancelled) timer = setTimeout(onTyped, ms);
    };

    // The typing started with the heading's first paint, perhaps well
    // before this ran, so wait on the last letter's animation itself.
    const typing = last.current
      ?.getAnimations()
      .find(
        (a) => a instanceof CSSAnimation && a.animationName === "hero-type"
      );

    if (typing) {
      // Its start time is only set once it's begun, on the next frame.
      typing.ready.then(
        () => {
          const from = Number(typing.startTime);

          if (!cancelled && Number.isFinite(from)) {
            onTyping?.({ from, to: from + TYPING_TIME });
          }
        },
        () => {}
      );

      typing.finished.then(
        () => after(AFTER_LAST),
        () => after(AFTER_LAST)
      );
    } else {
      // Reduced motion: it's all there already.
      const now = performance.now();
      onTyping?.({ from: now, to: now + HOLD });
      after(HOLD);
    }

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typed, onTyped, onTyping]);

  return (
    <div className={`hero__intro${hidden ? " hero__intro--hidden" : ""}`}>
      <div className="container grid">
        <h1
          className={`grid-span-12 grid-span-9@medium hero__title font-display theme-text${typed ? " hero__title--typed" : ""}`}
          aria-label={TEXT}
        >
          {sentences(last)}
        </h1>
      </div>
    </div>
  );
};
