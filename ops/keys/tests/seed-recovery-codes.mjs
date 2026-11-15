// ECSI CLOUD — données de TEST (CI et essais locaux uniquement) : 10 codes de récupération 2FA
// non utilisés pour le premier utilisateur, empreintes HMAC sous la clé ACTIVE de la pile
// (comme en production, où 10 codes sont restés sous « k2 »). Exécuté dans l'image applicative :
//   docker compose run --rm -T migrate node --input-type=module - < ops/keys/tests/seed-recovery-codes.mjs
// Aucun code ni aucune valeur affichés.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { SecretBox, parseKeyList } from './dist/auth/crypto/secret-box.js';

const box = new SecretBox(process.env.ENCRYPTION_KEY, {
  id: process.env.ENCRYPTION_KEY_ID || 'k1',
  previous: parseKeyList(process.env.ENCRYPTION_PREVIOUS_KEYS),
});
const pool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 1 });
try {
  const user = (await pool.query('select id from users order by email limit 1')).rows[0];
  for (let i = 0; i < 10; i += 1) {
    await pool.query('insert into mfa_recovery_codes (user_id, code_hash) values ($1, $2)', [
      user.id,
      box.mac(randomBytes(8).toString('hex').toUpperCase()),
    ]);
  }
  process.stdout.write(`Données de test : 10 codes de récupération sous ${box.activeKeyId}.\n`);
} finally {
  await pool.end();
}
