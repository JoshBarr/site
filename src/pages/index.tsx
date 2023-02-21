import React from "react";
import Layout from "../components/layout";
import SEO from "../components/seo";
import { GetStaticProps } from "next";
import Link from "next/link";
import { getAllPosts, PostMetaWithFrontMatter } from "../lib/blog";
import PostMetadata from "../components/PostMetadata";
import { WorkItem, WorkItemType, IMG_HEIGHT } from "../components/WorkItem";
import { Endorsement, EndorsementType } from "../components/Endorsement";

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
          <Link className="theme-link tiny-caps" href="/articles">
            All articles ⟶
          </Link>
        </div>
      </div>
    </div>
  </Layout>
);

export const getStaticProps: GetStaticProps<IndexPageProps> = async () => {
  const allPosts = (await getAllPosts()).slice(0, 1);

  const allWork: WorkItemType[] = [
    {
      link: "",
      title: "Stedi Developer Docs",
      image: "/images/work/stedi-api-docs.png",
      imageAlt: "Stedi API documentation",
      summary:
        "Developer documentation & interactive API Reference for Stedi's API-first EDI product.",
      technologies: ["react", "next.js"],
      year: 2022,
    },
    {
      link: "",
      title: "Stedi Authentication SDK",
      image: "/images/work/sign-in.png",
      imageAlt: "stedi Auth",
      summary:
        "Authentication Client built on top of AWS Cognito and Zag.js finite state machines. Worked with AWS team to improve performance of AWS Amplify client library.",
      technologies: ["oauth", "cognito"],
      width: IMG_HEIGHT,
      year: 2023,
      isSquare: true,
    },
    {
      link: "",
      title: "Xero Platform Conceptual Model",
      image: "/images/work/xero-platform.png",
      imageAlt: "Xero Platform diagram",
      summary:
        "Designed a conceptual model for exploring platform transactions in Xero's Ecosystem. Visual distillation of platform business literature.",
      technologies: [],
      year: 2020,
    },
    {
      link: "",
      title: "Architecture Explorer",
      image: "/images/work/arch-explorer.png",
      imageAlt: "Architecture explorer",
      summary:
        "An interactive UI for exploring solution architecture in a large product team. Displays relationships as a directed graph, allows filtering by component type, department, logical domain.",
      technologies: ["react"],
      year: 2020,
    },
    {
      link: "",
      title: "Sign In With Xero",
      image: "/images/work/xero-consent.png",
      imageAlt:
        "An image of an OAuth2 informed consent screen, with user information visibile",
      summary:
        "Led the architecture for Xero's third-pary SSO product, sign-in with Xero. Includes management APIs for revoking grants, and user interfaces for customers and staff",
      technologies: ["oauth"],
      width: IMG_HEIGHT,
      year: 2019,
    },
    {
      link: "",
      title: "Xero Navigation",
      image: "/images/work/xero-nav.png",
      imageAlt: "Xero Navigation diagram",
      summary:
        "High-traffic API for presenting the navigation to Xero's users. Aggregates and caches data from a range of sources.",
      technologies: ["react", "next.js"],
      year: 2018,
    },
  ];

  const allEndorsements = [
    {
      body:
        "Josh is one of the most resourceful, kind and intelligent people I have ever worked with. He is incredible at optimization and I saw him be promoted for his work in this area (which included being a part of an initiative that saved his company north of a million dollars).",
      author: {
        name: "Phil Knezevich",
        role:
          "Manager, Strategic & Enterprise Customer Success Teams, Teleport",
      },
    },
  ];

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
