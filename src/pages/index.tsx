import React from "react";
import Layout from "../components/layout";
import SEO from "../components/seo";
import { GetStaticProps } from "next";
import Link from "next/link";
import { getAllPosts, PostMetaWithFrontMatter } from "../lib/blog";
import PostMetadata from "../components/PostMetadata";
import { WorkItem, WorkItemType, IMG_HEIGHT } from "../components/WorkItem";
import { Endorsement, EndorsementType } from "../components/Endorsement";
import dynamic from "next/dynamic";
import { allEndorsements, allWork } from "../lib/content";

const DynamicBackground = dynamic(
  async () => {
    const { Background } = await import("../components/Background");
    return Background;
  },
  {
    loading: () => <></>,
  }
);

interface IndexPageProps {
  allPosts: PostMetaWithFrontMatter[];
  allWork: WorkItemType[];
  allEndorsements: EndorsementType[];
}

const IndexPage: React.FC<IndexPageProps> = ({
  allPosts,
  allWork,
  allEndorsements,
}) => (
  <Layout theme="theme--hero">
    <SEO title="Home" thumbnail={undefined} />

    <DynamicBackground />

    <div className="hero theme-text relative">
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
              Twitter ⟶
            </a>
          </li>
          <li>
            <a
              className="theme-link"
              href="https://www.linkedin.com/in/josh-barr-1291572a/"
            >
              LinkedIn ⟶
            </a>
          </li>
        </ul>
      </div>

      <div className="container">
        <div className="section">
          <h5 className="font-secondary tiny-caps">Work</h5>
          <div className="grid grid-odd hero__grid">
            {allWork.slice(0, 4).map((work) => (
              <WorkItem key={work.title} work={work} />
            ))}
            {allEndorsements.slice(0, 1).map((endorsement) => (
              <div
                key={endorsement.author.name}
                className="section hero__endorsement"
              >
                <Endorsement endorsement={endorsement} />
              </div>
            ))}
            {allWork.slice(4).map((work) => (
              <WorkItem key={work.title} work={work} />
            ))}
          </div>
        </div>
      </div>

      <div className="container">
        <div className="section">
          <h5 className="font-secondary tiny-caps">Latest article</h5>
          {allPosts.map((post) => {
            return (
              <div key={post.slug} className="hero__post hero__post--article">
                <Link
                  className="theme-link-block font-display"
                  href={post.permalink}
                >
                  <h3 className="hero__post-title theme-link">{post.title}</h3>
                  <p className="hero__post-body theme-body-text link-inert font-primary">
                    {post.blurb}
                  </p>
                </Link>
                <PostMetadata post={post} />
              </div>
            );
          })}
          <Link
            className="theme-link tiny-caps"
            href="/articles"
            scroll={false}
          >
            All articles ⟶
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
      allWork,
      allEndorsements,
    },
  };
};

export default IndexPage;
