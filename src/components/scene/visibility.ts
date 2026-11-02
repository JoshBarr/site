import { useEffect, useState } from "react";

/** Whether the scene is scrolled into view, as last observed. */
let inView = true;

/**
 * True while someone could be looking: the tab is in front and the scene is
 * on screen. Live feeds skip their polls when it's false.
 */
export function sceneShown() {
  return !document.hidden && inView;
}

/** Watches whether `element` is on screen, for the frame loop and the polls. */
export function useInView(element: Element | null) {
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (!element) return;

    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      setShown(inView);
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
      inView = true;
    };
  }, [element]);

  return shown;
}
