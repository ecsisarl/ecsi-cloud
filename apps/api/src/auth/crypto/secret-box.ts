import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Chiffrement authentifié AES-256-GCM des secrets stockés en base (graines TOTP).
 * Format : v1:<iv>:<tag>:<chiffré> (base64url). La clé (ENCRYPTION_KEY) vient du
 * gestionnaire de secrets ; deux sous-clés distinctes sont dérivées par HKDF.
 */
export class SecretBox {
  private readonly encryptionKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(base64Key: string) {
    const master = Buffer.from(base64Key, 'base64');
    if (master.length !== 32) {
      throw new Error('ENCRYPTION_KEY doit contenir 32 octets');
    }
    this.encryptionKey = Buffer.from(hkdfSync('sha256', master, '', 'ecsi:aes-gcm:v1', 32));
    this.hmacKey = Buffer.from(hkdfSync('sha256', master, '', 'ecsi:hmac:v1', 32));
  }

  encrypt(plaintext: string, associatedData = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  decrypt(payload: string, associatedData = ''): string {
    const [version, iv, tag, ciphertext] = payload.split(':');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Format de secret chiffré inconnu');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** HMAC-SHA256 complet (empreinte des codes de récupération 2FA, comparaison par égalité). */
  mac(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value, 'utf8').digest('base64url');
  }

  /** Identifiant pseudonyme stable (clés Redis, journaux) : jamais l'adresse e-mail en clair. */
  fingerprint(value: string): string {
    return createHmac('sha256', this.hmacKey)
      .update(value, 'utf8')
      .digest('base64url')
      .slice(0, 32);
  }
}
