import React, { useState } from "react";
import dynamic from "next/dynamic";
import SEO from "../components/seo";
import { SceneControls } from "../components/scene/controls/SceneControls";
import { TimeTravel } from "../components/scene/time/TimeTravel";

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
      <SceneControls clouds={clouds} onCloudsChange={setClouds} />
      <TimeTravel open={travelling} onOpenChange={setTravelling} />
    </div>
  );
};

export default ScenePage;
