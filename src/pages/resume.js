import React from 'react'
import { Link } from 'gatsby'

import Layout from '../components/layout'
import SEO from '../components/seo'
import styles from './resume.module.css';


const Resume = () => (
  <div className={styles.cvBody}>
    <SEO title="Resumé" description="My career story" />
      <link href='http://fonts.googleapis.com/css?family=Merriweather:900,300i,300,700' rel='stylesheet' type='text/css' />

      <div className={styles.cv}>
          <h1>Josh Barr</h1>

          <ul className={styles.nav}>
              <li><a href="mailto:josh@joshbarr.com" title="">josh@joshbarr.com</a></li>
              <li><a href="tel:0210567120" title="">+64 21 056 7120</a></li>
              <li><span>D.O.B</span> 28/10/1987</li>
          </ul>

          <h2>
              Solution Architect, MInstD
          </h2>

          <ul>
              <li>I enjoy leading and mentoring high-performing technical teams</li>
              <li>I believe in accessible, sensible user experiences <sup className="noprint"><a href="#note1">1</a></sup></li>
              <li>I’m a qualified graphic designer who thinks in code</li>
          </ul>


          <h2>Qualifications &amp; skills</h2>

          <ul>
              <li>Team leadership – 4 years leading and growing Springload's technical team</li>
              <li>Bachelor of Design (Hons, 1st Class, Massey Scholar)</li>
              <li>Experience with hiring, training and conducting reviews</li>
              <li>Comfortable speaking about technical concerns in plain language &amp; presenting to large groups</li>
              <li>Proficient in JavaScript, Python, C#, Node &amp; React</li>
              <li>Experience contributing to Wagtail, a <a href="//github.com/torchbox/wagtail.git">popular open source project</a>.</li>
              <li>Knowledge of Enterprise Architecture concepts</li>
              <li>Ability to build REST APIs and associated backend services</li>
              <li>Excellent grasp of large-scale CSS architecture (BEM, ITCSS)</li>
              <li>Understanding of unit testing and Continuous Delivery</li>
          </ul>

          <h2>
              The highlights so far
          </h2>

          <ul>
              <li>Growing the technical practice at <a href="//springload.co.nz/" target="_blank">Springload</a></li>
              <li>Launching <a href="https://votelocal.nz">Vote Local</a> for the 2016 local body elections</li>
              <li>Winning the Information category at the <a href="http://idealog.co.nz/tech/2016/08/kiwi-companies-bring-home-bacon-internet-awards">2016 ANZIA awards</a></li>
              <li>Helping improve health outcomes in South Africa with the <a href="//www.springload.co.nz/blog/wagtail-cape-town-sprint/">Wagtail CMS</a> core team in Cape Town, 2016</li>
              <li>Shaping Kiwibank's digital strategy and enterprise architecture</li>
              <li>Delivering a rich OpenType editor for <a href="//klim.co.nz/" target="_blank">Klim Type Foundry</a></li>
              <li>Best Awards – Gold and Purple Pin for <a target="_blank" href="http://homehunter.co.nz/">HomeHunter</a>, 2014</li>
              <li>Developing a new, responsive <a target="_blank" href="http://www.kiwibank.co.nz/personal-banking/">Personal Banking</a> section for Kiwibank</li>
              <li>Helping 220,000 users engage in democracy with <a target="_blank" href="http://onthefence.co.nz/">On The Fence</a></li>
              <li>Working to increase donations to the <a target="_blank" href="http://redcross.org.nz">New Zealand Red Cross</a></li>
              <li>Designing in-flight touchscreen interfaces for Air New Zealand</li>
              <li>Animating the Telecom/Spark logo for the 2010 identity refresh</li>
              <li>Exhibiting at Neville Brody’s Anti-Design Festival, London 2010</li>
              <li>Best Award – Outstanding, Student Graphic Design for <a target="_blank" href="http://blog.joshbarr.com/2011/01/akzidenz-baby/">Akzidenz Baby!</a>, 2009</li>
          </ul>

          <hr />

          <h3 className="">
              Employment History
          </h3>


          <h4>
              Solution Architect, Xero
          </h4>
          <p className="date">
              July 2018 – Present
          </p>
          <p>
              Responsible for architecture of Xero's Public API and app marketplace.
          </p> 

          <h4>
              Frontend Architect, Xero
          </h4>
          <p className="date">
              Nov 2016 - July 2018
          </p>
          <p>
            Architected and implemented new navigation for Xero's 18 customer-facing web applications. Touted as the "single biggest change to Xero in years".
          </p>
          <p>
            Created "good-by-default" libraries for dev teams to implement OpenId Connect authentication.
          </p>
          <p>
            Modernised Xero's frontend tooling to use Webpack, saving 100 hours/month in build server time.
          </p>
          

          <h4>
              Technical Director, Springload
          </h4>
          <p className="date">
              Nov 2015 - Nov 2016
          </p>
          <p>
              Alongside Richard McMillan, I am responsible for running the technical practice at Springload. Over 2014-2016, we've transformed Springload's technical culture, initiating continuous integration, continuous deployment, and unit testing practices. We've standardised environments and moved the studio to Python and Node on AWS. As a member of the NZ Institute of Directors, I'm passionate about continuously improving as a leader.
          </p>

          <h4>
              Designer, GoodWorld
          </h4>
          <p className="date">
              Aug 2014 - Feb 2015
          </p>
          <p>
              Working with the Wellington-based development team and Washington-based business team, I helped take GoodWorld through a successful funding round and into Fast Company's <a href="http://www.fastcompany.com/most-innovative-companies/sectors/social-good">most innovative non-profits</a> to watch in 2016.
          </p>

          <h4>
              Front-end director, Springload
          </h4>
          <p className="date">
              Dec 2013 - Nov 2015
          </p>
          <p>
              Responsible for growing and maintaining quality of the Springload front-end development team, ensuring environments and tooling are appropriate, conducting interviews and reviews, working on strategy and system architecture for Springload’s clients. Key projects include the redevelopment of kiwibank.co.nz, NZTA's front-end pattern library, Klim Type Foundary.
          </p>

          <h4>
              Senior front-end developer, Springload
          </h4>
          <p className="date">
              Jan 2013 - Dec 2013
          </p>
          <p>
              I worked to standardise Springload’s front-end practice and clear technical debt. I introduced a formal methodology for CSS and tools to expedite development. Key projects include developing the Forsyth Barr Investment Insights app and contributing to the frontend of Kiwibank Home Hunter.
          </p>

          <h4>
              Designer, Springload
          </h4>
          <p className="date">
              Nov 2011 - Jan 2013
          </p>
          <p>
              I was responsible for user experience and design on my allocated projects, under the direction of Andrew Hovey. Highlights include redesigning the New Zealand Red Cross website, launching the first responsive bank homepage for Kiwibank, as well as projects for RealMe and NZ Post.
          </p>

          <h4>
              Interactive Designer, Designworks Wellington
          </h4>
          <p className="date">
              July 2011 – October 2011 (fixed term)
          </p>
          <p>
              I took on a contract at designworks, helping execute in-store components of the NZ Post retail transformation project. Responsibilities included client liaison, briefing contract designers and developers, prototyping, design and illustration.
          </p>

          <h4>
              Visiting Tutor, Massey University
          </h4>
          <p className="date">
              February 2011 - June 2011 (fixed term)
          </p>
          <p>
              Responsibilities included tutoring 300-level graphic design, planning and delivery of screen-based interactive design curriculum, facilitating studio practice and critique sessions.
          </p>

          <h4>
              Designer, Designworks Wellington
          </h4>
          <p className="date">
              October 2009 – February 2010
          </p>
          <p>
              I joined Designworks as an intern during my final year of study. I worked on the refresh of the <a href="http://www.mch.govt.nz/" target="_blank">Ministry for Culture and Heritage</a> (design and front-end code), in-flight entertainment systems for Air New Zealand and Cathay Pacific, motion graphics for Telecom, and re–fit of a post office in Jin Jang, Malaysia.
          </p>

          <h3 className="">Education</h3>
          <p className="date">
              Massey University Wellington, 2006-2009
          </p>
          <p>
              I studied Visual Communication Design, with a focus on typography, identity, motion graphics and advertising. For my final year project, I explored the relationship between digital and physical publication. During this time I worked as a freelance web developer.
          </p>

          <hr></hr>
          <p>
              <em>References available on request</em>
          </p>
          <h4 className="noprint">Notes</h4>
          <p className="noprint footnote">
              <sup id="note1">1</sup> Matt Soar’s dissertation, <a target="_blank" href="http://mattsoar.com/dissertation/GraphicDesignGraphicDissent.pdf">Graphic Design/Graphic Dissent</a> (2002) inspired in me a love for work with social or civic benefit. Soar suggests that designers often produce work that’s only consumed by other cultural elites. As Bobbi Newman writes, <em>If it’s inaccessible to the poor it’s neither radical nor revolutionary</em>.
          </p>
          <p className="noprint">
              <a href="joshbarr-technical-director-2016-09.pdf" title="">Download this page (PDF)</a>
          </p>
      </div>
    </div>
);

export default Resume;
