# Triada POS — API

API del POS del restaurante **Triada** (NestJS 10 + Prisma 5 + PostgreSQL + Socket.IO).

El contrato de endpoints, permisos y formatos es **`docs/API_CONTRACT.md`** (única fuente de verdad).

## Requisitos
- Node 20+ y PostgreSQL 14+.

## Levantar en desarrollo
```bash
npm install
cp .env.example .env          # completar DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, CORS_ORIGINS
npx prisma migrate deploy     # aplica migraciones (no borra datos)
npx prisma generate
npx prisma db seed            # idempotente: restaurante "Triada" + datos de ejemplo si está vacío
npm run start:dev             # http://localhost:4010
```
Producción: `npm run build && npm run start:prod`.

## Crear / resetear un administrador
```bash
npm run create-admin -- admin@triada.ec "UnaClaveSegura" "Nombre" [restaurantId]
```
Si el email existe, actualiza la contraseña, lo deja como ADMIN activo y revoca sus sesiones.
Alternativa: definir `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` y ejecutar `npx prisma db seed`
(solo crea el admin si no existe).

## Variables de entorno
| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Conexión PostgreSQL |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Secretos distintos y largos (access 1h, refresh 7d) |
| `PORT` | Puerto HTTP y Socket.IO (4010) |
| `CORS_ORIGINS` | Orígenes permitidos, separados por coma (default `http://localhost:3000`) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Opcional, admin inicial del seed |

## Notas de diseño
- Multi-tenant: `restaurantId` sale siempre del JWT. Guards globales (JWT + roles); `@Public()` solo en login/refresh/health.
- Refresh tokens guardados como sha256 en `RefreshToken`, rotados en cada refresh y revocados en logout;
  reutilizar un token ya rotado revoca todas las sesiones del usuario.
- Montos con `Prisma.Decimal`, redondeo half-up a 2 decimales; el IVA se calcula en `src/modules/orders/tax.ts`.
- Una sola caja abierta por restaurante (índice único parcial `CashRegister_one_open_per_restaurant`).
  Las transferencias no suman al efectivo esperado.
- Tiempo real: Socket.IO namespace `/realtime`, JWT en `auth.token`, sala `restaurant:{id}`;
  eventos `table.updated`, `order.created`, `order.updated`, `cash.updated` emitidos tras el commit.
- Rate limit 10 req/min por IP en `/auth/*`; helmet; filtro global de errores (Prisma P2002/P2003 → 409, P2025 → 404).

## Tests
```bash
npm test     # cálculo de IVA y validación de cobro
```
