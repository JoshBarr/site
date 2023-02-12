import React, { FC, ReactElement } from "react";
import Header from "./header";

interface LayoutProps {
  children?: ReactElement | ReactElement[];
  theme?: string;
}

const Layout: FC<LayoutProps> = ({ children, theme = "theme--light" }) => (
  <>
    <div>
      <div>
        <Header theme={theme} siteTitle={"Josh Barr"} />
      </div>
      <div className={`children`}>
        <div className="theme-background">{children}</div>
      </div>
      <div className="theme--footer">
        <footer className="footer theme-background theme-text">
          <div className="container container--secondary small">
            <ul className="list-inline">
              <li>
                © 2023, built with{" "}
                <a href="https://www.nextjs.org" className="theme-link">
                  Next.js
                </a>
              </li>
              <li>
                <a
                  className="theme-link"
                  href="https://github.com/joshbarr/joshbarr.github.io"
                >
                  Source code on Github
                </a>
              </li>
            </ul>
          </div>
        </footer>
      </div>
    </div>
  </>
);

export default Layout;
