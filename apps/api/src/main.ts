import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Enable Cross-Origin Resource Sharing for frontend client
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const port = process.env.API_PORT || process.env.PORT || 4000;
  await app.listen(port);
  logger.log(`SmartProcure-Pay API running on port ${port} (Health: http://localhost:${port}/health)`);
}

bootstrap();
