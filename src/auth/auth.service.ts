import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { toUserDto, userSelect, UserRow } from '../modules/users/user.mapper';
import { JwtPayload } from './auth-user';

const ACCESS_TTL = '1h';
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { ...userSelect, password: true },
    });
    // Comparar siempre para no filtrar si el email existe por tiempo de respuesta
    const ok = await bcrypt.compare(password, user?.password ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    if (!user || !ok) throw new UnauthorizedException('Credenciales inválidas');
    if (!user.isActive) throw new UnauthorizedException('Usuario inactivo');
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; jti: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!stored || stored.userId !== payload.sub) {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }
    if (stored.revokedAt) {
      // Reutilización de un token ya rotado: se revocan todas las sesiones del usuario
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token revocado');
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedException('Refresh token inválido o expirado');

    // Rotación atómica: solo una petición puede revocar este token
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) throw new UnauthorizedException('Refresh token revocado');

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId }, select: userSelect });
    if (!user) throw new UnauthorizedException('Usuario no encontrado');
    if (!user.isActive) throw new UnauthorizedException('Usuario inactivo');
    return this.issueTokens(user);
  }

  async logout(userId: string, refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return toUserDto(user);
  }

  private async issueTokens(user: UserRow) {
    const payload: JwtPayload = { sub: user.id, role: user.role, restaurantId: user.restaurantId };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      expiresIn: ACCESS_TTL,
    });
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti: randomUUID() },
      { secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'), expiresIn: REFRESH_TTL_SECONDS },
    );
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      },
    });
    // Limpieza oportunista de tokens vencidos del usuario
    await this.prisma.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });

    return { accessToken, refreshToken, user: toUserDto(user) };
  }
}
