import mariadb from 'mariadb';
import { config } from './config.js';

// The pool keeps one connection per transaction and releases it in all cases.
// MariaDB is the only metadata store; encrypted uploads remain on disk.
let pool: ReturnType<typeof mariadb.createPool> | undefined;
function getPool(): ReturnType<typeof mariadb.createPool> {
  pool ??= mariadb.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: 10,
    connectTimeout: 10_000,
    acquireTimeout: 10_000,
    timezone: 'Etc/UTC',
    initSql: "SET time_zone = '+00:00'",
  });
  return pool;
}

type Params = unknown[];
export interface ExecuteResult { changes: number }
export interface DbClient {
  queryAll<T>(sql: string, params?: Params): Promise<T[]>;
  queryOne<T>(sql: string, params?: Params): Promise<T | undefined>;
  execute(sql: string, params?: Params): Promise<ExecuteResult>;
}

function normalizedRows<T>(rows: unknown): T[] {
  if (!Array.isArray(rows)) throw new Error('La consulta no devolvió filas');
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row as T;
    return Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, value instanceof Date ? value.toISOString() : value])) as T;
  });
}

function client(query: (sql: string, params?: Params) => Promise<unknown>): DbClient {
  return {
    async queryAll<T>(sql: string, params: Params = []): Promise<T[]> {
      return normalizedRows<T>(await query(sql, params));
    },
    async queryOne<T>(sql: string, params: Params = []): Promise<T | undefined> {
      return (await this.queryAll<T>(sql, params))[0];
    },
    async execute(sql: string, params: Params = []): Promise<ExecuteResult> {
      const result = await query(sql, params) as { affectedRows?: number | bigint };
      return { changes: Number(result.affectedRows ?? 0) };
    },
  };
}

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(256) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS profiles (
    user_id CHAR(36) PRIMARY KEY,
    rfc VARCHAR(13) NOT NULL DEFAULT '',
    nombre VARCHAR(250) NOT NULL DEFAULT '',
    codigo_postal VARCHAR(5) NOT NULL DEFAULT '',
    regimen_fiscal VARCHAR(3) NOT NULL DEFAULT '',
    uso_cfdi VARCHAR(3) NOT NULL DEFAULT 'G03',
    factura_email VARCHAR(254) NOT NULL DEFAULT '',
    domicilio VARCHAR(500) NOT NULL DEFAULT '',
    csf_file_id CHAR(36) NULL,
    openai_key_enc TEXT NULL,
    smtp_host VARCHAR(253) NOT NULL DEFAULT '',
    smtp_port SMALLINT UNSIGNED NOT NULL DEFAULT 587,
    smtp_secure TINYINT(1) NOT NULL DEFAULT 0,
    smtp_user VARCHAR(254) NOT NULL DEFAULT '',
    smtp_pass_enc TEXT NULL,
    smtp_from VARCHAR(254) NOT NULL DEFAULT '',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT profiles_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    csrf_token VARCHAR(128) NOT NULL,
    expires_at VARCHAR(35) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY sessions_user_idx (user_id),
    CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS files (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    original_name VARCHAR(200) NOT NULL,
    mime_type VARCHAR(80) NOT NULL,
    size_bytes INT UNSIGNED NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY files_user_idx (user_id),
    CONSTRAINT files_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT files_kind_ck CHECK (kind IN ('ticket','csf','invoice_pdf','invoice_xml'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS tickets (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    file_id CHAR(36) NOT NULL,
    analysis_json LONGTEXT NOT NULL,
    discovery_json LONGTEXT NULL,
    exploration_json LONGTEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY tickets_user_idx (user_id, created_at),
    KEY tickets_file_idx (file_id),
    CONSTRAINT tickets_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT tickets_file_fk FOREIGN KEY (file_id) REFERENCES files(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    ticket_id CHAR(36) NOT NULL,
    portal_url TEXT NOT NULL,
    status VARCHAR(24) NOT NULL,
    request_json LONGTEXT NOT NULL,
    result_json LONGTEXT NULL,
    error_text TEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY jobs_user_idx (user_id, created_at),
    KEY jobs_ticket_idx (ticket_id),
    CONSTRAINT jobs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT jobs_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
    CONSTRAINT jobs_status_ck CHECK (status IN ('queued','running','needs_action','submitted','completed','email_sent','failed'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS job_events (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    job_id CHAR(36) NOT NULL,
    kind VARCHAR(40) NOT NULL,
    message VARCHAR(1000) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY job_events_job_idx (job_id),
    CONSTRAINT job_events_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS mcp_tokens (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    name VARCHAR(80) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_used_at DATETIME(3) NULL,
    KEY mcp_tokens_user_idx (user_id),
    CONSTRAINT mcp_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

let dbReady: Promise<void> | undefined;
export function initializeDatabase(): Promise<void> {
  dbReady ??= (async () => {
    for (const statement of schema) await getPool().query(statement);
    // A process restart can interrupt a submission. Never retry it blindly.
    await getPool().query(`UPDATE jobs SET status='needs_action', error_text='Proceso interrumpido. Revise el portal antes de volver a enviar.', updated_at=CURRENT_TIMESTAMP(3) WHERE status='running'`);
  })();
  return dbReady;
}

const pooled = client((sql, params) => getPool().query(sql, params));
export async function queryAll<T>(sql: string, params: Params = []): Promise<T[]> {
  await initializeDatabase();
  return pooled.queryAll<T>(sql, params);
}
export async function queryOne<T>(sql: string, params: Params = []): Promise<T | undefined> {
  await initializeDatabase();
  return pooled.queryOne<T>(sql, params);
}
export async function execute(sql: string, params: Params = []): Promise<ExecuteResult> {
  await initializeDatabase();
  return pooled.execute(sql, params);
}
export async function transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
  await initializeDatabase();
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(client((sql, params) => connection.query(sql, params)));
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.release();
  }
}
export async function closeDatabase(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
  dbReady = undefined;
}

export interface UserRow { id: string; email: string; password_hash: string }
export interface ProfileRow {
  user_id: string; rfc: string; nombre: string; codigo_postal: string;
  regimen_fiscal: string; uso_cfdi: string; factura_email: string; domicilio: string;
  csf_file_id: string | null; openai_key_enc: string | null;
  smtp_host: string; smtp_port: number; smtp_secure: number;
  smtp_user: string; smtp_pass_enc: string | null; smtp_from: string;
}
export interface FileRow { id: string; user_id: string; kind: string; original_name: string; mime_type: string; size_bytes: number }
export interface TicketRow { id: string; user_id: string; file_id: string; analysis_json: string; discovery_json: string | null; exploration_json: string | null; created_at: string }
export interface JobRow { id: string; user_id: string; ticket_id: string; portal_url: string; status: string; request_json: string; result_json: string | null; error_text: string | null; created_at: string; updated_at: string }

export async function getProfile(userId: string): Promise<ProfileRow> {
  const row = await queryOne<ProfileRow>('SELECT * FROM profiles WHERE user_id=?', [userId]);
  if (!row) throw new Error('Perfil no encontrado');
  return row;
}
