import React from "react"
import { graphql, Link } from "gatsby"

import SEO from '../components/seo'
import Layout from '../components/layout'
import PostMetadata from '../components/PostMetadata'
import Author from '../components/Author'
import Tag from '../components/Tag'



export default function Template({
  data, // this prop will be injected by the GraphQL query we'll write in a bit
}) {
  const { markdownRemark: post } = data // data.markdownRemark holds our post data
  console.log(data);
  return (
    <Layout>
      <SEO title={`${post.frontmatter.title}`} />
      <div className="container">
        <div className="section-top">
          <h1 className="">{post.frontmatter.title}</h1>
        </div>

        <div className="split section-small">
          <div className="sidebar">
            <Author author={post.frontmatter.authors[0]} date={post.frontmatter.date} />
            <h6 className="keyline--top theme-border space--tight">Post tags:</h6>
            <ul className={`small font-primary list-unstyled`}>
            {post.frontmatter.tags.map((tag => (
              <li>
                <Tag tag={tag} />
              </li>
            )))}
            </ul>
          </div>
          <div className="article theme--light">
            <p className="intro">{post.frontmatter.blurb}</p>
            {/* <Img fluid={post.frontmatter.cover_image.childImageSharp.fluid}></Img> */}
            <div
              className="blog-post-content"
              dangerouslySetInnerHTML={{ __html: post.html }}
            />
          </div>
        </div>
        
      </div>
    </Layout>
  )
}

export const pageQuery = graphql`
  query BlogPostByPath($path: String!) {
    markdownRemark(frontmatter: { path: { eq: $path } }) {
      html
      frontmatter {
        date(formatString: "MMMM DD, YYYY")
        path
        title
        blurb
        tags
        cover_image {
          childImageSharp{
            fluid(maxWidth: 880) {
              ...GatsbyImageSharpFluid
            }
          }
        }
        authors {
          id
          name
          image {
            childImageSharp {
              fixed(width: 40, height: 40) {
                ...GatsbyImageSharpFixed
              }
            }
          }
        }
      }
    }
  }`;
