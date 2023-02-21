import React from "react";

import SEO from "../components/seo";
import styles from "./resume.module.css";
import { Merriweather } from "@next/font/google";

const merriweather = Merriweather({
  subsets: ["latin"],
  weight: ["300", "400", "700"],
  style: ["normal", "italic"],
});

const Resume = () => (
  <div className={`${styles.cvBodyElement} ${merriweather.className}`}>
    <style jsx global>
      {`
        @media print {
          @page {
            margin: 2cm;
          }

          body {
            font-family: "Merriweather", "georgia", serif;
            font-size: 7pt;
          }

          .cv {
            max-width: 100%;
          }

          ul.nav {
            margin-left: 0;
          }

          a {
            text-decoration: none;
          }

          ul {
            padding-left: 0;
          }
        }
      `}
    </style>
    <SEO title="Resumé" description="My career story" />

    <div className={styles.cv}>
      <h1>Josh Barr</h1>

      <ul className={styles.nav} style={{ marginLeft: "0" }}>
        <li>
          <a href="mailto:josh@joshbarr.com" title="">
            josh@joshbarr.com
          </a>
        </li>
        <li>
          <a href="tel:0210567120" title="">
            +64 21 056 7120
          </a>
        </li>
        <li>
          <span>D.O.B</span> 28/10/1987
        </li>
      </ul>

      <h2>UX Engineer</h2>

      <ul>
        <li>
          I’m a qualified graphic designer, a technology leader, and guitarist
        </li>
        <li>I believe in accessible, sensible user experiences</li>
        <li>
          I'm motivated by collaborating with great people &amp; making an
          impact at scale
        </li>
      </ul>

      <h2>Qualifications &amp; skills</h2>

      <ul>
        <li>Bachelor of Design (Hons, 1st Class, Massey Scholar)</li>
        <li>
          Hands-on experience evolving software architecture at a $20bn
          enterprise
        </li>
        <li>
          Crafting user interfaces in React, vanilla JS, and plain old HTML.
        </li>
        <li>
          Influencing change at a high level – working with executive
          stakeholders to set the technical direction for critical software
        </li>
        <li>Working on high-traffic APIs in compliance-conscious industries</li>
        <li>
          Designing solutions with standard AWS building blocks. Lambda,
          Kinesis, S3, SNS/SQS, Dynamo and API Gateway
        </li>
        <li>Line management – hiring, training and conducting reviews</li>
        <li>
          Experience as an open-source contributor to Wagtail, a{" "}
          <a href="//github.com/torchbox/wagtail.git">
            popular django-based content management system
          </a>
          .
        </li>
        <li>Developing in TypeScript, Python, C#, Node.js &amp; React</li>
      </ul>

      <h2>The highlights so far</h2>

      <ul>
        <li>
          Launching the <a href="https://www.stedi.com/docs">developer docs</a>,
          design system, and authentication for Stedi
        </li>
        <li>
          Transforming software delivery at Xero by leading the adoption of
          LaunchDarkly for feature management. The impact of this has been
          independently verified by Forrester to have delivered a 245% ROI and
          several million dollars in productivity gains.
        </li>
        <li>
          Shipping{" "}
          <a href="https://joshbarr.com/articles/xero-navigation">
            new navigation
          </a>{" "}
          at Xero – "the biggest change to Xero in years"
        </li>
        <li>
          Modernising Xero's API Gateway, delivering{" "}
          <a href="https://developer.xero.com/documentation/xero-app-store/app-partner-guides/sign-in/">
            Sign In With Xero
          </a>
        </li>
        <li>
          Contributing to Xero's Shell.js, a microfrontend orchestrator allowing
          teams to independently release user interfaces.
        </li>
        <li>
          Growing the front-end technical practice at{" "}
          <a href="//springload.co.nz/" target="_blank">
            Springload
          </a>
        </li>
        <li>
          Delivering a rich OpenType editor for{" "}
          <a href="//klim.co.nz/" target="_blank">
            Klim Type Foundry
          </a>
        </li>
        <li>
          Helping improve health outcomes in South Africa with the{" "}
          <a href="https://wagtail.io/blog/cape-town-retrospective/">
            Wagtail CMS
          </a>{" "}
          core team in Cape Town, 2016
        </li>
        <li>
          Encouraging 30,000 young people to get out and vote, with{" "}
          <a
            target="_blank"
            href="https://joshbarr.com/articles/getting-young-voters-off-the-fence"
          >
            On The Fence
          </a>
        </li>
        <li>
          Designing in-flight touchscreen interfaces for{" "}
          <a href="https://joshbarr.com/articles/air-new-zealand">
            Air New Zealand
          </a>
        </li>
        <li>
          Best Award – Outstanding, Student Graphic Design for{" "}
          <a href="https://joshbarr.com/articles/akzidenz-baby">
            Akzidenz Baby!
          </a>
          , 2009
        </li>
      </ul>

      <hr />

      <h3>Employment History</h3>

      <h4>UX Engineer, Stedi</h4>
      <p className={styles.date}>Apr 2021 – Feb 2023</p>
      <ul>
        <li>
          Established Stedi's Design Language System, for shared UI components
          across all applications
        </li>
        <li>
          In collaboration with Stedi's Recruiter, worked to make our front-end
          hiring process more inclusive.
        </li>
        <li>
          Migrated Stedi's Developer Docs and API Reference from a third-party
          host to Next.js, including a custom renderer for OpenAPI
          Specifications.
        </li>
        <li>
          Built a CLI and dynamo-backed API for publishing versioned OpenAPI
          specifications from teams' repositories
        </li>
        <li>
          Consolidated our frontend web applications – previously deployed on
          subdomains – behind a single domain
        </li>
        <li>
          Key contributor and code owner for Stedi's Authentication library.
          Worked with the AWS team to reduce Amplify's bundle size.
        </li>
        <li>
          Front-end ops: configured e2e tests with Playwright and Cypress, built
          deployment pipelines in Github Actions, ensured security compliance
          with custom reporting tooling on top of AWS SecurityHub,
          Infrastructure-as-code with AWS CDK.
        </li>
      </ul>

      <h4>Lead Portfolio Architect, Xero</h4>
      <p className={styles.date}>Dec 2019 – Mar 2021</p>
      <ul>
        <li>
          Coordinated across the 80-person Ecosystem group to design the
          architecture for Xero's transactional{" "}
          <a href="https://apps.xero.com/nz">app store</a>, including contract
          management and partner onboarding
        </li>
        <li>
          Wrote architectural whitepapers for senior leadership outlining
          important team and technology changes required for the business to
          meet its goals.
        </li>
        <li>
          Led a time-critical regulatory compliance project to shift WorkflowMax
          and Xero Practice Manager behind our OAuth2 Gateway
        </li>
        <li>
          Led the modernisation of developer.xero.com, from a bespoke
          application to open-source standard building blocks.
        </li>
        <li>
          Core contributor to Xero's global architecture principles and
          architecture strategy
        </li>
        <li>
          Upheld and improved the Ecosystem's security posture, through
          collaboration with Xero Security and external Security Advisors
        </li>
      </ul>

      <h4>Solution Architect, Xero</h4>
      <p className={styles.date}>July 2018 – Nov 2019</p>
      <ul>
        <li>
          Technical mentor and advisor for key initiatives in the Xero
          Ecosystem:
        </li>
        <li>
          Modernised our API Gateway, delivered Single Sign On, Informed
          Consent, OAuth 2
        </li>
        <li>
          Guided the creation of a new app marketplace for Xero, migrating from
          static content to a dynamic CMS, enabling a signed in experience.
        </li>
        <li>
          Led the adoption of LaunchDarkly for feature management across Xero
        </li>
        <li>
          Laid the foundations for secure single page applications with Xero's
          microfrontend solution – Shell.js
        </li>
        <li>
          Facilitator for API Community of Practice, building consensus on the
          right way to build APIs.
        </li>
      </ul>

      <h4>Frontend Architect, Xero</h4>

      <p className={styles.date}>Nov 2016 - July 2018</p>
      <ul>
        <li>
          Architected and implemented new navigation for Xero's 18
          customer-facing web applications.
        </li>
        <li>
          Created libraries for dev teams to implement OpenId Connect
          authentication in their web applications.
        </li>
        <li>
          Replaced a bespoke frontend build tool with Webpack, saving 100
          hours/month in CI server time. This changed enabled almost ~1m lines
          of frontend JS to be statically analysed for the first time.
        </li>
        <li>
          Technical lead for a pilot programme aiming to internationalise Xero's
          web applications
        </li>
        <li>
          Advocate for containerisation and pipelines as code, using Jenkins,
          Docker and ECS.
        </li>
      </ul>

      <h4>Technical Director, Springload</h4>
      <p className={styles.date}>Nov 2015 - Nov 2016</p>
      <p>
        Together with one other technical director, I was responsible for
        running the technical practice at Springload. Over 2014-2016, we
        transformed Springload's technical culture, initiating continuous
        integration, continuous deployment, and unit testing practices. We
        standardised environments and moved our client workloads on to AWS.
      </p>

      <h4>Designer, GoodWorld</h4>
      <p className={styles.date}>Aug 2014 - Feb 2015</p>
      <p>
        Working with the Wellington-based development team and Washington-based
        business team, I contributed to GoodWorld's user experience, leading to
        a successful funding round and Fast Company's{" "}
        <a href="http://www.fastcompany.com/most-innovative-companies/sectors/social-good">
          most innovative non-profits
        </a>{" "}
        to watch in 2016.
      </p>

      <h4 className={styles.printBreakBefore}>
        Front-end director, Springload
      </h4>
      <p className={styles.date}>Dec 2013 - Nov 2015</p>
      <p>
        Responsible for growing and maintaining quality of the Springload
        front-end development team, ensuring environments and tooling are
        appropriate, conducting interviews and reviews, working on strategy and
        system architecture for Springload’s clients. Key projects include the
        redevelopment of kiwibank.co.nz, NZTA's front-end pattern library, Klim
        Type Foundry.
      </p>

      <h4>Senior front-end developer, Springload</h4>
      <p className={styles.date}>Jan 2013 - Dec 2013</p>
      <p>
        I worked to expand Springload’s front-end practice and clear technical
        debt. I introduced a formal methodology for CSS (BEM) and command-line
        tooling such as Gulp &amp; Webpack. Key projects include developing the
        Forsyth Barr Investment Insights app and contributing to the frontend of
        Kiwibank Home Hunter.
      </p>

      <h4>Designer, Springload</h4>
      <p className={styles.date}>Nov 2011 - Jan 2013</p>
      <p>
        Responsible for user experience and design on my allocated projects,
        under the direction of Andy Hovey. Highlights include redesigning the
        New Zealand Red Cross website, launching the first responsive bank
        homepage for Kiwibank, as well as projects for RealMe and NZ Post.
      </p>

      <h4>Interactive Designer, Designworks Wellington</h4>
      <p className={styles.date}>July 2011 – October 2011 (fixed term)</p>
      <p>
        I took on a contract at designworks, helping execute in-store components
        of the NZ Post retail transformation project. Responsibilities included
        client liaison, briefing contract designers and developers, prototyping,
        design and illustration.
      </p>

      <h4>Visiting Tutor, Massey University</h4>
      <p className={styles.date}>February 2011 - June 2011 (fixed term)</p>
      <p>
        Responsibilities included tutoring 300-level graphic design, planning
        and delivery of screen-based interactive design curriculum, facilitating
        studio practice and critique sessions.
      </p>

      <h4>Designer, Designworks Wellington</h4>
      <p className={styles.date}>October 2009 – February 2010</p>
      <p>
        I joined Designworks as an intern during my final year of study. I
        worked on the refresh of the{" "}
        <a href="http://www.mch.govt.nz/" target="_blank">
          Ministry for Culture and Heritage
        </a>{" "}
        (design and front-end code), in-flight entertainment systems for Air New
        Zealand and Cathay Pacific, motion graphics for Telecom, and re–fit of a
        post office in Jin Jang, Malaysia.
      </p>

      <h3 className="">Education</h3>
      <p className={styles.date}>Massey University Wellington, 2006-2009</p>
      <p>
        I studied Visual Communication Design, with a focus on typography,
        identity, motion graphics and advertising. For my final year project, I
        explored the relationship between digital and physical publication.
        During this time I worked as a freelance web developer.
      </p>
      <hr />
      <p>
        <em>References available on request</em>
      </p>
      <p className="noprint">
        <a href="/resume-josh-barr-2023.pdf" title="Josh Barr – 2023">
          Download this page (PDF)
        </a>
      </p>
    </div>
  </div>
);

export default Resume;
