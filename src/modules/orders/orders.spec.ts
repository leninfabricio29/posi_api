import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { NewItem, OrdersService, planItemMerge } from './orders';
import { CreateOrderDto, UpdateOrderDto, UpdateOrderItemDto } from './orders.dto';
import { toNum } from '../../common/money';

const D = (v: number) => new Prisma.Decimal(v);
const item = (productId: string, quantity: number, notes: string | null = null): NewItem => ({
  productId,
  productName: productId,
  quantity,
  price: D(2.5),
  taxable: true,
  notes,
});

describe('planItemMerge (agregar items)', () => {
  it('suma al item existente con mismo producto y notas null', () => {
    const plan = planItemMerge([{ id: 'i1', productId: 'p1', notes: null, quantity: 2 }], [item('p1', 3)]);
    expect([...plan.updates]).toEqual([['i1', 5]]);
    expect(plan.creates).toEqual([]);
  });

  it('crea línea nueva si las notas difieren', () => {
    const plan = planItemMerge([{ id: 'i1', productId: 'p1', notes: null, quantity: 1 }], [item('p1', 1, 'sin hielo')]);
    expect(plan.updates.size).toBe(0);
    expect(plan.creates).toHaveLength(1);
  });

  it('suma con notas iguales y agrupa duplicados dentro de la misma solicitud', () => {
    const plan = planItemMerge(
      [{ id: 'i1', productId: 'p1', notes: 'sin hielo', quantity: 1 }],
      [item('p1', 1, 'sin hielo'), item('p2', 1), item('p2', 2)],
    );
    expect([...plan.updates]).toEqual([['i1', 2]]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({ productId: 'p2', quantity: 3 });
  });

  it('rechaza si la suma supera 999', () => {
    expect(() => planItemMerge([{ id: 'i1', productId: 'p1', notes: null, quantity: 998 }], [item('p1', 2)])).toThrow(
      BadRequestException,
    );
  });
});

describe('UpdateOrderItemDto (cambiar cantidad)', () => {
  const errs = (body: unknown) =>
    validateSync(plainToInstance(UpdateOrderItemDto, body)).flatMap((e) => Object.values(e.constraints ?? {}));

  it('acepta enteros >= 1', () => {
    expect(errs({ quantity: 1 })).toEqual([]);
  });
  it('rechaza 0, decimales y faltante con mensajes en español', () => {
    expect(errs({ quantity: 0 })).toContain('La cantidad mínima es 1');
    expect(errs({ quantity: 1.5 })).toContain('La cantidad debe ser un entero');
    expect(errs({})).toContain('La cantidad debe ser un entero');
  });
});

describe('OrdersService.updateItem', () => {
  function setup(status: OrderStatus, itemRow: { id: string; quantity: number; price: Prisma.Decimal; taxable: boolean } | null) {
    let items = itemRow ? [{ ...itemRow }] : [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'o1' }]),
      order: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'o1', status, tableId: 't1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      orderItem: {
        findFirst: jest.fn().mockResolvedValue(itemRow),
        update: jest.fn().mockImplementation(({ where, data }) => {
          items = items.map((i) => (i.id === where.id ? { ...i, ...data } : i));
          return {};
        }),
        findMany: jest.fn().mockImplementation(() => items),
      },
      restaurant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ taxRate: D(15), pricesIncludeTax: true }) },
    };
    const prisma = { $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
    const realtime = { orderUpdated: jest.fn(), tableUpdated: jest.fn() };
    const service = new OrdersService(prisma as never, realtime as never);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'o1' } as never);
    return { service, tx, realtime };
  }
  const user = { id: 'u1', restaurantId: 'r1' } as never;

  it('2 -> 1 recalcula subtotal de la línea y totales del pedido, y emite eventos', async () => {
    const { service, tx, realtime } = setup(OrderStatus.OPEN, { id: 'i1', quantity: 2, price: D(11.5), taxable: true });
    await service.updateItem(user, 'o1', 'i1', { quantity: 1 });

    const itemUpdate = tx.orderItem.update.mock.calls[0][0];
    expect(itemUpdate.data.quantity).toBe(1);
    expect(toNum(itemUpdate.data.subtotal)).toBe(11.5);
    const orderUpdate = tx.order.update.mock.calls[0][0].data;
    expect({ subtotal: toNum(orderUpdate.subtotal), tax: toNum(orderUpdate.tax), total: toNum(orderUpdate.total) }).toEqual({
      subtotal: 10,
      tax: 1.5,
      total: 11.5,
    });
    expect(realtime.orderUpdated).toHaveBeenCalledWith('r1', 'o1');
    expect(realtime.tableUpdated).toHaveBeenCalledWith('r1', 't1');
  });

  it('409 si el pedido está pagado', async () => {
    const { service, tx } = setup(OrderStatus.PAID, { id: 'i1', quantity: 2, price: D(1), taxable: true });
    await expect(service.updateItem(user, 'o1', 'i1', { quantity: 1 })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('404 si el item no pertenece al pedido', async () => {
    const { service } = setup(OrderStatus.OPEN, null);
    await expect(service.updateItem(user, 'o1', 'x', { quantity: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });
});

const msgs = (cls: new () => object, body: unknown) =>
  validateSync(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true }).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );

describe('CreateOrderDto (nombre del cliente obligatorio)', () => {
  const base = { items: [{ productId: 'p1', quantity: 1 }] };

  it('acepta nombre y lo recorta', () => {
    const dto = plainToInstance(CreateOrderDto, { ...base, customerName: '  Ana  ' });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.customerName).toBe('Ana');
  });
  it('rechaza faltante, null, vacío o solo espacios con "Ingrese el nombre del cliente"', () => {
    for (const customerName of [undefined, null, '', '   ']) {
      expect(msgs(CreateOrderDto, { ...base, customerName })).toEqual(['Ingrese el nombre del cliente']);
    }
  });
  it('rechaza más de 80 caracteres', () => {
    expect(msgs(CreateOrderDto, { ...base, customerName: 'a'.repeat(81) })).toEqual([
      'El nombre del cliente admite máximo 80 caracteres',
    ]);
    expect(msgs(CreateOrderDto, { ...base, customerName: 'a'.repeat(80) })).toEqual([]);
  });
});

describe('UpdateOrderDto (PATCH /orders/:id)', () => {
  it('acepta cuerpo vacío, solo notas (incluso null) o solo nombre', () => {
    expect(msgs(UpdateOrderDto, {})).toEqual([]);
    expect(msgs(UpdateOrderDto, { notes: null })).toEqual([]);
    expect(msgs(UpdateOrderDto, { customerName: ' Luis ' })).toEqual([]);
  });
  it('si viene customerName no puede quedar vacío ni null', () => {
    for (const customerName of [null, '', '  ']) {
      expect(msgs(UpdateOrderDto, { customerName })).toEqual(['Ingrese el nombre del cliente']);
    }
  });
  it('no permite cambiar el estado ni otros campos', () => {
    expect(msgs(UpdateOrderDto, { status: 'PAID' })).toContain('property status should not exist');
  });
});

describe('OrdersService.update', () => {
  function setup(status: OrderStatus) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'o1' }]),
      order: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'o1', status, tableId: 't1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = { $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
    const realtime = { orderUpdated: jest.fn(), tableUpdated: jest.fn() };
    const service = new OrdersService(prisma as never, realtime as never);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'o1' } as never);
    return { service, tx, realtime };
  }
  const user = { id: 'u1', restaurantId: 'r1' } as never;

  it('actualiza solo los campos enviados y emite order.updated y table.updated', async () => {
    const { service, tx, realtime } = setup(OrderStatus.OPEN);
    await service.update(user, 'o1', { customerName: 'Ana' });
    expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { customerName: 'Ana' } });
    expect(realtime.orderUpdated).toHaveBeenCalledWith('r1', 'o1');
    expect(realtime.tableUpdated).toHaveBeenCalledWith('r1', 't1');
  });

  it('permite borrar las notas con null', async () => {
    const { service, tx } = setup(OrderStatus.OPEN);
    await service.update(user, 'o1', { notes: null });
    expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { notes: null } });
  });

  it.each([OrderStatus.PAID, OrderStatus.CANCELLED])('409 si el pedido está %s', async (st) => {
    const { service, tx, realtime } = setup(st);
    await expect(service.update(user, 'o1', { customerName: 'Ana' })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(realtime.orderUpdated).not.toHaveBeenCalled();
  });
});
