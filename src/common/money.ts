import { Prisma } from '@prisma/client';

export type DecimalLike = Prisma.Decimal | number | string;

export const dec = (v: DecimalLike): Prisma.Decimal => new Prisma.Decimal(v as Prisma.Decimal.Value);

/** Redondeo half-up a 2 decimales. */
export const round2 = (v: DecimalLike): Prisma.Decimal =>
  dec(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** Decimal -> number con 2 decimales (para respuestas JSON). */
export const toNum = (v: DecimalLike | null | undefined): number => (v == null ? 0 : Number(round2(v).toFixed(2)));

export const toNumOrNull = (v: DecimalLike | null | undefined): number | null => (v == null ? null : toNum(v));

/** Monto a centavos enteros (para comparaciones exactas). */
export const toCents = (v: DecimalLike): number => Number(round2(v).times(100).toFixed(0));

export const sumDec = (values: DecimalLike[]): Prisma.Decimal =>
  values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), dec(0));
