import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { KeysService } from '../keys/keys.service';
import type { SignReply } from './blind-sign.worker';
import { selectSigningSuite } from './suite';

const WORKER_URL = new URL('./blind-sign.worker.ts', import.meta.url);

interface Slot {
  readonly worker: Worker;
  alive: boolean;
}

interface Pending {
  readonly slot: Slot;
  resolve(signature: string): void;
  reject(error: Error): void;
}

/**
 * A fixed pool of blind-signing workers.
 *
 * Signing is CPU-bound, so each worker takes one blank at a time: pipelining
 * into a busy worker would only add latency. Workers are spawned on first use,
 * so a process that never signs (a migration run, a test with signing stubbed)
 * starts no threads.
 *
 * A worker that dies or stops answering must not take the issuer with it, so
 * every task is bounded by a timeout and a lost worker is replaced.
 */
@Injectable()
export class SignerPool implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignerPool.name);
  private readonly pending = new Map<number, Pending>();
  private readonly slots: Slot[] = [];
  private readonly idle: Slot[] = [];
  private readonly waiting: ((slot: Slot) => void)[] = [];
  private started?: Promise<void>;
  private shuttingDown = false;
  private nextId = 0;

  constructor(
    @Inject(ISSUER_CONFIG) private readonly config: IssuerConfig,
    private readonly keys: KeysService,
  ) {}

  /**
   * Runs the known-answer test in the main process so the chosen signing path
   * is visible at boot rather than discovered under load. Workers repeat it in
   * their own realm.
   */
  async onModuleInit(): Promise<void> {
    const { fastPath, reason } = await selectSigningSuite(this.config.useNativeRsa);
    if (fastPath) {
      this.logger.log(`blind signing via the RSA-RAW fast path (${reason})`);
    } else {
      this.logger.warn(`blind signing via the pure-JS path, ~280ms per signature: ${reason}`);
    }
  }

  async sign(blindedBlank: string): Promise<string> {
    await this.ensureStarted();
    const slot = await this.acquire();
    const id = this.nextId++;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        this.pending.set(id, { slot, resolve, reject });
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`blind signing timed out after ${this.config.signingTimeoutMs}ms`));
          // A worker that missed its deadline is not trusted with the next
          // request: replacing it stops one wedged thread eating the pool.
          this.retire(slot, 'timed out');
        }, this.config.signingTimeoutMs);
        slot.worker.postMessage({ id, blindedBlank });
      });
    } finally {
      clearTimeout(timer);
      if (slot.alive) this.release(slot);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }

  private ensureStarted(): Promise<void> {
    // Assigned before the first await, so concurrent first requests share one
    // startup instead of each spawning a pool.
    return (this.started ??= this.spawnAll());
  }

  private async spawnAll(): Promise<void> {
    for (let i = 0; i < this.config.signingWorkers; i += 1) this.spawn();
    this.logger.log(`blind signing on ${this.config.signingWorkers} worker thread(s)`);
  }

  private spawn(): void {
    const worker = new Worker(WORKER_URL, {
      workerData: { privateKeyPem: this.keys.epochSigningKeyPem(), useNativeRsa: this.config.useNativeRsa },
    });
    const slot: Slot = { worker, alive: true };

    worker.on('message', (reply: SignReply) => this.settle(reply));
    worker.on('error', (error: Error) => this.retire(slot, error.message));
    worker.on('exit', (code) => {
      if (slot.alive) this.retire(slot, `exited with code ${code}`);
    });
    worker.unref();

    this.slots.push(slot);
    this.release(slot);
  }

  private settle(reply: SignReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return; // Already timed out.
    this.pending.delete(reply.id);
    if ('error' in reply) pending.reject(new Error(reply.error));
    else pending.resolve(reply.signature);
  }

  /** Drops a worker, fails whatever it was carrying, and replaces it. */
  private retire(slot: Slot, why: string): void {
    if (!slot.alive) return;
    slot.alive = false;

    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    const idleIndex = this.idle.indexOf(slot);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);

    for (const [id, pending] of this.pending) {
      if (pending.slot !== slot) continue;
      this.pending.delete(id);
      pending.reject(new Error(`signing worker ${why}`));
    }

    void slot.worker.terminate();
    if (this.shuttingDown) return;

    this.logger.error(`signing worker ${why}; replacing it`);
    this.spawn();
  }

  private acquire(): Promise<Slot> {
    const free = this.idle.pop();
    return free ? Promise.resolve(free) : new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(slot: Slot): void {
    const next = this.waiting.shift();
    if (next) next(slot);
    else this.idle.push(slot);
  }
}
