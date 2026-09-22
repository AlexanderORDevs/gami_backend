import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const apiPrefix = config.get<string>('API_PREFIX', 'api');
  const frontendUrl = config.getOrThrow<string>('FRONTEND_URL');
  const port = Number(
    config.get<string>('PORT') ?? config.get<string>('APP_PORT', '4000'),
  );

  app.setGlobalPrefix(apiPrefix);
  app.enableCors({
    origin: frontendUrl,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const openApiConfig = new DocumentBuilder()
    .setTitle('Gami API')
    .setVersion('1.0.0')
    .setDescription('API contract for the Gami marketplace')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () =>
    SwaggerModule.createDocument(app, openApiConfig),
  );

  await app.listen(port);
}
await bootstrap();
