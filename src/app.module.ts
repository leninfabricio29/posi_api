import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, RolesGuard } from './auth/guards';
import { RealtimeModule } from './modules/realtime/realtime';
import { RestaurantModule } from './modules/restaurant/restaurant';
import { UsersModule } from './modules/users/users';
import { AreasModule } from './modules/areas/areas';
import { TablesModule } from './modules/tables/tables';
import { ProductsModule } from './modules/products/products';
import { OrdersModule } from './modules/orders/orders';
import { CashRegisterModule } from './modules/cash-register/cash-register';
import { ReportsModule } from './modules/reports/reports';
import { PrintersModule } from './modules/printers/printers';
import { HealthModule } from './modules/health/health';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    // Solo se aplica en AuthController (@UseGuards(ThrottlerGuard)): 10 req/min por IP
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
    PrismaModule,
    AuthModule,
    RealtimeModule,
    RestaurantModule,
    UsersModule,
    AreasModule,
    TablesModule,
    ProductsModule,
    OrdersModule,
    CashRegisterModule,
    ReportsModule,
    PrintersModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
