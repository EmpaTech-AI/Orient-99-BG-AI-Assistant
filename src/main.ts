import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { CheckApiKeyMiddleware } from './middleware/check-api-key.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Apply the CheckApiKeyMiddleware globally
  app.use(new CheckApiKeyMiddleware().use);

  // Apply the ValidationPipe globally
  app.useGlobalPipes(new ValidationPipe(
    {
      whitelist: true,
    }
  ));
  await app.listen(3000);
}
bootstrap();
