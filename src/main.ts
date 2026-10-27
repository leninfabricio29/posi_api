import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { corsOrigins } from './common/cors';
import { SocketIoAdapter } from './common/socket-io.adapter';
import { buildValidationPipe } from './common/validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
