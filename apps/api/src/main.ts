import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Global validation pipe: Enforce strict DTO validation without mass assignment
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

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

  // Swagger OpenAPI documentation:
  // Hardened production default: OFF unless explicitly ENABLE_SWAGGER=true.
  // In development and test environments: ON unless explicitly disabled.
  const isProduction = process.env.NODE_ENV === 'production';
  const enableSwagger =
    process.env.ENABLE_SWAGGER === 'true' ||
    (!isProduction && process.env.ENABLE_SWAGGER !== 'false');
  if (enableSwagger) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('SmartProcure-Pay Core API')
      .setDescription(
        'Procure-to-Pay (P2P) Platform Backend API with Keycloak OIDC authentication and Apache APISIX Gateway routing',
      )
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'JWT',
          description: 'Keycloak Bearer Access Token',
          in: 'header',
        },
        'bearer',
      )
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
    logger.log('Swagger OpenAPI documentation available at /docs');
  }

  const port = process.env.API_PORT || process.env.PORT || 4000;
  await app.listen(port);
  logger.log(`SmartProcure-Pay API running on port ${port} (Health: http://localhost:${port}/health)`);
}

bootstrap();
