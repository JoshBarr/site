import React from 'react'
import { Link } from 'gatsby'

import Layout from '../components/layout'
import SEO from '../components/seo'

const Bookmarks = ({
    data: {
      allBookmarksYaml: {
        edges,
        group
      }
    },
  }) => (
  <Layout theme="theme--light">
    <SEO title="Bookmarks" />
    <div className="container generic-page">
      <h1 className="section-top theme-text theme-display-weight space--large">Bookmarks</h1>
      <div className="measure space--medium">
        <p className="intro">
          Interesting reads I've encountered in my travels, about the art of building web applications and working with engineering teams.
        </p>
      </div>
      <div>
        {group.map(((group, index) => {
          return (
            <div className={`measure theme-border ${index > 0 ? 'keyline--top' : ''}`}>
              <h3>{group.fieldValue}</h3>
              <div className="">
                {group.edges.map(edge => (
                  <div>
                    <p>
                      <a href={edge.node.url}>{edge.node.title}</a><br /> 
                      {edge.node.description}
                    </p>   
                  </div>
                ))} 
              </div>     
            </div>
          );
        }))}
      </div>
    </div>
  </Layout>
);

export default Bookmarks;

export const pageQuery = graphql`
  query {
    site {
      siteMetadata {
        title
      }
    }
    allBookmarksYaml {
      edges {
        node {
          title
          description
          category
          url
          date
        }
      }
      group(field: category) {
        field
        fieldValue
        totalCount
        edges {
          node {
            title
            description
            category
            url
            date
          }
        }
      }
    }
  }
`
