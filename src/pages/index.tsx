import React, { useCallback, useState } from "react";
import Layout from "../components/layout";
import SEO from "../components/seo";
import { TypedIntro } from "../components/TypedIntro";
import { GetStaticProps } from "next";
import dynamic from "next/dynamic";
import { SceneControls } from "../components/scene/controls/SceneControls";
import { TimeTravel } from "../components/scene/time/TimeTravel";

const WellingtonScene = dynamic(
  async () =>
    (await import("../components/scene/WellingtonScene")).WellingtonScene,
  { ssr: false }
);

const CC_BY = (
  <a className="theme-link" href="https://creativecommons.org/licenses/by/4.0/">
    CC BY 4.0
  </a>
);

const SCENE_CREDITS = (
  <>
    The Wellington scene is adapted from: elevation, tree canopy and building
    heights from Toitū Te Whenua Land Information New Zealand, {CC_BY}; 3D
    buildings © Wellington City Council and AAM Ltd, {CC_BY}; map data and
    building footprints ©{" "}
    <a className="theme-link" href="https://www.openstreetmap.org/copyright">
      OpenStreetMap contributors
    </a>
    . Weather from{" "}
    <a className="theme-link" href="https://www.metservice.com">
      MetService
    </a>
    , ship positions from{" "}
    <a className="theme-link" href="https://openwaters.io/ais/">
      Open Waters AIS
    </a>{" "}
    and{" "}
    <a className="theme-link" href="https://www.aishub.net">
      AISHub
    </a>
    , train and bus positions, bus routes and the cable car's timetable from{" "}
    <a className="theme-link" href="https://opendata.metlink.org.nz">
      Metlink
    </a>
    , traffic speeds and counts from{" "}
    <a
      className="theme-link"
      href="https://www.nzta.govt.nz/traffic-and-travel-information/use-our-data/"
    >
      NZTA
    </a>
    , and earthquakes and the tide from{" "}
    <a className="theme-link" href="https://www.geonet.org.nz">
      GeoNet
    </a>
    , {CC_BY}.
  </>
);

const IndexPage: React.FC = () => {
  const [loaded, setLoaded] = useState(false);
  const [typed, setTyped] = useState(false);
  const [clouds, setClouds] = useState(true);
  const [travelling, setTravelling] = useState(false);
  const onLoaded = useCallback(() => setLoaded(true), []);
  const onTyped = useCallback(() => setTyped(true), []);
  // The intro is typed out while the scene loads, then gives way to it.
  const revealed = loaded && typed;

  return (
    <Layout theme="theme--hero" credits={SCENE_CREDITS} floatingHeader>
      <SEO title="Home" thumbnail={undefined} />

      <div className="hero__scene">
        <WellingtonScene
          clouds={clouds}
          hidden={!revealed}
          onSettled={onLoaded}
        />
        <TypedIntro hidden={revealed} onTyped={onTyped} />
        {/* Once the scene's shown, not over the intro. */}
        {revealed && (
          <>
            <SceneControls
              clouds={clouds}
              onCloudsChange={setClouds}
              className="hero__controls"
            />
            <TimeTravel open={travelling} onOpenChange={setTravelling} />
          </>
        )}
      </div>
    </Layout>
  );
};

export const getStaticProps: GetStaticProps = async () => ({
  props: { isDark: true },
});

export default IndexPage;
