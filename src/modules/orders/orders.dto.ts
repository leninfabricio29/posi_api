import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidationArguments,
  ValidateIf,
  ValidateNested,
  IsPositive,
} from 'class-validator';
import { OrderStatus, PaymentMethod } from '@prisma/client';
import { DATE_RE } from '../../common/dates';
import { Trim, TrimOrNull } from '../../common/validation';

export const CUSTOMER_NAME_MAX = 80;
export const CUSTOMER_NAME_REQUIRED = 'Ingrese el nombre del cliente';
const CUSTOMER_NAME_TOO_LONG = `El nombre del cliente admite máximo ${CUSTOMER_NAME_MAX} caracteres`;

/**
 * Nombre del cliente (ya recortado con @Trim): string de 1–80 caracteres.
 * Un solo validador para devolver un único mensaje claro por caso
 * (faltante/vacío -> "Ingrese el nombre del cliente"; largo -> máximo 80).
 */
const IsCustomerName = () =>
  ValidateBy({
    name: 'isCustomerName',
    validator: {
      validate: (v: unknown) => typeof v === 'string' && v.length >= 1 && v.length <= CUSTOMER_NAME_MAX,
      defaultMessage: (args?: ValidationArguments) =>
        typeof args?.value === 'string' && args.value.length > CUSTOMER_NAME_MAX
          ? CUSTOMER_NAME_TOO_LONG
          : CUSTOMER_NAME_REQUIRED,
    },
  });

export class OrderItemInputDto {
  @IsString({ message: 'productId es requerido' })
  @IsNotEmpty({ message: 'productId es requerido' })
  productId!: string;

  @IsInt({ message: 'La cantidad debe ser un entero' })
  @Min(1, { message: 'La cantidad mínima es 1' })
  @Max(999, { message: 'La cantidad máxima es 999' })
  quantity!: number;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'Las notas del item deben ser texto' })
  @MaxLength(250, { message: 'Las notas del item admiten máximo 250 caracteres' })
  notes?: string | null;
}

export class CreateOrderDto {
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString({ message: 'tableId debe ser texto' })
  @IsNotEmpty({ message: 'tableId no puede estar vacío' })
  tableId?: string | null;

  /** Obligatorio: identifica quién pidió (no hay tabla de clientes). Se recorta; 1–80 caracteres. */
  @Trim()
  @IsCustomerName()
  customerName!: string;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'Las notas deben ser texto' })
  @MaxLength(500, { message: 'Las notas admiten máximo 500 caracteres' })
  notes?: string | null;

  @IsArray({ message: 'items debe ser una lista' })
  @ArrayMinSize(1, { message: 'El pedido debe tener al menos un producto' })
  @ArrayMaxSize(200, { message: 'Máximo 200 items por pedido' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

/** PATCH /orders/:id — corrige nombre del cliente y/o notas mientras el pedido está OPEN. */
export class UpdateOrderDto {
  // Si viene (incluido null), no puede quedar vacío; si no viene, no se toca.
  @ValidateIf((_o, v) => v !== undefined)
  @Trim()
  @IsCustomerName()
  customerName?: string;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'Las notas deben ser texto' })
  @MaxLength(500, { message: 'Las notas admiten máximo 500 caracteres' })
  notes?: string | null;
}

export class AddItemsDto {
  @IsArray({ message: 'items debe ser una lista' })
  @ArrayMinSize(1, { message: 'Debe enviar al menos un producto' })
  @ArrayMaxSize(200, { message: 'Máximo 200 items por solicitud' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

export class UpdateOrderItemDto {
  @IsInt({ message: 'La cantidad debe ser un entero' })
  @Min(1, { message: 'La cantidad mínima es 1' })
  @Max(999, { message: 'La cantidad máxima es 999' })
  quantity!: number;
}

export class PaymentInputDto {
  @IsIn([PaymentMethod.CASH, PaymentMethod.TRANSFER], { message: 'El método de pago debe ser CASH o TRANSFER' })
  method!: PaymentMethod;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'El monto debe ser un número con máximo 2 decimales' })
  @IsPositive({ message: 'El monto debe ser mayor a 0' })
  @Max(99999999, { message: 'El monto es demasiado alto' })
  amount!: number;

  @ValidateIf((o: PaymentInputDto) => o.method === PaymentMethod.TRANSFER || (o.reference !== undefined && o.reference !== null))
  @IsString({ message: 'La transferencia requiere el código de referencia (reference)' })
  @Matches(/\S/, { message: 'La transferencia requiere el código de referencia (reference)' })
  @MaxLength(100, { message: 'reference admite máximo 100 caracteres' })
  reference?: string | null;
}

export class PayOrderDto {
  @IsArray({ message: 'payments debe ser una lista' })
  @ArrayMinSize(1, { message: 'Debe registrar al menos un pago' })
  @ArrayMaxSize(20, { message: 'Máximo 20 pagos' })
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  payments!: PaymentInputDto[];
}

export class ListOrdersQuery {
  @IsOptional()
  @IsEnum(OrderStatus, { message: 'Estado inválido (OPEN, PAID o CANCELLED)' })
  status?: OrderStatus;

  @IsOptional()
  @Matches(DATE_RE, { message: 'from debe tener formato YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'to debe tener formato YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @IsString({ message: 'tableId debe ser texto' })
  tableId?: string;
}
