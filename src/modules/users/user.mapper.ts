import { Prisma } from '@prisma/client';

export const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  restaurantId: true,
  createdAt: true,
  restaurant: { select: { name: true } },
} satisfies Prisma.UserSelect;

export type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

export function toUserDto(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    restaurantId: u.restaurantId,
    restaurantName: u.restaurant.name,
    createdAt: u.createdAt,
  };
}
