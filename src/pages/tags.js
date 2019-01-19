import React from 'react'
import { Link } from 'gatsby'
import kebabCase from 'lodash/kebabCase'

import Layout from '../components/layout'
import SEO from '../components/seo'

const Tags = ({
  data: {
    allMarkdownRemark: { group },
  },
}) => (
  <Layout theme="theme--light">
    <SEO title="Tags" />
    <div className="container generic-page ">
      <h1 className="section-top theme-text theme-display-weight space--large">
        Articles by tag
      </h1>
      {/* <div className="article "> */}
      <ul className="list-inline font-primary">
        {group.map(tag => (
          <li>
            <Link
              key={tag.fieldValue}
              to={`/tags/${kebabCase(tag.fieldValue)}/`}
              className="shadow pill pill--large theme-link theme-border-link space"
            >
              {tag.fieldValue}{' '}
              <span className="counter theme-border-link theme-link__brand">
                {tag.totalCount}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {/* </div> */}
    </div>
  </Layout>
)

export default Tags

export const pageQuery = graphql`
  query {
    site {
      siteMetadata {
        title
      }
    }
    allMarkdownRemark(
      limit: 2000
      filter: { frontmatter: { published: { ne: false } } }
    ) {
      group(field: frontmatter___tags) {
        fieldValue
        totalCount
      }
    }
  }
`
