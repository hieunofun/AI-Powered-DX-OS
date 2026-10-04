import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Configure CORS: When behind APISIX API Gateway, APISIX acts as the external CORS authority.
  // When running standalone or in direct development, NestJS handles CORS as a fallback.
  const enableCors = process.env.ENABLE_CORS !== 'false';
  if (enableCors) {
    const corsOriginEnv = process.env.CORS_ORIGIN || 'http://localhost:3000';
    const corsOrigins = corsOriginEnv.includes(',')
      ? corsOriginEnv.split(',').map((origin) => origin.trim())
      : corsOriginEnv;

    app.enableCors({
      origin: corsOrigins,
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      credentials: true,
    });
    logger.log(`CORS enabled on backend for origins: ${JSON.stringify(corsOrigins)}`);
  } else {
    logger.log('CORS disabled on backend; APISIX API Gateway acts as external CORS authority');
  }

  const port = process.env.API_PORT || process.env.PORT || 4000;
  await app.listen(port);
  logger.log(`SmartProcure-Pay API running on port ${port} (Health: http://localhost:${port}/health)`);
}

bootstrap();
