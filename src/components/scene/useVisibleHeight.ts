import { useEffect, useState } from "react";

/**
 * The scene controls' height: the small viewport, or what's visible on load
 * if that's less. iOS Safari can run 100svh on under its toolbar, and the
 * controls along the foot with it; `innerHeight` is the height between its
 * bars. Measured again only when the width changes (a turn), not as the
 * toolbar collapses on a scroll, which would move the controls.
 */
export const useVisibleHeight = (): string => {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    let width = window.innerWidth;

    setHeight(window.innerHeight);

    const onResize = () => {
      if (window.innerWidth === width) return;

      width = window.innerWidth;
      setHeight(window.innerHeight);
    };

    window.addEventListener("resize", onResize);

    return () => window.removeEventListener("resize", onResize);
  }, []);

  return height ? `min(100svh, ${height}px)` : "100svh";
};
