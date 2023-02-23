import { IMG_HEIGHT, WorkItemType } from "../components/WorkItem";

export const allWork: WorkItemType[] = [
  {
    link: "",
    title: "Stedi Developer Docs",
    image: "/images/work/stedi-api-docs.png",
    imageAlt: "Stedi API documentation",
    summary:
      "Developer documentation & interactive API Reference for Stedi's API-first EDI product.",
    technologies: ["react", "next.js"],
    year: 2022,
  },
  {
    link: "",
    title: "Stedi Authentication SDK",
    image: "/images/work/sign-in.png",
    imageAlt: "stedi Auth",
    summary:
      "Authentication Client built on top of AWS Cognito and Zag.js finite state machines. Worked with AWS team to improve performance of AWS Amplify client library.",
    technologies: ["oauth", "cognito"],
    width: IMG_HEIGHT,
    year: 2023,
  },
  {
    link: "",
    title: "Xero Platform Conceptual Model",
    image: "/images/work/xero-platform.png",
    imageAlt: "Xero Platform diagram",
    summary:
      "Designed a conceptual model for exploring platform transactions in Xero's Ecosystem. Visual distillation of platform business literature.",
    technologies: [],
    year: 2020,
  },
  {
    link: "",
    title: "Architecture Explorer",
    image: "/images/work/arch-explorer.png",
    imageAlt: "Architecture explorer",
    summary:
      "An interactive UI for exploring solution architecture in a large product team. Displays relationships as a directed graph, allows filtering by component type, department, logical domain.",
    technologies: ["react"],
    year: 2020,
  },
  {
    link: "",
    title: "Sign In With Xero",
    image: "/images/work/xero-consent.png",
    imageAlt:
      "An image of an OAuth2 informed consent screen, with user information visibile",
    summary:
      "Led the architecture for Xero's third-pary SSO product, sign-in with Xero. Includes management APIs for revoking grants, and user interfaces for customers and staff",
    technologies: ["oauth"],
    width: IMG_HEIGHT,
    year: 2019,
  },
  {
    link: "",
    title: "Xero Navigation",
    image: "/images/work/xero-nav.png",
    imageAlt: "Xero Navigation diagram",
    summary:
      "High-traffic API for presenting the navigation to Xero's users. Aggregates and caches data from a range of sources.",
    technologies: ["react", "next.js"],
    year: 2018,
  },
];

export const allEndorsements = [
  {
    body:
      "Josh is one of the most resourceful, kind and intelligent people I have ever worked with. He is incredible at optimization and I saw him be promoted for his work in this area (which included being a part of an initiative that saved his company north of a million dollars).",
    author: {
      name: "Phil Knezevich",
      role: "Manager, Strategic & Enterprise Customer Success Teams, Teleport",
    },
  },
];
