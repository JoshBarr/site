import React from 'react'
import { Link, graphql } from 'gatsby'
import PostListing from '../components/PostListing';

import Layout from '../components/layout'
import SEO from '../components/seo'

const BlogIndex = ({
  data,
  pathContext: {
    previousPagePath,
    nextPagePath
  }
}) => (
  <Layout>
    <SEO title="Blog" keywords={[`frontend development`, `architecture`, `react`]} />
    <div className="container generic-page">
      <h1 className="hero__title section-top space--large">Articles</h1>

      <div className="theme--light">
  
        {data.allMarkdownRemark.edges.map(({ node: post }) => {
          return (<div key={post.frontmatter.path}><PostListing post={post} /></div>)})}

        {previousPagePath && <Link to={previousPagePath}>Previous</Link>}
        {nextPagePath && <Link to={nextPagePath}>Next</Link>}
      </div>
    </div>
  </Layout>
  );
  
  export default BlogIndex;
  
  export const pageQuery = graphql`
  query ($skip: Int!, $limit: Int!) {
    allMarkdownRemark(
      sort: { order: DESC, fields: [frontmatter___date] }
      skip: $skip      
      limit: $limit
      filter: { frontmatter: { published: { ne: false } } }
    ) {
      edges {
        node {
          frontmatter {
            path
            date(formatString: "MMMM DD, YYYY")
            title
            blurb
            tags
            cover_image {
              childImageSharp{
                fluid(maxWidth: 450) {
                  ...GatsbyImageSharpFluid
                }
              }
            }
          }
        }
      }
    }
  }
`;
