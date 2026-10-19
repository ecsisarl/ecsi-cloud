import { describe, expect, it } from 'vitest';
import { NAVIGATION, findNavItem, isActive, visibleNavigation } from './navigation';
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
    expect(main).not.toContain('routers');
    expect(main).not.toContain('hotspots');
  });

  it('détecte l’entrée active', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/ventes', '/')).toBe(false);
    expect(isActive('/reseau/routeurs/abc', '/reseau/routeurs')).toBe(true);
    expect(findNavItem('/ventes')?.plannedSprint).toBe('S8');
  });
});

describe('navigation selon les permissions', () => {
  const keys = (permissions: string[]) =>
    visibleNavigation(permissions).flatMap((group) => group.items.map((item) => item.key));

  it('masque les modules d’administration sans la permission correspondante', () => {
    const vendeur = keys(['sites.read', 'sales.read']);
    expect(vendeur).toContain('sites');
    expect(vendeur).not.toContain('users');
    expect(vendeur).not.toContain('audit');
    expect(vendeur).not.toContain('company');
    expect(vendeur).not.toContain('siteGroups');
    expect(vendeur).not.toContain('routers');
  });

  it('affiche Réseau → Routeurs avec routers.read (Sprint 3B)', () => {
    expect(keys(['routers.read'])).toContain('routers');
  });

  it('affiche Réseau → Monitoring avec monitoring.read (lot E1), plus en attente', () => {
    expect(keys(['monitoring.read'])).toContain('monitoring');
    expect(keys(['routers.read'])).not.toContain('monitoring');
    expect(findNavItem('/reseau/monitoring')?.plannedSprint).toBeUndefined();
  });

  it('lot B : Forfaits, Tickets et Hotspots livrés, selon leur permission', () => {
    expect(keys(['plans.read'])).toContain('plans');
    expect(keys(['vouchers.read'])).toContain('tickets');
    expect(keys(['hotspots.read'])).toContain('hotspots');
    for (const key of ['plans', 'tickets', 'hotspots'])
      expect(keys(['sites.read'])).not.toContain(key);
    for (const href of ['/forfaits', '/tickets', '/reseau/hotspots']) {
      expect(findNavItem(href)?.plannedSprint, href).toBeUndefined();
    }
    // Les autres modules restent annoncés comme à venir.
    expect(findNavItem('/clients')?.plannedSprint).toBe('S7');
  });

  it('affiche les modules du Sprint 2 à un administrateur', () => {
    const admin = keys([
      'sites.read',
      'site_groups.read',
      'companies.read',
      'users.read',
      'audit.read',
    ]);
    expect(admin).toEqual(
      expect.arrayContaining(['sites', 'siteGroups', 'company', 'users', 'audit']),
    );
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
