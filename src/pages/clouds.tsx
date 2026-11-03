import React from "react";
import dynamic from "next/dynamic";
import SEO from "../components/seo";

// Development bench for the clouds.
const CloudsPreview = dynamic(
  async () =>
    (await import("../components/scene/clouds/CloudsPreview")).CloudsPreview,
  { ssr: false }
);

const CloudsPage: React.FC = () => (
  <div style={{ position: "fixed", inset: 0, background: "#141414" }}>
    <SEO title="Clouds" thumbnail={undefined} />
    <CloudsPreview />
  </div>
);

export default CloudsPage;
