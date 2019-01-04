import React from "react"
import Img from 'gatsby-image'


const Author = ({ author }) => (
  <div className="">
    <div className="avatar">
      <Img fixed={author.image.childImageSharp.fixed} />
    </div>
    <div className="small">
      <strong>
        {author.name}
      </strong>
    </div>
  </div>
);

export default Author;
