# ADR 0013 — Console super administrateur via le rôle `ecsi_auth`

- Statut : Acceptée (Sprint 2)
- Complète : [ADR 0011](0011-roles-postgresql-rls-module-auth.md)

## Contexte

Le Sprint 2 ajoute la console `SUPER_ADMIN` : lister, rechercher, consulter, créer, suspendre et
réactiver les entreprises clientes, réinitialiser la 2FA d'un utilisateur, consulter et vérifier
le journal d'audit de toute la plateforme. Ces opérations portent sur **plusieurs** entreprises
à la fois : elles ne peuvent pas passer par `ecsi_app`, dont la RLS limite chaque transaction à
une seule entreprise.

Deux options : un nouveau rôle PostgreSQL « plateforme », ou le rôle sans tenant existant
`ecsi_auth`.

## Décision

- La console utilise `ecsi_auth` (connexion `AUTH_DRIZZLE`), déjà sans contexte d'entreprise et
  déjà réservé au module d'authentification, auquel le module `platform` est rattaché.
- Les droits ajoutés à `ecsi_auth` sont minimaux et listés dans la migration 0004 : lecture des
  sites et groupes (compteurs), `INSERT/UPDATE` sur `companies`, création des rôles système et de
  l'invitation du premier administrateur, `SELECT/INSERT` sur `audit_events`, exécution de
  `app.audit_verify_chain`.
- À l'inverse, `ecsi_app` perd le droit de modifier `status`, `suspended_at`,
  `suspension_reason`, `slug` et `id` des entreprises (privilèges par colonne) : une entreprise ne
  peut ni se réactiver ni changer d'identifiant, même par une requête oubliée.
- Les routes `/api/v1/platform/*` exigent le domaine plateforme (`@PlatformRealm`) avec une
  session dont la 2FA est vérifiée. Un jeton d'entreprise y est refusé (403), un jeton plateforme
  est refusé sur les routes d'entreprise.
- Toute action de la console est auditée dans la chaîne `platform` ; quand elle concerne une
  entreprise (création, suspension, réactivation, réinitialisation 2FA d'un de ses membres),
  l'événement est **aussi** écrit dans la chaîne de cette entreprise, pour qu'elle le voie dans
  son propre journal.
- La réinitialisation 2FA par la plateforme exige le code TOTP du super administrateur et un
  motif ; elle révoque toutes les sessions de l'utilisateur et ne révèle jamais l'ancien secret.

## Conséquences

- Pas de nouveau rôle ni de nouvelle connexion à provisionner.
- Le périmètre de confiance de `ecsi_auth` s'élargit au module `platform`
  (`apps/api/src/platform`) : il reste petit et couvert par `platform.int.test.ts`.
- Une compromission de `ecsi_auth` donne accès à toutes les entreprises : c'était déjà le cas au
  Sprint 1 (limite connue de l'ADR 0011). Un rôle séparé pourra être introduit si la console
  grossit.
- La suspension révoque immédiatement toutes les sessions des membres de l'entreprise ; la
  connexion à une entreprise suspendue est refusée.
