import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { corsOrigins } from './cors';

/** Adapter Socket.IO con CORS tomado de CORS_ORIGINS. */
export class SocketIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: corsOrigins(), credentials: true },
    });
  }
}
