import React from "react";
import Balancer from "react-wrap-balancer";

import SEO from "../../components/seo";
import Layout from "../../components/layout";
import Author from "../../components/Author";
import Tag from "../../components/Tag";
import { GetStaticPaths, GetStaticProps } from "next";
import { FrontMatter, getPostBySlug, getPostSlugs } from "../../lib/blog";

import { MDXRemote, MDXRemoteSerializeResult } from "next-mdx-remote";
import { serialize } from "next-mdx-remote/serialize";

interface ArticleProps {
  frontMatter: FrontMatter;
  source: MDXRemoteSerializeResult;
}

const components = {};

export default function ArticlePage({ source, frontMatter }: ArticleProps) {
  return (
    <Layout>
      <SEO title={`${frontMatter.title}`} description={frontMatter.blurb} />
      <div className="container">
        <div className="section-top">
          <h1 className="">
            <Balancer>{frontMatter.title}</Balancer>
          </h1>
        </div>

        <div className="split section-small">
          <div className="sidebar">
            <Author
              author={{ name: "Josh Barr", image: "/images/josh.png" }}
              date={frontMatter.date}
            />
            <h6 className="keyline--top theme-border space--tight">
              Post tags:
            </h6>
            <ul className={`small font-primary list-unstyled`}>
              {frontMatter.tags.map((tag) => (
                <li key={tag}>
                  <Tag tag={tag} />
                </li>
              ))}
            </ul>
          </div>
          <div className="article theme--light">
            <p className="intro">{frontMatter.blurb}</p>
            <div className="blog-post-content">
              <MDXRemote {...source} components={components} />
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

export const getStaticProps: GetStaticProps<ArticleProps> = async (req) => {
  const slug = req.params.slug;

  console.log(req.params);

  const pageData = await getPostBySlug(slug);

  if (!pageData) {
    return {
      notFound: true,
      props: {},
    };
  }

  const { content, data } = pageData;

  const mdxSource = await serialize(content, {
    mdxOptions: {
      remarkPlugins: [],
      rehypePlugins: [],
    },
    scope: data,
  });

  return {
    props: {
      source: mdxSource,
      frontMatter: data,
    },
  };
};

export const getStaticPaths: GetStaticPaths = async () => {
  const filePaths = await getPostSlugs();
  const paths = filePaths.map((slug) => ({ params: { slug } }));

  return {
    paths,
    fallback: false,
  };
};
