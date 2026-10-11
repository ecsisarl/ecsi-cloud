// ECSI CLOUD — données de TEST pour la sauvegarde (CI et essais locaux uniquement).
// Exécuté dans l'image applicative après seed.js, sur une pile de test :
//   docker compose run --rm -T migrate node --input-type=module - < ops/backup/tests/seed-secrets.mjs
// Ajoute deux routeurs avec mot de passe RouterOS chiffré (lié au routeur), un secret 2FA et
// deux événements d'audit chaînés, avec la clé ENCRYPTION_KEY de la pile. Aucune valeur affichée.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { SecretBox, parseKeyList } from './dist/auth/crypto/secret-box.js';
import { encryptRouterPassword } from './dist/routers/router-secret.js';

const box = new SecretBox(process.env.ENCRYPTION_KEY, {
  id: process.env.ENCRYPTION_KEY_ID || 'k1',
  previous: parseKeyList(process.env.ENCRYPTION_PREVIOUS_KEYS),
});
const pool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 1 });
try {
  const sites = (
    await pool.query('select company_id, id from sites order by company_id, id limit 2')
  ).rows;
  let n = 2;
  for (const site of sites) {
    const { rows } = await pool.query(
      `insert into routers (company_id, site_id, name, tunnel_ip, routeros_username,
         routeros_password_encrypted, transport)
       values ($1, $2, $3, $4, 'ecsi', 'v2:k1:x', 'API') returning id`,
      [site.company_id, site.id, `Routeur test ${n}`, `10.200.0.${n}`],
    );
    const owner = { companyId: site.company_id, routerId: rows[0].id };
    await pool.query('update routers set routeros_password_encrypted = $1 where id = $2', [
      encryptRouterPassword(box, owner, randomBytes(12).toString('hex')),
      owner.routerId,
    ]);
    n += 1;
  }
  const user = (await pool.query('select id from users order by email limit 1')).rows[0];
  await pool.query('insert into mfa_factors (user_id, secret_enc) values ($1, $2)', [
    user.id,
    box.encrypt(randomBytes(20).toString('hex'), `mfa:user:${user.id}`),
  ]);
  for (const action of ['backup.test_first', 'backup.test_second']) {
    await pool.query(
      `insert into audit_events (company_id, chain_key, chain_seq, hash, actor_type, actor_id,
         action, resource_type, result)
       values ($1, 'x', 0, ''::bytea, 'USER', $2, $3, 'test', 'SUCCESS')`,
      [sites[0].company_id, user.id, action],
    );
  }
  process.stdout.write(`Données de test : ${sites.length} routeurs, 1 secret 2FA, 2 événements.\n`);
} finally {
  await pool.end();
}
