// Pilote du laboratoire S3B : appelle l'API ECSI CLOUD RÉELLE comme le ferait le dashboard
// (session, cookie CSRF). Aucun secret affiché : le script d'enrôlement (qui contient le jeton)
// est écrit dans un fichier 0600 de .state, jamais sur la sortie standard.
// Toute réponse inattendue de l'API (404 d'un routeur supprimé, 403, 503…) est affichée
// proprement (« ERREUR <commande> : HTTP <statut> (<message>) ») avec le code de sortie 1.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiError, expectStatus, parseBody, routerView } from './pilote-lib.mjs';

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
  return { status: response.status, json: parseBody(await response.text()) };
}

async function main() {
  const login = await call('POST', '/auth/login', {
    email,
    password: readFileSync(passwordFile, 'utf8').trim(),
  });
  expectStatus(login, 200, 'connexion');
  // Comptes administrateurs : 2FA obligatoire. Secret TOTP du labo dans un fichier 0600 (jamais affiché).
  const mfaFile = process.env.PILOTE_MFA_FILE;
  if (mfaFile && login.json?.status === 'MFA_REQUIRED') {
    const code = totp(readFileSync(mfaFile, 'utf8').trim(), Date.now());
    expectStatus(await call('POST', '/auth/mfa/verify', { code }), 200, '2FA');
  } else if (mfaFile && !existsSync(mfaFile)) {
    const setup = expectStatus(await call('POST', '/auth/mfa/setup', {}), 200, '2FA');
    writeFileSync(mfaFile, setup.secret, { mode: 0o600 });
    const confirm = await call('POST', '/auth/mfa/confirm', {
      code: totp(setup.secret, Date.now()),
    });
    expectStatus(confirm, 200, '2FA');
  }
  const sites = expectStatus(await call('GET', '/sites'), 200, 'sites');
  const siteId = (code) => {
    const id = sites.find((s) => s.code === code)?.id;
    if (!id) throw new Error(`site ${code} introuvable`);
    return id;
  };

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
    const router = expectStatus(r, 201, 'manuel');
    console.log(r.status, router.id, router.tunnelIp);
  } else if (command === 'enroler') {
    const [name, scriptPath] = args;
    const r = await call('POST', '/routers/enrollments', { siteId: siteId('SITE-A'), name });
    const created = expectStatus(r, 201, 'enroler');
    writeFileSync(scriptPath, created.script, { mode: 0o600 });
    console.log(
      JSON.stringify({
        id: created.router.id,
        tunnelIp: created.router.tunnelIp,
        status: created.router.status,
        expiresAt: created.expiresAt,
      }),
    );
  } else if (command === 'voir') {
    const router = expectStatus(await call('GET', `/routers/${args[0]}`), 200, 'voir');
    console.log(JSON.stringify(routerView(router), null, 2));
  } else if (command === 'liste') {
    const routers = expectStatus(await call('GET', '/routers'), 200, 'liste');
    for (const x of routers)
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
    const r = await call('DELETE', `/routers/${args[0]}`);
    expectStatus(r, 204, 'supprimer');
    console.log(r.status);
  } else if (command === 'identifiants') {
    const [id, user, passwordPath] = args;
    const r = await call('PUT', `/routers/${id}/credentials`, {
      routerosUsername: user,
      routerosPassword: readFileSync(passwordPath, 'utf8').trim(),
    });
    const router = expectStatus(r, 200, 'identifiants');
    console.log(r.status, router.status);
  } else {
    throw new Error(`commande inconnue : ${command ?? '(aucune)'}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `ERREUR ${error instanceof ApiError ? error.message : `${command ?? ''} : ${error.message}`}`,
  );
  process.exitCode = 1;
}
