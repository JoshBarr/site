import React from 'react'
import { Link } from 'gatsby'

import Layout from '../components/layout'
import SEO from '../components/seo'


const getTime = () => {
  const options = {
    hour12: true,
    timeZone: 'Pacific/Auckland',
    hour: 'numeric',
    minute: 'numeric',
  };

  const formatter = new Intl.DateTimeFormat([], options)
  return formatter.format(new Date());
}

class Contact extends React.Component {
  
  constructor(props) {
    super(props);
    this.state = { time: null };
    this.checkTime = this.checkTime.bind(this);
  }

  checkTime() {
    this.setState({ time: getTime() });
  }

  componentDidMount() {
    this.checkTime();
    this.interval = setInterval(this.checkTime, 30 * 1000);
  }

  componentWillUnmount() {
    clearInterval(this.interval);
  }
  
  render() {
    return (
      <Layout theme="theme--hero">
        <SEO title="Contact" />
        <div className="container generic-page">
          <h1 className="hero__title section-top theme-text theme-display-weight">Contact me</h1>

      
          <ul className="list-unstyled list-nospace theme-text hero__subtitle">
            <li>
              Email: <a className="theme-link__brand" href="mailto:josh@joshbarr.com">josh@joshbarr.com</a>
            </li>
            <li>
              Phone: <a className="theme-link" href="tel:+64 21 056 7120">+64 21 056 7120</a>
            </li>
          </ul>

          <div className="hero__article theme-text">
          {Intl && this.state.time && <p>Right now, it's {this.state.time} in New Zealand</p>}
          </div>
        </div>
      </Layout>
    );
  }
}

export default Contact;