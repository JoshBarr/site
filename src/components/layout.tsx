import React, { FC, ReactElement } from "react";
import Header from "./header";
import { GridOverlay } from "./GridOverlay";

interface LayoutProps {
  children?: ReactElement | ReactElement[];
  theme?: string;
  /** Off for a page that's nothing but a full-screen scene. */
  footer?: boolean;
  /** Lays the header over the top of the page, e.g. a full-screen scene. */
  floatingHeader?: boolean;
}

const Layout: FC<LayoutProps> = ({
  children,
  theme = "theme--hero",
  footer = true,
  floatingHeader,
}) => (
  <>
    <Header theme={theme} siteTitle={"Josh Barr"} floating={floatingHeader} />
    <div className="children">
      <div className="theme-background">{children}</div>
      <GridOverlay />
    </div>
    {footer && (
      <div className="theme--footer">
        <footer className="footer theme-background theme-text">
          <div className="container container--secondary small font-secondary">
            <ul className="list-inline">
              <li>
                © {new Date().getFullYear()}, built with{" "}
                <a href="https://www.nextjs.org" className="theme-link">
                  Next.js
                </a>
              </li>
              <li>
                <a
                  className="theme-link"
                  href="https://github.com/JoshBarr/site"
                >
                  Source code on Github
                </a>
              </li>
            </ul>
          </div>
        </footer>
      </div>
    )}
  </>
);

export default Layout;
