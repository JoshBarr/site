import React from 'react'
import Img from 'gatsby-image'

const Author = ({ author, date }) => (
  <div className="media">
    <div className="media__image avatar">
      <Img fixed={author.image.childImageSharp.fixed} />
    </div>
    <div className="media__body small">
      <strong>{author.name}</strong>
      <br />
      {date}
    </div>
  </div>
)

export default Author
