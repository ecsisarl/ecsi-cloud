# ADR 0011 — RLS par rôle PostgreSQL et rôle dédié au module d'authentification

- Statut : Acceptée (Sprint 1)
- Complète : [ADR 0003](0003-postgresql-drizzle-rls.md)

## Contexte

L'isolation des entreprises doit tenir même si une requête applicative oublie son filtre
`company_id`. Mais certaines opérations ont lieu **avant** que l'entreprise soit connue :
connexion (recherche du compte par e-mail), rotation des jetons, réinitialisation du mot de
passe, acceptation d'une invitation. Elles ont aussi besoin des tables de secrets (empreintes
de mots de passe, sessions, graines 2FA), que l'API métier ne doit jamais pouvoir lire.

L'ADR 0003 prévoyait `FORCE ROW LEVEL SECURITY` sur chaque table tenant.

## Décision

Trois rôles applicatifs, aucun avec `BYPASSRLS` ni `SUPERUSER` :

| Rôle            | Utilisé par                      | Accès                                                                                                           |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ecsi_app`      | API métier (`TenantDatabase`)    | Politiques `company_id = app.current_company_id()` en lecture **et** écriture ; aucun accès aux secrets         |
| `ecsi_auth`     | Module d'authentification seul   | Politiques `USING (true)` sur les tables nécessaires ; seul rôle à accéder aux tables de secrets                |
| `ecsi_migrator` | Migrations, synchronisation RBAC | Propriétaire ; RLS activée mais **non forcée**, pour synchroniser le catalogue des permissions et rôles système |

- `app.company_id` et `app.user_id` sont positionnés par `set_config(…, true)` (portée
  transaction) à partir de la session authentifiée uniquement.
- Les tables de secrets ont la RLS activée **et** sont révoquées pour `ecsi_app` (double barrière).
- Un test garde-fou échoue si une table du schéma `public` n'a pas la RLS activée.
- `FORCE ROW LEVEL SECURITY` n'est pas utilisé : il ne s'appliquerait qu'au propriétaire
  (`ecsi_migrator`), qui n'est jamais utilisé par l'API.

## Conséquences

- Un oubli de filtre dans l'API métier ne peut pas exposer une autre entreprise (testé avec le
  rôle réel, sans passer par le code).
- Le module d'authentification est un périmètre de confiance plus large : il est petit, isolé
  (`apps/api/src/auth`) et couvert par des tests d'intégration dédiés.
- Limite connue : un attaquant capable d'exécuter du SQL arbitraire **avec le rôle `ecsi_app`**
  pourrait positionner lui-même `app.company_id`. La RLS protège contre les erreurs applicatives
  et l'injection limitée, pas contre la compromission complète du processus API. Les requêtes
  sont paramétrées (Drizzle) et le rôle n'a ni DDL ni changement de rôle possible.
- Production : le provisioning de la base doit créer `ecsi_auth` (la migration 0002 échoue
  explicitement s'il est absent).
