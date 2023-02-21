import Image from "next/image";
import Link from "next/link";
import React from "react";
import styles from "./Work.module.css";

export interface WorkItemType {
  title: string;
  image: string;
  width?: number;
  height?: number;
  imageAlt: string;
  summary: string;
  year?: number;
  link?: string;
  technologies?: string[];
  isSquare?: boolean;
}

export const IMG_HEIGHT = 472;
export const IMG_WIDTH = 830;

const WorkBody = ({ work }: { work: WorkItemType }) => {
  return (
    <div className={`${styles.workItem} mb2`}>
      <Image
        src={work.image}
        alt={work.imageAlt}
        width={work.width || IMG_WIDTH}
        height={work.height || IMG_HEIGHT}
      ></Image>
    </div>
  );
};

export const WorkItem = ({ work }: { work: WorkItemType }) => {
  return (
    <>
      <div key={work.link} className={`hero__post `}>
        {work.link ? (
          <Link className="theme-link-block font-display" href={work.link}>
            <WorkBody work={work} />
          </Link>
        ) : (
          <WorkBody work={work} />
        )}
      </div>
      <div className="hero__post-description hero__post-body">
        <p
          className={`theme-body-text link-inert font-primary small measure mb1 ${styles.workItemText}`}
        >
          <span className={`theme-text ${styles.workMetaLabel}`}>
            {work.title}
          </span>
          {" – "}
          {work.summary}
        </p>
        {work.technologies.length ? (
          <p className="font-primary small theme-body-text mb1">
            <span className={`theme-text ${styles.workMetaLabel}`}>
              Technologies
            </span>{" "}
            {work.technologies?.join(", ")}
          </p>
        ) : null}
        <p className="font-primary small theme-body-text mb1">
          <span className={`theme-text ${styles.workMetaLabel}`}>Year</span>{" "}
          {work.year}
        </p>
      </div>
    </>
  );
};
