import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpService } from '@nestjs/axios';
import { CreateMessageDto } from './dto/create-message.dto';
import { CreateThreadDto } from './dto/create-thread.dto';
import { USER_ROLES } from './interfaces/enums';
import { MODEL, INSTRUCTIONS, TOOLS, SUPPORTED_ACTIONS } from './assistant/config';

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
      console.log(`Error occured while trying to start a conversation: ${e}`)
    }
  }

  async chat(data: CreateMessageDto): Promise<any> {
    const { thread_id, message } = data;

    try {
      let response = await this.openai.responses.create({
        model: MODEL,
        instructions: INSTRUCTIONS,
        tools: TOOLS as any,
        conversation: thread_id,
        input: [{ role: USER_ROLES.USER, content: message }],
      });

      response = await this.resolveToolCalls(thread_id, response);

      if (!response.output_text) {
        throw new Error('Model returned an empty response');
      }

      return { response: response.output_text };
    } catch (e) {
      console.log(`Error while trying to chat with the assistant: ${e}`);
      return { response: "Моля изчакайте, генерирам отговор." };
    }
  }

  /**
   * Executes any function_call items the model returned and feeds their
   * outputs back into the same conversation, repeating until the model
   * stops calling tools (or MAX_TOOL_CALL_ROUNDS is reached).
   */
  private async resolveToolCalls(thread_id: string, response: OpenAI.Responses.Response): Promise<OpenAI.Responses.Response> {
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
        instructions: INSTRUCTIONS,
        tools: TOOLS as any,
        conversation: thread_id,
        input: toolOutputs,
      });
    }

    return response;
  }
}
