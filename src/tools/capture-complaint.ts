(async () => {
  const axios = require('axios');

  const config = {
    "type": "function",
    "function": {
      "name": "capture_complaint",
      "description": "Collects and stores information about complaints in an Airtable.",
      "parameters": {
        "type": "object",
        "properties": {
          "phone": {
            "type": "string",
            "description": "Phone number of the lead.",
          },
          "note": {
            "type": "string",
            "description":
              "Details of the complaint."
          }
        },
        "required": ["phone", "note"]
      }
    }
  }

  function validatePhone(phone) {
    var re = /^[+]*[(]{0,1}[0-9]{1,3}[)]{0,1}[-\s\./0-9]*$/g;
    return re.test(phone);
  }

  async function capture_complaint(params) {
    const { phone, note } = params;

    if (!phone || !note) {
      return "Missing required information. Please provide phone number, and note";
    }

    if (!validatePhone(phone)) {
      return "Invalid phone number format. Please provide a valid phone number.";
    }

    const AIRTABLE_BASE_ID = process.env['LEADS_AIRTABLE_BASE_ID'];
    const AIRTABLE_API_KEY = process.env['LEADS_AIRTABLE_API_KEY'];
    const URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Complaints`;

    const headers = {
      "Authorization": `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json"
    }

    const data = {
      "records": [{
        "fields": {
          "Phone": phone,
          "Note": note
        }
      }]
    }

    try {
      const response = await axios.post(URL, data,
        {
          headers: headers
        });
      if ([200, 201].includes(response.status)) {
        return "Complaint stored successfully."
      } else {
        const error = `Error storing a complaint: ${response.text}`
        return error;
      }
    } catch (e) {
      console.log(`Failed to store complaint: ${e}`)
    }
  }

  exports.capture_complaint_config = config;
  exports.capture_complaint = capture_complaint;
})();