import "../components/layout.css";
import { Lato } from "@next/font/google";
import { useEffect } from "react";

const lato = Lato({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
});

export default function JoshBarrSite({ Component, pageProps }) {
  useEffect(() => {
    document.body.className = `theme-body theme--${
      pageProps.isDark ? "hero" : "light"
    }`;
  });

  return (
    <>
      <style jsx global>{`
        html {
          font-family: ${lato.style.fontFamily};
        }
      `}</style>
      <Component {...pageProps} />
    </>
  );
}
