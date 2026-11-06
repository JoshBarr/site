import React from "react";
import Layout from "../components/layout";
import SEO from "../components/seo";
import { GetStaticProps } from "next";
import Link from "next/link";
import { getAllPosts, PostMetaWithFrontMatter } from "../lib/blog";
import PostMetadata from "../components/PostMetadata";
import { LogoVital } from "../components/logo-vital";
import { LogoStedi } from "../components/logo-stedi";
import { LogoXero } from "../components/logo-xero";
import { LogoSpringload } from "../components/logo-springload";

interface AboutPageProps {
  allPosts: PostMetaWithFrontMatter[];
}

const AboutPage: React.FC<AboutPageProps> = ({ allPosts }) => (
  <Layout theme="theme--hero">
    <SEO title="About" thumbnail={undefined} />

    <div className="hero theme-text relative">
      <div className="container grid relative">
        <h1 className="grid-span-12 grid-span-9@medium  hero__title font-display">
          Kia ora, I'm Josh.
        </h1>
        <p className="grid-span-12 grid-span-7@medium hero__subtitle font-display font-weight-normal">
          It all started when I picked up a copy of Usborne's Build your own
          Website in the school library. It blew my eleven-year-old mind that
          you could build entire worlds with nothing more than notepad.exe. It
          set me on a path of combining my love of the creative arts with
          technology.
        </p>
        <p className="grid-span-12 grid-span-7@medium hero__subtitle font-display font-weight-normal">
          Over the years, I've worked as a designer, educator, software
          engineer, technical leader. I've built things for millions of users,
          and scaled systems to billions of requests/month. Whatever the role,
          it's always in service of making a great thing that people love to
          use.
        </p>
        <p className="grid-span-12 grid-span-7@medium hero__subtitle font-display font-weight-normal">
          Today, I work at{" "}
          <a className="theme-link" href="https://www.stedi.com">
            Stedi
          </a>
          , helping shape the future of healthcare. Outside of work, you'll find
          me making music and exploring beautiful natural environment of
          Aotearoa<span className="dim">/</span>New Zealand.
        </p>
        <ul className="list-inline hero__social grid-span-12">
          <li>
            <a
              className="theme-link"
              href="https://www.linkedin.com/in/josh-barr-1291572a/"
            >
              LinkedIn<span className="hero__arrow">⟶</span>
            </a>
          </li>
          <li>
            <a className="theme-link" href="https://twitter.com/joshbarrnz">
              X<span className="hero__arrow">⟶</span>
            </a>
          </li>
        </ul>
      </div>
    </div>

    <div>
      <div className="container">
        <div className="grid">
          <h2 className="grid-span-12 theme-text hero__title heading-1 font-display mb0">
            Play the hits!
          </h2>

          <div className="grid-span-12 hr"></div>

          <div className="grid-span-12 grid-span-3@medium theme-text">
            <LogoStedi />
            <p className="font-secondary tiny-caps mb0">2026 &ndash; Present</p>
            <p className="font-secondary tiny-caps">stedi.com</p>
          </div>
          <p className="grid-span-9 grid-span-6@medium theme-text font-weight-normal">
            Tech Lead, Accounts &amp; Identity Team.
          </p>

          <div className="grid-span-12 grid-span-3@medium theme-text"></div>
          <div className="grid-span-12 hr"></div>

          <div className="grid-span-12 grid-span-3@medium theme-text">
            <LogoVital />
            <p className="font-secondary tiny-caps mb0">2023 &ndash; 2026</p>
            <p className="font-secondary tiny-caps">vital.io</p>
          </div>
          <p className="grid-span-9 grid-span-6@medium theme-text font-weight-normal">
            Led a major rewrite of the entire application stack, that cut our
            platform cost-to-serve by 43% and laid the foundations to process
            upwards of 15% of all Emergency Room visits in the USA.
          </p>

          <div className="grid-span-12 grid-span-3@medium theme-text"></div>
          <div className="grid-span-12 hr"></div>

          <div className="grid-span-12 grid-span-3@medium theme-text">
            <LogoStedi />
            <p className="font-secondary tiny-caps mb0">2021 &ndash; 2023</p>
            <p className="font-secondary tiny-caps">stedi.com</p>
          </div>

          <div className="grid-span-9 grid-span-6@medium theme-text font-weight-normal">
            <p className="">
              Built an evergreen API docs platform, that aggregated API changes
              from our CI pipelines into our public docs site in seconds.
            </p>
            <p className="">
              Shipped Stedi's Authentication SDK, including collaborating with
              the AWS SDK team to ship fewer bytes over the wire for all users
              of the AWS JavaScript client.
            </p>
          </div>

          <div className="grid-span-12 grid-span-3@medium theme-text"></div>
          <div className="grid-span-12 hr"></div>

          <div className="grid-span-12 grid-span-3@medium theme-text">
            <LogoXero />

            <p className="font-secondary tiny-caps mb0">2016 &ndash; 2021</p>
            <p className="font-secondary tiny-caps">xero.com</p>
          </div>
          <div className="grid-span-9 grid-span-6@medium theme-text font-weight-normal">
            <p>
              Designed and delivered Xero's Public API Gateway, a mission
              critical system processing two billion requests a month.
            </p>
            <p>
              Led architecture for Ecosystem, one of Xero's seven business
              units. Set direction and standards for an 80+ person team, led the
              way on API-first for Xero's global engineering team.
            </p>
            <p>
              Drove the rollout of LaunchDarkly for 1000+ engineers, saving the
              organisation millions of dollars and greatly improving our feature
              management practices
            </p>
            <p>
              Launched "Sign in with Xero", our trusted SSO solution for third
              party authentication. Collaborated with Xero's Identity team,
              external security experts, and our own engineers to bring this
              headline feature to market.
            </p>
            <p>
              Led the creation of Xero's main navigation API, allowing us to
              achieve consistent navigation UX across 18 web applications, and
              serving up over 1000 requests per second, 24/7.
            </p>
          </div>

          <div className="grid-span-12 grid-span-3@medium theme-text"></div>
          <div className="grid-span-12 hr"></div>

          <div className="grid-span-12 grid-span-3@medium theme-text">
            <LogoSpringload />
            <p className="font-secondary tiny-caps mb0">2011 &ndash; 2016</p>
            <p className="font-secondary tiny-caps">springload.co.nz</p>
          </div>
          <div className="grid-span-9 grid-span-6@medium theme-text font-weight-normal">
            <p>
              Delivered the first ever in-browser OpenType Tester for Klim Type
              Foundry.
            </p>
            <p>
              Core contributor to the Wagtail CMS OpenSource project, used by{" "}
              <a
                className="theme-link"
                href="https://madewithwagtail.org/developers/nasa-jpl/nasa-jet-propulsion-laboratory/"
              >
                NASA JPL
              </a>{" "}
              and{" "}
              <a className="theme-link" href="https://madewithwagtail.org/">
                many others
              </a>
            </p>
            <p className="">
              Built tech stack for "On the Fence", a multi-award-winning tool to
              help young people discover who to vote for, contributing to
              30,000+ new voters.
            </p>
          </div>

          <div className="grid-span-12 grid-span-3@medium theme-text "></div>

          <div className="grid-span-12 mb4"></div>
        </div>
      </div>
    </div>

    <div className="bg-articles">
      <div className="container">
        <div className="section">
          <h5 className="font-secondary tiny-caps theme-text">
            Latest Thinking
          </h5>
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
          <Link className="theme-link tiny-caps" href="/blog" scroll={false}>
            All posts ⟶
          </Link>
        </div>
      </div>
    </div>
  </Layout>
);

export const getStaticProps: GetStaticProps<AboutPageProps> = async () => {
  const allPosts = (await getAllPosts()).slice(0, 1);

  return {
    props: {
      isDark: true,
      allPosts,
    },
  };
};

export default AboutPage;
