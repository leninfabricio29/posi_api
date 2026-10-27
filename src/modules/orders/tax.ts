import { Prisma } from '@prisma/client';
import { dec, DecimalLike, round2 } from '../../common/money';

export interface TaxLine {
  price: DecimalLike;
  quantity: number;
  taxable: boolean;
}

export interface TaxTotals {
  lines: Prisma.Decimal[]; // lineTotal por item (price * quantity)
  subtotal: Prisma.Decimal;
  tax: Prisma.Decimal;
  total: Prisma.Decimal;
}

/**
 * Cálculo de IVA según el contrato:
 *  - pricesIncludeTax=true: precio final; lineTax = lineTotal - lineTotal/(1+rate) (solo gravados);
 *    total = Σ lineTotal, tax = Σ lineTax, subtotal = total - tax.
 *  - pricesIncludeTax=false: subtotal = Σ lineTotal, tax = Σ lineTotal*rate (gravados), total = subtotal + tax.
 * Redondeo half-up a 2 decimales sobre los acumulados.
 */
export function computeTotals(items: TaxLine[], taxRatePercent: DecimalLike, pricesIncludeTax: boolean): TaxTotals {
  const rate = dec(taxRatePercent).div(100);
  const lines = items.map((i) => round2(dec(i.price).times(i.quantity)));
  const gross = lines.reduce((a, l) => a.plus(l), dec(0));
  const taxableGross = lines.reduce((a, l, idx) => (items[idx].taxable ? a.plus(l) : a), dec(0));

  if (pricesIncludeTax) {
    const taxRaw = rate.isZero() ? dec(0) : taxableGross.minus(taxableGross.div(rate.plus(1)));
    const total = round2(gross);
    const tax = round2(taxRaw);
    return { lines, subtotal: total.minus(tax), tax, total };
  }

  const subtotal = round2(gross);
  const tax = round2(taxableGross.times(rate));
  return { lines, subtotal, tax, total: subtotal.plus(tax) };
}
