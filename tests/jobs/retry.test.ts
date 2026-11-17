import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('generic portal retries require review and no recorded issuance action', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'factura-retry-test-'));
  process.env.DATA_DIR = dataDir;
  try {
    const { db } = await import('../../src/db.js');
    const { getJob } = await import('../../src/jobs.js');
    const userId = 'user-retry';
    const ticketId = 'ticket-retry';
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(userId, 'retry@example.test', 'hash');
    db.prepare('INSERT INTO files (id,user_id,kind,original_name,mime_type,size_bytes) VALUES (?,?,?,?,?,?)')
      .run('file-retry', userId, 'ticket', 'ticket.png', 'image/png', 100);
    db.prepare('INSERT INTO tickets (id,user_id,file_id,analysis_json) VALUES (?,?,?,?)')
      .run(ticketId, userId, 'file-retry', '{}');
    const request = JSON.stringify({ ticketId, provider: 'generic', channel: 'portal' });
    db.prepare('INSERT INTO jobs (id,user_id,ticket_id,portal_url,status,request_json,result_json) VALUES (?,?,?,?,?,?,?)')
      .run('job-safe', userId, ticketId, 'https://facturas.example.com/', 'needs_action', request,
        JSON.stringify({ reason: 'stalled', steps: ['Rellenar folio'], documents: [] }));
    assert.equal(getJob(userId, 'job-safe')?.result?.retrySafe, true);
    db.prepare('UPDATE jobs SET result_json=? WHERE id=?')
      .run(JSON.stringify({ reason: 'invoice_not_downloaded', steps: ['Rellenar folio'], documents: [] }), 'job-safe');
    assert.equal(getJob(userId, 'job-safe')?.result?.retrySafe, false);
    db.prepare('UPDATE jobs SET result_json=? WHERE id=?')
      .run(JSON.stringify({ reason: 'captcha', steps: ['Hacer clic en Generar Factura'], documents: [] }), 'job-safe');
    assert.equal(getJob(userId, 'job-safe')?.result?.retrySafe, false);
    db.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
