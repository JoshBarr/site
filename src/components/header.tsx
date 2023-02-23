import React, { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSpring, animated, config } from "@react-spring/web";

type Theme = "theme--light" | "theme--dark" | string;

interface HeaderProps {
  siteTitle: string;
  theme: Theme;
}

const ScrollToTop = () => {
  const [isOpen, setOpen] = useState(false);

  const [buttonProps] = useSpring(
    {
      transform: isOpen ? "translateY(0px)" : "translateY(-100px)",
    },
    [isOpen]
  );

  useEffect(() => {
    const handleScroll: IntersectionObserverCallback = (e) => {
      const target = e.at(0);
      if (!target) {
        return;
      }

      if (target.isIntersecting) {
        setOpen(false);
      } else {
        setOpen(true);
      }
    };

    let target = document.querySelector(".header");

    let observer = new IntersectionObserver(handleScroll, {
      root: null,
      rootMargin: "40px",
      threshold: 1.0,
    });

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <>
      <animated.div
        className="logo-container tiny-caps  theme-text"
        style={{
          ...buttonProps,
        }}
      >
        <a
          href="#"
          className="theme-text header__link jump-to-top"
          style={{ textAlign: "center" }}
        >
          <div
            style={{
              transform: "rotate(-90deg) translateY(-4px)",
              fontSize: "14px",
            }}
          >
            ⟶
          </div>
          Top
        </a>
      </animated.div>
    </>
  );
};

const Header = ({ siteTitle, theme }: HeaderProps) => (
  <>
    <div className={"header  theme-header theme-color relative z-1"}>
      <div className="container container--secondary grid grid-odd align-center">
        <h2
          className={
            "header__title grid-span-1 grid-span-4@medium grid-span-6@large"
          }
        >
          <Link
            href="/"
            className="header__link theme-link-secondary"
            style={{
              textDecoration: `none`,
            }}
          >
            <Image
              className="logo"
              src={"/images/logo-white.svg"}
              alt={"Josh Barr"}
              width={"142"}
              height={"107"}
            />
            <span className="logo__wordmark">{siteTitle}</span>
          </Link>
        </h2>
        <nav className="header__nav grid-span-5 align-right grid-span-4@medium grid-span-6@large">
          {/* <Link className="theme-link" to="/services">Services</Link> */}
          {/* <Link className="theme-link" to="/work">Work</Link> */}
          <Link
            className="theme-link-selectable theme-link-secondary"
            href="/articles"
          >
            Articles
          </Link>
          <Link
            className="theme-link-selectable theme-link-secondary"
            href="/bookmarks"
          >
            Bookmarks
          </Link>
          <Link
            className="theme-link-selectable theme-link-secondary"
            href="/contact"
          >
            Contact
          </Link>
        </nav>
      </div>
    </div>
    <ScrollToTop />
  </>
);

export default Header;
