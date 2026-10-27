import {
  Body,
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
import { Printer, PrinterConnection, PrinterPurpose, UserRole } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import { Trim, TrimOrNull } from '../../common/validation';

const CONN_MSG = 'connectionType debe ser BLUETOOTH, NETWORK o USB';
const PURPOSE_MSG = 'purpose debe ser CASHIER, KITCHEN o BAR';
const WIDTH_MSG = 'paperWidth debe ser 58 u 80';

export class CreatePrinterDto {
  @Trim()
  @IsString({ message: 'El nombre es requerido' })
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(80, { message: 'El nombre admite máximo 80 caracteres' })
  name!: string;

  @IsEnum(PrinterConnection, { message: CONN_MSG })
  connectionType!: PrinterConnection;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'address debe ser texto' })
  @MaxLength(120, { message: 'address admite máximo 120 caracteres' })
  address?: string | null;

  @IsIn([58, 80], { message: WIDTH_MSG })
  paperWidth!: number;

  @IsEnum(PrinterPurpose, { message: PURPOSE_MSG })
  purpose!: PrinterPurpose;

  @IsOptional()
  @IsBoolean({ message: 'isDefault debe ser booleano' })
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'isActive debe ser booleano' })
  isActive?: boolean;
}

export class UpdatePrinterDto {
  @IsOptional()
  @Trim()
  @IsString({ message: 'El nombre debe ser texto' })
  @IsNotEmpty({ message: 'El nombre no puede estar vacío' })
  @MaxLength(80, { message: 'El nombre admite máximo 80 caracteres' })
  name?: string;

  @IsOptional()
  @IsEnum(PrinterConnection, { message: CONN_MSG })
  connectionType?: PrinterConnection;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'address debe ser texto' })
  @MaxLength(120, { message: 'address admite máximo 120 caracteres' })
  address?: string | null;

  @IsOptional()
  @IsIn([58, 80], { message: WIDTH_MSG })
  paperWidth?: number;

  @IsOptional()
  @IsEnum(PrinterPurpose, { message: PURPOSE_MSG })
  purpose?: PrinterPurpose;

  @IsOptional()
  @IsBoolean({ message: 'isDefault debe ser booleano' })
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'isActive debe ser booleano' })
  isActive?: boolean;
}

const toPrinterDto = (p: Printer) => ({
  id: p.id,
  name: p.name,
  connectionType: p.connectionType,
  address: p.address,
  paperWidth: p.paperWidth,
  purpose: p.purpose,
  isDefault: p.isDefault,
  isActive: p.isActive,
  createdAt: p.createdAt,
});

@Injectable()
export class PrintersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(restaurantId: string) {
    const printers = await this.prisma.printer.findMany({
      where: { restaurantId },
      orderBy: [{ purpose: 'asc' }, { name: 'asc' }],
    });
    return printers.map(toPrinterDto);
  }

  async create(restaurantId: string, dto: CreatePrinterDto) {
    const p = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.printer.updateMany({ where: { restaurantId, purpose: dto.purpose }, data: { isDefault: false } });
      }
      return tx.printer.create({
        data: {
          name: dto.name,
          connectionType: dto.connectionType,
          address: dto.address ?? null,
          paperWidth: dto.paperWidth,
          purpose: dto.purpose,
          isDefault: dto.isDefault ?? false,
          isActive: dto.isActive ?? true,
          restaurantId,
        },
      });
    });
    return toPrinterDto(p);
  }

  async update(restaurantId: string, id: string, dto: UpdatePrinterDto) {
    const existing = await this.findOwn(restaurantId, id);
    const p = await this.prisma.$transaction(async (tx) => {
      const purpose = dto.purpose ?? existing.purpose;
      const willBeDefault = dto.isDefault ?? existing.isDefault;
      if (willBeDefault) {
        await tx.printer.updateMany({
          where: { restaurantId, purpose, NOT: { id } },
          data: { isDefault: false },
        });
      }
      return tx.printer.update({ where: { id }, data: dto });
    });
    return toPrinterDto(p);
  }

  async remove(restaurantId: string, id: string) {
    await this.findOwn(restaurantId, id);
    await this.prisma.printer.delete({ where: { id } });
    return { success: true };
  }

  private async findOwn(restaurantId: string, id: string) {
    const p = await this.prisma.printer.findFirst({ where: { id, restaurantId } });
    if (!p) throw new NotFoundException('Impresora no encontrada');
    return p;
  }
}

@Controller('printers')
@Roles(UserRole.ADMIN, UserRole.CASHIER)
export class PrintersController {
  constructor(private readonly service: PrintersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.restaurantId);
  }

  @Roles(UserRole.ADMIN)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePrinterDto) {
    return this.service.create(user.restaurantId, dto);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdatePrinterDto) {
    return this.service.update(user.restaurantId, id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.restaurantId, id);
  }
}

@Module({
  controllers: [PrintersController],
  providers: [PrintersService],
})
export class PrintersModule {}
