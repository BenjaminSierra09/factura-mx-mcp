import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
export const db = new Database(path.join(config.dataDir, 'app.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rfc TEXT NOT NULL DEFAULT '',
  nombre TEXT NOT NULL DEFAULT '',
  codigo_postal TEXT NOT NULL DEFAULT '',
  regimen_fiscal TEXT NOT NULL DEFAULT '',
  uso_cfdi TEXT NOT NULL DEFAULT 'G03',
  factura_email TEXT NOT NULL DEFAULT '',
  domicilio TEXT NOT NULL DEFAULT '',
  csf_file_id TEXT,
  openai_key_enc TEXT,
  smtp_host TEXT NOT NULL DEFAULT '',
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_secure INTEGER NOT NULL DEFAULT 0,
  smtp_user TEXT NOT NULL DEFAULT '',
  smtp_pass_enc TEXT,
  smtp_from TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('ticket','csf','invoice_pdf','invoice_xml')),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS files_user_idx ON files(user_id);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id),
  analysis_json TEXT NOT NULL,
  discovery_json TEXT,
  exploration_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS tickets_user_idx ON tickets(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  portal_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','needs_action','submitted','completed','email_sent','failed')),
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);
`);

// A process restart can interrupt a submission. Do not retry it blindly: a
// portal may already have issued a CFDI even when the browser was lost.
db.prepare(`UPDATE jobs SET status='needs_action', error_text='Proceso interrumpido. Revise el portal antes de volver a enviar.', updated_at=CURRENT_TIMESTAMP WHERE status='running'`).run();

if (!(db.pragma('table_info(profiles)') as { name: string }[]).some(column => column.name === 'domicilio')) {
  db.exec("ALTER TABLE profiles ADD COLUMN domicilio TEXT NOT NULL DEFAULT ''");
}
for (const column of ['discovery_json', 'exploration_json']) {
  if (!(db.pragma('table_info(tickets)') as { name: string }[]).some(item => item.name === column)) {
    db.exec(`ALTER TABLE tickets ADD COLUMN ${column} TEXT`);
  }
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

export function getProfile(userId: string): ProfileRow {
  return db.prepare('SELECT * FROM profiles WHERE user_id=?').get(userId) as ProfileRow;
}
