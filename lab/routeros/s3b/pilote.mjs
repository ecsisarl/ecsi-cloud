// Pilote du laboratoire S3B : appelle l'API ECSI CLOUD RÉELLE comme le ferait le dashboard
// (session, cookie CSRF). Aucun secret affiché : le script d'enrôlement (qui contient le jeton)
// est écrit dans un fichier 0600 de .state, jamais sur la sortie standard.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { totp } = await import(
  fileURLToPath(new URL('../../../apps/api/dist/auth/crypto/totp.js', import.meta.url))
);

const [api, email, passwordFile, command, ...args] = process.argv.slice(2);
const cookies = new Map();
async function call(method, path, body) {
  const headers = { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  if (cookies.has('ecsi_csrf')) headers['x-csrf-token'] = cookies.get('ecsi_csrf');
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${api}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [name, ...value] = pair.split('=');
    cookies.set(name, value.join('='));
  }
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const login = await call('POST', '/auth/login', {
  email,
  password: readFileSync(passwordFile, 'utf8').trim(),
});
if (login.status !== 200) throw new Error(`connexion ${login.status}`);
// Comptes administrateurs : 2FA obligatoire. Secret TOTP du labo dans un fichier 0600 (jamais affiché).
const mfaFile = process.env.PILOTE_MFA_FILE;
if (mfaFile && login.json?.status === 'MFA_REQUIRED') {
  const code = totp(readFileSync(mfaFile, 'utf8').trim(), Date.now());
  const verified = await call('POST', '/auth/mfa/verify', { code });
  if (verified.status !== 200) throw new Error(`2FA ${verified.status}`);
} else if (mfaFile && !existsSync(mfaFile)) {
  const setup = await call('POST', '/auth/mfa/setup', {});
  writeFileSync(mfaFile, setup.json.secret, { mode: 0o600 });
  const confirm = await call('POST', '/auth/mfa/confirm', {
    code: totp(setup.json.secret, Date.now()),
  });
  if (confirm.status !== 200) throw new Error(`2FA ${confirm.status}`);
}
const sites = (await call('GET', '/sites')).json;
const siteId = (code) => sites.find((s) => s.code === code)?.id;

if (command === 'manuel') {
  const [name, tunnelIp, passwordPath] = args;
  const r = await call('POST', '/routers', {
    siteId: siteId('SITE-A'),
    name,
    tunnelIp,
    transport: 'API',
    routerosUsername: 'ecsi-cloud',
    routerosPassword: readFileSync(passwordPath, 'utf8').trim(),
  });
  console.log(r.status, r.json?.id ?? r.json?.detail, r.json?.tunnelIp ?? '');
} else if (command === 'enroler') {
  const [name, scriptPath] = args;
  const r = await call('POST', '/routers/enrollments', { siteId: siteId('SITE-A'), name });
  if (r.status !== 201) throw new Error(`enrôlement ${r.status} ${JSON.stringify(r.json)}`);
  writeFileSync(scriptPath, r.json.script, { mode: 0o600 });
  console.log(
    JSON.stringify({
      id: r.json.router.id,
      tunnelIp: r.json.router.tunnelIp,
      status: r.json.router.status,
      expiresAt: r.json.expiresAt,
    }),
  );
} else if (command === 'voir') {
  const r = await call('GET', `/routers/${args[0]}`);
  const { interfaces, ...rest } = r.json;
  console.log(
    JSON.stringify(
      { ...rest, interfaces: interfaces.map((i) => `${i.name}:${i.running ? 'up' : 'down'}`) },
      null,
      2,
    ),
  );
} else if (command === 'liste') {
  const r = await call('GET', '/routers');
  for (const x of r.json)
    console.log(
      [
        x.name,
        x.site.code,
        x.boardName,
        x.routerosVersion,
        x.tunnelIp,
        x.status,
        x.lastSeenAt,
        x.cpuLoad,
        x.uptimeSeconds,
      ].join(' | '),
    );
} else if (command === 'supprimer') {
  console.log((await call('DELETE', `/routers/${args[0]}`)).status);
} else if (command === 'identifiants') {
  const [id, user, passwordPath] = args;
  const r = await call('PUT', `/routers/${id}/credentials`, {
    routerosUsername: user,
    routerosPassword: readFileSync(passwordPath, 'utf8').trim(),
  });
  console.log(r.status, r.json?.status ?? r.json?.detail);
}
