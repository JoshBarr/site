import React from "react";
import { PostMetaWithFrontMatter } from "../lib/blog";
import { prettyDate } from "./prettyDate";
import Tag from "./Tag";

interface PostMetadatProps {
  post: PostMetaWithFrontMatter;
  stacked?: boolean;
}

const PostMetadata: React.FC<PostMetadatProps> = ({
  post,
  stacked = false,
}) => (
  <ul
    className={`small font-primary ${
      stacked ? "list-unstyled" : "list-inline"
    }`}
  >
    <li>{prettyDate({ date: post.date })}</li>
    {post.tags.map((tag) => (
      <li key={tag}>
        <Tag tag={tag} />
      </li>
    ))}
  </ul>
);

export default PostMetadata;
