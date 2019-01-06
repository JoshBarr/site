import React from 'react'
import Tag from './Tag';


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
