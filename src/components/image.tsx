import React from "react";
import NextImage from "next/image";

/*
 * This component is built using `gatsby-image` to automatically serve optimized
 * images with lazy loading and reduced file sizes. The image is loaded using a
 * `StaticQuery`, which allows us to load the image from directly within this
 * component, rather than having to pass the image data down from pages.
 *
 * For more information, see the docs:
 * - `gatsby-image`: https://gatsby.app/gatsby-image
 * - `StaticQuery`: https://gatsby.app/staticquery
 */

interface ImageProps {
  data: {
    placeholderImage: {
      childImageSharp: {
        fluid: string;
      };
    };
  };
}

const Image = ({ data }: ImageProps) => {
  return <NextImage src={data.placeholderImage.childImageSharp.fluid} alt="" />;
  // <StaticQuery
  //   query={graphql`
  //     query {
  //       placeholderImage: file(relativePath: { eq: "gatsby-icon.png" }) {
  //         childImageSharp {
  //           fluid(maxWidth: 300) {
  //             ...GatsbyImageSharpFluid
  //           }
  //         }
  //       }
  //     }
  //   `}
  //   render={(data) => (

  //   )}
  // />
};

export default Image;
