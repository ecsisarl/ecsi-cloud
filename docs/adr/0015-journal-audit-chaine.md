# ADR 0015 — Journal d'audit en ajout seul, chaîné par hachage en base

- Statut : Acceptée (Sprint 2)

## Contexte

Le journal d'audit doit être persistant, consultable par l'entreprise et par la plateforme, et
**difficile à modifier**, y compris par un développeur ou un processus API compromis. Il ne doit
jamais contenir de secret (mot de passe, jeton, cookie, secret TOTP, clé de chiffrement, futurs
secrets MikroTik, WireGuard ou RADIUS).

## Décision

- Table unique `audit_events` : acteur (type, identifiant, libellé, rôles), entreprise, action,
  ressource et identifiant, site, résultat (`SUCCESS`, `DENIED`, `FAILURE`), IP, user-agent,
  identifiant de requête, détails avant/après, horodatage.
- **Ajout seul** : `ecsi_app` et `ecsi_auth` n'ont que `SELECT` et `INSERT` ; des déclencheurs
  refusent `UPDATE`, `DELETE` et `TRUNCATE`, même au propriétaire `ecsi_migrator`.
- **Chaînage calculé en base** : un déclencheur `SECURITY DEFINER` attribue `chain_seq`,
  `prev_hash`, `occurred_at` et `hash = SHA-256(prev_hash + tous les champs)` sous verrou
  consultatif. Une chaîne par entreprise (`chain_key = company_id`) et une chaîne `platform`. Les
  valeurs fournies par l'appelant sont écrasées : l'API ne peut pas forger un maillon.
- **Vérification** : `app.audit_verify_chain(chain_key)` renvoie les maillons invalides ;
  exécutable par `ecsi_auth` seulement, exposée dans la console plateforme.
- **RLS** : une entreprise ne lit que ses événements et n'écrit qu'au nom de l'utilisateur
  authentifié de la transaction (`actor_id = app.current_user_id()`).
- **Écriture dans la transaction métier** : une action réussie et son événement sont validés
  ensemble. L'intercepteur `@Audited` enregistre aussi les refus (`DENIED`) et les échecs
  (`FAILURE`), hors transaction métier.
- **Assainissement** : toute clé de détail correspondant à `AUDIT_FORBIDDEN_KEY` (mot de passe,
  jeton, secret, cookie, TOTP, clé, empreinte, récupération…) est remplacée par `[masqué]`, à
  toute profondeur ; les métadonnées de site refusent ces clés dès la validation.

## Conséquences

- Supprimer ou modifier un événement exige un superutilisateur PostgreSQL qui désactive les
  déclencheurs ; la falsification est alors détectée par la vérification de chaîne (testé).
- La chaîne ne protège pas contre la suppression des derniers maillons par un superutilisateur ;
  l'export périodique des empreintes vers un stockage externe (WORM) est prévu au durcissement
  (Sprint 10).
- Le verrou par chaîne sérialise les écritures d'une même entreprise : acceptable aux volumes
  visés, à mesurer aux paliers de l'ADR 0010.
