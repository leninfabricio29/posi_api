import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';
import { Transform } from 'class-transformer';

function flatten(errors: ValidationError[], parent = ''): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const path = parent ? `${parent}.${e.property}` : e.property;
    if (e.constraints) {
      for (const [key, msg] of Object.entries(e.constraints)) {
        if (key === 'whitelistValidation') out.push(`La propiedad "${path}" no está permitida`);
        else out.push(msg);
      }
    }
    if (e.children?.length) out.push(...flatten(e.children, path));
  }
  return out;
}

export function buildValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    // Sin mensajes repetidos (p. ej. IsString + IsNotEmpty con el mismo texto)
    exceptionFactory: (errors) => new BadRequestException([...new Set(flatten(errors))]),
  });
}

/** Query string 'true'/'false' -> boolean (undefined si no viene). */
export const ToBoolean = () =>
  Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  });

/** Recorta strings; '' -> undefined para opcionales. */
export const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const TrimOrNull = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const t = value.trim();
    return t === '' ? null : t;
  });
