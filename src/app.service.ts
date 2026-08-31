import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpService } from '@nestjs/axios';
import { CreateMessageDto } from './dto/create-message.dto';
import { CreateThreadDto } from './dto/create-thread.dto';
import { CHANNELS, USER_ROLES } from './interfaces/enums';
import { MODEL, INSTRUCTIONS, CHANNEL_CHAR_LIMITS, TOOLS, SUPPORTED_ACTIONS } from './assistant/config';

require('dotenv').config();

const MAX_TOOL_CALL_ROUNDS = 8;

// Make.com's HTTP module times out its own request at 40s with no reply at
// all reaching the client. We bail out with a real (if generic) answer a
// bit earlier than that instead, so the client always gets something.
const REQUEST_TIMEOUT_MS = 32000;

// Only attempt the broken-link retry (a full extra OpenAI round-trip) if
// there's realistically enough time left in the budget above for it -
// otherwise skip it and return what we already have rather than risk the
// overall request timeout.
const RETRY_TIME_BUDGET_MS = 18000;

// Requires an explicit "talk to a [real] person/operator/rep" construct, not
// just the bare word "човек" (which routinely appears in "2 човека" party-size
// answers to the mandatory questionnaire and would false-positive constantly).
const HUMAN_HANDOFF_PATTERN = /(говор[а-яА-Я]*|свърж[а-яА-Я]*)\s+(ме\s+)?с\s+(истински\s+|жив\s+)?(човек|оператор|представител|служител|агент)|не искам( да говоря)? с бот|дай ми (телефон на )?(служител|оператор|представител)|искам (истински |жив )?(оператор|представител)/i;

const HUMAN_HANDOFF_FALLBACK_MESSAGE = `Разбирам, че желаете да говорите с наш екип. Вашето запитване е пренасочено към оператор от екипа на Orient99.

Национален телефон: 0700 144 34
Пловдив: 032 622 174
София: 00359 2 987 01 07
Email: office@orient99.com

Ако желаете да продължите разговора с AI асистента, напишете: продължи разговора`;

@Injectable()
export class AppService {
  private openai: OpenAI;

  constructor(private readonly httpService: HttpService) {
    // TODO:: take this from the .env file or secrets
    const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
    this.openai = new OpenAI({
      apiKey: OPENAI_API_KEY,
    });
  };

  async start(): Promise<CreateThreadDto> {
    try {
      // A Conversation is the Responses-API replacement for a Thread
      const conversation = await this.openai.conversations.create({});
      return new CreateThreadDto(conversation.id);
    } catch (e) {
      console.log(`Error occured while trying to start a conversation: ${e}`);
      return new CreateThreadDto(null);
    }
  }

  async chat(data: CreateMessageDto): Promise<any> {
    const channel = data.channel ?? CHANNELS.WEBCHAT;

    if (data.ai_paused) {
      console.log(`[${channel}] AI paused for ${data.thread_id}, skipping reply for message: ${data.message}`);
      return { response: null, ai_paused: true };
    }

    let timeoutHandle: NodeJS.Timeout;
    const timeout = new Promise<any>((resolve) => {
      timeoutHandle = setTimeout(() => {
        console.log(`[${channel}] Request exceeded ${REQUEST_TIMEOUT_MS}ms, returning a fallback reply instead of letting the caller time out with nothing.`);
        resolve({ response: "Моля изчакайте, генерирам отговор." });
      }, REQUEST_TIMEOUT_MS);
    });

    try {
      return await Promise.race([this.chatCore(data, channel), timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async chatCore(data: CreateMessageDto, channel: CHANNELS): Promise<any> {
    const { thread_id, message, contact_id } = data;
    const instructions = this.buildInstructions(channel);
    const startedAt = Date.now();

    try {
      let response = await this.openai.responses.create({
        model: MODEL,
        instructions,
        tools: TOOLS as any,
        conversation: thread_id,
        input: [{ role: USER_ROLES.USER, content: message }],
      });

      const calledTools = new Set<string>();
      response = await this.resolveToolCalls(thread_id, instructions, response, channel, calledTools, contact_id);

      if (!response.output_text) {
        throw new Error('Model returned an empty response');
      }

      if (HUMAN_HANDOFF_PATTERN.test(message) && !calledTools.has('transfer_to_human')) {
        console.log(`[${channel}] Human handoff phrase detected but transfer_to_human wasn't called - forcing it.`);

        await SUPPORTED_ACTIONS['transfer_to_human'].apply(null, [
          { reason: 'Клиентът поиска да говори с оператор/представител.', customer_message: message, customer_name: '' },
          { thread_id, channel, contact_id },
        ]);

        const forcedResponse = this.enforceChannelLimit(HUMAN_HANDOFF_FALLBACK_MESSAGE, channel);
        console.log(`[${channel}] Reply (${forcedResponse.length} chars, forced handoff): ${forcedResponse}`);
        return { response: forcedResponse };
      }

      let outputText = this.stripOfferImage(response.output_text, channel);

      if (CHANNEL_CHAR_LIMITS[channel] && this.isReservationLinkBroken(outputText) && Date.now() - startedAt < RETRY_TIME_BUDGET_MS) {
        console.log(`[${channel}] Booking link looked cut off, retrying once...`);

        let retry = await this.openai.responses.create({
          model: MODEL,
          instructions,
          tools: TOOLS as any,
          conversation: thread_id,
          input: [{
            role: USER_ROLES.USER,
            content: 'Линкът за резервация в предходния отговор излезе отрязан/непълен. Изпрати повторно СЪЩАТА единствена оферта в пълния формат, но този път задължително с целия суров booking линк докрай, дори ако се наложи да съкратиш уводното изречение.',
          }],
        });
        retry = await this.resolveToolCalls(thread_id, instructions, retry, channel, calledTools, contact_id);

        const retryText = retry.output_text ? this.stripOfferImage(retry.output_text, channel) : '';
        if (retryText && !this.isReservationLinkBroken(retryText)) {
          outputText = retryText;
        }
      }

      const withoutDisclaimer = this.stripPriceDisclaimer(outputText, channel);
      const finalResponse = this.enforceChannelLimit(withoutDisclaimer, channel);
      console.log(`[${channel}] Reply (${finalResponse.length} chars): ${finalResponse}`);
      return { response: finalResponse };
    } catch (e) {
      console.log(`Error while trying to chat with the assistant: ${e}`);
      return { response: "Моля изчакайте, генерирам отговор." };
    }
  }

  /**
   * Appends a channel-specific length constraint to the base instructions.
   * Webchat is left untouched to preserve existing behavior.
   */
  private buildInstructions(channel: CHANNELS): string {
    const escalationReminder = '🚨 TOP PRIORITY - HUMAN ESCALATION\nIf the client\'s message expresses ANY desire to talk to a human, a real person, an operator, or a representative (e.g. "искам да говоря с човек", "дай ми оператор", "не искам бот", "свържете ме с представител"), you MUST call the transfer_to_human function as the very first action this turn - before writing any other reply, before asking clarifying questions, and before offering unrelated content. This overrides every other rule below, including the mandatory questionnaire.\n\n';

    const limit = CHANNEL_CHAR_LIMITS[channel];

    if (!limit) {
      return escalationReminder + INSTRUCTIONS;
    }

    const softTarget = Math.round(limit * 0.8);
    const imageRule = channel === CHANNELS.INSTAGRAM
      ? 'Do NOT include the "![...](...)" image/thumbnail line at all on this channel - go straight from the intro to the offer fields. This frees up room so the booking URL always fits.'
      : 'Keep the image, all mandatory fields, and the full raw booking URL.';

    return `${escalationReminder}${INSTRUCTIONS}\n\n🚨 CHANNEL LENGTH LIMIT\nThis reply is being sent over ${channel}. Your entire response MUST NOT exceed ${limit} characters, including spaces and formatting. Aim to comfortably finish within ${softTarget} characters, leaving margin so you never run out of room mid-sentence.\nTo stay within that limit, present EXACTLY ONE offer or hotel per response on this channel - never 2 or 3, even where webchat normally would. Pick the single best match.\nThat one offer MUST always be complete and MUST NOT be cut off or shortened: ${imageRule} Pair it with a short one-sentence intro.\nThe booking URL is the single most important part of the reply. NEVER trail off with "..." instead of writing it out, and NEVER end the reservation line without the full URL. If you are running low on room, shorten or drop the intro sentence first - never the URL.\nOutput the booking URL as a bare raw link (no "[линк](...)" or other markdown wrapping) - it is shorter and matches the required raw-URL format.\nSkip the "*Имайте предвид, че цените на офертите са ориентировъчни.*" disclaimer line on this channel - do not include it.`;
  }

  /**
   * The model doesn't reliably follow the "skip the price disclaimer"
   * instruction, so it's stripped here instead. Matches from "Имайте
   * предвид" to the end of the text so a self-truncated ("...ориентир…")
   * copy is removed too. Webchat is unaffected.
   */
  private stripPriceDisclaimer(text: string, channel: CHANNELS): string {
    if (!CHANNEL_CHAR_LIMITS[channel]) {
      return text;
    }

    return text.replace(/\n*\*?\s*Имайте предвид,?\s*че цените[\s\S]*$/i, '').trimEnd();
  }

  /**
   * Instagram drops the image line entirely to leave guaranteed room for the
   * booking URL - the model doesn't reliably skip it on its own, so it's
   * also stripped here. Messenger/webchat are unaffected.
   */
  private stripOfferImage(text: string, channel: CHANNELS): string {
    if (channel !== CHANNELS.INSTAGRAM) {
      return text;
    }

    return text.replace(/!\[[^\]]*\]\([^)]*\)\n*/g, '').trim();
  }

  /**
   * Detects the model trailing off (e.g. "🔗 Резервация:…") instead of
   * writing out the booking URL, which has been observed when it runs low
   * on its self-estimated character budget near the end of a reply.
   */
  private isReservationLinkBroken(text: string): boolean {
    const match = text.match(/Резервация:\s*(\S*)/);
    return !!match && !/^https?:\/\//i.test(match[1]);
  }

  /**
   * Last-resort safety net: the prompt asks the model to send exactly one
   * complete offer so it naturally fits, so this should rarely trigger.
   * Webchat is unaffected.
   */
  private enforceChannelLimit(text: string, channel: CHANNELS): string {
    const limit = CHANNEL_CHAR_LIMITS[channel];

    if (!limit || text.length <= limit) {
      return text;
    }

    const truncated = text.slice(0, limit - 1);
    const lastSpace = truncated.lastIndexOf(' ');
    const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;

    return `${cut}…`;
  }

  /**
   * Executes any function_call items the model returned and feeds their
   * outputs back into the same conversation, repeating until the model
   * stops calling tools (or MAX_TOOL_CALL_ROUNDS is reached).
   */
  private async resolveToolCalls(thread_id: string, instructions: string, response: OpenAI.Responses.Response, channel: CHANNELS, calledTools: Set<string>, contact_id?: string): Promise<OpenAI.Responses.Response> {
    let rounds = 0;

    while (response.output.some((item) => item.type === 'function_call') && rounds < MAX_TOOL_CALL_ROUNDS) {
      rounds++;

      const functionCalls = response.output.filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call'
      );

      const toolOutputs = [];

      for (const call of functionCalls) {
        const functionName = call.name;

        if (SUPPORTED_ACTIONS[functionName]) {
          console.log(`This question requires us to call a function: ${functionName}`);
          calledTools.add(functionName);

          const args = JSON.parse(call.arguments);
          const output = await SUPPORTED_ACTIONS[functionName].apply(null, [args, { thread_id, channel, contact_id }]);

          console.log(output?.toString());

          const outputString = typeof output === 'string' ? output : JSON.stringify(output);

          toolOutputs.push({
            type: 'function_call_output' as const,
            call_id: call.call_id,
            output: outputString,
          });
        } else {
          console.log(`This question requires us to call a function: ${functionName} which is not supported !`);
          toolOutputs.push({
            type: 'function_call_output' as const,
            call_id: call.call_id,
            output: 'Error: This tool is not supported',
          });
        }
      }

      response = await this.openai.responses.create({
        model: MODEL,
        instructions,
        tools: TOOLS as any,
        conversation: thread_id,
        input: toolOutputs,
      });
    }

    return response;
  }
}
