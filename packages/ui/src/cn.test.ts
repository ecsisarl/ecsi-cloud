import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('résout les conflits Tailwind', () => {
    expect(cn('px-2 text-sm', 'px-4')).toBe('text-sm px-4');
  });
  it('ignore les valeurs falsy', () => {
    expect(cn('a', false, undefined, 'b')).toBe('a b');
  });
});
