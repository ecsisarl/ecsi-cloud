import { describe, expect, it } from 'vitest';
import { safeNextPath } from './client-api';

describe('safeNextPath', () => {
  it('n’autorise que des chemins internes (pas de redirection ouverte)', () => {
    expect(safeNextPath('/securite/sessions')).toBe('/securite/sessions');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('https://malveillant.example')).toBe('/');
    expect(safeNextPath('//malveillant.example')).toBe('/');
    expect(safeNextPath('/\\malveillant.example')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
  });

  it('conserve la requête et l’ancre d’un chemin interne', () => {
    expect(safeNextPath('/reseau/routeurs?site=a#liste')).toBe('/reseau/routeurs?site=a#liste');
  });

  it.each([
    '/\t/malveillant.example',
    '/\n/malveillant.example',
    '/\r\n/malveillant.example',
    '/\t\\malveillant.example',
    '/\\/malveillant.example',
    '/\u0000/malveillant.example',
    '/\u007f/malveillant.example',
  ])('refuse les caractères que le navigateur réécrit en « // » (%j)', (next) => {
    expect(safeNextPath(next)).toBe('/');
  });

  it('chaque résultat accepté reste sur la même origine une fois résolu par le navigateur', () => {
    const base = 'https://app.mytikcentral.com';
    for (const next of ['/a', '/%2F%2Fmalveillant.example', '/./a', '/..//malveillant.example']) {
      const result = safeNextPath(next);
      expect(new URL(result, base).origin).toBe(base);
    }
  });
});
