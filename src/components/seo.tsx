import React from "react";
import Head from "next/head";
import { config } from "../config";

interface SEOProps {
  description?: string;
  lang?: string;
  meta?: {
    name: string;
    content: string;
  }[];
  title: string;
  thumbnail?: string;
  data?: {
    site?: {
      siteMetadata: {
        title: string;
        description: string;
        author: string;
      };
    };
    placeholderImage?: {
      childImageSharp: {
        fixed: string;
      };
    };
  };
}

const SEO = ({ description, title, thumbnail, data }: SEOProps) => {
  const siteTitle = config.metadata.title;
  const pageDescription = description || config.metadata.description;

  return (
    <Head>
      <title>{`${title} | ${siteTitle}`}</title>
      <meta name="description" content={pageDescription} />
      <meta
        name="keywords"
        content={[`frontend development`, `architecture`, `react`].join(" ")}
      />
      <link rel="shortcut icon" href="/images/favicon.png" />
      <meta property="og:image" content="/images/cover-image.png" />
      <meta property="twitter:image" content="/images/cover-image.png" />
      <meta property="og:type" content="website" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={pageDescription} />
      <meta property="og:site_name" content={siteTitle} />
      <meta property="twitter:card" content="summary" />
      <meta
        property="twitter:creator"
        content={config.metadata.social.twitter}
      />
      <meta property="twitter:title" content={title} />
      <meta property="twitter:description" content={pageDescription} />
    </Head>
  );
};

export default SEO;
