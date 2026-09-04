import { decodeStrictBase64 } from '../errors/base64';
import { BLIND_SIGNATURE_SUITE, type KeyDocument } from './key-document';

/**
 * The issuer's view of its epoch keys.
 *
 * A single file, because a Nomad template renders one file atomically. Split
 * across several, a rotation could be observed half-applied: a key present
 * whose document has not landed, or the reverse.
 *
 * The root *private* key is deliberately absent. Only the rotation tool holds
 * it, so an issuer that is compromised can abuse the current epoch key but
 * cannot mint epochs or forge a key document.
 */
export interface EpochEntry extends KeyDocument {
  /** Signature over the published document fields, by the issuer root key. */
  readonly root_sig: string;
  /** PKCS#8 PEM. Never served; see publishedDocument(). */
  readonly private_key_pkcs8_pem: string;
}

export interface Keyring {
  readonly current_epoch: string;
  readonly root_public_key_spki: string;
  readonly epochs: readonly EpochEntry[];
}

export const KEY_DOCUMENT_FIELDS = [
  'epoch_id',
  'not_before',
  'not_after',
  'alg',
  'pubkey',
  'root_sig',
] as const;

/** The bytes root_sig covers: the published fields, keys in alphabetical order. */
export function canonicalKeyDocument(document: KeyDocument) {
  const ordered = JSON.stringify({
    alg: document.alg,
    epoch_id: document.epoch_id,
    not_after: document.not_after,
    not_before: document.not_before,
    pubkey: document.pubkey,
  });
  const encoded = new TextEncoder().encode(ordered);
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
}

/** Strips private material. What GET /v1/keys/current serves. */
export function publishedDocument(entry: EpochEntry): KeyDocument & { root_sig: string } {
  return {
    epoch_id: entry.epoch_id,
    not_before: entry.not_before,
    not_after: entry.not_after,
    alg: entry.alg,
    pubkey: entry.pubkey,
    root_sig: entry.root_sig,
  };
}

function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function parseKeyring(raw: unknown): Keyring {
  if (typeof raw !== 'object' || raw === null) throw new Error('keyring is not an object');
  const keyring = raw as Record<string, unknown>;

  if (typeof keyring.current_epoch !== 'string' || keyring.current_epoch.length === 0) {
    throw new Error('keyring.current_epoch must be a non-empty string');
  }
  if (
    typeof keyring.root_public_key_spki !== 'string' ||
    decodeStrictBase64(keyring.root_public_key_spki) === null
  ) {
    throw new Error('keyring.root_public_key_spki must be base64-encoded SPKI');
  }
  if (!Array.isArray(keyring.epochs) || keyring.epochs.length === 0) {
    throw new Error('keyring.epochs must be a non-empty array');
  }

  const epochs = keyring.epochs.map((entry, index) => parseEpoch(entry, index));
  if (!epochs.some((epoch) => epoch.epoch_id === keyring.current_epoch)) {
    throw new Error(`keyring.current_epoch ${keyring.current_epoch} is not among the epochs`);
  }

  const ids = new Set(epochs.map((epoch) => epoch.epoch_id));
  if (ids.size !== epochs.length) throw new Error('keyring has duplicate epoch_ids');

  return {
    current_epoch: keyring.current_epoch,
    root_public_key_spki: keyring.root_public_key_spki,
    epochs,
  };
}

function parseEpoch(raw: unknown, index: number): EpochEntry {
  if (typeof raw !== 'object' || raw === null) throw new Error(`epoch ${index} is not an object`);
  const entry = raw as Record<string, unknown>;

  for (const field of ['epoch_id', 'alg', 'pubkey', 'root_sig', 'private_key_pkcs8_pem']) {
    if (typeof entry[field] !== 'string' || (entry[field] as string).length === 0) {
      throw new Error(`epoch ${index} field ${field} must be a non-empty string`);
    }
  }
  if (entry.alg !== BLIND_SIGNATURE_SUITE) {
    throw new Error(`epoch ${index} alg must be ${BLIND_SIGNATURE_SUITE}, got ${entry.alg}`);
  }
  if (!isIsoInstant(entry.not_before) || !isIsoInstant(entry.not_after)) {
    throw new Error(`epoch ${index} validity window must use ISO-8601 UTC instants`);
  }
  if (Date.parse(entry.not_before) >= Date.parse(entry.not_after)) {
    throw new Error(`epoch ${index} not_before must precede not_after`);
  }
  if (decodeStrictBase64(entry.pubkey as string) === null) {
    throw new Error(`epoch ${index} pubkey must be base64-encoded SPKI`);
  }

  return entry as unknown as EpochEntry;
}

/**
 * The epoch a request may be signed under, or null.
 *
 * An epoch stays usable until its not_after, which rotation extends to
 * now + grace when the epoch is retired. So the grace window lives in the data
 * rather than in the issuer's configuration.
 */
export function usableEpoch(keyring: Keyring, epochId: string, at = new Date()): EpochEntry | null {
  const entry = keyring.epochs.find((epoch) => epoch.epoch_id === epochId);
  if (!entry) return null;

  const now = at.getTime();
  const usable = now >= Date.parse(entry.not_before) && now < Date.parse(entry.not_after);
  return usable ? entry : null;
}

export function currentEpoch(keyring: Keyring): EpochEntry {
  const entry = keyring.epochs.find((epoch) => epoch.epoch_id === keyring.current_epoch);
  if (!entry) throw new Error('keyring has no entry for its current epoch');
  return entry;
}
