import React from 'react'

import Layout from '../components/layout'
import SEO from '../components/seo'

const NotFoundPage = () => (
  <Layout>
    <SEO title="404: Not found" />
    <div className="container generic-page">
      <h1 className="hero__title">Not found.</h1>
      <p className="hero__subtitle">
        Palpable sadness.
      </p>
    </div>
  </Layout>
)

export default NotFoundPage
