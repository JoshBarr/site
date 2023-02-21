import React from "react";
import Link from "next/link";
import Image from "next/image";

type Theme = "theme--light" | "theme--dark" | string;

interface HeaderProps {
  siteTitle: string;
  theme: Theme;
}

const Header = ({ siteTitle, theme }: HeaderProps) => (
  <div className={"header  theme-header theme-color"}>
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
            src={
              theme === "theme--light"
                ? "/images/logo.svg"
                : "/images/logo-white.svg"
            }
            alt={siteTitle}
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
);

export default Header;
