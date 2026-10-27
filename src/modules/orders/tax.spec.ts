import { BadRequestException } from '@nestjs/common';
import { computeTotals } from './tax';
import { splitPayments } from './orders';
import { expectedCashOf } from '../cash-register/cash-register';
import { toNum } from '../../common/money';

const n = (t: ReturnType<typeof computeTotals>) => ({
  subtotal: toNum(t.subtotal),
  tax: toNum(t.tax),
  total: toNum(t.total),
});

describe('computeTotals (IVA)', () => {
  it('precios con IVA incluido: separa el impuesto de los gravados', () => {
    const t = computeTotals([{ price: 11.5, quantity: 1, taxable: true }], 15, true);
    expect(n(t)).toEqual({ subtotal: 10, tax: 1.5, total: 11.5 });
  });

  it('precios con IVA incluido: no gravados no generan impuesto', () => {
    const t = computeTotals(
      [
        { price: 11.5, quantity: 2, taxable: true },
        { price: 1, quantity: 3, taxable: false },
      ],
      15,
      true,
    );
    expect(n(t)).toEqual({ subtotal: 23, tax: 3, total: 26 });
    expect(t.lines.map(toNum)).toEqual([23, 3]);
  });

  it('precios sin IVA: suma el impuesto sobre gravados', () => {
    const t = computeTotals(
      [
        { price: 10, quantity: 2, taxable: true },
        { price: 5, quantity: 1, taxable: false },
      ],
      15,
      false,
    );
    expect(n(t)).toEqual({ subtotal: 25, tax: 3, total: 28 });
  });

  it('redondea half-up a 2 decimales', () => {
    // 0.10 * 15% = 0.015 -> 0.02
    const t = computeTotals([{ price: 0.1, quantity: 1, taxable: true }], 15, false);
    expect(n(t)).toEqual({ subtotal: 0.1, tax: 0.02, total: 0.12 });
    // 1.00 incluido: 1 - 1/1.15 = 0.1304... -> 0.13
    const t2 = computeTotals([{ price: 1, quantity: 1, taxable: true }], 15, true);
    expect(n(t2)).toEqual({ subtotal: 0.87, tax: 0.13, total: 1 });
  });

  it('subtotal + tax = total siempre (incluido)', () => {
    const t = computeTotals(
      [
        { price: 3.33, quantity: 7, taxable: true },
        { price: 2.49, quantity: 3, taxable: true },
      ],
      15,
      true,
    );
    expect(t.subtotal.plus(t.tax).equals(t.total)).toBe(true);
  });

  it('tasa 0', () => {
    const t = computeTotals([{ price: 4.5, quantity: 2, taxable: true }], 0, true);
    expect(n(t)).toEqual({ subtotal: 9, tax: 0, total: 9 });
  });
});

describe('splitPayments (cobro)', () => {
  it('separa efectivo y transferencia y compara en centavos', () => {
    const s = splitPayments([
      { method: 'CASH', amount: 10.1 },
      { method: 'TRANSFER', amount: 0.2, reference: 'ABC123' },
    ]);
    expect(s.totalCents).toBe(1030);
    expect(toNum(s.cash)).toBe(10.1);
    expect(toNum(s.transfer)).toBe(0.2);
  });

  it('exige reference en transferencias', () => {
    expect(() => splitPayments([{ method: 'TRANSFER', amount: 5 }])).toThrow(BadRequestException);
    expect(() => splitPayments([{ method: 'TRANSFER', amount: 5, reference: '   ' }])).toThrow(BadRequestException);
  });

  it('el efectivo esperado ignora transferencias', () => {
    expect(toNum(expectedCashOf(20, 10.1, 5, 3.5))).toBe(31.6);
  });
});
