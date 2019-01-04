import React from "react"
import SEO from '../components/seo'
import Layout from '../components/layout'
import { Link, graphql } from "gatsby"
import PostListing from '../components/PostListing'


export default function Template({
  pageContext,
  data, // this prop will be injected by the GraphQL query we'll write in a bit
}) {
  const { tag } = pageContext
  const { edges, totalCount } = data.allMarkdownRemark
  const tagHeader = `${totalCount} post${
    totalCount === 1 ? "" : "s"
  } tagged with "${tag}"`

  return (
    <Layout>
      <SEO title={tag}></SEO>
      <div className="container generic-page">
        <div className="article section-top">
          <h1>{tag}</h1>

          <ul className="list-inline space--large">
            <li>
              {tagHeader}
            </li>
            <li>
              <Link to="/tags">See all tags</Link>
            </li>
          </ul>
          {edges.map(({ node }) => {
            const { path, title } = node.frontmatter
            return (
              <PostListing key={path} post={node} />
            )
          })}
        </div>
      </div>
    </Layout>
  )
};

export const pageQuery = graphql`
  query($tag: String) {
    allMarkdownRemark(
      limit: 2000
      sort: { fields: [frontmatter___date], order: DESC }
      filter: { frontmatter: { tags: { in: [$tag] } } }
    ) {
      totalCount
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
