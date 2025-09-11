import React from "react";
import { kebabCase } from "change-case";
import Link from "next/link";

const Tag = ({ tag }) => (
  <Link
    className="theme-link theme-border-link pill"
    href={`/tags/${kebabCase(tag)}`}
  >
    {tag}
  </Link>
);

export default Tag;
