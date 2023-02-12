---
date: "2019-01-07T15:12:33.962Z"
title: "A colophon for joshbarr.com"
blurb: "The colophon is a wonderful concept from publication design that's found its way to the internet. This is my website's colophon – giving details of its authorship and printing."
cover_image: ../../images/cover-image.png
tags: ["Frontend development"]
published: true
authors: [josh_barr]
---

A couple of years ago, my new years resolution was to stop spending lots of money on subscription services. I used to host a number of small websites for friends on WebFaction. Not only was it costing me money, it was sapping my time. So I shut down the lot of it. My personal website, an ancient Wordpress blog, was also hosted there, and vanished in the clear-out.

It's 2019, and I've resolved to start writing again – and that means I need a website. I started with some priorities:

- I don't want to tangle with systems administration. I work at a SaaS company, there are enough servers, pipelines, environments and databases to worry about in my day job.
- I want to own the CSS and layout, and don't want to learn proprietary theme engines or frameworks.
- It should be cheap or free to host. I haven't forgotten my 2017 resolution to spend less on web services.

The key for me, is something simple, that just works. Javascript, APIs and Markup, the [JAMStack](https://jamstack.org), offer a great way to get a simple personal website off the ground with low ongoing maintenance. The website is compiled into static HTML, and can be served from a content delivery network, making it very fast, and very easy to scale (for all that viral content I'll be producing). I've long been a fan of this static website + API approach, in fact I built a static site generator for a client project, dubbed [the Wrangler](https://github.com/springload/Wrangler.py), back in 2013.

Building a static site has got much, much better over the last few years. Jekyll popularised the "put some Markdown in a directory, run a command, get a website" workflow, but it's Ruby ecosystem never really clicked with me. Starting a new web project in 2019, Javascript-based static site generators are a dime a dozen. You can choose from [Eleventy](https://www.11ty.io/), [Hexo](https://hexo.io/), [Docusaurus](https://docusaurus.io), [Next.js](https://nextjs.org), or [Metalsmith](https://metalsmith.io/), to name a few.

I landed on [Gatsby](https://www.gatsbyjs.org/). It's got a great local developer experience, good docs, and makes use of React for templating, which feels very comfortable for me. It's also backed by a robust data query strategy via GraphQL, that can accept many different data sources. This means I can plug in a [headless CMS](https://contentful.com) later if I need more editing flexibility.

### Some assembly required

The Gatsby documentation is pretty good, however there have been several changes between v1.x and v2, so _if you're googling for help, it might be out of date_. Here's some Gatsby resources I've found useful:

- [How to build a React and Gatsby-powered blog in about 10 minutes](https://medium.freecodecamp.org/how-to-build-a-react-and-gatsby-powered-blog-in-about-10-minutes-625c35c06481)
- [Why I built this blog with Gatsby.js and Contentful](https://www.halfelectronic.com/post/why-i-built-this-blog-with-gatsby-and-contentful/)
- [SEO in Gatsby](https://reactgo.com/gatsby-advanced-blog-tutorial/#seo-in-gatsby)

### Gatsby plugins I'm using

- [gatsby-awesome-pagination](https://github.com/GatsbyCentral/gatsby-awesome-pagination) for paginating the articles index.
- [gatsby-plugin-sitemap](https://www.npmjs.com/package/gatsby-plugin-sitemap), to generate a sitemap tree
- [gatsby-plugin-google-analytics](https://www.gatsbyjs.org/packages/gatsby-plugin-google-analytics/), for wiring up GA
- [gatsby-transformer-yaml](https://www.npmjs.com/package/gatsby-transformer-yaml) for referencing author information across all articles.

### Stay tuned

Now that I'm up and running with this performant, easy-to-manage website, I'll be dedicating more time to writing. Look out for new posts soon.
