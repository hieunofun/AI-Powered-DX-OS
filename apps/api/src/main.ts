import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Configure CORS using environment variable with a safe localhost default
  const corsOriginEnv = process.env.CORS_ORIGIN || 'http://localhost:3000';
  const corsOrigins = corsOriginEnv.includes(',')
    ? corsOriginEnv.split(',').map((origin) => origin.trim())
    : corsOriginEnv;

  app.enableCors({
    origin: corsOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const port = process.env.API_PORT || process.env.PORT || 4000;
  await app.listen(port);
  logger.log(`SmartProcure-Pay API running on port ${port} (Health: http://localhost:${port}/health)`);
  logger.log(`CORS allowed origins: ${JSON.stringify(corsOrigins)}`);
}

bootstrap();
