import React, { useEffect, useState } from "react";

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
        text: "I'm Josh\u00a0– a designer, software engineer and guitarist from ",
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

/** How long to wait after typing `c`, ms: a beat at punctuation. */
function pause(c: string) {
  if (c === ".") return 320;

  if (c === "," || c === "–") return 120;

  return 22 + Math.random() * 25;
}

const Caret = () => <span className="hero__caret" aria-hidden />;

/**
 * The sentences with the first `count` letters showing, and the caret after
 * them. The rest is laid out but invisible, so lines don't rewrap as it goes.
 */
function typedSentences(count: number) {
  let start = 0;

  return SENTENCES.map(({ runs, className }, s) => (
    <span key={s} className={`hero__sentence ${className ?? ""}`}>
      {runs.map(({ text, className, breakAfter }, i) => {
        const shown = Math.min(Math.max(count - start, 0), text.length);
        const end = start + text.length;
        const caret = count >= start && (count < end || end === TEXT.length);
        start = end;

        return (
          <React.Fragment key={i}>
            <span className={className}>
              {text.slice(0, shown)}
              {caret && <Caret />}
              {shown < text.length && (
                <span className="hero__untyped">{text.slice(shown)}</span>
              )}
            </span>
            {breakAfter && <wbr />}
          </React.Fragment>
        );
      })}
    </span>
  ));
}

/**
 * The homepage's heading, typed out over the scene while it loads.
 * `onTyped` must be stable: a new one starts the typing over.
 */
export const TypedIntro: React.FC<{
  /** Fades it out. */
  hidden: boolean;
  /** Called a beat after the last letter. */
  onTyped: () => void;
}> = ({ hidden, onTyped }) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const instant = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let typed = 0;
    let timer: ReturnType<typeof setTimeout>;

    const step = () => {
      if (typed >= TEXT.length) {
        timer = setTimeout(onTyped, HOLD);

        return;
      }

      typed = instant ? TEXT.length : typed + 1;
      setCount(typed);
      timer = setTimeout(step, pause(TEXT[typed - 1]));
    };

    timer = setTimeout(step, instant ? 0 : START);

    return () => clearTimeout(timer);
  }, [onTyped]);

  return (
    <div className={`hero__intro${hidden ? " hero__intro--hidden" : ""}`}>
      <div className="container grid">
        <h1 className="grid-span-12 grid-span-9@medium hero__title font-display theme-text">
          {typedSentences(count)}
        </h1>
      </div>
    </div>
  );
};
