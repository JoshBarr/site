import React from "react";
import Link from "next/link";
import Image from "next/image";

interface HeaderProps {
  siteTitle: string;
  theme: string;
}

const Header = ({ siteTitle, theme }: HeaderProps) => (
  <div className={"header  theme-header theme-color"}>
    <div className="container container--secondary header__flex">
      <h2 className={"header__title"}>
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
            alt={siteTitle}
            width={"142"}
            height={"107"}
          />
          <span className="logo__wordmark">{siteTitle}</span>
        </Link>
      </h2>
      <nav className="header__nav">
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
