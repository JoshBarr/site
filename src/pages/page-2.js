import React from 'react'
import { Link } from 'gatsby'

import Layout from '../components/layout'
import SEO from '../components/seo'

const SecondPage = () => (
  <Layout>
    <SEO title="Page two" />
    
    <div className="container">
      <div className="article">
        <h1>Making a hash of it</h1>
        <p className="excerpt">
          At Xero, there's lots of different ways of naming releases for production web services.
        </p>
        <p className="article__meta">2 Jan 2019</p>
        <div className="breakout">

        </div>
        <p className="intro">
          At Xero, there's lots of different ways of naming releases for production web services.
        </p>
      
        <p>
          Your release might have a semantic version number (1.0.1), a cute, unique mnemonic (XB-CrazyUnicornPineappleFace), or an incremental TeamCity build number (5431).
        </p>
        <p>
          Sometimes, all three of these values might be part of a release:
        </p>
        <p>
          While interesting, and sometimes even entertaining, none of these values give us great confidence about the code we're releasing:
        </p>
        <ul>
          <li>
            Build numbers can be reset in most build tools (TC and Jenkins), meaning in the event that the build system is destroyed/recreated, we may not know what the real value should be.
          </li>
          <li>
            Semantic versions rely on the judgement of the team to decide whether it's a major, minor or patch release, if they remember to update the version number at all. 
          </li>
          <li>
            There's no built-in correlation between the code change in git, and cute mnemonic names for releases. 
          </li>
        </ul>
        <p>
          Our favourite ways of naming builds aren't very helpful for figuring out which revision got deployed. We have to step through multiple tools, read manually created documentation, or hope certain state exists in our build agents. 
        </p>

        <p>
          These methods of versioning releases also disclose a bias towards one-off, infrequent, or remarkable events, rather than a boring, repeatable process. And we want our releases to be boring. You're probably familiar with the immutable infrastructure principle, "treat servers like cattle, not like pets" . The same can be said of release versions. 
        </p>
        <div style={{ maxWidth: `300px`, marginBottom: `1.45rem` }}>
          {/* <Image /> */}
        </div>
        <Link to="/page-2/">Go to page 2</Link>
      </div>
    </div>
    
  </Layout>
)

export default SecondPage
