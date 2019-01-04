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
    <div className="container">
      <h1 className="h0 section-top space--large">All blog posts</h1>

      <div className="article theme--light">
  
        {data.allMarkdownRemark.edges.map(({ node: post }) => {
          return (<PostListing post={post} />)})}

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
