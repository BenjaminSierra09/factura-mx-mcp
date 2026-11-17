import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import sharp from 'sharp';
import Database from 'better-sqlite3';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}

test('auto-invoice starts only with an owned ticket and returns the specific missing step', { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'factura-auto-api-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(), stdio: 'pipe',
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
      APP_PUBLIC_ORIGIN: '', APP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      RECAPTCHA_SITE_KEY: '', RECAPTCHA_SECRET_KEY: '', RECAPTCHA_SECRET_KEY_FILE: '' },
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${child.exitCode}`);
      try { ready = (await fetch(`${base}/healthz`)).ok; if (ready) break; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    async function register(email: string) {
      const response = await fetch(`${base}/api/auth/register`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct horse battery staple' }) });
      assert.equal(response.status, 201);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const { csrfToken } = await response.json() as { csrfToken: string };
      return { cookie, csrfToken };
    }
    const owner = await register('owner@example.test');
    const other = await register('other@example.test');
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'ticket.png');
    const upload = await fetch(`${base}/api/tickets`, { method: 'POST',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken }, body: form });
    assert.equal(upload.status, 201);
    const { ticket } = await upload.json() as { ticket: { id: string } };
    const endpoint = `${base}/api/tickets/${ticket.id}/auto-invoice`;
    const post = (cookie: string, csrfToken?: string) => fetch(endpoint, { method: 'POST',
      headers: { cookie, ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}), 'content-type': 'application/json' },
      body: JSON.stringify({ textoAdicional: 'Pagué en efectivo' }) });
    assert.equal((await post(owner.cookie)).status, 403, 'CSRF is required');
    assert.equal((await post(other.cookie, other.csrfToken)).status, 404, 'another user cannot start this ticket');
    const first = await post(owner.cookie, owner.csrfToken);
    assert.equal(first.status, 200);
    const firstResult = await first.json() as { status: string; reason: string; paymentSuggestion: { codigo: string } };
    assert.equal(firstResult.status, 'needs_review');
    assert.equal(firstResult.reason, 'profile');
    assert.equal(firstResult.paymentSuggestion.codigo, '01');
    const savedNote = await fetch(`${base}/api/tickets/${ticket.id}`, { headers: { cookie: owner.cookie } })
      .then(response => response.json()) as { analysis: { formaPagoUsuario?: { codigo: string; evidencia: string } } };
    assert.equal(savedNote.analysis.formaPagoUsuario?.codigo, '01', 'the payment clue survives a new ticket read');
    assert.match(savedNote.analysis.formaPagoUsuario?.evidencia ?? '', /Información adicional/);
    const replay = await fetch(endpoint, { method: 'POST',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
      body: '{}' }).then(response => response.json()) as { paymentSuggestion: { codigo: string } };
    assert.equal(replay.paymentSuggestion.codigo, '01', 'a retry reuses the stored user clue');
    const confirmed = await fetch(endpoint, { method: 'POST',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ formaPago: '28' }) });
    assert.equal(confirmed.status, 200);
    assert.equal(((await confirmed.json()) as { paymentSuggestion: { codigo: string } }).paymentSuggestion.codigo, '28');
    const savedConfirmation = await fetch(`${base}/api/tickets/${ticket.id}`, { headers: { cookie: owner.cookie } })
      .then(response => response.json()) as { analysis: { formaPagoUsuario?: { codigo: string; confirmada?: boolean } } };
    assert.equal(savedConfirmation.analysis.formaPagoUsuario?.codigo, '28');
    assert.equal(savedConfirmation.analysis.formaPagoUsuario?.confirmada, true);

    const saveProfile = await fetch(`${base}/api/profile`, { method: 'PUT',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ rfc: 'XAXX010101000', nombre: 'PERSONA DE PRUEBA', codigoPostal: '06000',
        regimenFiscal: '612', usoCfdi: 'G03', facturaEmail: 'owner@example.test' }) });
    assert.equal(saveProfile.status, 200);
    const second = await post(owner.cookie, owner.csrfToken).then(response => response.json()) as { status: string; reason: string };
    assert.equal(second.status, 'needs_review');
    assert.equal(second.reason, 'issuer');
    const stillConfirmed = await fetch(`${base}/api/tickets/${ticket.id}`, { headers: { cookie: owner.cookie } })
      .then(response => response.json()) as { analysis: { formaPagoUsuario?: { codigo: string; confirmada?: boolean } } };
    assert.equal(stillConfirmed.analysis.formaPagoUsuario?.codigo, '28', 'a later note does not replace a confirmed form');
    assert.equal(stillConfirmed.analysis.formaPagoUsuario?.confirmada, true);
    const sqlite = new Database(path.join(dataDir, 'app.sqlite'));
    try {
      const row = sqlite.prepare('SELECT analysis_json FROM tickets WHERE id=?').get(ticket.id) as { analysis_json: string };
      const analysis = JSON.parse(row.analysis_json) as Record<string, unknown>;
      analysis.empresa = 'Primera Plus';
      analysis.formaPagoSugerida = { codigo: '04', evidencia: 'Ticket: Tarjeta de crédito', confianza: 'alta' };
      analysis.formaPagoUsuario = null;
      sqlite.prepare('UPDATE tickets SET analysis_json=? WHERE id=?').run(JSON.stringify(analysis), ticket.id);
    } finally { sqlite.close(); }
    const paymentConflict = await post(owner.cookie, owner.csrfToken)
      .then(response => response.json()) as { status: string; reason: string };
    assert.equal(paymentConflict.status, 'needs_review');
    assert.equal(paymentConflict.reason, 'payment');
    const conflictingTicket = await fetch(`${base}/api/tickets/${ticket.id}`, { headers: { cookie: owner.cookie } })
      .then(response => response.json()) as { analysis: { formaPagoSugerida: { codigo: string }; formaPagoUsuario: { codigo: string } } };
    assert.equal(conflictingTicket.analysis.formaPagoSugerida.codigo, '04', 'the printed clue is not overwritten');
    assert.equal(conflictingTicket.analysis.formaPagoUsuario.codigo, '01', 'the user clue remains available for review');
    assert.deepEqual(await fetch(`${base}/api/jobs`, { headers: { cookie: owner.cookie } }).then(response => response.json()), []);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
