(async () => {
  const axios = require('axios');

  const config = {
    "type": "function",
    "name": "transfer_to_human",
    "description": "Call this when the user explicitly asks to speak with a human agent or live representative. Notifies the Orient 99 team so they can take over the conversation.",
    "parameters": {
      "type": "object",
      "properties": {
        "reason": {
          "type": "string",
          "description": "Brief reason the client wants to speak with a human, in Bulgarian, based on the conversation. Empty string if none was given."
        },
        "customer_message": {
          "type": "string",
          "description": "The client's most recent message that triggered this request."
        },
        "customer_name": {
          "type": "string",
          "description": "The client's name if it is already known from the conversation, otherwise an empty string."
        }
      },
      "required": ["reason", "customer_message", "customer_name"]
    },
    "strict": false
  }

  // # The callback function (notifies the team via the Make.com handoff webhook)
  async function transfer_to_human(params, context) {
    const { reason, customer_message, customer_name } = params || {};
    const { thread_id, channel } = context || {};

    const HUMAN_HANDOFF_WEBHOOK_URL = process.env['HUMAN_HANDOFF_WEBHOOK_URL'];

    if (!HUMAN_HANDOFF_WEBHOOK_URL) {
      console.log('HUMAN_HANDOFF_WEBHOOK_URL is not configured - skipping team notification.');
      return "Transfer to human acknowledged.";
    }

    const now = new Date();

    const payload = {
      contact_id: thread_id || '',
      channel: channel || 'webchat',
      customer_message: customer_message || '',
      reason: reason || '',
      customer_name: customer_name || '',
      date: now.toLocaleDateString('bg-BG', { year: 'numeric', month: 'long', day: 'numeric' }),
      time: now.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' }),
    };

    try {
      await axios.post(HUMAN_HANDOFF_WEBHOOK_URL, payload);
    } catch (e) {
      console.log(`Failed to notify human handoff webhook: ${e}`);
    }

    return "Transfer to human acknowledged.";
  }

  exports.transfer_to_human_config = config;
  exports.transfer_to_human = transfer_to_human;
})();
