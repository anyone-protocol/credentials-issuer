import { decodeStrictBase64 } from '../errors/base64';

export const BLIND_SIGNATURE_SUITE = 'RSABSSA-SHA384-PSS-Randomized';

export interface KeyDocument {
  readonly epoch_id: string;
  readonly not_before: string;
  readonly not_after: string;
  readonly alg: string;
  readonly pubkey: string;
}

export const KEY_DOCUMENT_FIELDS = ['epoch_id', 'not_before', 'not_after', 'alg', 'pubkey'] as const;

function isIsoInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function parseKeyDocument(raw: unknown): KeyDocument {
  if (typeof raw !== 'object' || raw === null) throw new Error('key document is not an object');
  const doc = raw as Record<string, unknown>;

  for (const field of KEY_DOCUMENT_FIELDS) {
    if (typeof doc[field] !== 'string' || (doc[field] as string).length === 0) {
      throw new Error(`key document field ${field} must be a non-empty string`);
    }
  }
  const { epoch_id, not_before, not_after, alg, pubkey } = doc as Record<
    (typeof KEY_DOCUMENT_FIELDS)[number],
    string
  >;

  if (alg !== BLIND_SIGNATURE_SUITE) {
    throw new Error(`key document alg must be ${BLIND_SIGNATURE_SUITE}, got ${alg}`);
  }
  if (!isIsoInstant(not_before) || !isIsoInstant(not_after)) {
    throw new Error('key document validity window must use ISO-8601 UTC instants');
  }
  if (Date.parse(not_before) >= Date.parse(not_after)) {
    throw new Error('key document not_before must precede not_after');
  }
  if (decodeStrictBase64(pubkey) === null) {
    throw new Error('key document pubkey must be base64-encoded SPKI');
  }

  return { epoch_id, not_before, not_after, alg, pubkey };
}
