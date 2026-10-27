import { BadRequestException, Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { Matches } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import {
  addDays,
  DATE_RE,
  daysBetween,
  endOfLocalDayExclusive,
  localDateString,
  mondayOf,
  startOfLocalDay,
} from '../../common/dates';
import { dec, round2, toNum } from '../../common/money';

export class SalesReportQuery {
  @Matches(DATE_RE, { message: 'from es requerido con formato YYYY-MM-DD' })
  from!: string;

  @Matches(DATE_RE, { message: 'to es requerido con formato YYYY-MM-DD' })
  to!: string;
}

type Bucket = { count: number; total: Prisma.Decimal; cash: Prisma.Decimal; transfer: Prisma.Decimal };
const emptyBucket = (): Bucket => ({ count: 0, total: dec(0), cash: dec(0), transfer: dec(0) });
const bucketDto = (b: Bucket) => ({ count: b.count, total: toNum(b.total), cash: toNum(b.cash), transfer: toNum(b.transfer) });

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async sales(restaurantId: string, q: SalesReportQuery) {
    const gte = startOfLocalDay(q.from);
    const lt = endOfLocalDayExclusive(q.to);
    if (q.from > q.to) throw new BadRequestException('La fecha "from" no puede ser mayor que "to"');
    if (daysBetween(q.from, q.to) + 1 > 366) throw new BadRequestException('El rango máximo es de 366 días');

    const sales = await this.prisma.sale.findMany({
      where: { restaurantId, createdAt: { gte, lt } },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { name: true } },
        order: {
          select: {
            number: true,
            customerName: true,
            table: { select: { name: true } },
            items: { select: { productId: true, productName: true, quantity: true, subtotal: true } },
          },
        },
      },
    });

    // byDay: todos los días del rango
    const byDay = new Map<string, Bucket>();
    for (let d = q.from; d <= q.to; d = addDays(d, 1)) byDay.set(d, emptyBucket());
    // byWeek: semanas lunes-domingo que intersectan el rango
    const byWeek = new Map<string, Bucket>();
    for (let w = mondayOf(q.from); w <= q.to; w = addDays(w, 7)) byWeek.set(w, emptyBucket());

    const totals = { count: 0, subtotal: dec(0), tax: dec(0), total: dec(0), cash: dec(0), transfer: dec(0) };
    const products = new Map<string, { productId: string; name: string; quantity: number; total: Prisma.Decimal }>();
    const users = new Map<string, { userId: string; name: string; count: number; total: Prisma.Decimal }>();

    for (const s of sales) {
      totals.count++;
      totals.subtotal = totals.subtotal.plus(s.subtotal);
      totals.tax = totals.tax.plus(s.tax);
      totals.total = totals.total.plus(s.total);
      totals.cash = totals.cash.plus(s.cashAmount);
      totals.transfer = totals.transfer.plus(s.transferAmount);

      const day = localDateString(s.createdAt);
      for (const b of [byDay.get(day), byWeek.get(mondayOf(day))]) {
        if (!b) continue;
        b.count++;
        b.total = b.total.plus(s.total);
        b.cash = b.cash.plus(s.cashAmount);
        b.transfer = b.transfer.plus(s.transferAmount);
      }

      for (const i of s.order.items) {
        const p = products.get(i.productId) ?? { productId: i.productId, name: i.productName, quantity: 0, total: dec(0) };
        p.quantity += i.quantity;
        p.total = p.total.plus(i.subtotal);
        products.set(i.productId, p);
      }

      const u = users.get(s.userId) ?? { userId: s.userId, name: s.user.name, count: 0, total: dec(0) };
      u.count++;
      u.total = u.total.plus(s.total);
      users.set(s.userId, u);
    }

    return {
      from: q.from,
      to: q.to,
      totals: {
        count: totals.count,
        subtotal: toNum(totals.subtotal),
        tax: toNum(totals.tax),
        total: toNum(totals.total),
        cash: toNum(totals.cash),
        transfer: toNum(totals.transfer),
        averageTicket: totals.count ? toNum(round2(totals.total.div(totals.count))) : 0,
      },
      byDay: [...byDay.entries()].map(([date, b]) => ({ date, ...bucketDto(b) })),
      byWeek: [...byWeek.entries()].map(([weekStart, b]) => ({ weekStart, weekEnd: addDays(weekStart, 6), ...bucketDto(b) })),
      topProducts: [...products.values()]
        .sort((a, b) => b.total.comparedTo(a.total) || b.quantity - a.quantity)
        .slice(0, 10)
        .map((p) => ({ productId: p.productId, name: p.name, quantity: p.quantity, total: toNum(p.total) })),
      byUser: [...users.values()]
        .sort((a, b) => b.total.comparedTo(a.total))
        .map((u) => ({ userId: u.userId, name: u.name, count: u.count, total: toNum(u.total) })),
      sales: [...sales].reverse().map((s) => ({
        id: s.id,
        orderId: s.orderId,
        orderNumber: s.order.number,
        customerName: s.order.customerName,
        tableName: s.order.table?.name ?? null,
        userName: s.user.name,
        total: toNum(s.total),
        cash: toNum(s.cashAmount),
        transfer: toNum(s.transferAmount),
        createdAt: s.createdAt,
      })),
    };
  }
}

@Controller('reports')
@Roles(UserRole.ADMIN, UserRole.CASHIER)
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get('sales')
  sales(@CurrentUser() user: AuthUser, @Query() q: SalesReportQuery) {
    return this.service.sales(user.restaurantId, q);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
