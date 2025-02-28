(async () => {
  const axios = require('axios');

  const config = {
    "type": "function",
    "function": {
      "name": "capture_lead",
      "description": "Collects and stores dentist patient lead information in Airtable.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "Name of the lead."
          },
          "phone": {
            "type": "string",
            "description": "Phone number of the lead.",
          },
          "email": {
            "type": "string",
            "description": "Email address of the lead.",
            "format": "email"
          },
          "query": {
            "type": "string",
            "description":
              "Details of the lead's inquiry"
          }
        },
        "required": ["name", "phone", "email", "query"]
      }
    }
  }

  function validateEmail(email) {
    var re = /\S+@\S+\.\S+/;
    return re.test(email);
  }

  // # The callback function (Adds lead to Airtable)
  async function capture_lead(params) {

    const { name, phone, email, query } = params;

    if (!name || !phone || !email || !query) {
      return "Missing required information. Please provide name, phone, email, and query";
    }

    if (!validateEmail(email)) {
      return "Invalid email format. Please provide a valid email address.";
    }

    const AIRTABLE_BASE_ID = process.env['LEADS_AIRTABLE_BASE_ID'];
    const AIRTABLE_API_KEY = process.env['LEADS_AIRTABLE_API_KEY'];
    const URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Leads`;

    const headers = {
      "Authorization": `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json"
    }

    // Data payload for the API request
    const data = {
      "records": [{
        "fields": {
          "Name": name,
          "Phone": phone,
          "Email": email,
          "Query": query
        }
      }]
    }

    // Making the API request with error handling
    try {
      const response = await axios.post(URL, data,
        {
          headers: headers
        });
      if ([200, 201].includes(response.status)) {
        return "Lead stored successfully."
      } else {
        const error = `Error storing a lead: ${response.text}`
        return error;
      }
    } catch (e) {
      console.log(`Failed to store lead: ${e}`)
    }
  }

  exports.capture_lead_config = config;
  exports.capture_lead = capture_lead;
})();