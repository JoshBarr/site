import React from 'react'
import PropTypes from 'prop-types'
import { StaticQuery, graphql } from 'gatsby'

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
        <link href="https://fonts.googleapis.com/css?family=Fira+Sans:300,400,600|Merriweather:300,400,400i,700,700i|Playfair+Display:400" rel="stylesheet" />
        
        <div className={theme}>
          <Header theme={theme} siteTitle={data.site.siteMetadata.title} />
        </div>
        <div className={`children ${theme}`}>
          <div className="theme-background">
            {children}
          </div>
        </div>
        <footer className="footer">
          <div className="container">
            <p className="footer__p">
              © 2019, Built with <a href="https://www.gatsbyjs.org" className="theme-link">Gatsby</a>
            </p>
          </div>
        </footer>
      </>
    )}
  />
)

Layout.propTypes = {
  children: PropTypes.node.isRequired,
}

export default Layout
