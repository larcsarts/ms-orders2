import { Module } from '@nestjs/common';
import {
  TerminusModule,
  TerminusModuleOptions,
  MicroserviceHealthIndicator,
} from '@nestjs/terminus';
import { Transport } from '@nestjs/microservices';

const getTerminusOptions = (
  microservice: MicroserviceHealthIndicator,
): TerminusModuleOptions => ({
  endpoints: [
    {
      url: '/health',
      healthIndicators: [],
    },
  ],
});

@Module({
  imports: [
    TerminusModule.forRootAsync({
      inject: [MicroserviceHealthIndicator],
      useFactory: getTerminusOptions,
    }),
  ],
})
export class HealthModule {}
