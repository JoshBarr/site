import { Link } from 'gatsby'
import PropTypes from 'prop-types'
import React from 'react'
import logo from "../images/logo.svg"
import logoWhite from "../images/logo-white.svg"


const Header = ({ siteTitle, theme }) => (
  <div className={"header theme-color"}>
    <div className="container container--secondary header__flex">
      <h2 className={"header__title"}>
        <Link
          to="/"
          className="header__link theme-link-secondary"
          style={{
            textDecoration: `none`,
          }}
        >
          <img className="logo" src={logoWhite} alt={siteTitle} />
          <span className="logo__wordmark">{siteTitle}</span>
        </Link>
      </h2>
      <nav className="header__nav">
        {/* <Link className="theme-link" to="/services">Services</Link> */}
        {/* <Link className="theme-link" to="/work">Work</Link> */}
        <Link className="theme-link-selectable theme-link-secondary" to="/articles">Articles</Link>
        <Link className="theme-link-selectable theme-link-secondary" to="/contact">Contact</Link>
      </nav>
      
    </div>
  </div>
)

Header.propTypes = {
  siteTitle: PropTypes.string,
}

Header.defaultProps = {
  siteTitle: ``,
}

export default Header
