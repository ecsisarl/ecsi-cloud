import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toProblem } from './problem-details.filter.js';

describe('toProblem', () => {
  it('masque le détail des erreurs internes', () => {
    const problem = toProblem(new Error('connexion à db.interne:5432 refusée'), '/x', 'req-1');
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Erreur interne',
      status: 500,
      instance: '/x',
      requestId: 'req-1',
    });
  });

  it('conserve le message des erreurs HTTP client', () => {
    expect(toProblem(new NotFoundException('Site introuvable'))).toMatchObject({
      status: 404,
      title: 'Ressource introuvable',
      detail: 'Site introuvable',
    });
    expect(toProblem(new BadRequestException(['a', 'b'])).detail).toBe('a, b');
  });

  it('transforme une erreur Zod en 422 avec les champs en erreur', () => {
    const result = z.object({ name: z.string().min(2) }).safeParse({ name: 'x' });
    expect(result.success).toBe(false);
    const problem = toProblem(result.error);
    expect(problem.status).toBe(422);
    expect(problem.errors?.[0]?.path).toBe('name');
  });
});
