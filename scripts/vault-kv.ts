/**
 * The slice of Vault's KV v2 API the rotation job needs. Not a general client:
 * read a secret with its version, write it back with a compare-and-set.
 *
 * Deliberately outside the issuer. The issuer reads its keyring from a file a
 * Nomad template renders, so it has no Vault client and keeps signing while
 * Vault is unreachable. Only the rotation tool talks to Vault, and only it
 * holds a token that can write.
 */
export interface VaultSecret {
  readonly data: Record<string, string>;
  /** Passed back as `cas` on write, so a concurrent rotation fails loudly. */
  readonly version: number;
}

export interface VaultOptions {
  readonly addr: string;
  readonly token: string;
  /** As written in a Nomad template: `<mount>/<path...>`, e.g. `kv/stage/app`. */
  readonly secret: string;
}

/** KV v2 splits the mount from the path and injects `data` between them. */
function dataUrl({ addr, secret }: VaultOptions): string {
  const [mount, ...rest] = secret.replace(/^\/+/, '').split('/');
  if (!mount || rest.length === 0) {
    throw new Error(`vault secret must look like <mount>/<path>, got ${JSON.stringify(secret)}`);
  }
  return `${addr.replace(/\/+$/, '')}/v1/${mount}/data/${rest.join('/')}`;
}

async function failed(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  // Vault echoes the path but never the secret, so this is safe to surface.
  return new Error(`vault ${what} failed: ${response.status} ${body.slice(0, 200)}`);
}

export async function readSecret(options: VaultOptions): Promise<VaultSecret> {
  const response = await fetch(dataUrl(options), {
    headers: { 'x-vault-token': options.token },
  });
  if (!response.ok) throw await failed(response, `read of ${options.secret}`);

  const body = (await response.json()) as {
    data?: { data?: Record<string, string>; metadata?: { version?: number } };
  };
  const data = body.data?.data;
  const version = body.data?.metadata?.version;
  if (!data || typeof version !== 'number') {
    throw new Error(`vault read of ${options.secret} returned no KV v2 data`);
  }
  return { data, version };
}

/**
 * Writes the whole secret back. Callers must pass every field they read, not
 * just the one they changed: KV v2 replaces the document, so a partial write
 * silently drops the database credentials sharing the path.
 */
export async function writeSecret(
  options: VaultOptions,
  data: Record<string, string>,
  cas: number,
): Promise<void> {
  const response = await fetch(dataUrl(options), {
    method: 'POST',
    headers: { 'x-vault-token': options.token, 'content-type': 'application/json' },
    body: JSON.stringify({ data, options: { cas } }),
  });
  if (!response.ok) throw await failed(response, `write of ${options.secret}`);
}
