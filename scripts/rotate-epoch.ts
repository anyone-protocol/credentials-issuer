/**
 * Rotates the epoch keyring, in a file or in Vault.
 *   bun run rotate-epoch [--keyring <path>] [--root-key <path>]
 *                        [--epoch-seconds N] [--grace-seconds N]
 *   bun run rotate-epoch --vault-secret kv/stage-services/credentials-issuer-stage
 *                        [--vault-addr <url>] [--vault-field KEYRING_BASE64]
 *
 * Vault mode reads VAULT_TOKEN from the environment and is what the periodic
 * Nomad job runs; see docs/deployment.md. It is deliberately a separate tool
 * from the issuer:
 * the issuer never holds the root private key, so a compromised issuer can
 * abuse the current epoch key but cannot mint epochs or forge a key document.
 *
 * Retiring an epoch extends its not_after to now + grace, so the grace window
 * lives in the keyring rather than in the issuer's configuration.
 */
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { BLIND_SIGNATURE_SUITE } from '../apps/backend/src/keys/key-document';
import { derToPkcs8Pem, derToSpkiPem } from '../apps/backend/src/keys/pem';
import { importRootSigningKey, signKeyDocument } from '../apps/backend/src/keys/root-key';
import { parseKeyring, type EpochEntry, type Keyring } from '../apps/backend/src/keys/keyring';
import { verifyKeyringSignatures } from '../apps/backend/src/keys/root-key';
import { readSecret, writeSecret, type VaultOptions } from './vault-kv';

export interface RotateOptions {
  readonly keyringPath: string;
  readonly rootKeyPath: string;
  readonly epochSeconds: number;
  readonly graceSeconds: number;
  readonly now?: Date;
}

export interface RotateSchedule {
  readonly epochSeconds: number;
  readonly graceSeconds: number;
  readonly now?: Date;
}

export async function rotateEpoch(options: RotateOptions): Promise<Keyring> {
  const existing = (await Bun.file(options.keyringPath).exists())
    ? parseKeyring(JSON.parse(await Bun.file(options.keyringPath).text()))
    : null;

  const keyring = await nextKeyring(
    existing,
    await Bun.file(options.rootKeyPath).text(),
    options,
  );
  await writeAtomically(options.keyringPath, `${JSON.stringify(keyring, null, 2)}\n`);
  return keyring;
}

/**
 * The rotation itself, with no storage attached, so the file and Vault paths
 * cannot drift apart in what they produce.
 */
export async function nextKeyring(
  existing: Keyring | null,
  rootPem: string,
  options: RotateSchedule,
): Promise<Keyring> {
  const now = options.now ?? new Date();
  const rootKey = await importRootSigningKey(rootPem);
  const rootPublicSpki = await rootPublicKeySpki(rootPem);

  const nextId = existing ? String(Number(existing.current_epoch) + 1) : '0';
  if (Number.isNaN(Number(nextId))) {
    throw new Error(`cannot derive the next epoch from ${existing?.current_epoch}`);
  }

  const { privateKey, publicKey } = await RSABSSA.SHA384.generateKey({
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  });

  const fresh = await sealed(
    {
      epoch_id: nextId,
      not_before: now.toISOString(),
      not_after: new Date(now.getTime() + options.epochSeconds * 1000).toISOString(),
      alg: BLIND_SIGNATURE_SUITE,
      pubkey: Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64'),
    },
    derToPkcs8Pem(await crypto.subtle.exportKey('pkcs8', privateKey)),
    rootKey,
  );

  // Outgoing epochs stay usable for the grace window, then fall out entirely.
  const graceUntil = new Date(now.getTime() + options.graceSeconds * 1000);
  const retained: EpochEntry[] = [];
  for (const epoch of existing?.epochs ?? []) {
    const notAfter = new Date(
      Math.min(Date.parse(epoch.not_after), graceUntil.getTime()),
    ).toISOString();
    if (Date.parse(notAfter) <= now.getTime()) continue; // Already expired: prune.
    retained.push(await sealed({ ...epoch, not_after: notAfter }, epoch.private_key_pkcs8_pem, rootKey));
  }

  const keyring: Keyring = {
    current_epoch: nextId,
    root_public_key_spki: rootPublicSpki,
    epochs: [fresh, ...retained],
  };

  // The issuer refuses a keyring whose signatures do not verify, and refusing
  // one on reload means the old keys keep signing. Checking here means we
  // never publish a rotation the issuer would reject and nobody would notice.
  await verifyKeyringSignatures(keyring);
  return keyring;
}

export interface VaultRotateOptions extends RotateSchedule {
  readonly vault: VaultOptions;
  /** KV field holding the base64 keyring, alongside whatever else lives there. */
  readonly field: string;
  readonly rootKeyPath: string;
}

/**
 * Rotates the keyring Vault holds, in place. Read-modify-write with a
 * compare-and-set: the same path carries the database credentials and the
 * proxy public key, so writing only the keyring field would delete them, and a
 * second rotation racing this one must fail rather than lose an epoch.
 *
 * The root private key is a file rendered by Nomad, never fetched here, so this
 * needs a Vault token that can write one path and read nothing sensitive.
 */
export async function rotateInVault(options: VaultRotateOptions): Promise<Keyring> {
  const { data, version } = await readSecret(options.vault);

  const encoded = data[options.field];
  const existing = encoded
    ? parseKeyring(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')))
    : null;

  const keyring = await nextKeyring(
    existing,
    await Bun.file(options.rootKeyPath).text(),
    options,
  );

  await writeSecret(
    options.vault,
    { ...data, [options.field]: Buffer.from(JSON.stringify(keyring, null, 2)).toString('base64') },
    version,
  );
  return keyring;
}

/** Re-signs the document, because root_sig covers not_after and grace moves it. */
async function sealed(
  document: Omit<EpochEntry, 'root_sig' | 'private_key_pkcs8_pem'>,
  privateKeyPem: string,
  rootKey: CryptoKey,
): Promise<EpochEntry> {
  const { epoch_id, not_before, not_after, alg, pubkey } = document;
  const published = { epoch_id, not_before, not_after, alg, pubkey };
  return {
    ...published,
    root_sig: await signKeyDocument(published, rootKey),
    private_key_pkcs8_pem: privateKeyPem,
  };
}

async function rootPublicKeySpki(rootPem: string): Promise<string> {
  const signing = await importRootSigningKey(rootPem);
  const jwk = (await crypto.subtle.exportKey('jwk', signing)) as { x?: string; crv?: string };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: jwk.crv, x: jwk.x, ext: true, key_ops: ['verify'] },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  return Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64');
}

/** Rename, so a reader never sees a half-written keyring. */
async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

export async function generateRootKey(path: string): Promise<void> {
  const { privateKey } = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  await writeAtomically(path, derToPkcs8Pem(await crypto.subtle.exportKey('pkcs8', privateKey)));
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      keyring: { type: 'string', default: 'config/keys/keyring.json' },
      'root-key': { type: 'string', default: 'config/keys/root.pem' },
      'epoch-seconds': { type: 'string', default: String(30 * 86_400) },
      'grace-seconds': { type: 'string', default: String(86_400) },
      'vault-secret': { type: 'string' },
      'vault-addr': { type: 'string', default: process.env.VAULT_ADDR },
      'vault-field': { type: 'string', default: 'KEYRING_BASE64' },
    },
    strict: true,
  });

  const schedule = {
    epochSeconds: Number(values['epoch-seconds']),
    graceSeconds: Number(values['grace-seconds']),
  };
  const rootKeyPath = values['root-key']!;

  let keyring: Keyring;
  if (values['vault-secret']) {
    const addr = values['vault-addr'];
    const token = process.env.VAULT_TOKEN;
    if (!addr) throw new Error('--vault-secret needs --vault-addr or VAULT_ADDR');
    if (!token) throw new Error('--vault-secret needs VAULT_TOKEN in the environment');

    keyring = await rotateInVault({
      ...schedule,
      vault: { addr, token, secret: values['vault-secret'] },
      field: values['vault-field']!,
      rootKeyPath,
    });
    console.log(
      `rotated to epoch ${keyring.current_epoch} in ${values['vault-secret']}; ` +
        `${keyring.epochs.length} epoch(s) usable`,
    );
  } else {
    keyring = await rotateEpoch({ ...schedule, keyringPath: values.keyring!, rootKeyPath });
    console.log(
      `rotated to epoch ${keyring.current_epoch}; ${keyring.epochs.length} epoch(s) usable`,
    );
  }
}
