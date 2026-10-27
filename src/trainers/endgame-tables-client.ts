import type { Defence, EndgameTables } from './endgame-tables';

export type TablesRequestMessage = { id: number; kind: 'warm' } | { id: number; kind: 'defend'; fen: string };

export type TablesResponseMessage =
  | { id: number; kind: 'warm' }
  | { id: number; kind: 'defence'; defence: Defence | null }
  | { id: number; kind: 'error'; message: string };

type TablesRequestBody = { kind: 'warm' } | { kind: 'defend'; fen: string };

/** What the endgame trainer needs from the exact tables. */
export interface EndgameDefender {
  /** Starts solving all three endings in the background, so the first reply is not slow. */
  warm(): void;
  /** Black's exact best reply, or null when the position is not K+Q, K+R or K+P v K (the engine plays it). */
  defend(fen: string): Promise<Defence | null>;
  /** Stops the background work. */
  terminate(): void;
}

/**
 * The page's side of the endgame-tables worker. The worker (and with it the solver chunk) is
 * only started when the endgame trainer first asks. Where `Worker` doesn't exist (Node), the
 * tables are solved inline.
 */
export class EndgameTablesClient implements EndgameDefender {
  private worker: Worker | null = null;
  private inline: EndgameTables | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (msg: TablesResponseMessage) => void; reject: (err: Error) => void }
  >();

  public warm(): void {
    void this.request({ kind: 'warm' }).catch(() => undefined);
  }

  public async defend(fen: string): Promise<Defence | null> {
    const msg = await this.request({ kind: 'defend', fen });
    if (msg.kind !== 'defence') throw new Error('Unexpected answer from the endgame tables worker');
    return msg.defence;
  }

  public terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('The endgame tables worker was stopped'));
    this.pending.clear();
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;
    const worker = new Worker(new URL('./endgame-tables.worker.ts', import.meta.url), {
      type: 'module',
      name: 'endgame-tables',
    });
    worker.addEventListener('message', (e: MessageEvent<TablesResponseMessage>) => {
      const entry = this.pending.get(e.data.id);
      if (!entry) return;
      this.pending.delete(e.data.id);
      if (e.data.kind === 'error') entry.reject(new Error(e.data.message));
      else entry.resolve(e.data);
    });
    worker.addEventListener('error', (e) => {
      const err = new Error(`The endgame tables worker failed: ${e.message || 'could not load'}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private async requestInline(id: number, body: TablesRequestBody): Promise<TablesResponseMessage> {
    this.inline ??= new (await import('./endgame-tables')).EndgameTables();
    if (body.kind === 'warm') {
      this.inline.ensure('p');
      return { id, kind: 'warm' };
    }
    return { id, kind: 'defence', defence: this.inline.defend(body.fen) };
  }

  private request(body: TablesRequestBody): Promise<TablesResponseMessage> {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    if (!worker) return this.requestInline(id, body);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...body, id } as TablesRequestMessage);
    });
  }
}
