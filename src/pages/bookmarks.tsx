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
  <Layout theme="theme--light">
    <SEO title="Bookmarks" thumbnail={undefined} />
    <div className="container generic-page">
      <h1 className="section-top theme-text theme-display-weight space--large">
        Bookmarks
      </h1>
      <div className="measure space--medium">
        <p className="intro">
          Interesting reads I've encountered in my travels, about the art of
          building web applications and working with engineering teams.
        </p>
      </div>
      <div>
        {bookmarks.map((group, index) => {
          return (
            <div
              className={`measure theme-border ${
                index > 0 ? "keyline--top" : ""
              }`}
            >
              <h3>{group.name}</h3>
              <div className="">
                {group.bookmarks.map((bookmark) => (
                  <div>
                    <p>
                      <a href={bookmark.url}>{bookmark.title}</a>
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
    },
  };
};
