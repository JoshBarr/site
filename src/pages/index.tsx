import React, { useCallback, useEffect, useState } from "react";
import Layout from "../components/layout";
import SEO from "../components/seo";
import { TypedIntro } from "../components/TypedIntro";
import { GetStaticProps } from "next";
import dynamic from "next/dynamic";
import { SceneControls } from "../components/scene/controls/SceneControls";
import { CreditsSentence } from "../components/scene/credits";
import { useVisibleHeight } from "../components/scene/useVisibleHeight";

const WellingtonScene = dynamic(
  async () =>
    (await import("../components/scene/WellingtonScene")).WellingtonScene,
  { ssr: false }
);

const SCENE_CREDITS = <CreditsSentence linkClass="theme-link" />;

/**
 * Set once the scene's been shown. Back on the homepage its tiles are in the
 * browser's cache: they all revalidate before it settles, but the view is
 * there in a second or two, so it fades straight up without the intro.
 */
let shownBefore = false;

const IndexPage: React.FC = () => {
  const [skipIntro] = useState(() => shownBefore);
  const [loaded, setLoaded] = useState(false);
  const [typed, setTyped] = useState(false);
  const [returned, setReturned] = useState(false);
  const [clouds, setClouds] = useState(true);
  const height = useVisibleHeight();
  const onLoaded = useCallback(() => setLoaded(true), []);
  const onTyped = useCallback(() => setTyped(true), []);
  // The intro is typed out while the scene loads, then gives way to it.
  const revealed = returned || (loaded && typed);

  useEffect(() => {
    if (revealed) shownBefore = true;
  }, [revealed]);

  // A frame after it's mounted hidden, so the scene fades up over its tiles
  // arriving rather than popping in.
  useEffect(() => {
    if (!skipIntro) return;

    const id = requestAnimationFrame(() => setReturned(true));

    return () => cancelAnimationFrame(id);
  }, [skipIntro]);

  return (
    <Layout theme="theme--hero" credits={SCENE_CREDITS} floatingHeader>
      <SEO title="Home" thumbnail={undefined} />

      <div className="hero__scene" style={{ height }}>
        <WellingtonScene
          clouds={clouds}
          hidden={!revealed}
          onSettled={onLoaded}
        />
        <TypedIntro
          hidden={revealed || skipIntro}
          typed={skipIntro}
          onTyped={onTyped}
        />
        {/* Once the scene's shown, not over the intro. */}
        {revealed && (
          <SceneControls clouds={clouds} onCloudsChange={setClouds} />
        )}
      </div>
    </Layout>
  );
};

export const getStaticProps: GetStaticProps = async () => ({
  props: { isDark: true },
});

export default IndexPage;
