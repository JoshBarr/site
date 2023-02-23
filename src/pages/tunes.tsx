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

type Equipment = {
  category: string;
  items: string[];
};

type TunesProps = {
  discography: SongCredit[];
  equipment: Equipment[];
};

const Chuuuunes: React.FC<TunesProps> = ({ discography, equipment }) => {
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
          priority
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

        <h2 className="theme-text tiny-caps section-small font-book">
          Equipment
        </h2>
        <p className="theme-text">
          If you'd like to collaborate on a project, I can provide the
          following:
        </p>
        <div className="grid section-small">
          {equipment.map((list) => {
            return (
              <div className="theme-text" key={list.category}>
                <h4 className="font-book tiny-caps mb2">{list.category}</h4>
                <ul className="small">
                  {list.items.map((item) => {
                    return <li key={item}>{item}</li>;
                  })}
                </ul>
              </div>
            );
          })}
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

  const equipment: Equipment[] = [
    {
      category: "Guitars",
      items: [
        "Fender American Special Telecaster",
        "Epiphone Les Paul Standard (hot-rodded)",
        "Cole Clarke FL2",
        "Fender Player Series P-Bass",
      ],
    },
    {
      category: "Amplifiers",
      items: ["Vox AC30 CC combo", "Ampeg BA112 combo"],
    },
    {
      category: "Effects",
      items: [
        "Boss DD500",
        "Boss DD20",
        "Blackstar HT-Dist Tube preamp",
        "Crowther Hotcake",
        "Korg Pitchblack+",
        "Line 6 DL4",
        "Line 6 Helix Floor",
        "Line 6 Pod X3",
      ],
    },
    {
      category: "Microphones",
      items: [
        "Vanguard v13 tube mic",
        "Beesneez BU87ic (u87 clone)",
        "Austrian Audio OC818",
        "Austrian Audio OC18",
        "Austrian Audio CC8 (pair)",
        "Telefunken M80-SH",
        "Beyerdynamic TG D70",
        "Beyerdynamic TG D71c",
      ],
    },
  ];

  return {
    props: {
      isDark: true,
      discography,
      equipment,
    },
  };
};

export default Chuuuunes;
