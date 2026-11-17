import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { decrypt, decryptText, encrypt, encryptText, hashPassword } from '../../src/crypto.js';
import { createTestDatabase } from '../support/mariadb.js';

test('one-time SQLite import preserves metadata and encrypted files in MariaDB', { timeout: 30_000 }, async () => {
  const testDb = await createTestDatabase();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'factura-sqlite-migration-'));
  const sourcePath = path.join(dataDir, 'app.sqlite');
  const userId = randomUUID();
  const fileId = randomUUID();
  const ticketId = randomUUID();
  const jobId = randomUUID();
  const mcpTokenId = randomUUID();
  const email = 'legacy@example.test';
  const key = randomBytes(32);
  const ticketBytes = Buffer.from('%PDF-1.4\nlegacy ticket\n');
  const encryptedKey = encryptText('sk-legacy-test', key, `${userId}:openai_key`);
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT);
      CREATE TABLE profiles (user_id TEXT PRIMARY KEY, rfc TEXT, nombre TEXT, codigo_postal TEXT,
        regimen_fiscal TEXT, uso_cfdi TEXT, factura_email TEXT, openai_key_enc TEXT, smtp_pass_enc TEXT);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, csrf_token TEXT, expires_at TEXT);
      CREATE TABLE files (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, original_name TEXT,
        mime_type TEXT, size_bytes INTEGER);
      CREATE TABLE tickets (id TEXT PRIMARY KEY, user_id TEXT, file_id TEXT, analysis_json TEXT);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, user_id TEXT, ticket_id TEXT, portal_url TEXT,
        status TEXT, request_json TEXT, result_json TEXT);
      CREATE TABLE job_events (id INTEGER PRIMARY KEY, job_id TEXT, kind TEXT, message TEXT);
      CREATE TABLE mcp_tokens (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, token_hash TEXT);
    `);
    source.prepare('INSERT INTO users VALUES (?,?,?)').run(userId, email, await hashPassword('legacy password 123'));
    source.prepare('INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?,?)').run(userId, 'XAXX010101000',
      'PERSONA LEGADO', '06000', '612', 'G03', email, encryptedKey, null);
    source.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('a'.repeat(64), userId, 'csrf-legacy',
      '2099-01-01T00:00:00.000Z');
    source.prepare('INSERT INTO files VALUES (?,?,?,?,?,?)').run(fileId, userId, 'ticket', 'legado.pdf',
      'application/pdf', ticketBytes.length);
    source.prepare('INSERT INTO tickets VALUES (?,?,?,?)').run(ticketId, userId, fileId, '{"empresa":"Primera Plus"}');
    source.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?)').run(jobId, userId, ticketId,
      'https://facturas.example.com/', 'running', '{"channel":"portal"}', null);
    source.prepare('INSERT INTO job_events VALUES (?,?,?,?)').run(1, jobId, 'info', 'Portal abierto');
    source.prepare('INSERT INTO mcp_tokens VALUES (?,?,?,?)').run(mcpTokenId, userId, 'Legacy MCP', 'b'.repeat(64));
    source.close();

    await mkdir(path.join(dataDir, 'files'));
    await writeFile(path.join(dataDir, 'master.key'), key);
    await writeFile(path.join(dataDir, 'files', `${fileId}.bin`),
      encrypt(ticketBytes, key, `${userId}:${fileId}:ticket`));

    const env = { ...process.env, ...testDb.env, DATA_DIR: dataDir, APP_MASTER_KEY: '' };
    const run = () => spawnSync(process.execPath, ['scripts/migrate-sqlite-to-mariadb.mjs', sourcePath],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 20_000 });
    const first = run();
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /Importación completada en MariaDB/);

    const [user] = await testDb.query<{ email: string }>('SELECT email FROM users WHERE id=?', [userId]);
    assert.equal(user?.email, email);
    const [profile] = await testDb.query<{ rfc: string; openai_key_enc: string }>(
      'SELECT rfc,openai_key_enc FROM profiles WHERE user_id=?', [userId]);
    assert.equal(profile?.rfc, 'XAXX010101000');
    assert.equal(decryptText(profile!.openai_key_enc, key, `${userId}:openai_key`), 'sk-legacy-test');
    const [ticket] = await testDb.query<{ analysis_json: string }>('SELECT analysis_json FROM tickets WHERE id=?', [ticketId]);
    assert.equal(JSON.parse(ticket!.analysis_json).empresa, 'Primera Plus');
    const [job] = await testDb.query<{ status: string; error_text: string }>(
      'SELECT status,error_text FROM jobs WHERE id=?', [jobId]);
    assert.equal(job?.status, 'needs_action', 'an interrupted issuance is never retried automatically');
    assert.match(job!.error_text, /Proceso interrumpido/);
    const [event] = await testDb.query<{ message: string }>('SELECT message FROM job_events WHERE job_id=?', [jobId]);
    assert.equal(event?.message, 'Portal abierto');
    const [session] = await testDb.query<{ csrf_token: string }>('SELECT csrf_token FROM sessions WHERE user_id=?', [userId]);
    assert.equal(session?.csrf_token, 'csrf-legacy');
    const [mcpToken] = await testDb.query<{ name: string }>('SELECT name FROM mcp_tokens WHERE id=?', [mcpTokenId]);
    assert.equal(mcpToken?.name, 'Legacy MCP');
    assert.deepEqual(decrypt(await readFile(path.join(dataDir, 'files', `${fileId}.bin`)), key,
      `${userId}:${fileId}:ticket`), ticketBytes);

    const backups = (await readdir(dataDir)).filter(name => name.startsWith('app.sqlite.pre-mariadb-') && name.endsWith('.bak'));
    assert.equal(backups.length, 1, 'the migration keeps a consistent SQLite backup');
    const backup = new DatabaseSync(path.join(dataDir, backups[0]!), { readOnly: true });
    try { assert.equal((backup.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1); }
    finally { backup.close(); }

    const second = run();
    assert.equal(second.status, 1, 'a second import must refuse a populated target');
    assert.match(second.stderr, /MariaDB ya contiene registros/);
    const rows = await testDb.query<{ email: string }>('SELECT email FROM users');
    assert.deepEqual(rows.map(row => row.email), [email]);
  } finally {
    try { source.close(); } catch { /* already closed */ }
    await testDb.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
