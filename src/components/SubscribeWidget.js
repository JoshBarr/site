import React from 'react'
import PropTypes from 'prop-types'

const mailchimpScriptId = 'mailchimpJs';

class SubscribeWidget extends React.Component {
  componentDidMount() {
    var element = document.getElementById(mailchimpScriptId);

    if (element) {
      element.removeEventListener('load', this.handleScriptLoaded);
      document.body.removeChild(element);
    }
  }

  componentDidMount() {
    var element = document.getElementById(mailchimpScriptId);
    
    if (element) {
      return;
    }

    var script = document.createElement('script');
    script.src = "//s3.amazonaws.com/downloads.mailchimp.com/js/mc-validate.js";
    script.type = 'text/javascript';
    script.id = mailchimpScriptId;
    document.body.appendChild(script);
    script.addEventListener('load', this.handleScriptLoaded);
  }

  handleScriptLoaded = () => {
      window.fnames = new Array(); 
      window.ftypes = new Array();
      window.fnames[0]='EMAIL';
      window.ftypes[0]='email';
      window.fnames[1]='FNAME';
      window.ftypes[1]='text';
      window.fnames[2]='LNAME';
      window.ftypes[2]='text';
      window.fnames[3]='ADDRESS';
      window.ftypes[3]='address';
      window.fnames[4]='PHONE';
      window.ftypes[4]='phone';
      window.fnames[5]='BIRTHDAY';
      window.ftypes[5]='birthday';
      window.$mcj = window.jQuery.noConflict(true);
  }
 
  render() {
    return (
      <div id="mc_embed_signup" className="subscribe__content">
        <form 
          action="https://joshbarr.us7.list-manage.com/subscribe/post?u=20b0e0d422e971a81048e2c77&amp;id=e2cfa08d50" 
          method="post" 
          id="mc-embedded-subscribe-form" 
          name="mc-embedded-subscribe-form" 
          className="validate"
          target="_blank" 
          noValidate
        >
          {/* <div id="mc_embed_signup_scroll">
            <h2>Subscribe to my mailing list</h2>
            <p>
              New articles, straight to your inbox. No spam. <br />
              <span id="mce-responses">
                <span role="alert" className="response error" id="mce-error-response" style={{display: 'none'}}></span>
                <span role="alert" className="response success" id="mce-success-response" style={{display: 'none'}}></span>
              </span>
            </p>

            <div className="font-primary">
              <label className="field-label visually-hidden" htmlFor="mce-EMAIL">Email Address </label>
              <input placeholder="your email address" type="email" defaultValue="" name="EMAIL" className="required email field-input  field--block" id="mce-EMAIL" />
            </div>
            
            <div className="visually-hidden" aria-hidden="true">
              <input type="text" name="b_20b0e0d422e971a81048e2c77_e2cfa08d50" tabIndex="-1" defaultValue="" />
            </div>

            <div className="font-primary">
              <button type="submit" name="subscribe" id="mc-embedded-subscribe" className="btn btn-primary btn--block">Subscribe</button>
            </div>
            </div> */}
        </form>
      </div>
    )
  }
}

export default SubscribeWidget
