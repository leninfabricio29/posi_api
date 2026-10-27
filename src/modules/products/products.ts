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
  Query,
} from '@nestjs/common';
import { Product, UserRole } from '@prisma/client';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import { dec, toNum } from '../../common/money';
import { ToBoolean, Trim, TrimOrNull } from '../../common/validation';

const PRICE_MSG = 'El precio debe ser un número con máximo 2 decimales';

export class CreateProductDto {
  @Trim()
  @IsString({ message: 'El nombre es requerido' })
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @MaxLength(120, { message: 'El nombre admite máximo 120 caracteres' })
  name!: string;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'La descripción debe ser texto' })
  @MaxLength(500, { message: 'La descripción admite máximo 500 caracteres' })
  description?: string | null;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: PRICE_MSG })
  @Min(0, { message: 'El precio no puede ser negativo' })
  @Max(99999999, { message: 'El precio es demasiado alto' })
  price!: number;

  @IsBoolean({ message: 'taxable es requerido (true/false)' })
  taxable!: boolean;

  @IsOptional()
  @IsBoolean({ message: 'available debe ser booleano' })
  available?: boolean;
}

export class UpdateProductDto {
  @IsOptional()
  @Trim()
  @IsString({ message: 'El nombre debe ser texto' })
  @IsNotEmpty({ message: 'El nombre no puede estar vacío' })
  @MaxLength(120, { message: 'El nombre admite máximo 120 caracteres' })
  name?: string;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'La descripción debe ser texto' })
  @MaxLength(500, { message: 'La descripción admite máximo 500 caracteres' })
  description?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: PRICE_MSG })
  @Min(0, { message: 'El precio no puede ser negativo' })
  @Max(99999999, { message: 'El precio es demasiado alto' })
  price?: number;

  @IsOptional()
  @IsBoolean({ message: 'taxable debe ser booleano' })
  taxable?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'available debe ser booleano' })
  available?: boolean;
}

export class ListProductsQuery {
  @IsOptional()
  @IsString({ message: 'search debe ser texto' })
  search?: string;

  @IsOptional()
  @ToBoolean()
  @IsBoolean({ message: 'available debe ser true o false' })
  available?: boolean;
}

const toProductDto = (p: Product) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  price: toNum(p.price),
  taxable: p.taxable,
  available: p.available,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(restaurantId: string, q: ListProductsQuery) {
    const search = q.search?.trim();
    const products = await this.prisma.product.findMany({
      where: {
        restaurantId,
        available: q.available,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
    });
    return products.map(toProductDto);
  }

  async create(restaurantId: string, dto: CreateProductDto) {
    const p = await this.prisma.product.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        price: dec(dto.price),
        taxable: dto.taxable,
        available: dto.available ?? true,
        restaurantId,
      },
    });
    return toProductDto(p);
  }

  async update(restaurantId: string, id: string, dto: UpdateProductDto) {
    await this.findOwn(restaurantId, id);
    const p = await this.prisma.product.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        price: dto.price !== undefined ? dec(dto.price) : undefined,
        taxable: dto.taxable,
        available: dto.available,
      },
    });
    return toProductDto(p);
  }

  async remove(restaurantId: string, id: string) {
    await this.findOwn(restaurantId, id);
    const used = await this.prisma.orderItem.count({ where: { productId: id } });
    if (used > 0) throw new ConflictException('El producto tiene ventas; desactívelo');
    await this.prisma.product.delete({ where: { id } });
    return { success: true };
  }

  private async findOwn(restaurantId: string, id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, restaurantId }, select: { id: true } });
    if (!p) throw new NotFoundException('Producto no encontrado');
    return p;
  }
}

@Controller('products')
@Roles(UserRole.ADMIN, UserRole.CASHIER, UserRole.WAITER)
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListProductsQuery) {
    return this.service.list(user.restaurantId, q);
  }

  @Roles(UserRole.ADMIN)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProductDto) {
    return this.service.create(user.restaurantId, dto);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.service.update(user.restaurantId, id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.restaurantId, id);
  }
}

@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
