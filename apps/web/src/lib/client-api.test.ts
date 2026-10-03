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
});
