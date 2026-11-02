import React from "react";
import dynamic from "next/dynamic";
import SEO from "../components/seo";

// Development bench for the scene's landmark assets.
const LandmarksPreview = dynamic(
  async () =>
    (await import("../components/scene/landmarks/LandmarksPreview"))
      .LandmarksPreview,
  { ssr: false }
);

const LandmarksPage: React.FC = () => (
  <div style={{ position: "fixed", inset: 0, background: "#141414" }}>
    <SEO title="Landmarks" thumbnail={undefined} />
    <LandmarksPreview />
  </div>
);

export default LandmarksPage;
