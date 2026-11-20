import React, { useSyncExternalStore } from "react";
import { firstViewProgress, subscribeFirstViewProgress } from "./scene/loading";

interface Run {
  text: string;
  className?: string;
  /** Can end a line after it. */
  breakAfter?: boolean;
}

/**
 * The heading, a sentence to a line: the name mustn't break at its hyphens,
 * and the slash is dimmed as in "Aotearoa/New Zealand" and can end a line.
 * The invitation's set apart, with how much of the scene's first view has
 * loaded.
 */
const sentences = (percent: number): { runs: Run[]; className?: string }[] => [
  {
    runs: [
      { text: "Te Whanganui-a-Tara", className: "hero__name" },
      { text: "/", className: "dim", breakAfter: true },
      { text: "Wellington" },
    ],
  },
  {
    runs: [
      { text: " Loading " },
      { text: `${percent}%`, className: "hero__loading-count" },
    ],
    className: "hero__invitation",
  },
];

/** The homepage's heading, over the scene while it loads. */
export const Intro: React.FC<{
  /** Fades it out. */
  hidden: boolean;
}> = ({ hidden }) => {
  const progress = useSyncExternalStore(
    subscribeFirstViewProgress,
    firstViewProgress,
    () => 0
  );

  return (
    <div className={`hero__intro${hidden ? " hero__intro--hidden" : ""}`}>
      <div className="container grid">
        <h1 className="grid-span-12 grid-span-9@medium hero__title page-title theme-text">
          {sentences(Math.round(progress * 100)).map(
            ({ runs, className }, s) => (
              <span key={s} className={`hero__sentence  ${className ?? ""}`}>
                {runs.map(({ text, className, breakAfter }, r) => (
                  <React.Fragment key={r}>
                    <span className={className}>{text}</span>
                    {breakAfter && <wbr />}
                  </React.Fragment>
                ))}
              </span>
            )
          )}
        </h1>
      </div>
    </div>
  );
};
