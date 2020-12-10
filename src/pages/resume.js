import React from 'react'

import SEO from '../components/seo'
import styles from './resume.module.css'

const Resume = () => (
  <div className={styles.cvBody}>
    <SEO title="Resumé" description="My career story" />
    <link
      href="http://fonts.googleapis.com/css?family=Merriweather:900,300i,300,700"
      rel="stylesheet"
      type="text/css"
    />

    <div className={styles.cv}>
      <h1>Josh Barr</h1>

      <ul className={styles.nav} style={{marginLeft: '0'}}>
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

      <h2>Lead Architect</h2>

      <ul>
        <li>I’m a qualified graphic designer, a technology leader, and guitarist</li>
        <li>
          I believe in accessible, sensible user experiences
        </li>
        <li>I'm motivated by collaborating with great people &amp; making an impact at scale</li>
      </ul>

      <h2>Qualifications &amp; skills</h2>

      <ul>
        <li>Bachelor of Design (Hons, 1st Class, Massey Scholar)</li>
        <li>Hands on experience evolving architecture at a $20bn enterprise</li>
        <li>
          Influencing change at a high level – working with executive stakeholders to
          set the technical direction for mission critical software
        </li>
        <li>Leading change to large scale APIs in a compliance-conscious industry</li>
        <li>Designing solutions with standard AWS building blocks. Lambda, Kinesis, S3, SNS/SQS, ECS, Dynamo and Aurora</li>
        <li>Line management – hiring, training and conducting reviews</li>
        <li>
          Bridging worlds – speaking about technical concerns in plain language
        </li>
        <li>
          Experience as a core contributor to Wagtail, a{' '}
          <a href="//github.com/torchbox/wagtail.git">
            popular open source content management system
          </a>
          .
        </li>
        <li>Developing solutions in TypeScript, Python, C#, Node.js &amp; React</li>
      </ul>

      <h2>The highlights so far</h2>
      
      <ul>
        <li>
          Transforming software delivery at Xero by leading the adoption of LaunchDarkly. The impact of this has been
          independently verified by Forrester to have delivered a 245% ROI and several million dollars in productivity gains.   
        </li>
        <li>
          One of three original contributors to Xero's Shell.js, a microfrontend orchestrator allowing teams to 
          independently release user interfaces. 
        </li>
        <li>
          Modernising Xero's API Gateway, delivering <em>Sign In With Xero</em>
        </li>
        <li>
          Four years growing the technical practice at{' '}
          <a href="//springload.co.nz/" target="_blank">
            Springload
          </a>
        </li>
        <li>
          Winning the Information category at the{' '}
          <a href="https://idealog.co.nz/tech/2016/08/kiwi-companies-bring-home-bacon-internet-awards">
            2016 ANZIA awards
          </a>
        </li>
        <li>
          Helping improve health outcomes in South Africa with the{' '}
          <a href="https://wagtail.io/blog/cape-town-retrospective/">
            Wagtail CMS
          </a>{' '}
          core team in Cape Town, 2016
        </li>
        <li>
          Delivering a rich OpenType editor for{' '}
          <a href="//klim.co.nz/" target="_blank">
            Klim Type Foundry
          </a>
        </li>
        <li>
          Helping 220,000 users engage in democracy with{' '}
          <a target="_blank" href="http://onthefence.co.nz/">
            On The Fence
          </a>
        </li>
        <li>
          Working to increase donations to the{' '}
          <a target="_blank" href="http://redcross.org.nz">
            New Zealand Red Cross
          </a>
        </li>
        <li>Designing in-flight touchscreen interfaces for Air New Zealand</li>
        <li>Exhibiting at Neville Brody’s Anti-Design Festival, London 2010</li>
        <li>
          Best Award – Outstanding, Student Graphic Design for <em>Akzidenz Baby!</em>, 2009
        </li>
      </ul>

      <hr />

      <h3>Employment History</h3>

      <h4>Lead Portfolio Architect, Xero</h4>
      <p className={styles.date}>Dec 2019 – Present</p>
      <ul>
        <li>
          Coordinated across the Ecosystem group to design the architecture for Xero's transactional app store
        </li>
        <li>
          Led a time-critical regulatory compliance project to shift WorkflowMax and Xero Practice Manager behind our OAuth2 Gateway
        </li>
        <li>
          Subject matter expert on APIs, consulted by teams across the company
        </li>
        <li>
          Led the migration of developer.xero.com to Gatsby (GraphQL) &amp; Contentful CMS. 
        </li>
        <li>
          Passionate contributor to Xero's global architecture principles and architecture strategy
        </li>
      </ul>

      <h4 className={styles.printBreakBefore}>Solution Architect, Xero</h4>
      <p className={styles.date}>July 2018 – Nov 2019</p>
      <ul>
        <li>
          Technical mentor and advisor for key initiatives in the Xero Ecosystem:
        </li>
        <li>
          Modernised our API Gateway, delivered Single Sign On, Informed Consent, OAuth 2
        </li>
        <li>
          Guided the creation of a new app marketplace for Xero, migrating to Contentful CMS
        </li>
        <li>
          Led the adoption of LaunchDarkly for feature management across Xero
        </li>
        <li>
          Laid the foundations for secure single page applications with Xero's microfrontends solution – Shell.js
        </li>
        <li>
          Facilitator for API Community of Practice, building consensus on the right way to build APIs.
        </li>
      </ul>

      <h4>Frontend Architect, Xero</h4>
    
      <p className={styles.date}>Nov 2016 - July 2018</p>
      <ul>
        <li>
          Architected and implemented new navigation for Xero's 18 customer-facing
          web applications. Heralded as the "biggest change to Xero in years".
        </li>
        <li>
          Created libraries for dev teams to implement OpenId
          Connect authentication.
        </li>
        <li>
          Replaced bespoke frontend build tool with Webpack, saving 100
          hours/month in CI server time.
        </li>
        <li>
          Technical lead for a pilot programme aiming to internationalise Xero's web applications 
        </li>
        <li>
          Advocate for containerisation and pipelines as code, using Jenkins, Docker and ECS.
        </li>
      </ul>

      <h4>Technical Director, Springload</h4>
      <p className={styles.date}>Nov 2015 - Nov 2016</p>
      <p>
        Together with one other technical director, I was responsible for running the technical
        practice at Springload. Over 2014-2016, we transformed Springload's
        technical culture, initiating continuous integration, continuous
        deployment, and unit testing practices. We standardised environments
        and moved our client workloads on to AWS.
      </p>

      <h4>Designer, GoodWorld</h4>
      <p className={styles.date}>Aug 2014 - Feb 2015</p>
      <p>
        Working with the Wellington-based development team and Washington-based
        business team, I contributed to GoodWorld's user experience, leading to a successful funding
        round and Fast Company's{' '}
        <a href="http://www.fastcompany.com/most-innovative-companies/sectors/social-good">
          most innovative non-profits
        </a>{' '}
        to watch in 2016.
      </p>

      <h4>Front-end director, Springload</h4>
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
        I worked to standardise Springload’s front-end practice and clear
        technical debt. I introduced a formal methodology for CSS and tools to
        expedite development. Key projects include developing the Forsyth Barr
        Investment Insights app and contributing to the frontend of Kiwibank
        Home Hunter.
      </p>

      <h4>Designer, Springload</h4>
      <p className={styles.date}>Nov 2011 - Jan 2013</p>
      <p>
        Responsible for user experience and design on my allocated
        projects, under the direction of Andy Hovey. Highlights include
        redesigning the New Zealand Red Cross website, launching the first
        responsive bank homepage for Kiwibank, as well as projects for RealMe
        and NZ Post.
      </p>

      <h4>Interactive Designer, Designworks Wellington</h4>
      <p className={styles.date}>July 2011 – October 2011 (fixed term)</p>
      <p>
        I took on a contract at designworks, helping execute in-store components
        of the NZ Post retail transformation project. Responsibilities included
        client liaison, briefing contract designers and developers, prototyping,
        design and illustration.
      </p>

      <h4 className={styles.printBreakBefore}>Visiting Tutor, Massey University</h4>
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
        worked on the refresh of the{' '}
        <a href="http://www.mch.govt.nz/" target="_blank">
          Ministry for Culture and Heritage
        </a>{' '}
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
        <a href="joshbarr-lead-architect-2020.pdf" title="">
          Download this page (PDF)
        </a>
      </p>
    </div>
  </div>
)

export default Resume
