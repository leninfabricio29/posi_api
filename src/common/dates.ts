import { BadRequestException } from '@nestjs/common';

/**
 * Zona America/Guayaquil = UTC-05:00 fijo (Ecuador no aplica horario de verano).
 */
export const TZ_OFFSET = '-05:00';
const OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inicio del día local (00:00 Guayaquil) como Date UTC. */
export function startOfLocalDay(date: string): Date {
  if (!DATE_RE.test(date)) throw new BadRequestException(`Fecha inválida: ${date} (use YYYY-MM-DD)`);
  const d = new Date(`${date}T00:00:00.000${TZ_OFFSET}`);
  if (Number.isNaN(d.getTime()) || localDateString(d) !== date) {
    throw new BadRequestException(`Fecha inválida: ${date}`);
  }
  return d;
}

/** Fin exclusivo: inicio del día local siguiente. */
export function endOfLocalDayExclusive(date: string): Date {
  return new Date(startOfLocalDay(date).getTime() + DAY_MS);
}

/** Fecha local YYYY-MM-DD de un instante. */
export function localDateString(d: Date): string {
  return new Date(d.getTime() - OFFSET_MS).toISOString().slice(0, 10);
}

/** Suma días a una fecha YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Lunes de la semana (lunes-domingo) de una fecha YYYY-MM-DD. */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 = domingo
  return addDays(date, -((dow + 6) % 7));
}

/** Diferencia en días entre dos fechas YYYY-MM-DD (to - from). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / DAY_MS,
  );
}

/** Construye filtro Prisma { gte, lt } a partir de from/to opcionales (inclusivos). */
export function dateRangeFilter(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  if (from && to && from > to) throw new BadRequestException('La fecha "from" no puede ser mayor que "to"');
  const filter: { gte?: Date; lt?: Date } = {};
  if (from) filter.gte = startOfLocalDay(from);
  if (to) filter.lt = endOfLocalDayExclusive(to);
  return filter;
}
