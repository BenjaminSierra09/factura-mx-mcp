import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import sharp from 'sharp';
import { createTestDatabase } from './support/mariadb.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}

test('API separates users, protects writes, and serves authenticated MCP', { timeout: 45_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'factura-api-test-'));
  const testDb = await createTestDatabase();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(), env: { ...process.env, ...testDb.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
      APP_PUBLIC_ORIGIN: '', APP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      RECAPTCHA_SITE_KEY: '', RECAPTCHA_SECRET_KEY: '', RECAPTCHA_SECRET_KEY_FILE: '',
      API_EXPENSIVE_LIMIT: '2', API_ACTION_LIMIT: '2', API_MCP_LIMIT: '2' }, stdio: 'pipe',
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${child.exitCode}`);
      try { ready = (await fetch(`${base}/healthz`)).ok; if (ready) break; } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'server started');
    const publicConfig = await fetch(`${base}/api/config`).then(response => response.json()) as Record<string, unknown>;
    assert.deepEqual(publicConfig, { recaptchaSiteKey: null, registrationEnabled: true });

    async function register(email: string) {
      const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct horse battery staple' }) });
      assert.equal(response.status, 201);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const data = await response.json() as { csrfToken: string; id: string };
      return { cookie, csrf: data.csrfToken, id: data.id };
    }
    const alice = await register('alice@example.test');
    const bob = await register('bob@example.test');
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'ticket.png');

    const blocked = await fetch(`${base}/api/tickets`, { method: 'POST', headers: { cookie: alice.cookie }, body: form });
    assert.equal(blocked.status, 403, 'missing CSRF token is rejected');

    const uploaded = await fetch(`${base}/api/tickets`, { method: 'POST', headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrf }, body: form });
    assert.equal(uploaded.status, 201);
    const { ticket } = await uploaded.json() as { ticket: { id: string; fileId: string } };
    assert.ok(ticket.id);
    const portals = await fetch(`${base}/api/portals`, { headers: { cookie: alice.cookie } });
    assert.equal(portals.status, 200);
    assert.match(JSON.stringify(await portals.json()), /oxxo/);
    const ticketDetail = await fetch(`${base}/api/tickets/${ticket.id}`, { headers: { cookie: alice.cookie } });
    assert.equal(ticketDetail.status, 200);
    assert.match(JSON.stringify(await ticketDetail.json()), /detection/);
    assert.equal((await fetch(`${base}/api/tickets/${ticket.id}`, { headers: { cookie: bob.cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/tickets`, { headers: { cookie: bob.cookie } }).then(r => r.json()) as unknown[]).length, 0);
    assert.equal((await fetch(`${base}/api/files/${ticket.fileId}`, { headers: { cookie: bob.cookie } })).status, 400);

    const saved = await fetch(`${base}/api/profile`, { method: 'PUT', headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ openAiKey: 'sk-test-secret' }) });
    assert.equal(saved.status, 200);
    const profile = await saved.json() as Record<string, unknown>;
    assert.equal(profile.hasOpenAiKey, true);
    assert.equal(JSON.stringify(profile).includes('sk-test-secret'), false);
    const malformed = await fetch(`${base}/api/profile`, { method: 'PUT',
      headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrf, 'content-type': 'application/json' },
      body: '{"secret":"SENTINEL_SECRET",' });
    assert.equal(malformed.status, 400, 'malformed request JSON remains a client error');
    assert.equal((await malformed.text()).includes('SENTINEL_SECRET'), false, 'parser errors do not echo request content');

    const tokenResponse = await fetch(`${base}/api/mcp-tokens`, { method: 'POST', headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }) });
    assert.equal(tokenResponse.status, 201);
    const { token } = await tokenResponse.json() as { token: string };
    assert.ok(token.startsWith('fxmcp_'));
    const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(unauthorized.status, 401);
    const listMcp = (bearer: string) => fetch(`${base}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const mcp = await listMcp(token);
    assert.equal(mcp.status, 200);
    const output = await mcp.text();
    assert.match(output, /cargar_y_facturar/);
    assert.match(output, /iniciar_factura/);
    assert.match(output, /descubrir_portal/);
    assert.match(output, /explorar_portal/);
    assert.equal((await listMcp(token)).status, 200, 'a normal MCP tool-list request remains available');
    assert.equal((await listMcp(token)).status, 429, 'authenticated MCP calls have an account quota');
    const bobTokenResponse = await fetch(`${base}/api/mcp-tokens`, { method: 'POST',
      headers: { cookie: bob.cookie, 'x-csrf-token': bob.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bob-test' }) });
    assert.equal(bobTokenResponse.status, 201);
    const { token: bobToken } = await bobTokenResponse.json() as { token: string };
    assert.equal((await listMcp(bobToken)).status, 200, 'another user has a separate MCP quota');
    const automaticTool = await fetch(`${base}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'cargar_y_facturar', arguments: { filename: 'ticket.png', base64: png.toString('base64'),
          textoAdicional: 'Pagué en efectivo' } } }),
    });
    assert.equal(automaticTool.status, 200);
    const automaticOutput = await automaticTool.text();
    assert.match(automaticOutput, /needs_review/, 'the tool returns the next required step');
    assert.match(automaticOutput, /profile/, 'a missing fiscal profile is identified');
    assert.match(automaticOutput, /paymentSuggestion/, 'the payment clue is preserved');

    const createJob = (account: typeof alice) => fetch(`${base}/api/jobs`, { method: 'POST',
      headers: { cookie: account.cookie, 'x-csrf-token': account.csrf, 'content-type': 'application/json' },
      body: '{}' });
    assert.equal((await createJob(alice)).status, 400, 'expected validation errors remain client errors');
    assert.equal((await createJob(alice)).status, 429, 'expensive routes share an account quota');
    assert.equal((await createJob(bob)).status, 400, 'another account has its own quota');
    assert.equal((await fetch(`${base}/api/tickets`, { headers: { cookie: alice.cookie } })).status, 200,
      'ordinary reads remain available after the expensive-operation quota');
    const browserAction = () => fetch(`${base}/api/jobs/${ticket.id}/action`, { method: 'POST',
      headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'continue' }) });
    assert.equal((await browserAction()).status, 409);
    assert.equal((await browserAction()).status, 409);
    assert.equal((await browserAction()).status, 429, 'browser actions have a separate account quota');

    const invalidLogin = (email: string) => fetch(`${base}/api/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'irrelevant' }) });
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.equal((await invalidLogin('invalid-address')).status, 400);
    }
    assert.equal((await invalidLogin('invalid-address')).status, 429, 'one email is limited');
    assert.equal((await invalidLogin('another-invalid-address')).status, 400,
      'another email can still use the shared connector IP');

    await testDb.query('UPDATE tickets SET analysis_json=? WHERE id=?', ['SENTINEL_SECRET', ticket.id]);
    const failedRead = await fetch(`${base}/api/tickets`, { headers: { cookie: alice.cookie } });
    assert.equal(failedRead.status, 500, 'unexpected data errors are server errors');
    assert.deepEqual(await failedRead.json(), { error: 'Error interno. Intenta más tarde.' },
      'internal exception text is not returned to the client');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await testDb.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
