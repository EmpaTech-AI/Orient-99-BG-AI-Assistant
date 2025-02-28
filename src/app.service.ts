import { Injectable } from '@nestjs/common';
import * as ASSISTANT_CONFIGURATION from '../assistant/assistant.json';
import OpenAI from 'openai';
import { HttpService } from '@nestjs/axios';
import { CreateMessageDto } from './dto/create-message.dto';
import { CreateThreadDto } from './dto/create-thread.dto';
import { SECONDS, USER_ROLES } from './interfaces/enums';
const { capture_lead } = require('./tools/capture-lead');
const { capture_complaint } = require('./tools/capture-complaint');
// const { fetch_data } = require('./tools/fetch-data');
// const { fetch_cruise } = require('./tools/fetch-cruise');
// const { fetch_own_transport } = require('./tools/fetch-own-transport');


require('dotenv').config();

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
      // Create a thread using the assistantId
      const thread = await this.openai.beta.threads.create();
      return new CreateThreadDto(thread.id);
    } catch (e) {
      console.log(`Error occured while trying to start a conversation: ${e}`)
    }
  }

  async chat(data: CreateMessageDto): Promise<any> {
    const { assistantId } = ASSISTANT_CONFIGURATION;
    const { thread_id, message } = data;

    try {

      const activeRun = await this.getActiveRun(thread_id);
      if (activeRun) {
        return { response: "Моля изчакайте, генерирам отговор." };
      }

      // Pass in the user question into the existing thread
      await this.openai.beta.threads.messages.create(thread_id, {
        role: USER_ROLES.USER,
        content: message,
      });

      // Create a run
      const run = await this.openai.beta.threads.runs.create(thread_id, {
        assistant_id: assistantId,
      });

      // Poll the status of the run
      await this.pollStatusUntillCompleted(thread_id, run.id);

      // Find the last message for the current run
      const lastMessageForRun = await this.getLatestMessageFromThread(thread_id, run.id);
      // @ts-ignore
      return { response: lastMessageForRun.content[0].text.value };
    } catch (e) {
      console.log(`Error while trying to chat with the assistant: ${e}`);
      return { response: "Моля изчакайте, генерирам отговор." };
    }
  }

  /**
   * This method polls the run status on every 5 seconds untill it's completed or error
   * In need calls the appropriate actions
   * @param thread_id 
   * @param runId 
   * @returns a Run
   */
  private async pollStatusUntillCompleted(thread_id: string, runId: string): Promise<OpenAI.Beta.Threads.Runs.Run> {
    // Imediately fetch run-status, which will be "in_progress"
    let runStatus = await this.openai.beta.threads.runs.retrieve(
      thread_id,
      runId
    );

    console.log(`Run ${runId} status: ${runStatus.status} `);

    // Polling mechanism to see if runStatus is completed
    while (runStatus.status !== 'completed') {
      await new Promise((resolve) => setTimeout(resolve, SECONDS.FIVE));

      console.log(`Run ${runId} status: ${runStatus.status} `);

      runStatus = await this.openai.beta.threads.runs.retrieve(
        thread_id,
        runId
      );

      if (runStatus.status === 'requires_action') {
        const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
        const toolOutputs = [];

        const SUPPORTED_ACTIONS = {
          'capture_lead': capture_lead,
          'capture_complaint': capture_complaint,
          // 'fetch_data': fetch_data,
          // 'fetch_cruise': fetch_cruise,
          // 'fetch_own_transport': fetch_own_transport
        };

        for (const toolCall of toolCalls) {
          const functionName = toolCall.function.name;

          if (SUPPORTED_ACTIONS[functionName]) {
            console.log(`This question requires us to call a function: ${functionName}`);

            const args = JSON.parse(toolCall.function.arguments);

            // Dynamically call the function with arguments
            const output = await SUPPORTED_ACTIONS[functionName].apply(null, [args]);

            console.log(output.toString())

            const outputString = typeof output === 'string' ? output : JSON.stringify(output);

            toolOutputs.push({
              tool_call_id: toolCall.id,
              output: outputString,
            });
          } else {
            console.log(`This question requires us to call a function: ${functionName} which is not supported !`);
            // This should not happen, we should always have the functions which are mentioned in the instructions of the assistant
            // Still generate the output for the tool, since the run expects it
            toolOutputs.push({
              tool_call_id: toolCall.id,
              output: 'Error: This tool is not supported',
            });
          }
        }
        // Submit tool outputs
        await this.openai.beta.threads.runs.submitToolOutputs(
          thread_id,
          runId,
          { tool_outputs: toolOutputs }
        );
        continue; // Continue polling for the final response
      }

      // Check for failed, cancelled, or expired status
      if (["failed", "cancelled", "expired"].includes(runStatus.status)) {
        console.log(
          `Run status is '${runStatus.status}'. Unable to complete the request.`
        );
        break; // Exit the loop if the status indicates a failure or cancellation
      }
    }

    console.log(`Run ${runId} status: ${runStatus.status} `);

    return runStatus
  }

  /**
   * Find the last message for the current run
   * @param thread_id 
   * @param run_id 
   * @returns 
   */
  private async getLatestMessageFromThread(thread_id: string, run_id): Promise<OpenAI.Beta.Threads.Messages.Message> {
    // Get the last assistant message from the messages array
    const messages = await this.openai.beta.threads.messages.list(thread_id);

    const lastMessageForRun = messages.data
      .filter(
        (message) =>
          message.run_id === run_id && message.role === USER_ROLES.ASSISTANT
      )
      .pop();
    return lastMessageForRun;
  }

  private async getActiveRun(thread_id: string): Promise<OpenAI.Beta.Threads.Runs.Run | null> {
    const runs = await this.openai.beta.threads.runs.list(thread_id);
    return runs.data.find(run => run.status === 'in_progress') || null;
  }
}


