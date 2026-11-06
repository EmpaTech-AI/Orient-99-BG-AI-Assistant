# Orient99 AI assistant

A NestJS service that answers Orient99 travel-agency clients on the website chat, Facebook Messenger and Instagram. It uses the OpenAI Responses API with file search over the agency's offers, and it can hand a conversation over to a human from the team.

## How it is called

| Endpoint | Purpose |
|---|---|
| `GET /start` | Creates a conversation and returns `{ "thread_id": "conv_..." }`. |
| `POST /chat` | Body `{ "thread_id", "message", "channel"?, "contact_id"? }`, returns `{ "response": "..." }`. |

Every request needs the `x-api-key` header, which must equal `SECURITY_API_KEY`.

- `channel` is `webchat` (default), `messenger` or `instagram`. Messenger and Instagram replies are capped at 600 and 450 characters. Markdown is removed for them because those apps show it as raw text, and the booking link is never cut.
- `contact_id` is the GoHighLevel contact id. GHL and Make.com send it on Messenger and Instagram so a handoff can find the contact.
- A turn that takes longer than 32 seconds returns a short "please wait" reply, because the Make.com call times out at 40 seconds.

## Handing a client over to the team

The model calls the `transfer_to_human` tool when the client asks for a person, or when no matching offer exists for the hotel, destination or year the client asked about. The tool posts to a Make.com webhook, and GHL then pauses the AI for that contact until the client writes "продължи разговора".

- **Webchat:** the team has no contact details, so the agent asks for a phone number before the handoff.
- **Messenger and Instagram:** the handoff happens straight away. The reply that hands the client over ends with the agency's contacts and the resume phrase.

The code also hands over when a social reply promises that a colleague will follow up but the tool was not called. That check matches the reply text and has known gaps.

## Where things live

| Path | What it is |
|---|---|
| `src/assistant/instructions.ts` | The system prompt. It is the only source of truth. |
| `src/assistant/config.ts` | Model and reasoning effort, and the tool list (`search_offers` for offers, `code_interpreter` for the two company documents). |
| `src/app.service.ts` | The conversation flow: tool calls, channel limits, the broken-link retry and the handoff. |
| `src/channel-format.ts` | Messenger and Instagram formatting, and the length limits. |
| `src/tools/` | Tool implementations: handoff webhook, lead and complaint capture (Airtable), date and time. |

## Configuration

These are set in the environment, or in `.env` for local runs. Never commit their values.

| Variable | Used for |
|---|---|
| `OPENAI_API_KEY` | OpenAI API |
| `SECURITY_API_KEY` | The `x-api-key` every request must send |
| `HUMAN_HANDOFF_WEBHOOK_URL` | Make.com handoff webhook for Messenger and Instagram |
| `HUMAN_HANDOFF_WEBHOOK_URL_WEBCHAT` | Make.com handoff webhook for the website chat |
| `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID` | Lead and complaint capture |
| `PORT` | HTTP port (default 3000) |

## Running and testing

```bash
npm install
npm run start:dev   # watch mode
npm run build && npm run start:prod
npm test            # unit tests (jest, src/**/*.spec.ts)
```

The unit tests mock OpenAI, the handoff tool and the capture tools. `src/app.service.ts` loads `.env`, so a test that let one of those tools run for real would post to the live webhook or to Airtable.

`test/replay-869fnmpyu.ts` replays scenarios based on real client conversations against the live model and checks the replies. It needs `OPENAI_API_KEY`, costs API credits and is not part of `npm test`. It replaces the handoff and capture tools with recorders, so nothing reaches the team.

```bash
npx ts-node test/replay-869fnmpyu.ts [log-file]
```
