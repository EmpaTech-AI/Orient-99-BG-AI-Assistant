import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
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

  // True when a human agent has taken over this conversation in GHL - the
  // AI must stay silent so it doesn't talk over them. Defaults to false.
  @IsOptional()
  @IsBoolean()
  ai_paused?: boolean;
}