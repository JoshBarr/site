import { GetStaticProps } from "next";
import React from "react";

import Layout from "../components/layout";
import SEO from "../components/seo";

const NotFoundPage = () => (
  <Layout>
    <SEO title="404: Not found" />
    <div className="container generic-page">
      <h1 className="page-title section-top theme-text">Not found.</h1>
      <p className="lead theme-body-text">Palpable sadness.</p>
    </div>
  </Layout>
);

export const getStaticProps: GetStaticProps = () => {
  return {
    props: {
      isDark: true,
    },
  };
};

export default NotFoundPage;
