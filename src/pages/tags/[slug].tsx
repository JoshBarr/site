import React from "react";
import Layout from "../../components/layout";
import SEO from "../../components/seo";
import { GetStaticPaths, GetStaticProps } from "next";
import { getAllPostsByTag, PostMetaWithFrontMatter } from "../../lib/blog";
import PostListing from "../../components/PostListing";

interface TagsPageProps {
  name: string;
  slug: string;
  count: number;
  posts: PostMetaWithFrontMatter[];
}

const Tags: React.FC<TagsPageProps> = ({ name, posts }) => (
  <Layout>
    <SEO title="Tags" thumbnail={undefined} />
    <div className="container generic-page ">
      <h1 className="page-title section-top theme-text space--large">
        Tag: {name}
      </h1>

      <div>
        {posts.map((post) => {
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

export default Tags;

export const getStaticProps: GetStaticProps<TagsPageProps> = async (req) => {
  const postsByTag = await getAllPostsByTag();

  const tag = postsByTag.find((tagGroup) => tagGroup.slug === req.params?.slug);

  if (!tag) {
    return { redirect: { destination: "/tags", permanent: false } };
  }

  return {
    props: {
      isDark: true,
      ...tag,
    },
  };
};

export const getStaticPaths: GetStaticPaths = async () => {
  const postsByTag = await getAllPostsByTag();
  const paths = postsByTag.map((tagGroup) => tagGroup.permalink);

  return {
    paths,
    fallback: "blocking",
  };
};
