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
import { CashRegisterStatus, OrderStatus, PaymentMethod, Prisma, TableStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, CurrentUser, Roles } from '../../auth/auth-user';
import { dateRangeFilter } from '../../common/dates';
import { dec, toCents, toNum } from '../../common/money';
import { RealtimeService } from '../realtime/realtime';
import { ACTIVE_ORDER_STATUS, orderInclude, toOrderDto } from '../shared/views';
import { computeTotals } from './tax';
import {
  AddItemsDto,
  CreateOrderDto,
  ListOrdersQuery,
  OrderItemInputDto,
  PayOrderDto,
  PaymentInputDto,
  UpdateOrderDto,
  UpdateOrderItemDto,
} from './orders.dto';

type Tx = Prisma.TransactionClient;

/** Flujo de pedido: OPEN -> PAID (solo vía /pay). CANCELLED existe solo en datos históricos. */
const STATUS_ES: Record<OrderStatus, string> = {
  OPEN: 'abierto',
  PAID: 'pagado',
  CANCELLED: 'cancelado',
};

const MAX_ITEM_QTY = 999;

export interface NewItem {
  productId: string;
  productName: string;
  quantity: number;
  price: Prisma.Decimal;
  taxable: boolean;
  notes: string | null;
}

export interface ItemMergePlan {
  /** Items existentes cuya cantidad aumenta (id -> nueva cantidad). */
  updates: Map<string, number>;
  /** Líneas nuevas (producto + notas que aún no están en el pedido). */
  creates: NewItem[];
}

const itemKey = (productId: string, notes: string | null | undefined) => JSON.stringify([productId, notes ?? null]);

/**
 * Agrupa los items a agregar con los existentes: mismo producto + mismas notas (null == null)
 * suma la cantidad a la línea existente en vez de crear una nueva. Pura, testeable.
 */
export function planItemMerge(
  existing: { id: string; productId: string; notes: string | null; quantity: number }[],
  incoming: NewItem[],
): ItemMergePlan {
  const byKey = new Map<string, { id?: string; quantity: number; item?: NewItem }>();
  for (const e of existing) {
    const k = itemKey(e.productId, e.notes);
    if (!byKey.has(k)) byKey.set(k, { id: e.id, quantity: e.quantity });
  }
  const updates = new Map<string, number>();
  const creates: NewItem[] = [];
  for (const i of incoming) {
    const k = itemKey(i.productId, i.notes);
    const cur = byKey.get(k);
    if (cur) {
      cur.quantity += i.quantity;
      if (cur.quantity > MAX_ITEM_QTY) {
        throw new BadRequestException(`La cantidad máxima es ${MAX_ITEM_QTY} (producto "${i.productName}")`);
      }
      if (cur.id) updates.set(cur.id, cur.quantity);
      else cur.item!.quantity = cur.quantity;
    } else {
      const item = { ...i };
      creates.push(item);
      byKey.set(k, { quantity: item.quantity, item });
    }
  }
  return { updates, creates };
}

export interface PaymentSplit {
  totalCents: number;
  cash: Prisma.Decimal;
  transfer: Prisma.Decimal;
}

/** Valida y separa pagos por método (pura, testeable). */
export function splitPayments(payments: Pick<PaymentInputDto, 'method' | 'amount' | 'reference'>[]): PaymentSplit {
  let cash = dec(0);
  let transfer = dec(0);
  for (const p of payments) {
    if (p.method === PaymentMethod.TRANSFER && !(p.reference && p.reference.trim())) {
      throw new BadRequestException('La transferencia requiere el código de referencia (reference)');
    }
    if (p.method === PaymentMethod.CASH) cash = cash.plus(dec(p.amount));
    else transfer = transfer.plus(dec(p.amount));
  }
  return { totalCents: toCents(cash.plus(transfer)), cash, transfer };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(restaurantId: string, q: ListOrdersQuery) {
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId,
        status: q.status,
        tableId: q.tableId || undefined,
        createdAt: dateRangeFilter(q.from, q.to),
      },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return orders.map(toOrderDto);
  }

  async active(restaurantId: string) {
    const orders = await this.prisma.order.findMany({
      where: { restaurantId, status: ACTIVE_ORDER_STATUS },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
    });
    return orders.map(toOrderDto);
  }

  async findOne(restaurantId: string, id: string) {
    const o = await this.prisma.order.findFirst({ where: { id, restaurantId }, include: orderInclude });
    if (!o) throw new NotFoundException('Pedido no encontrado');
    return toOrderDto(o);
  }

  async create(user: AuthUser, dto: CreateOrderDto) {
    const rid = user.restaurantId;
    const tableId = dto.tableId || null;
    const orderId = await this.prisma.$transaction(async (tx) => {
      if (tableId) {
        const table = await tx.table.findFirst({ where: { id: tableId, restaurantId: rid }, select: { id: true } });
        if (!table) throw new NotFoundException('Mesa no encontrada');
        await tx.$queryRaw`SELECT "id" FROM "Table" WHERE "id" = ${tableId} FOR UPDATE`;
        const open = await tx.order.count({ where: { tableId, status: OrderStatus.OPEN } });
        if (open > 0) throw new ConflictException('La mesa ya tiene un pedido abierto');
      }
      const items = await this.buildItems(tx, rid, dto.items);
      const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: rid } });
      const totals = computeTotals(items, restaurant.taxRate, restaurant.pricesIncludeTax);

      const order = await tx.order.create({
        data: {
          restaurantId: rid,
          userId: user.id,
          tableId,
          status: OrderStatus.OPEN,
          customerName: dto.customerName,
          notes: dto.notes ?? null,
          subtotal: totals.subtotal,
          tax: totals.tax,
          total: totals.total,
          items: { create: items.map((i, idx) => ({ ...i, subtotal: totals.lines[idx] })) },
        },
        select: { id: true },
      });
      if (tableId) await tx.table.update({ where: { id: tableId }, data: { status: TableStatus.OCCUPIED } });
      return order.id;
    });

    this.realtime.orderCreated(rid, orderId);
    this.realtime.tableUpdated(rid, tableId);
    return this.findOne(rid, orderId);
  }

  /** Corrige nombre del cliente y/o notas. Solo OPEN (409 si PAID/CANCELLED). */
  async update(user: AuthUser, id: string, dto: UpdateOrderDto) {
    const rid = user.restaurantId;
    const order = await this.prisma.$transaction(async (tx) => {
      const o = await this.lockEditable(tx, rid, id);
      const data: Prisma.OrderUpdateInput = {};
      if (dto.customerName !== undefined) data.customerName = dto.customerName;
      if (dto.notes !== undefined) data.notes = dto.notes;
      if (Object.keys(data).length > 0) await tx.order.update({ where: { id }, data });
      return o;
    });
    this.realtime.orderUpdated(rid, id);
    this.realtime.tableUpdated(rid, order.tableId);
    return this.findOne(rid, id);
  }

  async addItems(user: AuthUser, id: string, dto: AddItemsDto) {
    const rid = user.restaurantId;
    const order = await this.prisma.$transaction(async (tx) => {
      const o = await this.lockEditable(tx, rid, id);
      const items = await this.buildItems(tx, rid, dto.items);
      const existing = await tx.orderItem.findMany({
        where: { orderId: id },
        select: { id: true, productId: true, notes: true, quantity: true, price: true, taxable: true },
        orderBy: { id: 'asc' },
      });
      const plan = planItemMerge(existing, items);
      const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: rid } });
      for (const [itemId, quantity] of plan.updates) {
        const e = existing.find((x) => x.id === itemId)!;
        await this.setItemQuantity(tx, e, quantity, restaurant.taxRate, restaurant.pricesIncludeTax);
      }
      if (plan.creates.length > 0) {
        const lines = computeTotals(plan.creates, restaurant.taxRate, restaurant.pricesIncludeTax).lines;
        await tx.orderItem.createMany({
          data: plan.creates.map((i, idx) => ({ ...i, orderId: id, subtotal: lines[idx] })),
        });
      }
      await this.recalc(tx, id, restaurant.taxRate, restaurant.pricesIncludeTax);
      return o;
    });
    this.realtime.orderUpdated(rid, id);
    this.realtime.tableUpdated(rid, order.tableId);
    return this.findOne(rid, id);
  }

  async removeItem(user: AuthUser, id: string, itemId: string) {
    const rid = user.restaurantId;
    const order = await this.prisma.$transaction(async (tx) => {
      const o = await this.lockEditable(tx, rid, id);
      const item = await tx.orderItem.findFirst({ where: { id: itemId, orderId: id }, select: { id: true } });
      if (!item) throw new NotFoundException('Item no encontrado en el pedido');
      const count = await tx.orderItem.count({ where: { orderId: id } });
      if (count <= 1) {
        throw new BadRequestException('El pedido debe tener al menos un producto');
      }
      await tx.orderItem.delete({ where: { id: itemId } });
      const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: rid } });
      await this.recalc(tx, id, restaurant.taxRate, restaurant.pricesIncludeTax);
      return o;
    });
    this.realtime.orderUpdated(rid, id);
    this.realtime.tableUpdated(rid, order.tableId);
    return this.findOne(rid, id);
  }

  async updateItem(user: AuthUser, id: string, itemId: string, dto: UpdateOrderItemDto) {
    const rid = user.restaurantId;
    const order = await this.prisma.$transaction(async (tx) => {
      const o = await this.lockEditable(tx, rid, id);
      const item = await tx.orderItem.findFirst({
        where: { id: itemId, orderId: id },
        select: { id: true, quantity: true, price: true, taxable: true },
      });
      if (!item) throw new NotFoundException('Item no encontrado en el pedido');
      if (item.quantity !== dto.quantity) {
        const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: rid } });
        await this.setItemQuantity(tx, item, dto.quantity, restaurant.taxRate, restaurant.pricesIncludeTax);
        await this.recalc(tx, id, restaurant.taxRate, restaurant.pricesIncludeTax);
      }
      return o;
    });
    this.realtime.orderUpdated(rid, id);
    this.realtime.tableUpdated(rid, order.tableId);
    return this.findOne(rid, id);
  }

  async pay(user: AuthUser, id: string, dto: PayOrderDto) {
    const rid = user.restaurantId;
    const split = splitPayments(dto.payments);

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lock(tx, rid, id);
      if (order.status !== OrderStatus.OPEN) {
        throw new ConflictException(
          order.status === OrderStatus.PAID ? 'El pedido ya está pagado' : `El pedido está ${STATUS_ES[order.status]}`,
        );
      }

      const register = await tx.cashRegister.findFirst({
        where: { restaurantId: rid, status: CashRegisterStatus.OPEN },
        select: { id: true },
      });
      if (!register) throw new ConflictException('No hay caja abierta');
      // Bloquea la caja para serializar con el cierre
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "CashRegister" WHERE "id" = ${register.id} FOR UPDATE`;
      if (locked[0]?.status !== CashRegisterStatus.OPEN) throw new ConflictException('No hay caja abierta');

      const orderCents = toCents(order.total);
      if (split.totalCents !== orderCents) {
        throw new BadRequestException(
          `La suma de los pagos (${(split.totalCents / 100).toFixed(2)}) debe ser igual al total del pedido (${toNum(order.total).toFixed(2)})`,
        );
      }

      await tx.sale.create({
        data: {
          orderId: id,
          userId: user.id,
          restaurantId: rid,
          cashRegisterId: register.id,
          subtotal: order.subtotal,
          tax: order.tax,
          total: order.total,
          cashAmount: split.cash,
          transferAmount: split.transfer,
          payments: {
            create: dto.payments.map((p) => ({
              method: p.method,
              amount: dec(p.amount),
              reference: p.method === PaymentMethod.TRANSFER ? p.reference!.trim() : null,
              restaurantId: rid,
              cashRegisterId: register.id,
            })),
          },
        },
      });
      await tx.order.update({ where: { id }, data: { status: OrderStatus.PAID } });
      if (order.tableId) await this.releaseTable(tx, order.tableId);
      return { tableId: order.tableId, registerId: register.id };
    });

    this.realtime.orderUpdated(rid, id);
    this.realtime.tableUpdated(rid, result.tableId);
    this.realtime.cashUpdated(rid, result.registerId, 'OPEN');
    return this.findOne(rid, id);
  }

  // ---------------- helpers ----------------
  private async lock(tx: Tx, restaurantId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Order" WHERE "id" = ${id} AND "restaurantId" = ${restaurantId} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('Pedido no encontrado');
    return tx.order.findUniqueOrThrow({ where: { id } });
  }

  private async lockEditable(tx: Tx, restaurantId: string, id: string) {
    const o = await this.lock(tx, restaurantId, id);
    if (o.status !== OrderStatus.OPEN) {
      throw new ConflictException(`El pedido está ${STATUS_ES[o.status]} y no se puede modificar`);
    }
    return o;
  }

  private async buildItems(tx: Tx, restaurantId: string, input: OrderItemInputDto[]) {
    const ids = [...new Set(input.map((i) => i.productId))];
    const products = await tx.product.findMany({ where: { id: { in: ids }, restaurantId } });
    const byId = new Map(products.map((p) => [p.id, p]));
    return input.map((i) => {
      const p = byId.get(i.productId);
      if (!p) throw new BadRequestException(`Producto no encontrado: ${i.productId}`);
      if (!p.available) throw new BadRequestException(`El producto "${p.name}" no está disponible`);
      return {
        productId: p.id,
        productName: p.name,
        quantity: i.quantity,
        price: p.price,
        taxable: p.taxable,
        notes: i.notes ?? null,
      };
    });
  }

  private async recalc(tx: Tx, orderId: string, taxRate: Prisma.Decimal, pricesIncludeTax: boolean) {
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { price: true, quantity: true, taxable: true } });
    const t = computeTotals(items, taxRate, pricesIncludeTax);
    await tx.order.update({ where: { id: orderId }, data: { subtotal: t.subtotal, tax: t.tax, total: t.total } });
  }

  /** Cambia la cantidad de una línea y su subtotal (mismo cálculo de tax.ts). No recalcula el pedido. */
  private async setItemQuantity(
    tx: Tx,
    item: { id: string; price: Prisma.Decimal; taxable: boolean },
    quantity: number,
    taxRate: Prisma.Decimal,
    pricesIncludeTax: boolean,
  ) {
    const [subtotal] = computeTotals([{ price: item.price, quantity, taxable: item.taxable }], taxRate, pricesIncludeTax).lines;
    await tx.orderItem.update({ where: { id: item.id }, data: { quantity, subtotal } });
  }

  private async releaseTable(tx: Tx, tableId: string) {
    const stillActive = await tx.order.count({ where: { tableId, status: OrderStatus.OPEN } });
    if (stillActive === 0) {
      await tx.table.updateMany({
        where: { id: tableId, status: TableStatus.OCCUPIED },
        data: { status: TableStatus.AVAILABLE },
      });
    }
  }
}

@Controller('orders')
@Roles(UserRole.ADMIN, UserRole.CASHIER, UserRole.WAITER)
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListOrdersQuery) {
    return this.service.list(user.restaurantId, q);
  }

  @Get('active')
  active(@CurrentUser() user: AuthUser) {
    return this.service.active(user.restaurantId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user.restaurantId, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.service.create(user, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateOrderDto) {
    return this.service.update(user, id, dto);
  }

  @Post(':id/items')
  addItems(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AddItemsDto) {
    return this.service.addItems(user, id, dto);
  }

  @Delete(':id/items/:itemId')
  removeItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string) {
    return this.service.removeItem(user, id, itemId);
  }

  @Patch(':id/items/:itemId')
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateOrderItemDto,
  ) {
    return this.service.updateItem(user, id, itemId, dto);
  }

  @Post(':id/pay')
  pay(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PayOrderDto) {
    return this.service.pay(user, id, dto);
  }
}

@Module({
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
