/**
 * Sprint 2 — sites, groupes de sites et portée par site (RBAC + RLS).
 * Démontre : GERANT_SITE_A ne voit jamais SITE_B ; VENDEUR_SITE_B ne peut pas administrer
 * SITE_A ; ENTREPRISE_A ne voit jamais les sites d'ENTREPRISE_B ; aucun contournement par
 * UUID, URL, paramètre de requête, corps ou en-tête.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient, loginAs, startTestApp, type TestApp } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

let infra: TestInfra;
let t: TestApp;
let gerantA: HttpClient;
let gerantSiteA: HttpClient;
let vendeurSiteB: HttpClient;
let gerantB: HttpClient;

interface SiteView {
  id: string;
  code: string;
  name: string;
  status: string;
  metadata: Record<string, string>;
  groups: { id: string }[];
}

const site = (key: 'A' | 'B', code: string) => t.seed.sites[key][code] ?? '';
const SPOOF_HEADERS = () => ({
  'x-company-id': t.seed.companies.B,
  'x-site-id': site('A', 'SITE-B'),
  'x-tenant-id': t.seed.companies.B,
});

const siteRow = async (id: string) =>
  (
    await t.migrator.query<{ name: string; deleted_at: Date | null; company_id: string }>(
      'select name, deleted_at, company_id from sites where id = $1',
      [id],
    )
  ).rows[0];

const auditCount = async (action: string, result: string) =>
  Number(
    (
      await t.migrator.query<{ n: string }>(
        'select count(*) as n from audit_events where action = $1 and result = $2',
        [action, result],
      )
    ).rows[0]?.n ?? 0,
  );

beforeAll(async () => {
  infra = await startInfra();
  t = await startTestApp(infra);
  gerantA = await loginAs(t.app, 'gerant.a@ecsi.test');
  gerantSiteA = await loginAs(t.app, 'gerant.site-a@ecsi.test');
  vendeurSiteB = await loginAs(t.app, 'vendeur.site-b@ecsi.test');
  gerantB = await loginAs(t.app, 'gerant.b@ecsi.test');
}, 180_000);

afterAll(async () => {
  await t.close();
  await infra.stop();
});

describe('portée par site : GERANT_SITE_A', () => {
  it('ne liste que SITE_A, même en tentant de forcer un autre site ou une autre entreprise', async () => {
    const list = await gerantSiteA.get('/sites', { headers: SPOOF_HEADERS() });
    expect(list.statusCode).toBe(200);
    expect(list.json<SiteView[]>().map((s) => s.code)).toEqual(['SITE-A']);
    // Paramètre inconnu : refusé (schéma strict), jamais interprété comme un filtre de portée.
    expect((await gerantSiteA.get(`/sites?siteId=${site('A', 'SITE-B')}`)).statusCode).toBe(422);
    expect((await gerantSiteA.get(`/sites?companyId=${t.seed.companies.B}`)).statusCode).toBe(422);
    // Filtre par groupe : le groupe contient SITE_B, qui reste invisible.
    const byGroup = await gerantSiteA.get(`/sites?groupId=${t.seed.groupId}`);
    expect(byGroup.json<SiteView[]>().map((s) => s.code)).toEqual(['SITE-A']);
  });

  it('ne peut ni lire, ni modifier, ni supprimer SITE_B par son UUID (404, aucune modification)', async () => {
    const siteB = site('A', 'SITE-B');
    expect((await gerantSiteA.get(`/sites/${siteB}`)).statusCode).toBe(404);
    expect((await gerantSiteA.patch(`/sites/${siteB}`, { name: 'Piraté' })).statusCode).toBe(404);
    const removal = await gerantSiteA.delete(`/sites/${siteB}`);
    expect([403, 404]).toContain(removal.statusCode);
    const row = await siteRow(siteB);
    expect(row?.name).toBe('Yopougon Selmer');
    expect(row?.deleted_at).toBeNull();
  });

  it('peut lire et modifier SITE_A ; la modification partielle ne touche pas aux autres champs', async () => {
    const siteA = site('A', 'SITE-A');
    expect((await gerantSiteA.get(`/sites/${siteA}`)).statusCode).toBe(200);
    const before = (
      await gerantA.patch(`/sites/${siteA}`, { metadata: { borne: 'B1' } })
    ).json<SiteView>();
    expect(before.metadata).toEqual({ borne: 'B1' });
    const updated = await gerantSiteA.patch(`/sites/${siteA}`, { description: 'Point principal' });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<SiteView>()).toMatchObject({
      code: 'SITE-A',
      status: 'ACTIVE',
      metadata: { borne: 'B1' },
    });
  });

  it('ne peut pas créer de site (droit sur toute l’entreprise requis) ni injecter companyId', async () => {
    const body = { name: 'Nouveau', code: 'SITE-X', country: 'CI', timezone: 'Africa/Abidjan' };
    expect((await gerantSiteA.post('/sites', body)).statusCode).toBe(403);
    expect(
      (await gerantA.post('/sites', { ...body, companyId: t.seed.companies.B })).statusCode,
    ).toBe(422);
  });

  it('ne voit que les membres de son site, jamais ceux de SITE_B ni l’administrateur', async () => {
    const members = (await gerantSiteA.get('/users'))
      .json<{ email: string }[]>()
      .map((m) => m.email);
    expect(members).toContain('gerant.site-a@ecsi.test');
    expect(members).not.toContain('vendeur.site-b@ecsi.test');
    expect(members).not.toContain('admin.a@ecsi.test');
    const vendeurB = t.seed.users['vendeur.site-b@ecsi.test'] ?? '';
    expect((await gerantSiteA.get(`/users/${vendeurB}`)).statusCode).toBe(404);
    expect(
      (await gerantSiteA.patch(`/users/${vendeurB}/status`, { status: 'DISABLED' })).statusCode,
    ).toBe(404);
  });

  it('invite sur son site uniquement ; jamais sur SITE_B ni sur toute l’entreprise', async () => {
    const vendeurRole = t.seed.roles.A.VENDEUR;
    const ok = await gerantSiteA.post('/invitations', {
      email: 'nouveau.site-a@ecsi.test',
      roles: [{ roleId: vendeurRole, scope: 'SITES', siteIds: [site('A', 'SITE-A')] }],
    });
    expect(ok.statusCode).toBe(201);
    const otherSite = await gerantSiteA.post('/invitations', {
      email: 'pirate1@ecsi.test',
      roles: [{ roleId: vendeurRole, scope: 'SITES', siteIds: [site('A', 'SITE-B')] }],
    });
    expect([403, 404]).toContain(otherSite.statusCode);
    const companyWide = await gerantSiteA.post('/invitations', {
      email: 'pirate2@ecsi.test',
      roles: [{ roleId: vendeurRole }],
    });
    expect(companyWide.statusCode).toBe(403);
    const foreignSite = await gerantSiteA.post('/invitations', {
      email: 'pirate3@ecsi.test',
      roles: [{ roleId: vendeurRole, scope: 'SITES', siteIds: [site('B', 'SITE-A')] }],
    });
    expect([403, 404, 422]).toContain(foreignSite.statusCode);
    const pending = (
      await t.migrator.query('select 1 from invitations where email like $1', ['pirate%'])
    ).rowCount;
    expect(pending).toBe(0);
  });
});

describe('portée par site : VENDEUR_SITE_B', () => {
  it('voit SITE_B (lecture seule) et jamais SITE_A', async () => {
    const list = (await vendeurSiteB.get('/sites')).json<SiteView[]>();
    expect(list.map((s) => s.code)).toEqual(['SITE-B']);
    expect((await vendeurSiteB.get(`/sites/${site('A', 'SITE-A')}`)).statusCode).toBe(404);
  });

  it('ne peut administrer ni SITE_A ni son propre site', async () => {
    const denied = await auditCount('sites.update', 'DENIED');
    for (const id of [site('A', 'SITE-A'), site('A', 'SITE-B')]) {
      const r = await vendeurSiteB.patch(`/sites/${id}`, { name: 'Modifié par le vendeur' });
      expect(r.statusCode).toBe(403);
      expect((await vendeurSiteB.delete(`/sites/${id}`)).statusCode).toBe(403);
    }
    expect((await siteRow(site('A', 'SITE-A')))?.name).toBe('Cocody Riviera');
    // Chaque tentative refusée est tracée dans le journal d'audit.
    expect(await auditCount('sites.update', 'DENIED')).toBe(denied + 2);
  });

  it('n’a accès ni aux membres, ni aux groupes, ni au journal d’audit', async () => {
    expect((await vendeurSiteB.get('/users')).statusCode).toBe(403);
    expect((await vendeurSiteB.get('/site-groups')).statusCode).toBe(403);
    expect((await vendeurSiteB.get('/audit')).statusCode).toBe(403);
    expect((await vendeurSiteB.patch('/company', { name: 'X' })).statusCode).toBe(403);
  });
});

describe('isolation entre entreprises', () => {
  it('le même code de site existe dans les deux entreprises sans collision', () => {
    expect(site('A', 'SITE-A')).not.toBe(site('B', 'SITE-A'));
  });

  it('ENTREPRISE_A ne voit, ne modifie ni ne regroupe jamais un site d’ENTREPRISE_B', async () => {
    const foreign = site('B', 'SITE-A');
    expect((await gerantA.get('/sites')).json<SiteView[]>().map((s) => s.id)).not.toContain(
      foreign,
    );
    expect((await gerantA.get(`/sites/${foreign}`)).statusCode).toBe(404);
    expect((await gerantA.patch(`/sites/${foreign}`, { name: 'Piraté' })).statusCode).toBe(404);
    const addForeign = await gerantA.post(`/site-groups/${t.seed.groupId}/sites`, {
      siteIds: [foreign],
    });
    expect([404, 422]).toContain(addForeign.statusCode);
    expect((await siteRow(foreign))?.name).toBe('Plateau Centre (B)');
    // Et dans l'autre sens.
    expect((await gerantB.get(`/sites/${site('A', 'SITE-A')}`)).statusCode).toBe(404);
    expect((await gerantB.get(`/site-groups/${t.seed.groupId}`)).statusCode).toBe(404);
    expect((await gerantB.get('/site-groups')).json<unknown[]>()).toEqual([]);
  });
});

describe('sites et groupes de sites (ECSI Roaming)', () => {
  it('crée un site avec code unique par entreprise et coordonnées cohérentes', async () => {
    const base = { name: 'Abobo Gare', code: 'site-c', country: 'CI', timezone: 'Africa/Abidjan' };
    const created = await gerantA.post('/sites', { ...base, latitude: 5.42, longitude: -4.02 });
    expect(created.statusCode).toBe(201);
    expect(created.json<SiteView>().code).toBe('SITE-C');
    expect((await gerantA.post('/sites', base)).statusCode).toBe(409);
    expect(
      (await gerantA.post('/sites', { ...base, code: 'SITE-D', latitude: 5.4 })).statusCode,
    ).toBe(422);
    expect(
      (await gerantA.post('/sites', { ...base, code: 'SITE-E', timezone: 'Mars/Olympus' }))
        .statusCode,
    ).toBe(422);
    expect(
      (await gerantA.post('/sites', { ...base, code: 'SITE-F', metadata: { api_password: 'x' } }))
        .statusCode,
    ).toBe(422);
    expect(await auditCount('sites.create', 'SUCCESS')).toBeGreaterThanOrEqual(1);
  });

  it('gère les membres d’un groupe ; un site peut appartenir à plusieurs groupes', async () => {
    const siteA = site('A', 'SITE-A');
    const siteB = site('A', 'SITE-B');
    const group = await gerantA.post('/site-groups', {
      name: 'Nord',
      code: 'GROUPE-NORD',
      siteIds: [siteA],
    });
    expect(group.statusCode).toBe(201);
    const groupId = group.json<{ id: string }>().id;
    const added = await gerantA.post(`/site-groups/${groupId}/sites`, { siteIds: [siteB] });
    expect(added.statusCode).toBe(200);
    expect(
      added
        .json<{ sites: { code: string }[] }>()
        .sites.map((s) => s.code)
        .sort(),
    ).toEqual(['SITE-A', 'SITE-B']);
    const detail = (await gerantA.get(`/sites/${siteA}`)).json<SiteView>();
    expect(detail.groups.map((g) => g.id).sort()).toEqual([t.seed.groupId, groupId].sort());

    const removed = await gerantA.post(`/site-groups/${groupId}/sites/remove`, {
      siteIds: [siteA],
    });
    expect(removed.json<{ sites: { code: string }[] }>().sites.map((s) => s.code)).toEqual([
      'SITE-B',
    ]);
    expect(
      (await gerantA.post('/site-groups', { name: 'Doublon', code: 'GROUPE-NORD' })).statusCode,
    ).toBe(409);
    // Un gérant de site ne gère pas les groupes (droit sur toute l'entreprise).
    expect(
      (await gerantSiteA.post(`/site-groups/${groupId}/sites`, { siteIds: [siteA] })).statusCode,
    ).toBe(403);
    expect((await gerantA.delete(`/site-groups/${groupId}`)).statusCode).toBe(204);
    expect((await gerantA.get(`/site-groups/${groupId}`)).statusCode).toBe(404);
  });

  it('la suppression d’un site est réservée au droit sites.delete (pas au GERANT)', async () => {
    const created = await gerantA.post('/sites', {
      name: 'Temporaire',
      code: 'SITE-TMP',
      country: 'CI',
      timezone: 'Africa/Abidjan',
    });
    const id = created.json<SiteView>().id;
    expect((await gerantA.delete(`/sites/${id}`)).statusCode).toBe(403);
    expect((await siteRow(id))?.deleted_at).toBeNull();
  });
});
