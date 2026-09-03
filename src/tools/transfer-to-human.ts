(async () => {
  const axios = require('axios');

  // Returned to the model (and recognised in app.service.ts) when a handoff was
  // deliberately NOT sent, so it doesn't count as a completed escalation.
  const HANDOFF_NOT_SENT_MARKER = 'HANDOFF_NOT_SENT';

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
          "description": "The client's name if it is already known from the conversation, otherwise an empty string. Optional - never hold up the handoff over a missing name."
        },
        "customer_phone": {
          "type": "string",
          "description": "The client's phone number. On the webchat channel this is how the team reaches them, so it is the one detail worth asking for before calling this function - unless it was already given earlier in the conversation, in which case reuse it and don't ask again. Empty string if the client hasn't given one."
        },
        "customer_email": {
          "type": "string",
          "description": "The client's email address if known, otherwise an empty string. Optional - never hold up the handoff over a missing email."
        }
      },
      "required": ["reason", "customer_message", "customer_name", "customer_phone", "customer_email"]
    },
    "strict": false
  }

  // # The callback function (notifies the team via the Make.com handoff webhook)
  async function transfer_to_human(params, context) {
    const { reason, customer_message, customer_name, customer_phone, customer_email } = params || {};
    const { channel, contact_id } = context || {};
    const resolvedChannel = channel || 'webchat';

    // A webchat handoff is only actionable with a phone number - the team has
    // no GHL contact and no channel to reply on. The base prompt's "call this
    // FIRST" rule makes the model fire this before collecting contacts, so
    // refuse here rather than emailing the team something they can't act on.
    if (resolvedChannel === 'webchat' && !String(customer_phone || '').trim()) {
      console.log(`[${resolvedChannel}] Handoff not sent - no phone number yet, the client needs to be asked for contacts first.`);
      return `${HANDOFF_NOT_SENT_MARKER}: The team was NOT notified, because no phone number is known yet. Ask the client for their name, phone number and email in one short message - make clear the phone number is the one that matters - and call this function again as soon as you have a phone number.`;
    }

    // Webchat handoffs go to their own Make.com scenario: they have no GHL
    // contact to update, so the social one (which does update GHL) can't
    // handle them. No cross-fallback on purpose - routing a channel to the
    // wrong scenario is worse than a loud log about a missing env var.
    const webhookEnvVar = resolvedChannel === 'webchat'
      ? 'HUMAN_HANDOFF_WEBHOOK_URL_WEBCHAT'
      : 'HUMAN_HANDOFF_WEBHOOK_URL';
    const webhookUrl = process.env[webhookEnvVar];

    if (!webhookUrl) {
      console.log(`${webhookEnvVar} is not configured - skipping team notification for channel "${resolvedChannel}".`);
      return "Transfer to human acknowledged.";
    }

    const now = new Date();

    // contact_id is the GHL contact record id, and ONLY that - it must never
    // fall back to the OpenAI conversation id, which GHL can't do anything
    // with (it fails the Update-a-Contact step with a 400). Webchat visitors
    // have no GHL contact, so it stays empty there and the Make.com scenario
    // filters on that instead of trying to update a contact that doesn't exist.
    const payload = {
      contact_id: contact_id || '',
      channel: resolvedChannel,
      customer_message: customer_message || '',
      reason: reason || '',
      customer_name: customer_name || '',
      customer_phone: customer_phone || '',
      customer_email: customer_email || '',
      // Formatted in Bulgarian local time explicitly - the server runs in UTC,
      // so without this the team sees timestamps 2-3 hours behind.
      date: now.toLocaleDateString('bg-BG', { timeZone: 'Europe/Sofia', year: 'numeric', month: 'long', day: 'numeric' }),
      time: now.toLocaleTimeString('bg-BG', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit' }),
    };

    try {
      await axios.post(webhookUrl, payload);
    } catch (e) {
      console.log(`Failed to notify human handoff webhook for channel "${resolvedChannel}": ${e}`);
    }

    return "Transfer to human acknowledged.";
  }

  exports.transfer_to_human_config = config;
  exports.transfer_to_human = transfer_to_human;
  exports.handoff_not_sent_marker = HANDOFF_NOT_SENT_MARKER;
})();
