import Document, { Html, Head, Main, NextScript } from "next/document";

export default class CustomDocument extends Document {
  render() {
    const pageProps = this.props?.__NEXT_DATA__?.props?.pageProps;

    return (
      <Html>
        <Head />
        <body
          className={`theme-body theme--${pageProps.isDark ? "hero" : "light"}`}
        >
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
