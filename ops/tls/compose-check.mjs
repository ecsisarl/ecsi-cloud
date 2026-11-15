// ECSI CLOUD — contrôle de la configuration Compose FUSIONNÉE de production (Sprint S3H, H4).
// Lit sur l'entrée standard la sortie de « docker compose … config --format json » et n'écrit
// que des verdicts (OK / ECHEC / INFO) : aucune valeur de variable n'est jamais affichée.
// Exécuté par ops/tls/preflight.sh dans l'image applicative (node), sans réseau.
//
// Code de sortie : 0 conforme, 1 au moins un ECHEC.
import { createHash } from 'node:crypto';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let config;
try {
  config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  console.log('ECHEC configuration Compose illisible (variable obligatoire manquante ?)');
  process.exit(1);
}
const services = config.services ?? {};

let fails = 0;
const ok = (message) => console.log(`OK    ${message}`);
const bad = (message) => {
  console.log(`ECHEC ${message}`);
  fails += 1;
};
const info = (message) => console.log(`INFO  ${message}`);
const check = (condition, good, wrong) => (condition ? ok(good) : bad(wrong));
const env = (name) => services[name]?.environment ?? {};
const kcv = (value) =>
  createHash('sha256').update(`ecsi-kcv-v1:${value}`).digest('hex').slice(0, 16);

// 1. Ports publiés : Nginx 80 et 443 (toutes interfaces), PostgreSQL 127.0.0.1:5432, rien d'autre.
const published = [];
for (const [name, service] of Object.entries(services)) {
  for (const port of service.ports ?? []) {
    published.push(`${name}:${port.host_ip ?? ''}:${port.published}->${port.target}`);
  }
}
const expected = ['nginx::80->8080', 'nginx::443->8443', 'postgres:127.0.0.1:5432->5432'];
check(
  published.length === expected.length && expected.every((p) => published.includes(p)),
  'ports publiés : Nginx 80 et 443, PostgreSQL 127.0.0.1:5432 seulement',
  `ports publiés inattendus : ${published.sort().join(', ') || 'aucun'}`,
);
for (const name of ['api', 'web', 'redis', 's3', 'portal', 'mailpit', 'migrate', 'worker']) {
  if (services[name]?.ports?.length) bad(`${name} publie un port`);
}

// 2. Portail captif : ni démarré par défaut, ni dépendance de Nginx.
check(!services.portal, 'portail captif non démarré (profil « portail »)', 'portail captif actif');
const nginx = services.nginx ?? {};
check(
  !Object.keys(nginx.depends_on ?? {}).includes('portal'),
  'Nginx ne dépend pas du portail',
  'Nginx dépend du portail',
);

// 3. Nginx : configuration de production, certificats et défis ACME en lecture seule.
const command = (nginx.command ?? []).join(' ');
const mode = /\/etc\/nginx\/ecsi\/([a-z-]+)\.conf/.exec(command)?.[1];
check(
  mode === 'https' || mode === 'acme-bootstrap',
  `Nginx : configuration de production, mode « ${mode} »`,
  'Nginx : configuration de production absente ou mode inconnu',
);
if (mode === 'acme-bootstrap')
  info('mode acme-bootstrap : HTTPS inactif (obtention du certificat)');
const mounts = Object.fromEntries((nginx.volumes ?? []).map((v) => [v.target, v]));
check(
  mounts['/etc/letsencrypt']?.read_only === true && mounts['/var/www/acme']?.read_only === true,
  'Nginx : certificats et défis ACME montés en lecture seule',
  'Nginx : volumes letsencrypt / acme-webroot absents ou en écriture',
);
check(
  !mounts['/etc/nginx/nginx.conf'],
  'Nginx : configuration de développement non montée',
  'Nginx : configuration de développement encore montée',
);

// 4. Variables de production effectives de l'API (valeurs publiques comparées, jamais affichées).
const api = env('api');
const expectations = {
  NODE_ENV: 'production',
  WEB_PUBLIC_URL: 'https://app.mytikcentral.com',
  CORS_ORIGINS: 'https://app.mytikcentral.com',
  ROUTER_ENROLL_PUBLIC_URL: 'https://enroll.mytikcentral.com/api/v1/routers/enroll',
  COOKIE_SECURE: 'true',
  LOG_PRETTY: 'false',
  S3_AUTO_CREATE_BUCKET: 'false',
  ROUTER_ENROLL_CA_URL: '',
  ROUTER_ENROLL_CA_FINGERPRINT: '',
};
for (const [key, value] of Object.entries(expectations)) {
  check(
    (api[key] ?? '') === value,
    `api ${key} conforme`,
    `api ${key} non conforme (attendu : ${value || 'vide'})`,
  );
}

// 5. Clés de chiffrement : mêmes clés actives et anciennes dans tous les processus qui
//    déchiffrent ; k2 toujours présente parmi les anciennes clés (codes de récupération 2FA).
const decrypting = ['api', 'migrate', 'worker', 'gateway', 'keys-rotate'];
for (const key of ['ENCRYPTION_KEY', 'ENCRYPTION_KEY_ID', 'ENCRYPTION_PREVIOUS_KEYS']) {
  const present = decrypting.filter((name) => services[name]);
  const prints = new Set(present.map((name) => kcv(env(name)[key] ?? '')));
  check(
    prints.size === 1 && (env('api')[key] ?? '') !== '',
    `${key} identique et non vide dans ${present.join(', ')}`,
    `${key} absente ou différente selon les services (${present.join(', ')})`,
  );
}
const previousIds = (env('api').ENCRYPTION_PREVIOUS_KEYS ?? '')
  .split(',')
  .map((entry) => entry.split(':')[0].trim())
  .filter(Boolean);
check(
  previousIds.includes('k2'),
  `ancienne clé k2 conservée (anciennes clés : ${previousIds.join(', ')})`,
  `ancienne clé k2 ABSENTE (anciennes clés : ${previousIds.join(', ') || 'aucune'}) : NE PAS déployer`,
);
for (const name of ['gateway', 'keys-rotate']) {
  if (!services[name]) info(`${name} hors du contrôle (profil non activé)`);
}

// 6. SMTP : Mailpit n'est pas un SMTP de production.
const smtp = (api.SMTP_HOST ?? '').toLowerCase();
check(
  smtp !== '' &&
    !/^(mailpit|localhost|127\.|::1$)/.test(smtp) &&
    !/\.(invalid|test|local|localhost)$/.test(smtp),
  'SMTP_HOST : serveur réel (ni Mailpit, ni local, ni domaine réservé)',
  'SMTP_HOST : Mailpit, local ou domaine réservé : SMTP réel obligatoire',
);

console.log(
  fails === 0 ? 'RESULTAT : configuration fusionnée conforme' : `RESULTAT : ${fails} échec(s)`,
);
process.exit(fails === 0 ? 0 : 1);
