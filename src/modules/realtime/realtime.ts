import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../../auth/auth-user';
import { loadOrderDto, loadTableDto } from '../shared/views';

export const roomOf = (restaurantId: string) => `restaurant:${restaurantId}`;

/**
 * Servicio inyectable para emitir eventos a la sala del restaurante.
 * Llamar SIEMPRE después del commit de la transacción. Nunca lanza: los fallos se registran.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger('Realtime');
  private server?: Namespace;

  constructor(private readonly prisma: PrismaService) {}

  attach(server: Namespace) {
    this.server = server;
  }

  emit(restaurantId: string, event: string, payload: unknown) {
    try {
      this.server?.to(roomOf(restaurantId)).emit(event, payload);
    } catch (e) {
      this.logger.warn(`No se pudo emitir ${event}: ${(e as Error).message}`);
    }
  }

  tableUpdated(restaurantId: string, tableId: string | null | undefined) {
    if (!tableId) return;
    this.run('table.updated', async () => {
      const t = await loadTableDto(this.prisma, tableId);
      if (t) this.emit(restaurantId, 'table.updated', t);
    });
  }

  orderCreated(restaurantId: string, orderId: string) {
    this.run('order.created', async () => {
      const o = await loadOrderDto(this.prisma, orderId);
      if (o) this.emit(restaurantId, 'order.created', o);
    });
  }

  orderUpdated(restaurantId: string, orderId: string) {
    this.run('order.updated', async () => {
      const o = await loadOrderDto(this.prisma, orderId);
      if (o) this.emit(restaurantId, 'order.updated', o);
    });
  }

  cashUpdated(restaurantId: string, registerId: string, status: 'OPEN' | 'CLOSED') {
    this.emit(restaurantId, 'cash.updated', { registerId, status });
  }

  private run(event: string, fn: () => Promise<void>) {
    fn().catch((e) => this.logger.warn(`No se pudo emitir ${event}: ${(e as Error).message}`));
  }
}

@WebSocketGateway({ namespace: '/realtime' })
export class RealtimeGateway implements OnGatewayInit<Namespace>, OnGatewayConnection<Socket> {
  private readonly logger = new Logger('RealtimeGateway');

  constructor(
    private readonly realtime: RealtimeService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: Namespace) {
    this.realtime.attach(server);
  }

  async handleConnection(client: Socket) {
    try {
      const raw =
        (client.handshake.auth?.token as string | undefined) ??
        client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!raw) throw new Error('sin token');
      const payload = await this.jwt.verifyAsync<JwtPayload>(raw, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, isActive: true, restaurantId: true, role: true },
      });
      if (!user || !user.isActive) throw new Error('usuario inválido o inactivo');
      client.data.user = user;
      await client.join(roomOf(user.restaurantId));
      client.emit('ready', { restaurantId: user.restaurantId });
    } catch (e) {
      this.logger.debug(`Conexión rechazada: ${(e as Error).message}`);
      client.emit('unauthorized', { message: 'Token inválido o expirado' });
      client.disconnect(true);
    }
  }
}

@Global()
@Module({
  providers: [RealtimeService, RealtimeGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
