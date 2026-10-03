import type { Provider } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { SecretBox, parseKeyList } from './crypto/secret-box.js';

export const SECRET_BOX = Symbol('SECRET_BOX');

export const secretBoxProvider: Provider = {
  provide: SECRET_BOX,
  inject: [ENV],
  useFactory: (env: Env) => createSecretBox(env),
};

export function createSecretBox(env: Env): SecretBox {
  return new SecretBox(env.ENCRYPTION_KEY, {
    id: env.ENCRYPTION_KEY_ID,
    previous: parseKeyList(env.ENCRYPTION_PREVIOUS_KEYS),
  });
}
