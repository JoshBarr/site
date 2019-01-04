
import React from 'react'
import { Link } from 'gatsby'
import kebabCase from 'lodash/kebabCase';


const Tag = ({ tag }) => (
  <Link className="theme-link theme-border pill" to={`/tags/${kebabCase(tag)}`}>
    {tag}
  </Link>
);


const PostMetadata = ({ post, stacked = false }) => (
  <ul className={`small font-primary ${stacked ? 'list-unstyled' : 'list-inline'}`}>
    <li>{post.frontmatter.date}</li>
    {post.frontmatter.tags.map((tag => (
      <li>
        <Tag tag={tag} />
      </li>
    )))}
  </ul>
);
    
export default PostMetadata;
