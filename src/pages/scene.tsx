import React, { useState } from "react";
import dynamic from "next/dynamic";
import SEO from "../components/seo";
import { FollowPanel } from "../components/scene/follow/FollowPanel";
import { ShotPanel } from "../components/scene/shots/ShotPanel";
import {
  PANEL_HEIGHT,
  TAB_HEIGHT,
  TimeTravel,
} from "../components/scene/time/TimeTravel";

// Full-viewport development page for the homepage scene.
const WellingtonScene = dynamic(
  async () =>
    (await import("../components/scene/WellingtonScene")).WellingtonScene,
  { ssr: false }
);

const ScenePage: React.FC = () => {
  const [clouds, setClouds] = useState(true);
  const [travelling, setTravelling] = useState(false);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#141414" }}>
      <SEO title="Scene" thumbnail={undefined} />
      <WellingtonScene clouds={clouds} />
      <label
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          display: "flex",
          gap: 6,
          alignItems: "center",
          padding: "6px 10px",
          borderRadius: 6,
          background: "rgba(0, 0, 0, 0.55)",
          color: "#eee",
          font: "13px system-ui, sans-serif",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={clouds}
          onChange={(e) => setClouds(e.target.checked)}
        />
        Clouds
      </label>
      <FollowPanel
        style={{
          // Clear of the time-travel tab, and its drawer when it's open.
          bottom: TAB_HEIGHT + 12 + (travelling ? PANEL_HEIGHT : 0),
          transition: "bottom 380ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
      />
      <ShotPanel />
      <TimeTravel open={travelling} onOpenChange={setTravelling} />
    </div>
  );
};

export default ScenePage;
