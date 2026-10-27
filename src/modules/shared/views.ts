import { OrderStatus, Prisma, PrismaClient } from '@prisma/client';
import { toNum } from '../../common/money';

type Db = PrismaClient | Prisma.TransactionClient;

/** Único estado "activo" (abierto, sin cobrar). Flujo: OPEN -> PAID. */
export const ACTIVE_ORDER_STATUS = OrderStatus.OPEN;

// ---------------- Order ----------------
export const orderInclude = {
  table: { select: { name: true, area: { select: { name: true } } } },
  user: { select: { name: true } },
  items: { orderBy: { id: 'asc' } },
  sale: {
    include: {
      user: { select: { name: true } },
      payments: { orderBy: { createdAt: 'asc' } },
    },
  },
} satisfies Prisma.OrderInclude;

export type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export function toOrderDto(o: OrderRow) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    tableId: o.tableId,
    tableName: o.table?.name ?? null,
    areaName: o.table?.area.name ?? null,
    userId: o.userId,
    userName: o.user.name,
    customerName: o.customerName,
    notes: o.notes,
    subtotal: toNum(o.subtotal),
    tax: toNum(o.tax),
    total: toNum(o.total),
    items: o.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productName: i.productName,
      quantity: i.quantity,
      price: toNum(i.price),
      taxable: i.taxable,
      subtotal: toNum(i.subtotal),
      notes: i.notes,
    })),
    sale: o.sale
      ? {
          id: o.sale.id,
          orderId: o.sale.orderId,
          cashRegisterId: o.sale.cashRegisterId,
          userId: o.sale.userId,
          userName: o.sale.user.name,
          subtotal: toNum(o.sale.subtotal),
          tax: toNum(o.sale.tax),
          total: toNum(o.sale.total),
          cashAmount: toNum(o.sale.cashAmount),
          transferAmount: toNum(o.sale.transferAmount),
          payments: o.sale.payments.map((p) => ({
            id: p.id,
            method: p.method,
            amount: toNum(p.amount),
            reference: p.reference,
            createdAt: p.createdAt,
          })),
          createdAt: o.sale.createdAt,
        }
      : null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export async function loadOrderDto(db: Db, id: string) {
  const o = await db.order.findUnique({ where: { id }, include: orderInclude });
  return o ? toOrderDto(o) : null;
}

// ---------------- Table ----------------
export const tableInclude = {
  area: { select: { name: true } },
  orders: {
    where: { status: ACTIVE_ORDER_STATUS },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      id: true,
      number: true,
      customerName: true,
      status: true,
      total: true,
      createdAt: true,
      items: { select: { quantity: true } },
    },
  },
} satisfies Prisma.TableInclude;

export type TableRow = Prisma.TableGetPayload<{ include: typeof tableInclude }>;

export function toTableDto(t: TableRow) {
  const o = t.orders[0];
  return {
    id: t.id,
    name: t.name,
    seats: t.seats,
    areaId: t.areaId,
    areaName: t.area.name,
    status: t.status,
    activeOrder: o
      ? {
          id: o.id,
          number: o.number,
          customerName: o.customerName,
          status: o.status,
          total: toNum(o.total),
          itemsCount: o.items.reduce((acc, i) => acc + i.quantity, 0),
          createdAt: o.createdAt,
        }
      : null,
  };
}

export async function loadTableDto(db: Db, id: string) {
  const t = await db.table.findUnique({ where: { id }, include: tableInclude });
  return t ? toTableDto(t) : null;
}

/** Orden natural por nombre ("Mesa 2" antes que "Mesa 10"). */
export const byNaturalName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });
