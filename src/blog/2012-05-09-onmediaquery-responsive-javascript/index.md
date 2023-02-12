---
date: "2012-05-09T15:00:00.962Z"
title: "onMediaQuery - Responsive JavaScript"
blurb: "onMediaQuery is a neat way to trigger JS when your user's browser changes size"
cover_image: ../../images/cover-image.png
tags: ["Frontend development"]
published: true
authors: [josh_barr]
---

Chances are, you're going to want to execute some code based on media queries in your snazzy responsive layout. At Springload we started by doing this with the window.matchMedia() function. It worked pretty well, but it always felt a bit, well.. inelegant. The problem was, we had to set our media queries in our Javascript as well as in our CSS files. This made our geeky department very nervous, so we struck out in search of a better, simpler way that didn't keep our developers up at night in a pool of cold sweat.

### The CSS

Jeremy Keith recently posted a [great article](https://adactio.com/journal/5429/) about using conditional CSS to add properties to the page that are enumerable in Javascript. Jeremy uses the `:after` pseudo property on the `<body>` tag to add information about the current viewport. The markup is really simple:

```html
<style>
  body:after {
    content: "mobile";
    display: none; /* comment this line for debugging purposes */
  }

  @media screen and (min-width: 35em) {
    body:after {
      content: "skinny";
    }
  }

  @media screen and (min-width: 56em) {
    body:after {
      content: "wide-screen";
    }
  }
</style>
```

This gives us a hidden string containing the currently active query, which we can fish out using a couple of lines of Javascript. All we need to do is evaluate the window when it resizes, check if the body:after property has changed, and fire a callback.

### The JavaScript

We've wrapped up Jeremy's great solution in a little Javascript module that can be inserted into your page. It's super lean and engineered with mobile loading times in mind.

```html
<script type="text/javascript" src="js/onmediaquery.min.js"></script>
<script>
  // Define the queries you want to test for.. and what to do if they're TRUE
  var queries = [
    {
      context: "mobile",
      callback: function () {
        console.log("Mobile callback. Maybe hook up some tel: numbers?");
        // Your mobile specific logic can go here.
      },
    },
    {
      context: "skinny",
      callback: function () {
        console.log("skinny callback! Swap the class on the body element.");
        // Your tablet specific logic can go here.
      },
    },
    {
      context: "wide-screen",
      callback: function () {
        console.log(
          "wide-screen callback woohoo! Load some heavy desktop JS badddness."
        );
        // your desktop specific logic can go here.
      },
    },
  ];
  // Go!
  MQ.init(queries);
</script>
```

Make sure that the strings you define in the context: property match the :after content in your css!

### Adding queries

As well as passing an array of objects when you initialise the plugin, you can add extra callbacks at any time. This is especially handy if you've got multiple JS files across the site that need to test whether a query is true.

```js
//Add a media query test
var my_query = MQ.addQuery({
  context: "skinny",
  callback: function () {
    console.log("second skinny callback!");
  },
});
```

The addQuery function returns a reference to the object you added, so you can remove it later if you need to:

```js
MQ.removeQuery(my_query);
```

This weighs in at a whopping 1.06KB (517 bytes gzipped), well worth including in your next project.

[onMediaQuery source is available on Github](https://github.com/JoshBarr/js-media-queries)
