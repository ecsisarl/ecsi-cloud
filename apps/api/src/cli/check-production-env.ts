/**
 * Contrôle AVANT déploiement (Sprint S3H, étape H7) : la configuration de l'API EN SERVICE
 * passerait-elle les garde-fous de production de CETTE version ? Lecture seule.
 *
 *   docker exec <conteneur api> env | docker run --rm -i <image H7> \
 *     node dist/cli/check-production-env.js
 *
 * Les variables sont lues sur l'entrée standard (sortie de `env`), jamais affichées : seuls
 * des noms de variables et des messages génériques sont écrits. Code 0 : déploiement
 * possible ; 1 : au moins un refus à corriger d'abord ; 2 : entrée vide.
 */
import { productionPreflight, parseEnvLines } from '../config/production-preflight.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const source = parseEnvLines(await readStdin());
if (Object.keys(source).length === 0) {
  process.stderr.write('Entrée vide : fournir la sortie de « env » du conteneur api.\n');
  process.exit(2);
}
const report = productionPreflight(source);
const out: string[] = [`INFO  NODE_ENV actuel : ${report.currentNodeEnv}`];
for (const issue of report.blocking) out.push(`ECHEC ${issue}`);
for (const warning of report.warnings) out.push(`AVERT ${warning}`);
out.push(
  report.blocking.length === 0
    ? 'RESULTAT : conforme aux garde-fous de production H7 (aucune valeur affichée).'
    : `RESULTAT : ${report.blocking.length} refus à corriger avant déploiement (aucune valeur affichée).`,
);
process.stdout.write(`${out.join('\n')}\n`);
process.exit(report.blocking.length === 0 ? 0 : 1);
