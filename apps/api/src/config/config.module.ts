import { Global, Module } from '@nestjs/common';
import { type Env, parseEnv } from './env.js';

export const ENV = Symbol('ENV');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: Env = parseEnv(process.env)) {
    return {
      module: ConfigModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
