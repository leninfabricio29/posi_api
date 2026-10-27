import {
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
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import { Trim } from '../../common/validation';
import { RealtimeService } from '../realtime/realtime';

export class AreaDto {
  @Trim()
  @IsString({ message: 'El nombre es requerido' })
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(60, { message: 'El nombre admite máximo 60 caracteres' })
  name!: string;
}

type AreaRow = { id: string; name: string; createdAt: Date; _count: { tables: number } };
const toAreaDto = (a: AreaRow) => ({ id: a.id, name: a.name, tablesCount: a._count.tables, createdAt: a.createdAt });
const areaSelect = { id: true, name: true, createdAt: true, _count: { select: { tables: true } } } as const;

@Injectable()
export class AreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(restaurantId: string) {
    const areas = await this.prisma.area.findMany({ where: { restaurantId }, select: areaSelect, orderBy: { name: 'asc' } });
    return areas.map(toAreaDto);
  }

  async create(restaurantId: string, dto: AreaDto) {
    await this.ensureNameFree(restaurantId, dto.name);
    const a = await this.prisma.area.create({ data: { name: dto.name, restaurantId }, select: areaSelect });
    return toAreaDto(a);
  }

  async update(restaurantId: string, id: string, dto: AreaDto) {
    await this.findOwn(restaurantId, id);
    await this.ensureNameFree(restaurantId, dto.name, id);
    const a = await this.prisma.area.update({ where: { id }, data: { name: dto.name }, select: areaSelect });
    // las mesas del área cambian su areaName
    const tables = await this.prisma.table.findMany({ where: { areaId: id }, select: { id: true } });
    tables.forEach((t) => this.realtime.tableUpdated(restaurantId, t.id));
    return toAreaDto(a);
  }

  async remove(restaurantId: string, id: string) {
    const area = await this.findOwn(restaurantId, id);
    if (area._count.tables > 0) throw new ConflictException('El área tiene mesas; elimínelas o muévalas primero');
    await this.prisma.area.delete({ where: { id } });
    return { success: true };
  }

  private async findOwn(restaurantId: string, id: string) {
    const a = await this.prisma.area.findFirst({ where: { id, restaurantId }, select: areaSelect });
    if (!a) throw new NotFoundException('Área no encontrada');
    return a;
  }

  private async ensureNameFree(restaurantId: string, name: string, exceptId?: string) {
    const other = await this.prisma.area.findFirst({
      where: { restaurantId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw new ConflictException('Ya existe un área con ese nombre');
  }
}

@Controller('areas')
@Roles(UserRole.ADMIN, UserRole.CASHIER, UserRole.WAITER)
export class AreasController {
  constructor(private readonly service: AreasService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.restaurantId);
  }

  @Roles(UserRole.ADMIN)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: AreaDto) {
    return this.service.create(user.restaurantId, dto);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AreaDto) {
    return this.service.update(user.restaurantId, id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.restaurantId, id);
  }
}

@Module({
  controllers: [AreasController],
  providers: [AreasService],
})
export class AreasModule {}
