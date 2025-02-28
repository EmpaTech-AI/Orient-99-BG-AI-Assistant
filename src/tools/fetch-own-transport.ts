(async () => {
  require('dotenv').config();
  const axios = require('axios');

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  const config = {
    type: "function",
    function: {
      name: "fetch_own_transport",
      description: "Fetch data from Airtable based on user queries.",
      parameters: {
        type: "object",
        properties: {
          offer: {
            type: "string",
            description: "The description of the holiday in the database."
          }
        },
        required: ["offer"]
      }
    }
  }

  async function fetch_own_transport(arguments) {
    const { offer } = arguments;

    if (!offer) {
      return "Missing required information. Please provide the destination.";
    }

    let allRecords = [];
    let offset = null;

    const headers = {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    };
    const query = `FIND("${offer.trim().toLowerCase()}", LOWER({Offer}), 0)`;
    const URL_WITH_QUERY =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/OwnTransport?filterByFormula=` + encodeURIComponent(query);

    console.log(URL_WITH_QUERY);
    console.log(query)

    await axios.get(URL_WITH_QUERY, {
      headers: headers,
      params: {
        pageSize: 100,
        offset: offset,
      }
    }).then(res => {
      allRecords = res.data.records;
      console.log(allRecords.length);
    }).catch(err => err.data);

    // Shuffle the records
    const shuffledRecords = allRecords.sort(() => 0.5 - Math.random());
    // Select the first two records from the shuffled list
    const selectedRecords = shuffledRecords.slice(0, 2);

    return selectedRecords;
  }

  exports.fetch_own_transport_config = config;
  exports.fetch_own_transport = fetch_own_transport;
})();
