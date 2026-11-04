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

  return (
    <div style={{ position: "fixed", inset: 0, background: "#141414" }}>
      <SEO title="Scene" thumbnail={undefined} />
      <WellingtonScene clouds={clouds} />
      <SceneControls clouds={clouds} onCloudsChange={setClouds} />
    </div>
  );
};

export default ScenePage;
