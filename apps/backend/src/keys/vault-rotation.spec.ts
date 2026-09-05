import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRootKey, rotateInVault } from '../../../../scripts/rotate-epoch';
import { parseKeyring } from './keyring';
import { verifyKeyringSignatures } from './root-key';

const directories: string[] = [];
const servers: { stop(closeActive?: boolean): void }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const TOKEN = 'test-token';
const SECRET = 'kv/stage-services/credentials-issuer-stage';
const FIELD = 'KEYRING_BASE64';

interface FakeVault {
  addr: string;
  /** What the store holds now, as Vault would return it. */
  data: Record<string, string>;
  version: number;
  readonly writes: { data: Record<string, string>; cas: number }[];
  /** Lands another write between our read and our write, deterministically. */
  raceAfterNextRead: boolean;
}

/** The slice of KV v2 the rotation tool uses, including CAS enforcement. */
function startFakeVault(initial: Record<string, string> = {}): FakeVault {
  const state: FakeVault = {
    addr: '',
    data: initial,
    version: 1,
    writes: [],
    raceAfterNextRead: false,
  };

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get('x-vault-token') !== TOKEN) {
        return Response.json({ errors: ['permission denied'] }, { status: 403 });
      }
      const expected = `/v1/kv/data/${SECRET.split('/').slice(1).join('/')}`;
      if (new URL(request.url).pathname !== expected) {
        return Response.json({ errors: ['no handler'] }, { status: 404 });
      }

      if (request.method === 'GET') {
        const body = { data: { data: state.data, metadata: { version: state.version } } };
        if (state.raceAfterNextRead) {
          state.raceAfterNextRead = false;
          state.version += 1;
        }
        return Response.json(body);
      }

      const body = (await request.json()) as {
        data: Record<string, string>;
        options?: { cas?: number };
      };
      const cas = body.options?.cas ?? -1;
      if (cas !== state.version) {
        return Response.json({ errors: ['check-and-set parameter did not match'] }, { status: 400 });
      }
      state.writes.push({ data: body.data, cas });
      state.data = body.data;
      state.version += 1;
      return Response.json({ data: { version: state.version } });
    },
  });
  servers.push(server);
  state.addr = server.url.origin;
  return state;
}

async function rootKeyFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'issuer-vault-rotation-'));
  directories.push(dir);
  const path = join(dir, 'root.pem');
  await generateRootKey(path);
  return path;
}

function rotate(vault: FakeVault, rootKeyPath: string) {
  return rotateInVault({
    vault: { addr: vault.addr, token: TOKEN, secret: SECRET },
    field: FIELD,
    rootKeyPath,
    epochSeconds: 3600,
    graceSeconds: 60,
  });
}

const storedKeyring = (vault: FakeVault) =>
  parseKeyring(JSON.parse(Buffer.from(vault.data[FIELD]!, 'base64').toString('utf8')));

describe('rotating the keyring in Vault', () => {
  it('creates the first epoch when the field is empty', async () => {
    const vault = startFakeVault({ DB_USER: 'app' });

    const keyring = await rotate(vault, await rootKeyFile());

    expect(keyring.current_epoch).toBe('0');
    expect(storedKeyring(vault).current_epoch).toBe('0');
    await verifyKeyringSignatures(storedKeyring(vault));
  });

  it('advances the epoch and keeps the previous one in its grace window', async () => {
    const vault = startFakeVault();
    const rootKeyPath = await rootKeyFile();

    await rotate(vault, rootKeyPath);
    const second = await rotate(vault, rootKeyPath);

    expect(second.current_epoch).toBe('1');
    expect(second.epochs.map((epoch) => epoch.epoch_id).sort()).toEqual(['0', '1']);
    await verifyKeyringSignatures(storedKeyring(vault));
  });

  // The path also holds the database credentials and the proxy public key. KV
  // v2 replaces the whole document, so writing only the keyring field would
  // delete them and the issuer would fail to start on its next deploy.
  it('preserves the other fields at the same path', async () => {
    const vault = startFakeVault({ DB_USER: 'app', DB_PASS: 'secret', PROXY_PUBLIC_KEY_BASE64: 'cGVt' });

    await rotate(vault, await rootKeyFile());

    expect(vault.data.DB_USER).toBe('app');
    expect(vault.data.DB_PASS).toBe('secret');
    expect(vault.data.PROXY_PUBLIC_KEY_BASE64).toBe('cGVt');
  });

  // Two rotations racing would otherwise lose an epoch: the loser's write
  // would overwrite a keyring it never read, and the credentials signed under
  // the epoch it dropped would stop verifying.
  it('fails rather than clobbering a rotation that landed first', async () => {
    const vault = startFakeVault();
    const rootKeyPath = await rootKeyFile();
    await rotate(vault, rootKeyPath);

    // Another rotation lands between our read and our write.
    vault.raceAfterNextRead = true;
    const before = vault.data[FIELD];

    await expect(rotate(vault, rootKeyPath)).rejects.toThrow(/check-and-set|vault write/i);
    expect(vault.data[FIELD]).toBe(before);
  });

  it('writes nothing when the token is refused', async () => {
    const vault = startFakeVault({ DB_USER: 'app' });

    const rejected = rotateInVault({
      vault: { addr: vault.addr, token: 'wrong', secret: SECRET },
      field: FIELD,
      rootKeyPath: await rootKeyFile(),
      epochSeconds: 3600,
      graceSeconds: 60,
    });

    await expect(rejected).rejects.toThrow(/vault read/i);
    expect(vault.writes).toEqual([]);
  });

  // Someone pasting a bad value into Vault must not be rotated over: doing so
  // would replace whatever the field held with a fresh single-epoch keyring
  // and strip every epoch still inside its grace window.
  it('refuses to rotate a keyring field it cannot parse', async () => {
    const vault = startFakeVault({ [FIELD]: Buffer.from('{"nope":true}').toString('base64') });

    await expect(rotate(vault, await rootKeyFile())).rejects.toThrow();
    expect(vault.writes).toEqual([]);
  });
});
