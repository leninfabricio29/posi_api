import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,

  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CashMovementType, CashRegisterStatus, PaymentMethod, Prisma, UserRole } from '@prisma/client';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, IsPositive } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import { DATE_RE, dateRangeFilter } from '../../common/dates';
import { dec, round2, toNum, toNumOrNull } from '../../common/money';
import { Trim, TrimOrNull } from '../../common/validation';
import { RealtimeService } from '../realtime/realtime';

type Db = PrismaService | Prisma.TransactionClient;
const AMOUNT_MSG = 'debe ser un número con máximo 2 decimales';

export class OpenCashRegisterDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: `initialAmount ${AMOUNT_MSG}` })
  @Min(0, { message: 'initialAmount no puede ser negativo' })
  @Max(99999999, { message: 'initialAmount es demasiado alto' })
  initialAmount!: number;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'Las notas deben ser texto' })
  @MaxLength(500, { message: 'Las notas admiten máximo 500 caracteres' })
  notes?: string | null;
}

export class CashMovementDto {
  @IsIn([CashMovementType.INCOME, CashMovementType.EXPENSE], { message: 'type debe ser INCOME o EXPENSE' })
  type!: CashMovementType;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: `amount ${AMOUNT_MSG}` })
  @IsPositive({ message: 'El monto debe ser mayor a 0' })
  @Max(99999999, { message: 'El monto es demasiado alto' })
  amount!: number;

  @Trim()
  @IsString({ message: 'El motivo es requerido' })
  @IsNotEmpty({ message: 'El motivo es requerido' })
  @MaxLength(250, { message: 'El motivo admite máximo 250 caracteres' })
  reason!: string;
}

export class CloseCashRegisterDto {
  @IsNumber({ maxDecimalPlaces: 2 }, { message: `countedCash ${AMOUNT_MSG}` })
  @Min(0, { message: 'countedCash no puede ser negativo' })
  @Max(99999999, { message: 'countedCash es demasiado alto' })
  countedCash!: number;

  @IsOptional()
  @TrimOrNull()
  @IsString({ message: 'Las notas deben ser texto' })
  @MaxLength(500, { message: 'Las notas admiten máximo 500 caracteres' })
  notes?: string | null;
}

export class HistoryQuery {
  @IsOptional()
  @Matches(DATE_RE, { message: 'from debe tener formato YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'to debe tener formato YYYY-MM-DD' })
  to?: string;
}

const summaryInclude = {
  openedBy: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
  restaurant: { select: { name: true, ruc: true, address: true, phone: true } },
  movements: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
  sales: {
    orderBy: { createdAt: 'asc' },
    include: {
      order: { select: { number: true, customerName: true, table: { select: { name: true } } } },
      payments: { orderBy: { createdAt: 'asc' } },
    },
  },
} satisfies Prisma.CashRegisterInclude;

/** expected = initial + ventas en efectivo + ingresos - egresos */
export function expectedCashOf(
  initial: Prisma.Decimal.Value,
  salesCash: Prisma.Decimal.Value,
  incomes: Prisma.Decimal.Value,
  expenses: Prisma.Decimal.Value,
) {
  return round2(dec(initial).plus(dec(salesCash)).plus(dec(incomes)).minus(dec(expenses)));
}

@Injectable()
export class CashRegisterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async current(restaurantId: string) {
    const r = await this.prisma.cashRegister.findFirst({
      where: { restaurantId, status: CashRegisterStatus.OPEN },
      select: { id: true },
    });
    return { register: r ? await this.summary(this.prisma, r.id) : null };
  }

  async open(user: AuthUser, dto: OpenCashRegisterDto) {
    const existing = await this.prisma.cashRegister.findFirst({
      where: { restaurantId: user.restaurantId, status: CashRegisterStatus.OPEN },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Ya hay una caja abierta');
    let id: string;
    try {
      const r = await this.prisma.cashRegister.create({
        data: {
          restaurantId: user.restaurantId,
          openedById: user.id,
          initialAmount: dec(dto.initialAmount),
          notes: dto.notes ?? null,
        },
        select: { id: true },
      });
      id = r.id;
    } catch (e) {
      // Índice único parcial: otra petición abrió caja en paralelo
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ya hay una caja abierta');
      }
      throw e;
    }
    this.realtime.cashUpdated(user.restaurantId, id, 'OPEN');
    return this.summary(this.prisma, id);
  }

  async addMovement(user: AuthUser, dto: CashMovementDto) {
    const id = await this.prisma.$transaction(async (tx) => {
      const register = await this.lockOpen(tx, user.restaurantId);
      if (dto.type === CashMovementType.EXPENSE) {
        const s = await this.summary(tx, register.id);
        if (dec(s.expectedCash).minus(dec(dto.amount)).isNegative()) {
          throw new BadRequestException(
            `El egreso deja el efectivo esperado en negativo (disponible: ${s.expectedCash.toFixed(2)})`,
          );
        }
      }
      await tx.cashMovement.create({
        data: {
          type: dto.type,
          amount: dec(dto.amount),
          reason: dto.reason,
          cashRegisterId: register.id,
          restaurantId: user.restaurantId,
          userId: user.id,
        },
      });
      return register.id;
    });
    this.realtime.cashUpdated(user.restaurantId, id, 'OPEN');
    return this.summary(this.prisma, id);
  }

  async close(user: AuthUser, dto: CloseCashRegisterDto) {
    const id = await this.prisma.$transaction(async (tx) => {
      const register = await this.lockOpen(tx, user.restaurantId);
      const s = await this.summary(tx, register.id);
      const expected = dec(s.expectedCash);
      const counted = round2(dto.countedCash);
      await tx.cashRegister.update({
        where: { id: register.id },
        data: {
          status: CashRegisterStatus.CLOSED,
          closedAt: new Date(),
          closedById: user.id,
          expectedCash: expected,
          countedCash: counted,
          difference: counted.minus(expected),
          closingNotes: dto.notes ?? null,
        },
      });
      return register.id;
    });
    this.realtime.cashUpdated(user.restaurantId, id, 'CLOSED');
    return this.summary(this.prisma, id);
  }

  async history(restaurantId: string, q: HistoryQuery) {
    const registers = await this.prisma.cashRegister.findMany({
      where: { restaurantId, openedAt: dateRangeFilter(q.from, q.to) },
      orderBy: { openedAt: 'desc' },
      take: 500,
      include: {
        openedBy: { select: { id: true, name: true } },
        closedBy: { select: { id: true, name: true } },
      },
    });
    const ids = registers.map((r) => r.id);
    const [sales, movements] = await Promise.all([
      this.prisma.sale.groupBy({
        by: ['cashRegisterId'],
        where: { cashRegisterId: { in: ids } },
        _sum: { total: true, cashAmount: true },
      }),
      this.prisma.cashMovement.groupBy({
        by: ['cashRegisterId', 'type'],
        where: { cashRegisterId: { in: ids } },
        _sum: { amount: true },
      }),
    ]);
    const salesBy = new Map(sales.map((s) => [s.cashRegisterId, s._sum]));
    const movBy = (id: string, type: CashMovementType) =>
      movements.find((m) => m.cashRegisterId === id && m.type === type)?._sum.amount ?? 0;

    return registers.map((r) => {
      const s = salesBy.get(r.id);
      const computed = expectedCashOf(
        r.initialAmount,
        s?.cashAmount ?? 0,
        movBy(r.id, CashMovementType.INCOME),
        movBy(r.id, CashMovementType.EXPENSE),
      );
      return {
        id: r.id,
        status: r.status,
        openedAt: r.openedAt,
        closedAt: r.closedAt,
        openedBy: r.openedBy,
        closedBy: r.closedBy,
        initialAmount: toNum(r.initialAmount),
        salesTotal: toNum(s?.total ?? 0),
        expectedCash: toNum(r.status === CashRegisterStatus.CLOSED && r.expectedCash != null ? r.expectedCash : computed),
        countedCash: toNumOrNull(r.countedCash),
        difference: toNumOrNull(r.difference),
      };
    });
  }

  async summaryFor(restaurantId: string, id: string) {
    const r = await this.prisma.cashRegister.findFirst({ where: { id, restaurantId }, select: { id: true } });
    if (!r) throw new NotFoundException('Caja no encontrada');
    return this.summary(this.prisma, id);
  }

  // ---------------- helpers ----------------
  private async lockOpen(tx: Prisma.TransactionClient, restaurantId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CashRegister"
      WHERE "restaurantId" = ${restaurantId} AND "status" = 'OPEN'::"CashRegisterStatus"
      FOR UPDATE`;
    if (rows.length === 0) throw new ConflictException('No hay caja abierta');
    return rows[0];
  }

  async summary(db: Db, id: string) {
    const r = await db.cashRegister.findUniqueOrThrow({ where: { id }, include: summaryInclude });

    let subtotal = dec(0);
    let tax = dec(0);
    let total = dec(0);
    let cash = dec(0);
    let transfer = dec(0);
    for (const s of r.sales) {
      subtotal = subtotal.plus(s.subtotal);
      tax = tax.plus(s.tax);
      total = total.plus(s.total);
      cash = cash.plus(s.cashAmount);
      transfer = transfer.plus(s.transferAmount);
    }
    let incomes = dec(0);
    let expenses = dec(0);
    for (const m of r.movements) {
      if (m.type === CashMovementType.INCOME) incomes = incomes.plus(m.amount);
      else expenses = expenses.plus(m.amount);
    }
    const computed = expectedCashOf(r.initialAmount, cash, incomes, expenses);
    const expected = r.status === CashRegisterStatus.CLOSED && r.expectedCash != null ? r.expectedCash : computed;

    return {
      id: r.id,
      status: r.status,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      openedBy: r.openedBy,
      closedBy: r.closedBy,
      notes: r.notes,
      closingNotes: r.closingNotes,
      initialAmount: toNum(r.initialAmount),
      sales: {
        count: r.sales.length,
        subtotal: toNum(subtotal),
        tax: toNum(tax),
        total: toNum(total),
        cash: toNum(cash),
        transfer: toNum(transfer),
      },
      incomes: toNum(incomes),
      expenses: toNum(expenses),
      expectedCash: toNum(expected),
      countedCash: toNumOrNull(r.countedCash),
      difference: toNumOrNull(r.difference),
      movements: r.movements.map((m) => ({
        id: m.id,
        type: m.type,
        amount: toNum(m.amount),
        reason: m.reason,
        userName: m.user.name,
        createdAt: m.createdAt,
      })),
      transfers: r.sales.flatMap((s) =>
        s.payments
          .filter((p) => p.method === PaymentMethod.TRANSFER)
          .map((p) => ({
            id: p.id,
            orderNumber: s.order.number,
            amount: toNum(p.amount),
            reference: p.reference ?? '',
            createdAt: p.createdAt,
          })),
      ),
      salesList: r.sales.map((s) => ({
        id: s.id,
        orderId: s.orderId,
        orderNumber: s.order.number,
        customerName: s.order.customerName,
        tableName: s.order.table?.name ?? null,
        total: toNum(s.total),
        cash: toNum(s.cashAmount),
        transfer: toNum(s.transferAmount),
        createdAt: s.createdAt,
      })),
      restaurant: r.restaurant,
    };
  }
}

@Controller('cash-register')
@Roles(UserRole.ADMIN, UserRole.CASHIER)
export class CashRegisterController {
  constructor(private readonly service: CashRegisterService) {}

  @Get('current')
  current(@CurrentUser() user: AuthUser) {
    return this.service.current(user.restaurantId);
  }

  @Post('open')
  open(@CurrentUser() user: AuthUser, @Body() dto: OpenCashRegisterDto) {
    return this.service.open(user, dto);
  }

  @Post('movements')
  movement(@CurrentUser() user: AuthUser, @Body() dto: CashMovementDto) {
    return this.service.addMovement(user, dto);
  }

  @Post('close')
  close(@CurrentUser() user: AuthUser, @Body() dto: CloseCashRegisterDto) {
    return this.service.close(user, dto);
  }

  @Get('history')
  history(@CurrentUser() user: AuthUser, @Query() q: HistoryQuery) {
    return this.service.history(user.restaurantId, q);
  }

  @Get(':id/summary')
  summary(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.summaryFor(user.restaurantId, id);
  }
}

@Module({
  controllers: [CashRegisterController],
  providers: [CashRegisterService],
})
export class CashRegisterModule {}
