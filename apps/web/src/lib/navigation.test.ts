import { describe, expect, it } from 'vitest';
import { NAVIGATION, findNavItem, isActive } from './navigation';
import fr from '../../messages/fr.json';
import en from '../../messages/en.json';

describe('navigation', () => {
  it('chaque entrée possède une traduction en français et en anglais', () => {
    for (const item of NAVIGATION.flatMap((g) => g.items)) {
      expect(fr.nav).toHaveProperty(item.key);
      expect(en.nav).toHaveProperty(item.key);
    }
  });

  it('les URL sont uniques', () => {
    const hrefs = NAVIGATION.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('les fonctions techniques sont hors du groupe « Activité »', () => {
    const main = NAVIGATION.find((g) => g.key === 'main')!.items.map((i) => i.key);
    expect(main).not.toContain('mikrotik');
    expect(main).not.toContain('hotspots');
  });

  it('détecte l’entrée active', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/ventes', '/')).toBe(false);
    expect(isActive('/reseau/mikrotik/abc', '/reseau/mikrotik')).toBe(true);
    expect(findNavItem('/tickets')?.plannedSprint).toBe('S6');
  });
});

describe('traductions', () => {
  const keys = (obj: object, prefix = ''): string[] =>
    Object.entries(obj).flatMap(([k, v]) =>
      typeof v === 'object' && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
    );

  it('le fichier anglais contient exactement les mêmes clés que le français', () => {
    expect(keys(en).sort()).toEqual(keys(fr).sort());
  });
});
