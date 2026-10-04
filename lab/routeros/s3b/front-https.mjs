// Frontal HTTPS du LABORATOIRE (namespace « cloud », 203.0.113.30:8443) devant l'API ECSI CLOUD
// réelle : certificat signé par l'AC du labo (pki-labo.sh), /ca.pem pour l'étape 2 du script,
// tout le reste relayé tel quel à l'API (X-Forwarded-For = adresse publique vue). En production,
// ce rôle est tenu par Nginx avec un certificat d'AC publique.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

const [pki, upstreamHost, upstreamPort, listenHost, listenPort] = process.argv.slice(2);
const ca = readFileSync(`${pki}/ca.pem`);
createServer(
  { key: readFileSync(`${pki}/serveur.key`), cert: readFileSync(`${pki}/serveur.pem`) },
  (req, res) => {
    if (req.method === 'GET' && req.url === '/ca.pem') {
      res.writeHead(200, { 'content-type': 'application/x-pem-file' });
      res.end(ca);
      return;
    }
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '' };
    const upstream = request(
      {
        host: upstreamHost,
        port: Number(upstreamPort),
        method: req.method,
        path: req.url,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url}`);
  },
).listen(Number(listenPort), listenHost);
