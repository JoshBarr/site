import React from 'react'
import { Link, graphql } from 'gatsby'

// import kebabCase from "lodash/kebabCase"

import Layout from '../components/layout'
import SEO from '../components/seo'
import PostMetadata from '../components/PostMetadata';



const IndexPage = ({ data }) => (
  <Layout theme="theme--hero">
    <SEO title="Home" keywords={[`frontend development`, `architecture`, `react`]} />
    <div className="hero theme-text">
      <div className="container">
        <h1 className="hero__title section-top theme-display-weight ">
          Code. Pixels. Tunes.
        </h1>
        <p className="hero__subtitle font-display theme-display-weight">
          I'm a software architect, designer, guitarist and sound engineer,
          from Wellington, New Zealand. I help companies build scalable, secure web applications 
          and beautiful user experiences.
        </p>
        <ul className="list-inline hero__social">
          <li>
            <a className="theme-link" href="https://twitter.com/joshbarrnz">Twitter</a>
          </li>
          <li>
            <a className="theme-link" href="https://www.linkedin.com/in/josh-barr-1291572a/">LinkedIn</a>
          </li>
          {/* <li>
            <Link className="theme-link" to="/resume/">
              Resumé
            </Link>
          </li> */}
        </ul>
      </div>
      <div className="container">
        <div className="section">
          <h4 className="font-primary">Latest article</h4>
          {data.allMarkdownRemark.edges.map(({ node: post }) => {
            return (
              <div key={post.frontmatter.path} className="hero__post">
                <Link className="theme-link-block font-display" to={post.frontmatter.path}>
                  <h3 className="hero__post-title theme-link__brand">
                    {post.frontmatter.title}
                  </h3>
                  <p className="hero__post-body link-inert font-primary">
                    {post.frontmatter.blurb}
                  </p>
                  
                </Link>
                <PostMetadata post={post} />
              </div>
           )
          })}
          <Link className="theme-link__brand" to='/articles'>All articles</Link>
        </div>
      </div> 
    </div>
  </Layout>
)

export const pageQuery = graphql`
{
  allMarkdownRemark(
    sort: { order: DESC, fields: [frontmatter___date] }
    limit: 1
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
}`;


export default IndexPage
