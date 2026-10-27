# Contrato API — Triada POS (panel + API)

Única fuente de verdad entre `api_posi` (NestJS + Prisma/PostgreSQL) y `dashboard_restaurant` (Next.js).
Si algo no está aquí, no existe. Cualquier cambio se hace primero en este archivo.

## Generales
- Base URL: `http://localhost:4010` (sin prefijo global). Front: `NEXT_PUBLIC_API_BASE=http://localhost:4010`.
- JSON siempre, también en DELETE (`{ "success": true }`) y en "no hay datos" (`{ "register": null }`). Nunca body vacío.
- Montos: en request **number** con hasta 2 decimales; en response **number** (no string, no Decimal).
- Fechas: response ISO 8601. Query `from`/`to` en formato `YYYY-MM-DD`, interpretadas en zona `America/Guayaquil`, ambos inclusivos.
- Auth: `Authorization: Bearer <accessToken>` en todo excepto `/auth/login`, `/auth/refresh`, `/health`.
- Multi-tenant: `restaurantId` siempre sale del JWT, nunca del body ni de query.
- Errores: `{ "statusCode": 400, "message": "texto en español" | ["..."], "error": "Bad Request" }`.
  Prisma P2002→409, P2025→404, P2003→409. Validaciones → 400. Sin permiso → 403. Token inválido → 401.
- Roles: `ADMIN`, `CASHIER`, `WAITER`. (Se elimina `DEVICE`.) El panel solo permite login a ADMIN y CASHIER (el front lo bloquea; el back permite login a todos para la futura app de meseros).

Leyenda de permisos: **A** = ADMIN, **C** = CASHIER, **W** = WAITER.

---

## Auth
| Método | Ruta | Roles | Body | Respuesta |
|---|---|---|---|---|
| POST | `/auth/login` | público | `{ email, password }` | `AuthResponse` |
| POST | `/auth/refresh` | público | `{ refreshToken }` | `AuthResponse` (rota refresh token) |
| POST | `/auth/logout` | A C W | `{ refreshToken }` | `{ success: true }` (revoca) |
| GET | `/auth/me` | A C W | — | `User` |

```ts
AuthResponse = { accessToken: string; refreshToken: string; user: User }
User = { id, name, email, role: 'ADMIN'|'CASHIER'|'WAITER', isActive: boolean, restaurantId, restaurantName, createdAt }
```
- accessToken 1h, refreshToken 7d. Refresh token guardado hasheado en BD; rotación en cada refresh; logout lo revoca.
- `/auth/register` **se elimina**. Login con usuario inactivo → 401 "Usuario inactivo".
- Rate limit en `/auth/*`: 10 req/min por IP.

## Restaurante / Configuración
| GET | `/restaurant` | A C | — | `Restaurant` |
|---|---|---|---|---|
| PATCH | `/restaurant` | A | `{ name?, ruc?, address?, phone?, taxRate?, pricesIncludeTax? }` | `Restaurant` |

```ts
Restaurant = { id, name, ruc: string|null, address: string|null, phone: string|null,
               taxRate: number /* ej 15 */, pricesIncludeTax: boolean, createdAt, updatedAt }
```
- El controller `/restaurants` (plural, sin guards) **se elimina**.

## Usuarios (meseros, cajeros, admins) — A
| GET | `/users?role=WAITER&active=true` | `User[]` |
|---|---|---|
| POST | `/users` `{ name, email, password (min 6), role }` | `User` |
| PATCH | `/users/:id` `{ name?, email?, password?, role?, isActive? }` | `User` |
| DELETE | `/users/:id` | `{ success: true }` — si tiene pedidos/ventas → se desactiva (`isActive=false`) en vez de borrar, responde `{ success: true, deactivated: true }` |
- Un admin no puede desactivarse ni borrarse a sí mismo (400).

## Áreas — GET: A C W · escritura: A
| GET | `/areas` | `Area[]` (con `tablesCount`) |
|---|---|---|
| POST | `/areas` `{ name }` | `Area` |
| PATCH | `/areas/:id` `{ name }` | `Area` |
| DELETE | `/areas/:id` | `{ success: true }` · 409 si tiene mesas |
```ts
Area = { id, name, tablesCount: number, createdAt }
```

## Mesas — GET: A C W · escritura: A
| GET | `/tables?areaId=` | `Table[]` |
|---|---|---|
| GET | `/tables/map` | `TableMapArea[]` (mapa del local con estado y pedido activo) |
| POST | `/tables` `{ name, areaId, seats? }` | `Table` |
| PATCH | `/tables/:id` `{ name?, areaId?, seats? }` | `Table` (el estado NO se edita a mano: OCCUPIED al abrir pedido, AVAILABLE al cobrarlo) |
| DELETE | `/tables/:id` | `{ success: true }` · 409 si tiene pedido activo |
```ts
TableStatus = 'AVAILABLE' | 'OCCUPIED'   // solo Libre / Ocupada. Sin reservas ni alertas por tiempo
Table = { id, name, seats: number|null, areaId, areaName, status: TableStatus,
          activeOrder: { id, number: number, customerName: string | null /* null en pedidos antiguos: el front muestra "Sin nombre" */, status: OrderStatus, total: number, itemsCount: number, createdAt } | null }
TableMapArea = { id, name, tables: Table[] }
```

## Productos — GET: A C W · escritura: A
Sin imagen. Descripción opcional. El admin decide si grava IVA.
| GET | `/products?search=&available=true` | `Product[]` (orden alfabético) |
|---|---|---|
| POST | `/products` `{ name, description?, price, taxable, available? }` | `Product` |
| PATCH | `/products/:id` (mismos campos opcionales) | `Product` |
| DELETE | `/products/:id` | `{ success: true }` · 409 "El producto tiene ventas; desactívelo" si tiene items |
```ts
Product = { id, name, description: string|null, price: number, taxable: boolean, available: boolean, createdAt, updatedAt }
```

## Cálculo de IVA (backend, al crear/modificar pedido)
- `rate = restaurant.taxRate / 100`. Por item: `lineTotal = price * quantity`.
- Si `pricesIncludeTax = true` (por defecto): el precio es final. Item gravado: `lineTax = lineTotal - lineTotal/(1+rate)`. `order.total = Σ lineTotal`, `order.tax = Σ lineTax`, `order.subtotal = total - tax`.
- Si `false`: `order.subtotal = Σ lineTotal`, `order.tax = Σ (lineTotal * rate)` de gravados, `order.total = subtotal + tax`.
- Redondeo a 2 decimales (half-up) con `Prisma.Decimal`, nunca floats. Se guarda snapshot en el item: `productName`, `price`, `taxable`.

## Pedidos — A C W
| GET | `/orders?status=&from=&to=&tableId=` | `Order[]` (desc por fecha, máx 200) |
|---|---|---|
| GET | `/orders/active` | `Order[]` con status OPEN (abiertos, sin cobrar) |
| GET | `/orders/:id` | `Order` |
| POST | `/orders` `{ tableId?, customerName (requerido, 1–80 caracteres, se recorta), notes?, items: [{ productId, quantity (int ≥1), notes? }] (min 1) }` | `Order` (status OPEN) · 409 si la mesa ya tiene pedido abierto · 400 si producto no disponible. Mesa → OCCUPIED |
| POST | `/orders/:id/items` `{ items: [...] }` | `Order` · 409 si PAID. Si el producto ya está en el pedido con las mismas notas, suma a ese item |
| PATCH | `/orders/:id` `{ customerName?, notes? }` | `Order` · corrige nombre/notas · 409 si PAID |
| PATCH | `/orders/:id/items/:itemId` `{ quantity (int ≥1) }` | `Order` · cambia la cantidad (p. ej. 2 → 1) · 409 si PAID |
| DELETE | `/orders/:id/items/:itemId` | `Order` · quita el producto · 409 si PAID · 400 si es el último item ("El pedido debe tener al menos un producto") |
| POST | `/orders/:id/pay` | ver **Cobro** |

**Nombre del cliente:** obligatorio al crear (400 "Ingrese el nombre del cliente" si falta o está vacío); identifica quién pidió y se muestra en la mesa. Se puede corregir con `PATCH /orders/:id` `{ customerName }` mientras el pedido está OPEN (409 si PAID). No hay tabla de clientes.

**Solo dos estados: `OPEN` (Abierto) → `PAID` (Pagado).** No hay estados intermedios (preparación, entregado) ni anulación, y **no existe endpoint para cambiar el estado a mano**: el único paso es cobrar con `/pay`, que lo deja PAID y libera la mesa (AVAILABLE). Mientras está OPEN, el pedido se modifica agregando, cambiando cantidad o quitando items; cada cambio recalcula totales e IVA.
(Migración: pedidos existentes PENDING/PREPARING/DELIVERED → OPEN; los CANCELLED históricos se conservan como dato antiguo, el API los devuelve con status `CANCELLED` solo en historial y no se pueden crear.)
```ts
OrderStatus = 'OPEN'|'PAID'|'CANCELLED' /* CANCELLED solo en datos históricos */
Order = { id, number: number /* correlativo legible */, status: OrderStatus,
  tableId: string|null, tableName: string|null, areaName: string|null,
  userId, userName, customerName: string|null /* null solo en pedidos antiguos */, notes: string|null,
  subtotal: number, tax: number, total: number,
  items: OrderItem[], sale: Sale|null, createdAt, updatedAt }
OrderItem = { id, productId, productName, quantity, price: number, taxable: boolean, subtotal: number, notes: string|null }
```

## Cobro — A C W
`POST /orders/:id/pay`
```ts
{ payments: [ { method: 'CASH'|'TRANSFER', amount: number, reference?: string } ] }  // min 1
```
- Solo efectivo y transferencia. `TRANSFER` exige `reference` (código de la transferencia, no vacío) → 400 si falta.
- Requiere caja abierta → 409 "No hay caja abierta".
- `Σ amount` debe ser **exactamente** `order.total` (comparar en centavos) → 400 si no. El vuelto lo calcula el front.
- Pedido que no está OPEN → 409.
- En una transacción: crea `Sale` + `Payment[]` ligados a la caja abierta, pedido → PAID, mesa → AVAILABLE.
- **Las transferencias no afectan el efectivo de caja**; solo `CASH` suma al efectivo esperado.
- Respuesta: `Order` (con `sale` lleno).
```ts
Sale = { id, orderId, cashRegisterId, userId, userName, subtotal, tax, total, cashAmount: number, transferAmount: number,
         payments: Payment[], createdAt }
Payment = { id, method: 'CASH'|'TRANSFER', amount: number, reference: string|null, createdAt }
```

## Caja — A C
Una sola caja abierta por restaurante (índice único parcial en BD).
| GET | `/cash-register/current` | `{ register: CashRegisterSummary | null }` |
|---|---|---|
| POST | `/cash-register/open` `{ initialAmount (≥0), notes? }` | `CashRegisterSummary` · 409 si ya hay una abierta |
| POST | `/cash-register/movements` `{ type: 'INCOME'|'EXPENSE', amount (>0), reason (requerido) }` | `CashRegisterSummary` · 409 sin caja abierta · 400 si egreso deja efectivo esperado < 0 |
| POST | `/cash-register/close` `{ countedCash (≥0), notes? }` | `CashRegisterSummary` (status CLOSED) — es el reporte de cierre |
| GET | `/cash-register/history?from=&to=` | `CashRegisterListItem[]` (desc) |
| GET | `/cash-register/:id/summary` | `CashRegisterSummary` (reimprimir PDF de cualquier cierre) |

Los ingresos/egresos manuales son de **efectivo**. Las ventas no se guardan como movimientos: se calculan desde los pagos.
```ts
CashRegisterSummary = {
  id, status: 'OPEN'|'CLOSED', openedAt, closedAt: string|null,
  openedBy: { id, name }, closedBy: { id, name } | null,
  notes: string|null, closingNotes: string|null,
  initialAmount: number,
  sales: { count: number, subtotal: number, tax: number, total: number, cash: number, transfer: number },
  incomes: number, expenses: number,
  expectedCash: number,      // initialAmount + sales.cash + incomes - expenses
  countedCash: number|null,  // al cerrar
  difference: number|null,   // countedCash - expectedCash
  movements: { id, type: 'INCOME'|'EXPENSE', amount: number, reason: string, userName: string, createdAt }[],
  transfers: { id, orderNumber: number, amount: number, reference: string, createdAt }[],
  salesList: { id, orderId, orderNumber: number, customerName: string|null, tableName: string|null, total: number, cash: number, transfer: number, createdAt }[],
  restaurant: { name, ruc, address, phone }   // para el encabezado del PDF
}
CashRegisterListItem = { id, status, openedAt, closedAt, openedBy: { id, name }, closedBy: { id, name } | null,
  initialAmount, salesTotal: number, expectedCash, countedCash: number|null, difference: number|null }
```
El PDF del cierre lo genera el **front** con `CashRegisterSummary`.

## Reportes — A C
`GET /reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD` (máx 366 días; 400 si `from > to`)
```ts
SalesReport = {
  from, to,
  totals: { count, subtotal, tax, total, cash, transfer, averageTicket: number },
  byDay: { date: 'YYYY-MM-DD', count, total, cash, transfer }[],   // todos los días del rango, también en 0
  byWeek: { weekStart: 'YYYY-MM-DD', weekEnd: 'YYYY-MM-DD', count, total, cash, transfer }[],  // semanas lunes-domingo
  topProducts: { productId, name, quantity, total }[],             // top 10 por total
  byUser: { userId, name, count, total }[],
  sales: { id, orderId, orderNumber, customerName: string|null, tableName, userName, total, cash, transfer, createdAt }[]   // orderId → GET /orders/:id para ver el detalle
}
```

## Impresoras — GET: A C · escritura: A
Solo registro/configuración en backend; conexión y prueba se hacen desde el navegador (Web Bluetooth).
| GET | `/printers` | `Printer[]` |
|---|---|---|
| POST | `/printers` `{ name, connectionType, address?, paperWidth, purpose, isDefault?, isActive? }` | `Printer` |
| PATCH | `/printers/:id` | `Printer` (si `isDefault=true`, desmarca las demás del mismo `purpose`) |
| DELETE | `/printers/:id` | `{ success: true }` |
```ts
Printer = { id, name, connectionType: 'BLUETOOTH'|'NETWORK'|'USB', address: string|null /* MAC, IP:puerto o nombre BLE */,
            paperWidth: 58|80, purpose: 'CASHIER'|'KITCHEN'|'BAR', isDefault: boolean, isActive: boolean, createdAt }
```

## Tiempo real — Socket.IO (preparado)
- Mismo puerto 4010, namespace `/realtime`. Conexión: `io('http://localhost:4010/realtime', { auth: { token: accessToken } })`.
- El servidor valida el JWT en el handshake (desconecta si es inválido) y une al socket a la sala `restaurant:{restaurantId}`.
- Eventos servidor → cliente (solo a la sala del restaurante, emitidos **después** del commit):
  - `table.updated` → `Table` (cambio de estado, pedido abierto/pagado/cancelado, edición)
  - `order.created` → `Order`
  - `order.updated` → `Order` (items, estado, pago)
  - `cash.updated` → `{ registerId, status: 'OPEN'|'CLOSED' }`
- Fallos de emisión se registran con Logger, nunca tumban la petición. **Se elimina Pusher** por completo.

## Health
`GET /health` → `{ status: 'ok', db: boolean, time }` (público).
