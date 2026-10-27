/**
 * Crea o resetea un usuario ADMIN por email.
 * Uso: npx ts-node prisma/create-admin.ts <email> <password> [nombre] [restaurantId]
 *  - Si el email ya existe: actualiza contraseña, rol ADMIN, activo y revoca sus refresh tokens.
 *  - restaurantId por defecto: cmp1he0et0000zdbo9ia8qsm8 (Triada); si no existe, usa el primer restaurante.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();
const prisma = new PrismaClient();

async function main() {
  const [rawEmail, password, name = 'Administrador', restaurantIdArg] = process.argv.slice(2);
  const email = rawEmail?.trim().toLowerCase();

  if (!email || !password) {
    console.error('Uso: npx ts-node prisma/create-admin.ts <email> <password> [nombre] [restaurantId]');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('La contraseña debe tener al menos 6 caracteres');
    process.exit(1);
  }

  const restaurant = restaurantIdArg
    ? await prisma.restaurant.findUnique({ where: { id: restaurantIdArg } })
    : ((await prisma.restaurant.findUnique({ where: { id: 'cmp1he0et0000zdbo9ia8qsm8' } })) ??
      (await prisma.restaurant.findFirst({ orderBy: { createdAt: 'asc' } })));
  if (!restaurant) {
    console.error(`No existe el restaurante ${restaurantIdArg ?? '(ninguno en la BD; ejecute el seed)'}`);
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { password: hashedPassword, role: 'ADMIN', isActive: true, restaurantId: restaurant.id },
    create: { email, password: hashedPassword, name, role: 'ADMIN', restaurantId: restaurant.id },
  });
  await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });

  console.log(`Admin listo: ${user.email} (id: ${user.id}) en restaurante "${restaurant.name}"`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
