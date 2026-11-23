/**
 * Minimal typings for the `pg` driver used by the Hyperdrive path (docs/ops/db.md).
 * `@types/pg` is not part of the approved dependency set, so only the surface the
 * Worker uses is declared here.
 */
declare module "pg" {
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
  }
  export interface QueryResult<R = unknown> {
    rows: R[];
    rowCount: number | null;
  }
  export class Pool {
    constructor(config?: PoolConfig);
    query<R = unknown>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: "error", listener: (error: Error) => void): this;
  }
  export interface PoolClient {
    query<R = unknown>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    release(): void;
  }
  export class Client {
    constructor(config?: PoolConfig);
    connect(): Promise<void>;
    query<R = unknown>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
  const pg: { Pool: typeof Pool; Client: typeof Client };
  export default pg;
}
