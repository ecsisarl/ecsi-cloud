// ECSI CLOUD — service amont FACTICE pour l'essai Nginx HTTPS (Sprint S3H, H4). Remplace l'API
// et le tableau de bord derrière le vrai Nginx de production : renvoie la méthode, le chemin
// reçu et les en-têtes de la requête (jamais l'environnement). Imite aussi les en-têtes de
// sécurité de helmet / next.config.ts, que Nginx doit remplacer par les siens.
// Chaque requête est journalisée (une ligne JSON) pour compter ce qui atteint le service.
import http from 'node:http';

const name = process.env.STUB_NAME ?? 'amont';
const port = Number(process.env.STUB_PORT ?? 8000);

const server = http.createServer((request, response) => {
  let bodyBytes = 0;
  request.on('data', (chunk) => {
    bodyBytes += chunk.length;
  });
  request.on('end', () => {
    console.log(JSON.stringify({ stub: name, method: request.method, url: request.url }));
    response.writeHead(200, {
      'content-type': 'application/json',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-frame-options': 'SAMEORIGIN',
    });
    response.end(
      JSON.stringify({
        stub: name,
        method: request.method,
        url: request.url,
        headers: request.headers,
        bodyBytes,
      }),
    );
  });
});

// WebSocket : poignée de main acceptée (101) puis fermeture.
server.on('upgrade', (request, socket) => {
  console.log(
    JSON.stringify({ stub: name, method: request.method, url: request.url, upgrade: true }),
  );
  socket.end(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Ecsi-Stub: ${name}\r\n\r\n`,
  );
});

server.listen(port, '0.0.0.0');
