import { Body, Controller, Get, Injectable, Module, NotFoundException, Patch } from '@nestjs/common';
import { Restaurant, UserRole } from '@prisma/client';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import { toNum } from '../../common/money';
import { Trim, TrimOrNull } from '../../common/validation';

export class UpdateRestaurantDto {
  @IsOptional()
  @Trim()
  @IsString({ message: 'El nombre debe ser texto' })
  @IsNotEmpty({ message: 'El nombre no puede estar vacío' })
  @MaxLength(120, { message: 'El nombre admite máximo 120 caracteres' })
  name?: string;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'El RUC debe ser texto' })
  @MaxLength(20, { message: 'El RUC admite máximo 20 caracteres' })
  ruc?: string | null;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'La dirección debe ser texto' })
  @MaxLength(250, { message: 'La dirección admite máximo 250 caracteres' })
  address?: string | null;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'El teléfono debe ser texto' })
  @MaxLength(30, { message: 'El teléfono admite máximo 30 caracteres' })
  phone?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'taxRate debe ser un número con máximo 2 decimales' })
  @Min(0, { message: 'taxRate no puede ser negativo' })
  @Max(100, { message: 'taxRate no puede ser mayor a 100' })
  taxRate?: number;

  @IsOptional()
  @IsBoolean({ message: 'pricesIncludeTax debe ser booleano' })
  pricesIncludeTax?: boolean;
}

export function toRestaurantDto(r: Restaurant) {
  return {
    id: r.id,
    name: r.name,
    ruc: r.ruc,
    address: r.address,
    phone: r.phone,
    taxRate: toNum(r.taxRate),
    pricesIncludeTax: r.pricesIncludeTax,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

@Injectable()
export class RestaurantService {
  constructor(private readonly prisma: PrismaService) {}

  async get(restaurantId: string) {
    const r = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Restaurante no encontrado');
    return toRestaurantDto(r);
  }

  async update(restaurantId: string, dto: UpdateRestaurantDto) {
    const r = await this.prisma.restaurant.update({ where: { id: restaurantId }, data: dto });
    return toRestaurantDto(r);
  }
}

@Controller('restaurant')
export class RestaurantController {
  constructor(private readonly service: RestaurantService) {}

  @Roles(UserRole.ADMIN, UserRole.CASHIER)
  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.service.get(user.restaurantId);
  }

  @Roles(UserRole.ADMIN)
  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateRestaurantDto) {
    return this.service.update(user.restaurantId, dto);
  }
}

@Module({
  controllers: [RestaurantController],
  providers: [RestaurantService],
})
export class RestaurantModule {}
