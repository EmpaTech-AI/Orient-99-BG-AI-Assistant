import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { CheckApiKeyMiddleware } from './middleware/check-api-key.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allow the webchat widget (served from a different origin) to call this API
  app.enableCors({
    origin: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
  });

  // Apply the CheckApiKeyMiddleware globally
  app.use(new CheckApiKeyMiddleware().use);

  // Apply the ValidationPipe globally
  app.useGlobalPipes(new ValidationPipe(
    {
      whitelist: true,
    }
  ));
  await app.listen(process.env.PORT || 3000);
}
bootstrap();
