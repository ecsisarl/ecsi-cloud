import { describe, expect, it } from 'vitest';
import { checkLogo, detectImageType } from './logo.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('Contrôle des logos', () => {
  it('reconnaît PNG, JPEG et WebP par leur signature', () => {
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(JPEG)).toBe('image/jpeg');
    expect(detectImageType(WEBP)).toBe('image/webp');
    expect(detectImageType(SVG)).toBeNull();
  });

  it('refuse un SVG, un type mensonger, un fichier vide ou trop lourd', () => {
    expect(checkLogo(PNG.toString('base64'), 'image/png').ok).toBe(true);
    expect(checkLogo(SVG.toString('base64'), 'image/png')).toEqual({
      ok: false,
      reason: 'Format accepté : PNG, JPEG ou WebP',
    });
    expect(checkLogo(PNG.toString('base64'), 'image/jpeg').ok).toBe(false);
    expect(checkLogo('', 'image/png').ok).toBe(false);
    const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024)]);
    expect(checkLogo(big.toString('base64'), 'image/png').ok).toBe(false);
  });
});
