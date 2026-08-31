import { IsEnum, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { CHANNELS } from '../interfaces/enums';

export class CreateMessageDto {
  @IsNotEmpty()
  @IsString()
  thread_id: string;

  @MinLength(1)
  @IsString()
  message: string;

  // Where the message came from (GHL/Make.com forward this for Messenger/Instagram).
  // Defaults to webchat when omitted, preserving existing behavior.
  @IsOptional()
  @IsEnum(CHANNELS)
  channel?: CHANNELS;
}