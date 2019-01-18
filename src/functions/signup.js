// Implementation from 
// https://github.com/tobilg/netlify-functions-landingpage/blob/master/src/lambda/signup.js

const request = require("request");
const Joi = require("joi");

const config = {
    mailChimpAPI: process.env.MAILCHIMP_API_KEY,
    mailChimpListID: process.env.MAILCHIMP_LIST_ID,
    mailChimpRegion: process.env.MAILCHIMP_REGION,
    origin: process.env.ORIGIN,
};

const schema = Joi.object().keys({
    email: Joi.string().email({ minDomainAtoms: 2 }).required(),
});

const configSchema = Joi.object().keys({
    mailChimpRegion: Joi.string().required(),
    mailChimpAPI: Joi.string().required(),
    mailChimpListID: Joi.string().required(),
    origin: Joi.string().required(),
});


const tryParse = (body) => {
    try {
        return JSON.parse(body);
    } catch(e) {
        console.error(e);
        return null;
    }
};

const cors = () => ({
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": "true"
});


const createResponder = (callback) => (status, body) => {
    callback(null,  {
        statusCode: status,
        headers: cors(),
        body: JSON.stringify(body)
    });
};


const handleResponse = (respond) => (error, response, body) => {
    if (error) {
        callback(error, null);
        return;
    }
    
    const bodyObj = tryParse(body);

    if (!bodyObj) {
        console.log("No response from MailChimp");
        respond(500, {
            status: "Internal server error"
        });
        return;
    }

    console.log("Mailchimp body: " + JSON.stringify(bodyObj));
    console.log("Status Code: " + response.statusCode);
    
    if ((bodyObj.status === 400 && bodyObj.title === "Member Exists")) {
        console.log("Member already added");
        respond(400, {
            status: "Member already added"
        });
        return;
    }

    if (response.statusCode < 300) {
        console.log("Added to list in Mailchimp subscriber list");
        respond(201, {
            status: "Added email to list"
        });
        return;
    }
    
    console.log("Error from mailchimp", bodyObj.detail);
    respond(500, {
        status: "Internal server error"
    });
}


const buildRequest = (email, validatedConfig) => {
    const data = {
        email_address: email,
        status: "subscribed",
        merge_fields: {}
    };

    const subscriber = JSON.stringify(data);
    console.log("Sending data to mailchimp", subscriber);

    return {
        method: "POST",
        url: `https://${validatedConfig.mailChimpRegion}.api.mailchimp.com/3.0/lists/${validatedConfig.mailChimpListID}/members`,
        body: subscriber,
        headers: {
            "Authorization": `apikey ${validatedConfig.mailChimpAPI}`,
            "Content-Type": "application/json"
        }
    };
}



exports.handler = (event, context, callback) => {
    const validatedConfig = Joi.validate(config, configSchema);
    const respond = createResponder(callback);
    let errorMessage = null;

    if (validatedConfig.error) {
        errorMessage = JSON.stringify(validatedConfig.error);
        console.log(errorMessage);
        respond(500, {
            status: "The function is not configured properly"
        });
        return;
    }

    const formData = tryParse(event.body);

    if (!formData) {
        errorMessage = "No form data supplied";
        console.log(errorMessage);
        respond(400, { status: errorMessage });
        return;
    }

    const validatedBody = Joi.validate(formData, schema);

    if (validatedBody.error) {
        errorMessage = JSON.stringify(validatedBody.error);
        console.log(errorMessage);
        respond(400, { 
            status: "Invalid body", 
            details: validatedBody.error 
        });
        return;
    }

    request(
        buildRequest(validatedBody.value.email, validatedConfig.value), 
        handleResponse(respond)
    );
};
