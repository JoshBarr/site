import React, { useState } from "react";
import dynamic from "next/dynamic";
import SEO from "../components/seo";
import { SceneControls } from "../components/scene/controls/SceneControls";

// Full-viewport development page for the homepage scene.
const WellingtonScene = dynamic(
  async () =>
    (await import("../components/scene/WellingtonScene")).WellingtonScene,
  { ssr: false }
);

const ScenePage: React.FC = () => {
  const [clouds, setClouds] = useState(true);
  const [wind, setWind] = useState(false);

  return (
    // The large viewport, running on under iOS Safari's toolbar; the controls
    // keep to what's visible above it.
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "100lvh",
        overflow: "hidden",
        background: "#141414",
      }}
    >
      <SEO title="Scene" thumbnail={undefined} />
      <WellingtonScene clouds={clouds} wind={wind} />
      <SceneControls
        clouds={clouds}
        onCloudsChange={setClouds}
        wind={wind}
        onWindChange={setWind}
      />
    </div>
  );
};

export default ScenePage;
