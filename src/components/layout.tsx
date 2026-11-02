import React, { FC, ReactElement, ReactNode } from "react";
import Header from "./header";

interface LayoutProps {
  children?: ReactElement | ReactElement[];
  theme?: string;
  /** Data credits for the page, shown under the footer links. */
  credits?: ReactNode;
}

const Layout: FC<LayoutProps> = ({
  children,
  theme = "theme--hero",
  credits,
}) => (
  <>
    <Header theme={theme} siteTitle={"Josh Barr"} />
    <div className={`children`}>
      <div className="theme-background">{children}</div>
    </div>
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
              <a className="theme-link" href="https://github.com/JoshBarr/site">
                Source code on Github
              </a>
            </li>
          </ul>
          {credits && <p className="footer__credits dim">{credits}</p>}
        </div>
      </footer>
    </div>
  </>
);

export default Layout;
