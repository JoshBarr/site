---
path: "/articles/first-post"
date: "2019-01-03T15:12:33.962Z"
title: "Making a hash of it"
blurb: "At Xero, there's lots of different ways of naming releases for production web services."
cover_image: ../../images/gatsby-astronaut.png
tags: ["CI/CD"]
published: true
authors: [josh_barr]
---


Your release might have a semantic version number (1.0.1), a cute, unique mnemonic (XB-CrazyUnicornPineappleFace), or an incremental TeamCity build number (5431).

Sometimes, all three of these values might be part of a release:

While interesting, and sometimes even entertaining, none of these values give us great confidence about the code we're releasing:

* Build numbers can be reset in most build tools (TC and Jenkins), meaning in the event that the build system is destroyed/recreated, we may not know what the real value should be.
* Semantic versions rely on the judgement of the team to decide whether it's a major, minor or patch release, if they remember to update the version number at all.
* There's no built-in correlation between the code change in git, and cute mnemonic names for releases.

Our favourite ways of naming builds aren't very helpful for figuring out which revision got deployed. We have to step through multiple tools, read manually created documentation, or hope certain state exists in our build agents.

These methods of versioning releases also disclose a bias towards one-off, infrequent, or remarkable events, rather than a boring, repeatable process. And we want our releases to be boring. You're probably familiar with the immutable infrastructure principle, "treat servers like cattle, not like pets" . The same can be said of release versions.

