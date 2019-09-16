import { TypeOrmModule } from '@nestjs/typeorm';
import { Module } from '@nestjs/common';

import { OrdersModule } from './order/order.module';
import { HealthModule } from './health.module';
import { RedisModule } from './redis.module';

const pgHost = process.env.PG_HOST;
const pgPort: number = parseInt(process.env.PG_PORT, 10) || 5432;
const pgUser = process.env.PG_USER;
const pgPass = process.env.PG_PASSWORD;
const pgDatebase = process.env.PG_DATABASE;

@Module({
  imports: [
    RedisModule,
    HealthModule,
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: pgHost,
      port: pgPort,
      username: pgUser,
      password: pgPass,
      database: pgDatebase,
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      synchronize: false,
      logging: process.env.LOGGING === 'true' ? true : false,
      schema: 'btcbolsa',
    }),
    OrdersModule,
  ],
})
export class AppModule {}
