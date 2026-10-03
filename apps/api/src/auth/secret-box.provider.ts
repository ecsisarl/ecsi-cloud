import type { Provider } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { SecretBox } from './crypto/secret-box.js';

export const SECRET_BOX = Symbol('SECRET_BOX');

export const secretBoxProvider: Provider = {
  provide: SECRET_BOX,
  inject: [ENV],
  useFactory: (env: Env) => new SecretBox(env.ENCRYPTION_KEY),
};
