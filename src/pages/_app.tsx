import "../components/layout.css";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import Head from "next/head";
import { useEffect } from "react";

const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700", "600"],
  style: ["normal", "italic"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  // 500 and 600 for the scene's controls.
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
});

export default function JoshBarrSite({ Component, pageProps }) {
  useEffect(() => {
    document.body.className = `theme-body theme--${
      pageProps.isDark ? "hero" : "light"
    }`;
  }, [pageProps]);

  return (
    <>
      {/* At scale 1 on a phone, rather than whatever iOS Safari picks. */}
      <Head>
        <meta
          key="viewport"
          name="viewport"
          content="width=device-width, initial-scale=1"
        />
      </Head>
      <style jsx global>{`
        :root {
          --font-mono: ${plexMono.style.fontFamily};
        }

        html {
          font-family: ${plex.style.fontFamily}, sans-serif;
        }

        .header,
        .font-secondary {
          font-family: ${plexMono.style.fontFamily}, sans-serif;
        }

        .font-secondary-italic {
          font-family: ${plexMono.style.fontFamily}, sans-serif;
          font-style: italic;
        }
      `}</style>
      <Component {...pageProps} />
    </>
  );
}
