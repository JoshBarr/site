import React from "react";

import Layout from "../components/layout";
import SEO from "../components/seo";
import { GetStaticProps } from "next";
import { Bookmark, getBookmarks } from "../lib/bookmarks";

interface BookmarksPageProps {
  bookmarks: {
    name: string;
    bookmarks: Bookmark[];
  }[];
}

const Bookmarks: React.FC<BookmarksPageProps> = ({ bookmarks }) => (
  <Layout>
    <SEO title="Bookmarks" thumbnail={undefined} />
    <div className="container generic-page theme-text">
      <h1 className="section-top theme-text theme-display-weight space--large">
        Bookmarks
      </h1>
      <div className="measure space--medium">
        <p className="intro theme-text">
          Interesting reads I've encountered in my travels, about building web
          applications and working with engineering teams.
        </p>
      </div>
      <div>
        {bookmarks.map((group, index) => {
          return (
            <div
              key={group.name}
              className={` theme-border ${index > 0 ? "keyline--top" : ""}`}
            >
              <h2>{group.name}</h2>
              <div className="grid grid-three">
                {group.bookmarks.map((bookmark) => (
                  <div className="measure">
                    <p>
                      <a href={bookmark.url} className="theme-link__brand">
                        {bookmark.title}
                      </a>
                      <br />
                      {bookmark.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  </Layout>
);

export default Bookmarks;

export const getStaticProps: GetStaticProps<BookmarksPageProps> = async () => {
  const bookmarks = await getBookmarks();

  return {
    props: {
      bookmarks,
      isDark: true,
    },
  };
};
