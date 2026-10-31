import {
  type RecoveryExecution,
  type RecoveryStore,
  validateRecoveryExecution,
} from "./recovery.js";

/** Trusted database adapter. Queries must resolve only after durable commit acknowledgement. */
export interface RecoverySqlClient {
  query(
    sql: string,
    parameters: unknown[],
  ): Promise<{ rows: Array<{ checkpoint: RecoveryExecution }> }>;
}
function tableName(table: string): string {
  const parts = table.split(".");
  if (parts.length !== 2 || parts.some((p) => !/^[a-z_][a-z0-9_]*$/.test(p)))
    throw new Error("Use a schema-qualified recovery table");
  return parts.map((p) => `"${p}"`).join(".");
}
/** Review and apply this migration separately; constructing a store never modifies the database. */
export function recoveryTableDDL(table: string): string {
  return `CREATE TABLE ${tableName(table)} (id text PRIMARY KEY, revision bigint NOT NULL, checkpoint jsonb NOT NULL, CHECK (checkpoint->>'id' = id), CHECK ((checkpoint->>'revision')::bigint = revision))`;
}

export class PostgresRecoveryStore implements RecoveryStore {
  readonly durable = true as const;
  private readonly table: string;
  constructor(
    private readonly client: RecoverySqlClient,
    table: string,
  ) {
    this.table = tableName(table);
  }
  async create(value: RecoveryExecution): Promise<boolean> {
    validateRecoveryExecution(value);
    if (value.revision !== 0 || value.fence !== 0 || value.owner !== null || value.expiresAt !== 0)
      throw new Error("New recovery checkpoints must be unclaimed");
    const result = await this.client.query(
      `INSERT INTO ${this.table} (id, revision, checkpoint) VALUES ($1, 0, $2::jsonb) ON CONFLICT (id) DO NOTHING RETURNING checkpoint`,
      [value.id, JSON.stringify(value)],
    );
    return result.rows.length === 1;
  }
  async read(id: string): Promise<RecoveryExecution | undefined> {
    const result = await this.client.query(`SELECT checkpoint FROM ${this.table} WHERE id = $1`, [
      id,
    ]);
    const value = result.rows[0]?.checkpoint;
    if (value) {
      validateRecoveryExecution(value);
      if (value.id !== id) throw new Error("Recovery identity mismatch");
    }
    return value ? structuredClone(value) : undefined;
  }
  async compareAndSwap(
    id: string,
    expectedRevision: number,
    value: RecoveryExecution,
  ): Promise<boolean> {
    validateRecoveryExecution(value);
    if (
      value.id !== id ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      value.revision !== expectedRevision + 1
    )
      throw new Error("Invalid recovery CAS");
    const result = await this.client.query(
      `UPDATE ${this.table} SET revision = $3, checkpoint = $4::jsonb WHERE id = $1 AND revision = $2 RETURNING checkpoint`,
      [id, expectedRevision, value.revision, JSON.stringify(value)],
    );
    return result.rows.length === 1;
  }
}
