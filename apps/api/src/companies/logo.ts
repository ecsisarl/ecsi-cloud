import { LOGO_MAX_BYTES } from '@ecsi/shared';

type LogoType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * Vérifie qu'un logo est bien l'image annoncée en lisant sa signature (« magic bytes ») :
 * le type déclaré par le client n'est jamais cru sur parole. SVG refusé (script possible).
 */
export function detectImageType(data: Buffer): LogoType | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export type LogoCheck =
  { ok: true; data: Buffer; contentType: LogoType } | { ok: false; reason: string };

export function checkLogo(base64: string, declared: LogoType): LogoCheck {
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) return { ok: false, reason: 'Fichier vide' };
  if (data.length > LOGO_MAX_BYTES) return { ok: false, reason: 'Le logo dépasse 512 Ko' };
  const actual = detectImageType(data);
  if (!actual) return { ok: false, reason: 'Format accepté : PNG, JPEG ou WebP' };
  if (actual !== declared)
    return { ok: false, reason: 'Le contenu ne correspond pas au type annoncé' };
  return { ok: true, data, contentType: actual };
}

export const LOGO_EXTENSIONS: Record<LogoType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
