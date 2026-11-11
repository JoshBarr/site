import React from "react";
import type { FrontMatter } from "../lib/blog";
import { prettyDate } from "./prettyDate";
import Tag from "./Tag";

interface PostMetadatProps {
  post: Pick<FrontMatter, "date" | "tags">;
}

/** A post's date and tags, on one line of the rhythm. */
const PostMetadata: React.FC<PostMetadatProps> = ({ post }) => (
  <ul className="post-meta small font-secondary theme-text list-unstyled">
    <li>{prettyDate({ date: post.date })}</li>
    {post.tags.map((tag) => (
      <li key={tag}>
        <Tag tag={tag} />
      </li>
    ))}
  </ul>
);

export default PostMetadata;
