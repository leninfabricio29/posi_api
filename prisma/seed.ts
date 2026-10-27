/**
 * Seed idempotente de Triada POS. No borra datos.
 *  - Usa el restaurante cmp1he0et0000zdbo9ia8qsm8 si existe (lo renombra a "Triada"); si no, busca/crea "Triada".
 *  - Crea un ADMIN solo si se definen SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD (si ya existe, no cambia su contraseña).
 *  - Crea áreas/mesas/productos de ejemplo solo si el restaurante no tiene ninguno.
 * Uso: npx prisma db seed
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();
const prisma = new PrismaClient();
const LEGACY_RESTAURANT_ID = 'cmp1he0et0000zdbo9ia8qsm8';

async function ensureRestaurant() {
  const legacy = await prisma.restaurant.findUnique({ where: { id: LEGACY_RESTAURANT_ID } });
  if (legacy) {
    return legacy.name === 'Triada'
      ? legacy
      : prisma.restaurant.update({ where: { id: legacy.id }, data: { name: 'Triada' } });
  }
  const existing = await prisma.restaurant.findFirst({ where: { name: 'Triada' } });
  if (existing) return existing;
  return prisma.restaurant.create({ data: { name: 'Triada', taxRate: 15, pricesIncludeTax: true } });
}

async function main() {
  const restaurant = await ensureRestaurant();
  console.log(`Restaurante: ${restaurant.name} (${restaurant.id})`);

  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 6) throw new Error('SEED_ADMIN_PASSWORD debe tener al menos 6 caracteres');
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`Admin ${email} ya existe: no se modifica`);
    } else {
      await prisma.user.create({
        data: {
          email,
          password: await bcrypt.hash(password, 10),
          name: 'Administrador',
          role: 'ADMIN',
          restaurantId: restaurant.id,
        },
      });
      console.log(`Admin creado: ${email}`);
    }
  } else {
    console.log('SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD no definidos: no se crea admin');
  }

  const areas = await prisma.area.count({ where: { restaurantId: restaurant.id } });
  if (areas === 0) {
    const salon = await prisma.area.create({ data: { name: 'Salón', restaurantId: restaurant.id } });
    const terraza = await prisma.area.create({ data: { name: 'Terraza', restaurantId: restaurant.id } });
    const tables = [
      ...[1, 2, 3, 4].map((n) => ({ name: `Mesa ${n}`, seats: 4, areaId: salon.id })),
      ...[5, 6].map((n) => ({ name: `Mesa ${n}`, seats: 2, areaId: terraza.id })),
    ];
    for (const t of tables) {
      await prisma.table.upsert({
        where: { restaurantId_name: { restaurantId: restaurant.id, name: t.name } },
        update: {},
        create: { ...t, restaurantId: restaurant.id },
      });
    }
    console.log('Áreas y mesas de ejemplo creadas');
  } else {
    console.log(`Ya existen ${areas} áreas: no se crean de ejemplo`);
  }

  const products = await prisma.product.count({ where: { restaurantId: restaurant.id } });
  if (products === 0) {
    await prisma.product.createMany({
      data: [
        { name: 'Encebollado', description: 'Con chifle y limón', price: 6.5, taxable: true },
        { name: 'Seco de pollo', price: 7.0, taxable: true },
        { name: 'Ceviche de camarón', price: 9.5, taxable: true },
        { name: 'Jugo natural', price: 2.5, taxable: true },
        { name: 'Agua sin gas', price: 1.0, taxable: false },
      ].map((p) => ({ ...p, restaurantId: restaurant.id })),
    });
    console.log('Productos de ejemplo creados');
  } else {
    console.log(`Ya existen ${products} productos: no se crean de ejemplo`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
