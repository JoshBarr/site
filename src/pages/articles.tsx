import React from "react";
import PostListing from "../components/PostListing";

import Layout from "../components/layout";
import SEO from "../components/seo";
import Link from "next/link";
import { GetStaticProps } from "next";
import { getAllPosts, PostMetaWithFrontMatter } from "../lib/blog";

interface BlogIndexProps {
  allPosts: PostMetaWithFrontMatter[];
}

const BlogIndex: React.FC<BlogIndexProps> = ({ allPosts }: BlogIndexProps) => (
  <Layout>
    <SEO title="Blog" thumbnail={undefined} />
    <div className="container generic-page">
      <h1 className="hero__title section-top space--large">Articles</h1>

      <div className="theme--light">
        {allPosts.map((post) => {
          return (
            <div key={post.slug}>
              <PostListing post={post} />
            </div>
          );
        })}
      </div>
    </div>
  </Layout>
);

export default BlogIndex;

export const getStaticProps: GetStaticProps<BlogIndexProps> = async () => {
  const allPosts = await getAllPosts();

  return {
    props: {
      allPosts,
    },
  };
};

// export const pageQuery = graphql`
//   query($skip: Int!, $limit: Int!) {
//     allMarkdownRemark(
//       sort: { order: DESC, fields: [frontmatter___date] }
//       skip: $skip
//       limit: $limit
//       filter: { frontmatter: { published: { ne: false } } }
//     ) {
//       edges {
//         node {
//           frontmatter {
//             path
//             date(formatString: "MMMM DD, YYYY")
//             title
//             blurb
//             tags
//             cover_image {
//               childImageSharp {
//                 fluid(maxWidth: 450) {
//                   ...GatsbyImageSharpFluid
//                 }
//               }
//             }
//           }
//         }
//       }
//     }
//   }
// `;
