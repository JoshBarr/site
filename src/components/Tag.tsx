import React from "react";
import { paramCase } from "change-case";
import Link from "next/link";

const Tag = ({ tag }) => (
  <Link
    className="theme-link theme-border-link pill"
    href={`/tags/${paramCase(tag)}`}
  >
    {tag}
  </Link>
);

export default Tag;
