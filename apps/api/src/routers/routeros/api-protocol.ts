/**
 * Codage des mots et phrases du protocole API RouterOS (TCP 8728), d'après la documentation
 * officielle « API » (help.mikrotik.com/docs/spaces/ROS/pages/47579160/API, section Protocol) :
 *
 *   longueur              octets  codage
 *   0 ≤ len ≤ 0x7F           1    len
 *   0x80 ≤ len ≤ 0x3FFF      2    len | 0x8000
 *   0x4000 ≤ len ≤ 0x1FFFFF  3    len | 0xC00000
 *   0x200000 ≤ len ≤ 0xFFFFFFF 4  len | 0xE0000000
 *   len ≥ 0x10000000         5    0xF0 puis len sur 4 octets
 *
 * Une phrase est une suite de mots terminée par un mot de longueur nulle.
 */

export function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) {
    const v = length | 0x8000;
    return Buffer.from([(v >> 8) & 0xff, v & 0xff]);
  }
  if (length < 0x200000) {
    const v = length | 0xc00000;
    return Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  if (length < 0x10000000) {
    const v = (length | 0xe0000000) >>> 0;
    return Buffer.from([(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  const out = Buffer.alloc(5);
  out[0] = 0xf0;
  out.writeUInt32BE(length >>> 0, 1);
  return out;
}

export function encodeSentence(words: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const word of words) {
    const data = Buffer.from(word, 'utf8');
    parts.push(encodeLength(data.length), data);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Lit une longueur à `offset` : [longueur, octets consommés], ou null si incomplet. */
export function decodeLength(buffer: Buffer, offset: number): [number, number] | null {
  const first = buffer[offset];
  if (first === undefined) return null;
  const need = first < 0x80 ? 1 : first < 0xc0 ? 2 : first < 0xe0 ? 3 : first < 0xf0 ? 4 : 5;
  if (buffer.length < offset + need) return null;
  switch (need) {
    case 1:
      return [first, 1];
    case 2:
      return [buffer.readUInt16BE(offset) & 0x3fff, 2];
    case 3:
      return [((first << 16) | buffer.readUInt16BE(offset + 1)) & 0x1fffff, 3];
    case 4:
      return [buffer.readUInt32BE(offset) & 0x0fffffff, 4];
    default:
      if (first !== 0xf0) throw new Error('Longueur de mot API invalide');
      return [buffer.readUInt32BE(offset + 1), 5];
  }
}

/**
 * Découpe un tampon en phrases complètes. Renvoie les phrases et le nombre d'octets
 * consommés (le reste, incomplet, attend la suite du flux).
 */
export function decodeSentences(buffer: Buffer): { sentences: string[][]; consumed: number } {
  const sentences: string[][] = [];
  let offset = 0;
  let consumed = 0;
  let words: string[] = [];
  for (;;) {
    const header = decodeLength(buffer, offset);
    if (!header) break;
    const [length, size] = header;
    if (buffer.length < offset + size + length) break;
    offset += size;
    if (length === 0) {
      // Les phrases vides sont ignorées (documentation : « Empty sentences are ignored »).
      if (words.length > 0) sentences.push(words);
      words = [];
      consumed = offset;
      continue;
    }
    words.push(buffer.toString('utf8', offset, offset + length));
    offset += length;
  }
  return { sentences, consumed };
}

/** « =clé=valeur » -> [clé, valeur] (la valeur peut contenir « = »). */
export function parseAttribute(word: string): [string, string] | null {
  if (!word.startsWith('=')) return null;
  const index = word.indexOf('=', 1);
  if (index < 0) return [word.slice(1), ''];
  return [word.slice(1, index), word.slice(index + 1)];
}
