import React, { useEffect, useSyncExternalStore } from "react";

/**
 * The type's grid laid over the page, for checking the rhythm: a rule every
 * line (and a fainter one every half line) from the top of the content, and
 * the twelve columns of `.container .grid`. ⌘' (Ctrl+' off a Mac) shows and
 * hides it; it stays as it was across pages for the rest of the visit.
 */

const KEY = "grid-overlay";

const listeners = new Set<() => void>();

let shown = read();

function read() {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function toggleGridOverlay() {
  shown = !shown;

  try {
    sessionStorage.setItem(KEY, shown ? "1" : "0");
  } catch {
    // Private windows and blocked storage just don't remember it.
  }

  listeners.forEach((listener) => listener());
}

/** ⌘' or Ctrl+', by key or, on layouts without it there, by position. */
function isToggle(e: KeyboardEvent) {
  return (e.metaKey || e.ctrlKey) && (e.key === "'" || e.code === "Quote");
}

export const GridOverlay: React.FC = () => {
  const visible = useSyncExternalStore(
    subscribe,
    () => shown,
    () => false
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isToggle(e) || e.repeat) return;

      e.preventDefault();
      toggleGridOverlay();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!visible) return null;

  return (
    <div className="grid-overlay" aria-hidden="true" data-testid="grid-overlay">
      <div className="container grid grid-overlay__columns">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="grid-overlay__column" />
        ))}
      </div>
    </div>
  );
};
