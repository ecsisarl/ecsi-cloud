import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Chiffrement des secrets stockés en base (graines TOTP), par enveloppe et versionné
 * (ADR 0014, docs/SECURITY.md) :
 *
 *  - chaque secret est chiffré (AES-256-GCM) avec une clé de données (DEK) aléatoire et
 *    unique ; la DEK est elle-même chiffrée (« enveloppée ») par la clé maîtresse (KEK)
 *    active, identifiée par un identifiant de version (ENCRYPTION_KEY_ID) ;
 *  - format v2 : v2:<kid>:<iv DEK>:<tag DEK>:<DEK chiffrée>:<iv>:<tag>:<chiffré> (base64url) ;
 *  - rotation : nouvelle clé active, anciennes clés conservées en lecture
 *    (ENCRYPTION_PREVIOUS_KEYS), puis `pnpm keys:rotate` ré-enveloppe chaque DEK avec la clé
 *    active sans toucher au secret lui-même ; une ancienne clé peut ensuite être retirée ;
 *  - le format v1 du Sprint 1 (v1:<iv>:<tag>:<chiffré>, clé dérivée directement) reste
 *    lisible et est converti en v2 par la rotation.
 *
 * Les données associées (AAD) lient chaque chiffré à son propriétaire : copié sur une autre
 * ligne, il est inutilisable. Aucune clé n'est jamais écrite en base ni dans les journaux.
 */
export interface KeyMaterial {
  readonly id: string;
  /** 32 octets encodés en base64. */
  readonly base64: string;
}

interface DerivedKey {
  readonly id: string;
  readonly kek: Buffer;
  readonly legacyEncryption: Buffer;
  readonly hmac: Buffer;
}

export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,15}$/;

function derive(material: KeyMaterial): DerivedKey {
  if (!KEY_ID_PATTERN.test(material.id)) {
    throw new Error(`Identifiant de clé invalide : ${material.id}`);
  }
  const master = Buffer.from(material.base64, 'base64');
  if (master.length !== 32) {
    throw new Error('Chaque clé de chiffrement doit contenir 32 octets');
  }
  const sub = (info: string) => Buffer.from(hkdfSync('sha256', master, '', info, 32));
  return {
    id: material.id,
    kek: sub('ecsi:kek:v2'),
    legacyEncryption: sub('ecsi:aes-gcm:v1'),
    hmac: sub('ecsi:hmac:v1'),
  };
}

const b64 = (buffer: Buffer) => buffer.toString('base64url');
const unb64 = (value: string) => Buffer.from(value, 'base64url');

function seal(key: Buffer, plaintext: Buffer, aad: string): [Buffer, Buffer, Buffer] {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext];
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class SecretBox {
  private readonly active: DerivedKey;
  private readonly keys: ReadonlyMap<string, DerivedKey>;

  constructor(activeBase64: string, options: { id?: string; previous?: KeyMaterial[] } = {}) {
    this.active = derive({ id: options.id ?? 'k1', base64: activeBase64 });
    const keys = new Map<string, DerivedKey>([[this.active.id, this.active]]);
    for (const material of options.previous ?? []) {
      if (keys.has(material.id)) throw new Error(`Identifiant de clé en double : ${material.id}`);
      keys.set(material.id, derive(material));
    }
    this.keys = keys;
  }

  get activeKeyId(): string {
    return this.active.id;
  }

  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  encrypt(plaintext: string, associatedData = ''): string {
    return this.envelope(Buffer.from(plaintext, 'utf8'), associatedData);
  }

  decrypt(payload: string, associatedData = ''): string {
    return this.openPayload(payload, associatedData).toString('utf8');
  }

  /** Vrai si le chiffré n'est pas au format v2 sous la clé active (à ré-envelopper). */
  needsRewrap(payload: string): boolean {
    const [version, kid] = payload.split(':');
    return version !== 'v2' || kid !== this.active.id;
  }

  /**
   * Ré-enveloppe un chiffré avec la clé active. En v2, seule la DEK est déchiffrée puis
   * ré-chiffrée : le secret lui-même n'est jamais manipulé en clair. Le v1 est converti.
   */
  rewrap(payload: string, associatedData = ''): string {
    const parts = payload.split(':');
    if (parts[0] !== 'v2')
      return this.envelope(this.openPayload(payload, associatedData), associatedData);
    const [, kid, wrapIv, wrapTag, wrapped, iv, tag, ciphertext] = parts;
    if (!kid || !wrapIv || !wrapTag || !wrapped || !iv || !tag || ciphertext === undefined) {
      throw new Error('Format de secret chiffré inconnu');
    }
    const dek = this.unwrapDek(kid, wrapIv, wrapTag, wrapped, associatedData);
    const [newIv, newTag, newWrapped] = seal(
      this.active.kek,
      dek,
      this.wrapAad(this.active.id, associatedData),
    );
    dek.fill(0);
    return [
      'v2',
      this.active.id,
      b64(newIv),
      b64(newTag),
      b64(newWrapped),
      iv,
      tag,
      ciphertext,
    ].join(':');
  }

  /**
   * Empreinte HMAC-SHA256 versionnée (« kid$empreinte ») : codes de récupération 2FA.
   * Comparaison par égalité ; voir macCandidates pour la recherche.
   */
  mac(value: string): string {
    return `${this.active.id}$${this.rawMac(this.active, value)}`;
  }

  /**
   * Empreintes possibles d'une valeur sous toutes les clés connues, y compris le format
   * non versionné du Sprint 1 : permet de retrouver un code créé avant une rotation.
   */
  macCandidates(value: string): string[] {
    const candidates: string[] = [];
    for (const key of this.keys.values()) {
      const raw = this.rawMac(key, value);
      candidates.push(`${key.id}$${raw}`, raw);
    }
    return candidates;
  }

  /** Identifiant pseudonyme (clés Redis, journaux) : jamais l'adresse e-mail en clair. */
  fingerprint(value: string): string {
    return this.rawMac(this.active, value).slice(0, 32);
  }

  private rawMac(key: DerivedKey, value: string): string {
    return createHmac('sha256', key.hmac).update(value, 'utf8').digest('base64url');
  }

  private wrapAad(kid: string, associatedData: string): string {
    return `ecsi:dek:${kid}:${associatedData}`;
  }

  private envelope(plaintext: Buffer, associatedData: string): string {
    const dek = randomBytes(32);
    try {
      const [iv, tag, ciphertext] = seal(dek, plaintext, associatedData);
      const [wrapIv, wrapTag, wrapped] = seal(
        this.active.kek,
        dek,
        this.wrapAad(this.active.id, associatedData),
      );
      return [
        'v2',
        this.active.id,
        b64(wrapIv),
        b64(wrapTag),
        b64(wrapped),
        b64(iv),
        b64(tag),
        b64(ciphertext),
      ].join(':');
    } finally {
      dek.fill(0);
    }
  }

  private unwrapDek(
    kid: string,
    wrapIv: string,
    wrapTag: string,
    wrapped: string,
    associatedData: string,
  ): Buffer {
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Clé de chiffrement « ${kid} » indisponible`);
    return open(
      key.kek,
      unb64(wrapIv),
      unb64(wrapTag),
      unb64(wrapped),
      this.wrapAad(kid, associatedData),
    );
  }

  private openPayload(payload: string, associatedData: string): Buffer {
    const parts = payload.split(':');
    if (parts[0] === 'v2') {
      const [, kid, wrapIv, wrapTag, wrapped, iv, tag, ciphertext] = parts;
      if (!kid || !wrapIv || !wrapTag || !wrapped || !iv || !tag || ciphertext === undefined) {
        throw new Error('Format de secret chiffré inconnu');
      }
      const dek = this.unwrapDek(kid, wrapIv, wrapTag, wrapped, associatedData);
      try {
        return open(dek, unb64(iv), unb64(tag), unb64(ciphertext), associatedData);
      } finally {
        dek.fill(0);
      }
    }
    if (parts[0] === 'v1') {
      const [, iv, tag, ciphertext] = parts;
      if (!iv || !tag || ciphertext === undefined)
        throw new Error('Format de secret chiffré inconnu');
      // Le v1 ne porte pas d'identifiant de clé : essai avec chaque clé (GCM authentifie).
      for (const key of this.keys.values()) {
        try {
          return open(
            key.legacyEncryption,
            unb64(iv),
            unb64(tag),
            unb64(ciphertext),
            associatedData,
          );
        } catch {
          // clé suivante
        }
      }
      throw new Error('Aucune clé ne déchiffre ce secret (v1)');
    }
    throw new Error('Format de secret chiffré inconnu');
  }
}

/** « k1:base64,k0:base64 » -> liste de clés (ENCRYPTION_PREVIOUS_KEYS). */
export function parseKeyList(value: string | undefined): KeyMaterial[] {
  if (!value?.trim()) return [];
  return value.split(',').map((entry) => {
    const index = entry.indexOf(':');
    if (index <= 0) throw new Error('ENCRYPTION_PREVIOUS_KEYS : format « id:base64,… » attendu');
    return { id: entry.slice(0, index).trim(), base64: entry.slice(index + 1).trim() };
  });
}
