
import React from 'react'
import { Link } from 'gatsby'
import PostMetadata from './PostMetadata';


const PostListing = ({ post, hideBlurb = false }) => (
  <div className="post-listing space">
    <h3 className="post-listing__heading">
      <Link className="theme-link" to={post.frontmatter.path}>{post.frontmatter.title}</Link>
    </h3>
    {!hideBlurb && <p className="post-listing__blurb font-primary">{post.frontmatter.blurb}</p>}
    <PostMetadata post={post} />
  </div>
);
    
export default PostListing;
