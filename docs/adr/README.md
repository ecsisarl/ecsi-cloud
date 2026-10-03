# Décisions d'architecture (ADR)

Chaque décision structurante est consignée ici : contexte, décision, conséquences. Une décision n'est jamais réécrite ; elle est remplacée par une nouvelle ADR qui la rend caduque.

| N°                                               | Décision                                                         | Statut   |
| ------------------------------------------------ | ---------------------------------------------------------------- | -------- |
| [0001](0001-monorepo-pnpm-turborepo.md)          | Monorepo pnpm + Turborepo, TypeScript strict                     | Acceptée |
| [0002](0002-nestjs-monolithe-modulaire.md)       | Backend NestJS en monolithe modulaire                            | Acceptée |
| [0003](0003-postgresql-drizzle-rls.md)           | PostgreSQL, Drizzle, isolation des tenants par RLS               | Acceptée |
| [0004](0004-wireguard-passerelles.md)            | WireGuard via passerelles, clé privée générée sur le routeur     | Acceptée |
| [0005](0005-radius-central.md)                   | AAA centralisé FreeRADIUS, MVP technique et commercial           | Acceptée |
| [0006](0006-portail-captif-html-pur.md)          | Portail captif en HTML pur sans JavaScript client                | Acceptée |
| [0007](0007-gestion-des-secrets.md)              | Gestion des secrets                                              | Acceptée |
| [0008](0008-laboratoire-mikrotik-obligatoire.md) | Laboratoire MikroTik obligatoire                                 | Acceptée |
| [0009](0009-stockage-objet-developpement.md)     | SeaweedFS comme stockage S3 de développement                     | Acceptée |
| [0010](0010-fiabilite-avant-optimisation.md)     | Fiabilité avant optimisation, montée en charge par paliers       | Acceptée |
| [0011](0011-roles-postgresql-rls-module-auth.md) | RLS par rôle PostgreSQL, rôle dédié au module d'authentification | Acceptée |
| [0012](0012-sessions-jetons-cookies.md)          | Sessions serveur, jetons courts, cookies httpOnly                | Acceptée |
| [0013](0013-console-plateforme-role-auth.md)     | Console super administrateur via le rôle `ecsi_auth`             | Acceptée |
| [0014](0014-chiffrement-enveloppe-rotation.md)   | Chiffrement enveloppe versionné, rotation de la clé maîtresse    | Acceptée |
| [0015](0015-journal-audit-chaine.md)             | Journal d'audit en ajout seul, chaîné par hachage en base        | Acceptée |
