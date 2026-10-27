import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import { ToBoolean, Trim } from '../../common/validation';
import { toUserDto, userSelect } from './user.mapper';

const lower = () => Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));
const ROLE_MSG = 'El rol debe ser ADMIN, CASHIER o WAITER';

export class CreateUserDto {
  @Trim()
  @IsString({ message: 'El nombre es requerido' })
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(100, { message: 'El nombre admite máximo 100 caracteres' })
  name!: string;

  @lower()
  @IsEmail({}, { message: 'El email no es válido' })
  email!: string;

  @IsString({ message: 'La contraseña es requerida' })
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres' })
  @MaxLength(72, { message: 'La contraseña admite máximo 72 caracteres' })
  password!: string;

  @IsEnum(UserRole, { message: ROLE_MSG })
  role!: UserRole;
}

export class UpdateUserDto {
  @IsOptional()
  @Trim()
  @IsString({ message: 'El nombre debe ser texto' })
  @IsNotEmpty({ message: 'El nombre no puede estar vacío' })
  @MaxLength(100, { message: 'El nombre admite máximo 100 caracteres' })
  name?: string;

  @IsOptional()
  @lower()
  @IsEmail({}, { message: 'El email no es válido' })
  email?: string;

  @IsOptional()
  @IsString({ message: 'La contraseña debe ser texto' })
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres' })
  @MaxLength(72, { message: 'La contraseña admite máximo 72 caracteres' })
  password?: string;

  @IsOptional()
  @IsEnum(UserRole, { message: ROLE_MSG })
  role?: UserRole;

  @IsOptional()
  @IsBoolean({ message: 'isActive debe ser booleano' })
  isActive?: boolean;
}

export class ListUsersQuery {
  @IsOptional()
  @IsEnum(UserRole, { message: ROLE_MSG })
  role?: UserRole;

  @IsOptional()
  @ToBoolean()
  @IsBoolean({ message: 'active debe ser true o false' })
  active?: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(restaurantId: string, q: ListUsersQuery) {
    const users = await this.prisma.user.findMany({
      where: { restaurantId, role: q.role, isActive: q.active },
      select: userSelect,
      orderBy: { name: 'asc' },
    });
    return users.map(toUserDto);
  }

  async create(restaurantId: string, dto: CreateUserDto) {
    await this.ensureEmailFree(dto.email);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        password: await bcrypt.hash(dto.password, 10),
        role: dto.role,
        restaurantId,
      },
      select: userSelect,
    });
    return toUserDto(user);
  }

  async update(current: AuthUser, id: string, dto: UpdateUserDto) {
    const existing = await this.findOwn(current.restaurantId, id);
    if (id === current.id) {
      if (dto.isActive === false) throw new BadRequestException('No puede desactivar su propio usuario');
      if (dto.role && dto.role !== UserRole.ADMIN) {
        throw new BadRequestException('No puede quitarse a sí mismo el rol de administrador');
      }
    }
    if (dto.email && dto.email !== existing.email.toLowerCase()) await this.ensureEmailFree(dto.email, id);

    const data: Prisma.UserUpdateInput = {
      name: dto.name,
      email: dto.email,
      role: dto.role,
      isActive: dto.isActive,
    };
    if (dto.password) data.password = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id }, data, select: userSelect });
      // Cambio de contraseña o desactivación: cerrar sesiones abiertas
      if (dto.password || dto.isActive === false) {
        await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      return u;
    });
    return toUserDto(user);
  }

  async remove(current: AuthUser, id: string) {
    await this.findOwn(current.restaurantId, id);
    if (id === current.id) throw new BadRequestException('No puede eliminar su propio usuario');

    const [orders, sales, opened, closed, movements] = await Promise.all([
      this.prisma.order.count({ where: { userId: id } }),
      this.prisma.sale.count({ where: { userId: id } }),
      this.prisma.cashRegister.count({ where: { openedById: id } }),
      this.prisma.cashRegister.count({ where: { closedById: id } }),
      this.prisma.cashMovement.count({ where: { userId: id } }),
    ]);
    if (orders + sales + opened + closed + movements > 0) {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id }, data: { isActive: false } }),
        this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
      ]);
      return { success: true, deactivated: true };
    }
    await this.prisma.user.delete({ where: { id } });
    return { success: true };
  }

  private async findOwn(restaurantId: string, id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, restaurantId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return user;
  }

  private async ensureEmailFree(email: string, exceptId?: string) {
    const other = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
      select: { id: true },
    });
    if (other) throw new ConflictException('El email ya está registrado');
  }
}

@Controller('users')
@Roles(UserRole.ADMIN)
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListUsersQuery) {
    return this.service.list(user.restaurantId, q);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.service.create(user.restaurantId, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.service.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user, id);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
