import React from "react";

interface Run {
  text: string;
  className?: string;
  /** Can end a line after it. */
  breakAfter?: boolean;
}

/**
 * The heading, a sentence to a line: the name mustn't break at its hyphens,
 * and the slash is dimmed as in "Aotearoa/New Zealand" and can end a line.
 * The invitation is set apart.
 */
const SENTENCES: { runs: Run[]; className?: string }[] = [
  {
    runs: [
      { text: "Te Whanganui-a-Tara", className: "hero__name" },
      { text: "/", className: "dim", breakAfter: true },
      { text: "Wellington" },
    ],
  },
  {
    runs: [{ text: "Loading..." }],
    className: "hero__invitation",
  },
];

/** The homepage's heading, over the scene while it loads. */
export const Intro: React.FC<{
  /** Fades it out. */
  hidden: boolean;
}> = ({ hidden }) => (
  <div className={`hero__intro${hidden ? " hero__intro--hidden" : ""}`}>
    <div className="container grid">
      <h1 className="grid-span-12 grid-span-9@medium hero__title page-title theme-text">
        {SENTENCES.map(({ runs, className }, s) => (
          <span key={s} className={`hero__sentence  ${className ?? ""}`}>
            {runs.map(({ text, className, breakAfter }, r) => (
              <React.Fragment key={r}>
                <span className={className}>{text}</span>
                {breakAfter && <wbr />}
              </React.Fragment>
            ))}
          </span>
        ))}
      </h1>
    </div>
  </div>
);
