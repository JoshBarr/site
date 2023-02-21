import React from "react";
import Image from "next/image";
import { prettyDate } from "./prettyDate";

interface AuthorProps {
  author: {
    name: string;
    image: string;
  };
  date: Date | string;
}

const Author = ({ author, date }: AuthorProps) => (
  <div className="media">
    <div className="media__image avatar">
      <Image
        src={author.image}
        width={256}
        height={256}
        alt={`an image of ${author.name}`}
      />
    </div>
    <div className="media__body small">
      <strong>{author.name}</strong>
      <br />
      {prettyDate({ date })}
    </div>
  </div>
);

export default Author;
