import React, { useState } from "react";
import dynamic from "next/dynamic";
import SEO from "../components/seo";
import { FollowPanel } from "../components/scene/follow/FollowPanel";

// Full-viewport development page for the homepage scene.
const WellingtonScene = dynamic(
  async () =>
    (await import("../components/scene/WellingtonScene")).WellingtonScene,
  { ssr: false }
);

const ScenePage: React.FC = () => {
  const [clouds, setClouds] = useState(true);

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
      <FollowPanel />
    </div>
  );
};

export default ScenePage;
