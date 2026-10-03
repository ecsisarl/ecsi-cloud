import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Valide une entrée avec un schéma Zod partagé (packages/shared). Une erreur de
 * validation est convertie en HTTP 422 par ProblemDetailsFilter.
 *
 * Usage : `@Body(new ZodValidationPipe(createSiteSchema)) body: CreateSite`
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
