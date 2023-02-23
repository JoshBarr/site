import "../components/layout.css";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "@next/font/google";
import { useEffect } from "react";

const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  style: ["normal", "italic"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
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
      <style jsx global>{`
        html {
          font-family: ${plex.style.fontFamily}, sans-serif;
        }

        .header,
        .font-secondary {
          font-family: ${plexMono.style.fontFamily}, sans-serif;
        }
      `}</style>
      <Component {...pageProps} />
    </>
  );
}
