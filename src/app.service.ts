import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpService } from '@nestjs/axios';
import { CreateMessageDto } from './dto/create-message.dto';
import { CreateThreadDto } from './dto/create-thread.dto';
import { CHANNELS, USER_ROLES } from './interfaces/enums';
import { MODEL, INSTRUCTIONS, CHANNEL_CHAR_LIMITS, TOOLS, SUPPORTED_ACTIONS } from './assistant/config';

require('dotenv').config();

const MAX_TOOL_CALL_ROUNDS = 8;

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
    const { thread_id, message } = data;
    const channel = data.channel ?? CHANNELS.WEBCHAT;
    const instructions = this.buildInstructions(channel);

    try {
      let response = await this.openai.responses.create({
        model: MODEL,
        instructions,
        tools: TOOLS as any,
        conversation: thread_id,
        input: [{ role: USER_ROLES.USER, content: message }],
      });

      response = await this.resolveToolCalls(thread_id, instructions, response);

      if (!response.output_text) {
        throw new Error('Model returned an empty response');
      }

      let outputText = this.stripOfferImage(response.output_text, channel);

      if (CHANNEL_CHAR_LIMITS[channel] && this.isReservationLinkBroken(outputText)) {
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
        retry = await this.resolveToolCalls(thread_id, instructions, retry);

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
    const limit = CHANNEL_CHAR_LIMITS[channel];

    if (!limit) {
      return INSTRUCTIONS;
    }

    const softTarget = Math.round(limit * 0.8);
    const imageRule = channel === CHANNELS.INSTAGRAM
      ? 'Do NOT include the "![...](...)" image/thumbnail line at all on this channel - go straight from the intro to the offer fields. This frees up room so the booking URL always fits.'
      : 'Keep the image, all mandatory fields, and the full raw booking URL.';

    return `${INSTRUCTIONS}\n\n🚨 CHANNEL LENGTH LIMIT\nThis reply is being sent over ${channel}. Your entire response MUST NOT exceed ${limit} characters, including spaces and formatting. Aim to comfortably finish within ${softTarget} characters, leaving margin so you never run out of room mid-sentence.\nTo stay within that limit, present EXACTLY ONE offer or hotel per response on this channel - never 2 or 3, even where webchat normally would. Pick the single best match.\nThat one offer MUST always be complete and MUST NOT be cut off or shortened: ${imageRule} Pair it with a short one-sentence intro.\nThe booking URL is the single most important part of the reply. NEVER trail off with "..." instead of writing it out, and NEVER end the reservation line without the full URL. If you are running low on room, shorten or drop the intro sentence first - never the URL.\nOutput the booking URL as a bare raw link (no "[линк](...)" or other markdown wrapping) - it is shorter and matches the required raw-URL format.\nSkip the "*Имайте предвид, че цените на офертите са ориентировъчни.*" disclaimer line on this channel - do not include it.`;
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
  private async resolveToolCalls(thread_id: string, instructions: string, response: OpenAI.Responses.Response): Promise<OpenAI.Responses.Response> {
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

          const args = JSON.parse(call.arguments);
          const output = await SUPPORTED_ACTIONS[functionName].apply(null, [args]);

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
