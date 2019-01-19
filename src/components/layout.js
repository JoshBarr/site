import React from 'react'
import PropTypes from 'prop-types'
import { StaticQuery, graphql } from 'gatsby'
import Helmet from 'react-helmet'

import Header from './header'
import './layout.css'

const Layout = ({ children, theme = 'theme--light' }) => (
  <StaticQuery
    query={graphql`
      query SiteTitleQuery {
        site {
          siteMetadata {
            title
          }
        }
      }
    `}
    render={data => (
      <>
        <link
          href="https://fonts.googleapis.com/css?family=Merriweather:300,400,400i,700|Lato:400,400i,700"
          rel="stylesheet"
        />
        <Helmet
          bodyAttributes={{
            class: `${theme} theme-body`,
          }}
        />
        <div>
          <div>
            <Header theme={theme} siteTitle={data.site.siteMetadata.title} />
          </div>
          <div className={`children`}>
            <div className="theme-background">{children}</div>
          </div>
          <div className="theme--footer">
            <footer className="footer theme-background theme-text">
              <div className="container container--secondary small">
                <ul className="list-inline">
                  <li>
                    © 2019, built with{' '}
                    <a href="https://www.gatsbyjs.org" className="theme-link">
                      Gatsby
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
    )}
  />
)

Layout.propTypes = {
  children: PropTypes.node.isRequired,
}

export default Layout
