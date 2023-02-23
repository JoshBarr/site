import { GetStaticProps } from "next";
import React, { useEffect, useState } from "react";
import Image from "next/image";
import Layout from "../components/layout";
import SEO from "../components/seo";
import styles from "../components/Tunes.module.css";

const getTime = () => {
  const options: Intl.DateTimeFormatOptions = {
    hour12: true,
    timeZone: "Pacific/Auckland",
    hour: "numeric",
    minute: "numeric",
  };

  const formatter = new Intl.DateTimeFormat([], options);
  return formatter.format(new Date());
};

type SongCredit = {
  track: string;
  artist: string;
  album?: string;
  year: number;
  contribution: string;
};

type TunesProps = {
  discography: SongCredit[];
};

const Chuuuunes: React.FC<TunesProps> = ({ discography }) => {
  const [time, setTime] = useState<string | undefined>();

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
      <div className={styles.tunesBackground}>
        <Image
          width={3400}
          style={{ maxWidth: "100%", height: "auto" }}
          height={2267}
          alt=""
          src="/images/tunes.jpeg"
        />
      </div>
      <SEO title="Contact" thumbnail={undefined} />

      <div className="container generic-page relative">
        <div className={styles.tunesHero}>
          <h1 className="theme-text hero__title section-top theme-text theme-display-weight">
            Tunes.
          </h1>
          <p className="hero__subtitle font-display theme-display-weight theme-text">
            Guitar. Bass. Live production. Mixing.
          </p>

          <figcaption className={styles.tunesPhotoCredit}>
            <span className="theme-body-text tiny-caps">Photo by</span>{" "}
            <a
              href="https://instagram.com/phinebarr"
              className={"theme-link tiny-caps"}
            >
              @phinebarr
            </a>
          </figcaption>
        </div>

        <h2 className="theme-text tiny-caps font-book">Discography</h2>

        <div className="grid grid-three">
          {discography.map((disco) => {
            return (
              <div key={disco.track} className="theme-text">
                <p className="mb1">
                  {disco.track} – {disco.artist} ({disco.year})
                </p>
                <p className="small theme-body-text">{disco.contribution}</p>
              </div>
            );
          })}
        </div>

        <h2 className="theme-text tiny-caps section-small font-book">Listen</h2>

        <div className="measure">
          <iframe
            style={{ borderRadius: "12px" }}
            src="https://open.spotify.com/embed/playlist/5W7ktgJWIlyG1b8ybtyQN1?utm_source=generator&theme=0"
            width="100%"
            height="352"
            allowFullScreen
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
          ></iframe>
        </div>
      </div>
    </Layout>
  );
};

export const getStaticProps: GetStaticProps<TunesProps> = () => {
  const discography: SongCredit[] = [
    {
      track: "Shelter",
      artist: "The Bridge",
      year: 2022,
      contribution:
        "Production, arrangement, mixing, bass guitar, additional keyboards",
    },
    {
      track: "Unfailing love",
      year: 2021,
      artist: "Magnify",
      contribution: "Bass guitar, additional keyboards",
    },
    {
      track: "You Shine",
      year: 2018,
      artist: "Elim NZ",
      contribution: "Electric guitars",
    },
    {
      track: "Worthy Lord",
      year: 2018,
      artist: "Elim NZ",
      contribution: "Acoustic guitar, additional arrangement",
    },
    {
      track: "Listening",
      year: 2018,
      artist: "Elim NZ",
      contribution: "Electric guitar, ambient sounds",
    },
    {
      track: "Greater Than",
      year: 2013,
      artist: "Tom Field",
      contribution: "Additional songwriting",
    },
  ];

  return {
    props: {
      isDark: true,
      discography,
    },
  };
};

export default Chuuuunes;
