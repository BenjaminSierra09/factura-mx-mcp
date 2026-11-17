import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase } from '../support/mariadb.js';

test('generic portal retries require review and no recorded issuance action', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'factura-retry-test-'));
  const testDb = await createTestDatabase();
  process.env.DATA_DIR = dataDir;
  Object.assign(process.env, testDb.env);
  let closeDatabase: (() => Promise<void>) | undefined;
  try {
    const database = await import('../../src/db.js');
    closeDatabase = database.closeDatabase;
    await database.initializeDatabase();
    const { execute } = database;
    const { getJob } = await import('../../src/jobs.js');
    const userId = 'user-retry';
    const ticketId = 'ticket-retry';
    await execute('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'retry@example.test', 'hash']);
    await execute('INSERT INTO files (id,user_id,kind,original_name,mime_type,size_bytes) VALUES (?,?,?,?,?,?)',
      ['file-retry', userId, 'ticket', 'ticket.png', 'image/png', 100]);
    await execute('INSERT INTO tickets (id,user_id,file_id,analysis_json) VALUES (?,?,?,?)',
      [ticketId, userId, 'file-retry', '{}']);
    const request = JSON.stringify({ ticketId, provider: 'generic', channel: 'portal' });
    await execute('INSERT INTO jobs (id,user_id,ticket_id,portal_url,status,request_json,result_json) VALUES (?,?,?,?,?,?,?)',
      ['job-safe', userId, ticketId, 'https://facturas.example.com/', 'needs_action', request,
        JSON.stringify({ reason: 'stalled', steps: ['Rellenar folio'], documents: [] })]);
    assert.equal((await getJob(userId, 'job-safe'))?.result?.retrySafe, true);
    await execute('UPDATE jobs SET result_json=? WHERE id=?',
      [JSON.stringify({ reason: 'invoice_not_downloaded', steps: ['Rellenar folio'], documents: [] }), 'job-safe']);
    assert.equal((await getJob(userId, 'job-safe'))?.result?.retrySafe, false);
    await execute('UPDATE jobs SET result_json=? WHERE id=?',
      [JSON.stringify({ reason: 'captcha', steps: ['Hacer clic en Generar Factura'], documents: [] }), 'job-safe']);
    assert.equal((await getJob(userId, 'job-safe'))?.result?.retrySafe, false);
  } finally {
    if (closeDatabase) await closeDatabase();
    await testDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
