import React from "react";

import SEO from "../../components/seo";
import Layout from "../../components/layout";
import PostMetadata from "../../components/PostMetadata";
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
        <header className="post-header section-top theme-text">
          <h1 className="page-title">{frontMatter.title}</h1>
          <PostMetadata post={frontMatter} />
        </header>

        <div className="article">
          <p className="lead theme-text">{frontMatter.blurb}</p>
          <div className="blog-post-content theme-prose">
            <MDXRemote {...source} components={components} />
          </div>
        </div>
      </div>
    </Layout>
  );
}

export const getStaticProps: GetStaticProps<ArticleProps> = async (req) => {
  const slug = req.params?.slug;
  const pageData = slug ? await getPostBySlug(slug) : undefined;

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
      isDark: true,
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
