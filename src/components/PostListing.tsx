import Link from "next/link";
import React from "react";
import type { PostMetaWithFrontMatter } from "../lib/blog";
import PostMetadata from "./PostMetadata";

interface PostListingProps {
  post: PostMetaWithFrontMatter;
  hideBlurb?: boolean;
}

const PostListing = ({ post, hideBlurb = false }: PostListingProps) => (
  <div className="post-listing space">
    <h3 className="post-listing__heading">
      <Link className="theme-link" href={post.permalink}>
        {post.title}
      </Link>
    </h3>
    {!hideBlurb && (
      <p className="post-listing__blurb font-primary">{post.blurb}</p>
    )}
    <PostMetadata post={post} />
  </div>
);

export default PostListing;
