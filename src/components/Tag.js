import React from 'react'
import { Link } from 'gatsby'
import kebabCase from 'lodash/kebabCase'

const Tag = ({ tag }) => (
  <Link
    className="theme-link theme-border-link pill"
    to={`/tags/${kebabCase(tag)}`}
  >
    {tag}
  </Link>
)

export default Tag
