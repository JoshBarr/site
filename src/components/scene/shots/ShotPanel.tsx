import React, { useState } from "react";
import { currentView, goTo, SHOTS } from "./shots";

const GROUPS = [...new Set(SHOTS.map(({ group }) => group))];

const control: React.CSSProperties = {
  padding: "4px 8px",
  border: "1px solid rgba(255, 255, 255, 0.18)",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

/**
 * Pick a set view and the camera goes there, flying or cutting as the
 * follow panel's Cut says. Copy puts the view now on the clipboard as a
 * `?cam=` link, for sharing it or adding it to the list.
 */
export const ShotPanel: React.FC<{ style?: React.CSSProperties }> = ({
  style,
}) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const view = currentView();

    if (!view) return;
    const url = new URL(location.href);
    url.searchParams.delete("shot");
    url.searchParams.set("cam", view.map(Math.round).join(","));
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: 16,
        display: "flex",
        gap: 6,
        alignItems: "center",
        padding: "6px 8px",
        borderRadius: 6,
        background: "rgba(0, 0, 0, 0.55)",
        color: "#eee",
        font: "13px system-ui, sans-serif",
        userSelect: "none",
        ...style,
      }}
    >
      <select
        // Back to the prompt each time, so the same shot can be picked again.
        value=""
        onChange={(e) => {
          const shot = SHOTS.find(({ id }) => id === e.target.value);

          if (shot) goTo(shot);
        }}
        aria-label="Go to a view"
        // Dark menus, so the options are legible in the inherited colour.
        style={{ ...control, colorScheme: "dark" }}
      >
        <option value="" disabled>
          Go to…
        </option>
        {GROUPS.map((group) => (
          <optgroup key={group} label={group}>
            {SHOTS.filter((shot) => shot.group === group).map(
              ({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              )
            )}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        onClick={copy}
        title="Copy a link to this view"
        style={control}
      >
        {copied ? "Copied" : "Copy view"}
      </button>
    </div>
  );
};
