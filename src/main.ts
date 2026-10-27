import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { corsOrigins } from './common/cors';
import { SocketIoAdapter } from './common/socket-io.adapter';
import { buildValidationPipe } from './common/validation';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Detrás de Nginx / Nginx Proxy Manager: usar la IP real del cliente (X-Forwarded-For).
  // Sin esto, el límite de intentos de login contaría a todos los usuarios como una sola IP (la del proxy).
  // Por defecto solo se confía en proxies de red local/Docker.
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

  app.use(helmet());
  app.enableCors({ origin: corsOrigins(), credentials: true });
  app.useGlobalPipes(buildValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new SocketIoAdapter(app));
  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || 4010;
  await app.listen(port);
  Logger.log(`API Triada POS escuchando en http://localhost:${port}`, 'Bootstrap');
}

bootstrap();
