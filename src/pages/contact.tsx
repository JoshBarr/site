import { GetStaticProps } from "next";
import React, { useEffect, useState } from "react";
import Layout from "../components/layout";
import SEO from "../components/seo";

const getTime = () => {
  const options = {
    hour12: true,
    timeZone: "Pacific/Auckland",
    hour: "numeric",
    minute: "numeric",
  };

  const formatter = new Intl.DateTimeFormat([], options);
  return formatter.format(new Date());
};

const Contact = () => {
  const [time, setTime] = useState();

  useEffect(() => {
    const interval = setInterval(() => {
      const time = getTime();
      setTime(time);
    }, 30 * 1000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  return (
    <Layout theme="theme--hero">
      <SEO title="Contact" thumbnail={undefined} />
      <div className="container generic-page">
        <h1 className="theme-text hero__title section-top theme-text theme-display-weight">
          Contact me
        </h1>

        <ul className="list-unstyled list-nospace theme-text hero__subtitle">
          <li>
            Email:{" "}
            <a className="theme-link__brand" href="mailto:josh@joshbarr.com">
              josh@joshbarr.com
            </a>
          </li>
        </ul>

        <div className="hero__article theme-text">
          {Intl && time && <p>Right now, it's {time} in New Zealand</p>}
        </div>
      </div>
    </Layout>
  );
};

export const getStaticProps: GetStaticProps = () => {
  return {
    props: {
      isDark: true,
    },
  };
};

export default Contact;
