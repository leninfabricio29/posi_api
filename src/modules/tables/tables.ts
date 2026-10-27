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
import { UserRole } from '@prisma/client';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import { Trim } from '../../common/validation';
import { RealtimeService } from '../realtime/realtime';
import { ACTIVE_ORDER_STATUS, byNaturalName, tableInclude, toTableDto } from '../shared/views';

export class CreateTableDto {
  @Trim()
  @IsString({ message: 'El nombre es requerido' })
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(40, { message: 'El nombre admite máximo 40 caracteres' })
  name!: string;

  @IsString({ message: 'areaId es requerido' })
  @IsNotEmpty({ message: 'areaId es requerido' })
  areaId!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt({ message: 'seats debe ser un entero' })
  @Min(1, { message: 'seats debe ser al menos 1' })
  @Max(100, { message: 'seats no puede ser mayor a 100' })
  seats?: number | null;
}

export class UpdateTableDto {
  @IsOptional()
  @Trim()
  @IsString({ message: 'El nombre debe ser texto' })
  @IsNotEmpty({ message: 'El nombre no puede estar vacío' })
  @MaxLength(40, { message: 'El nombre admite máximo 40 caracteres' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'areaId debe ser texto' })
  @IsNotEmpty({ message: 'areaId no puede estar vacío' })
  areaId?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt({ message: 'seats debe ser un entero' })
  @Min(1, { message: 'seats debe ser al menos 1' })
  @Max(100, { message: 'seats no puede ser mayor a 100' })
  seats?: number | null;
}
// El estado de la mesa NO se edita a mano: OCCUPIED al abrir pedido, AVAILABLE al cobrarlo.

export class ListTablesQuery {
  @IsOptional()
  @IsString({ message: 'areaId debe ser texto' })
  areaId?: string;
}

@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(restaurantId: string, areaId?: string) {
    const tables = await this.prisma.table.findMany({
      where: { restaurantId, areaId: areaId || undefined },
      include: tableInclude,
    });
    return tables
      .sort((a, b) => a.area.name.localeCompare(b.area.name, 'es') || byNaturalName(a, b))
      .map(toTableDto);
  }

  async map(restaurantId: string) {
    const areas = await this.prisma.area.findMany({
      where: { restaurantId },
      orderBy: { name: 'asc' },
      include: { tables: { include: tableInclude } },
    });
    return areas.map((a) => ({
      id: a.id,
      name: a.name,
      tables: a.tables.sort(byNaturalName).map(toTableDto),
    }));
  }

  async create(restaurantId: string, dto: CreateTableDto) {
    await this.ensureArea(restaurantId, dto.areaId);
    await this.ensureNameFree(restaurantId, dto.name);
    const t = await this.prisma.table.create({
      data: { name: dto.name, areaId: dto.areaId, seats: dto.seats ?? null, restaurantId },
      include: tableInclude,
    });
    this.realtime.tableUpdated(restaurantId, t.id);
    return toTableDto(t);
  }

  async update(restaurantId: string, id: string, dto: UpdateTableDto) {
    const table = await this.findOwn(restaurantId, id);
    if (dto.areaId) await this.ensureArea(restaurantId, dto.areaId);
    if (dto.name && dto.name !== table.name) await this.ensureNameFree(restaurantId, dto.name, id);
    const t = await this.prisma.table.update({
      where: { id },
      data: { name: dto.name, areaId: dto.areaId, seats: dto.seats },
      include: tableInclude,
    });
    this.realtime.tableUpdated(restaurantId, t.id);
    return toTableDto(t);
  }

  async remove(restaurantId: string, id: string) {
    const table = await this.findOwn(restaurantId, id);
    if (table.orders.length > 0) throw new ConflictException('La mesa tiene un pedido activo');
    // Los pedidos históricos quedan con tableId = null (onDelete: SetNull)
    await this.prisma.table.delete({ where: { id } });
    return { success: true };
  }

  private async findOwn(restaurantId: string, id: string) {
    const t = await this.prisma.table.findFirst({
      where: { id, restaurantId },
      include: { orders: { where: { status: ACTIVE_ORDER_STATUS }, select: { id: true } } },
    });
    if (!t) throw new NotFoundException('Mesa no encontrada');
    return t;
  }

  private async ensureArea(restaurantId: string, areaId: string) {
    const area = await this.prisma.area.findFirst({ where: { id: areaId, restaurantId }, select: { id: true } });
    if (!area) throw new BadRequestException('El área no existe');
  }

  private async ensureNameFree(restaurantId: string, name: string, exceptId?: string) {
    const other = await this.prisma.table.findFirst({
      where: { restaurantId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw new ConflictException('Ya existe una mesa con ese nombre');
  }
}

@Controller('tables')
@Roles(UserRole.ADMIN, UserRole.CASHIER, UserRole.WAITER)
export class TablesController {
  constructor(private readonly service: TablesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListTablesQuery) {
    return this.service.list(user.restaurantId, q.areaId);
  }

  @Get('map')
  map(@CurrentUser() user: AuthUser) {
    return this.service.map(user.restaurantId);
  }

  @Roles(UserRole.ADMIN)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTableDto) {
    return this.service.create(user.restaurantId, dto);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateTableDto) {
    return this.service.update(user.restaurantId, id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.restaurantId, id);
  }
}

@Module({
  controllers: [TablesController],
  providers: [TablesService],
})
export class TablesModule {}
