import React from "react";
import Layout from "../components/layout";
import SEO from "../components/seo";
import { GetStaticProps } from "next";
import Link from "next/link";
import { getAllPosts, PostMetaWithFrontMatter } from "../lib/blog";
import PostMetadata from "../components/PostMetadata";

interface IndexPageProps {
  allPosts: PostMetaWithFrontMatter[];
}

const IndexPage: React.FC<IndexPageProps> = ({ allPosts }) => (
  <Layout theme="theme--hero">
    <SEO title="Home" thumbnail={undefined} />
    <div className="hero theme-text">
      <div className="container">
        <h1 className="hero__title section-top theme-display-weight ">
          Code. Pixels. Tunes.
        </h1>
        <p className="hero__subtitle font-display theme-display-weight">
          I'm a UX Engineer, designer, guitarist and live audio engineer, from
          Wellington, New Zealand. I help companies build scalable, secure web
          applications and beautiful user experiences.
        </p>
        <ul className="list-inline hero__social">
          <li>
            <a className="theme-link" href="https://twitter.com/joshbarrnz">
              Twitter
            </a>
          </li>
          <li>
            <a
              className="theme-link"
              href="https://www.linkedin.com/in/josh-barr-1291572a/"
            >
              LinkedIn
            </a>
          </li>
        </ul>
      </div>
      <div className="container">
        <div className="section">
          <h5 className="font-primary">Latest article</h5>
          {allPosts.map((post) => {
            return (
              <div key={post.slug} className="hero__post">
                <Link
                  className="theme-link-block font-display"
                  href={post.permalink}
                >
                  <h3 className="hero__post-title theme-link__brand">
                    {post.title}
                  </h3>
                  <p className="hero__post-body link-inert font-primary">
                    {post.blurb}
                  </p>
                </Link>
                <PostMetadata post={post} />
              </div>
            );
          })}
          <Link className="theme-link__brand" href="/articles">
            All articles
          </Link>
        </div>
      </div>
    </div>
  </Layout>
);

export const getStaticProps: GetStaticProps<IndexPageProps> = async () => {
  const allPosts = (await getAllPosts()).slice(0, 1);

  return {
    props: {
      isDark: true,
      allPosts,
    },
  };
};

export default IndexPage;
