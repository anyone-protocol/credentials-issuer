import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { KeysService } from '../keys/keys.service';
import type { SignReply } from './blind-sign.worker';
import { selectSigningSuite } from './suite';

const WORKER_URL = new URL('./blind-sign.worker.ts', import.meta.url);

interface Pending {
  resolve(signature: string): void;
  reject(error: Error): void;
}

/**
 * A fixed pool of blind-signing workers.
 *
 * One signature is ~280ms of CPU on this platform (see README), so the pool
 * exists to keep that off the event loop and to use more than one core. Each
 * worker takes one blank at a time: the work is CPU-bound, so pipelining into
 * a busy worker would only add latency.
 *
 * Spawned on first use rather than at boot, so a process that never signs (a
 * migration run, a test with signing stubbed) starts no threads.
 */
@Injectable()
export class SignerPool implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignerPool.name);
  private readonly pending = new Map<number, Pending>();
  private readonly idle: Worker[] = [];
  private readonly waiting: ((worker: Worker) => void)[] = [];
  private workers?: Promise<Worker[]>;
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
    await this.ensureWorkers();
    const worker = await this.acquire();
    const id = this.nextId++;

    try {
      return await new Promise<string>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.postMessage({ id, blindedBlank });
      });
    } finally {
      this.release(worker);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.workers) return;
    await Promise.all((await this.workers).map((worker) => worker.terminate()));
  }

  private ensureWorkers(): Promise<Worker[]> {
    // Assigned before the first await, so concurrent first requests share one
    // spawn instead of each starting a pool.
    return (this.workers ??= this.spawn());
  }

  private async spawn(): Promise<Worker[]> {
    const count = this.config.signingWorkers;
    const privateKeyPem = this.keys.epochSigningKeyPem();

    const workers = Array.from({ length: count }, () => {
      const worker = new Worker(WORKER_URL, {
        workerData: { privateKeyPem, useNativeRsa: this.config.useNativeRsa },
      });
      worker.on('message', (reply: SignReply) => this.settle(reply));
      worker.on('error', (error: Error) => this.failAll(error));
      worker.unref();
      this.idle.push(worker);
      return worker;
    });

    this.logger.log(`blind signing on ${count} worker thread(s)`);
    return workers;
  }

  private settle(reply: SignReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if ('error' in reply) pending.reject(new Error(reply.error));
    else pending.resolve(reply.signature);
  }

  /** A worker that dies takes its in-flight work with it; fail loudly. */
  private failAll(error: Error): void {
    this.logger.error(`signing worker failed: ${error.message}`);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private acquire(): Promise<Worker> {
    const free = this.idle.pop();
    return free ? Promise.resolve(free) : new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }
}
