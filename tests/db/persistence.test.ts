import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase } from '../support/mariadb.js';

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

async function startServer(dataDir: string, dbEnv: Record<string, string>) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(), stdio: 'pipe',
    env: { ...process.env, ...dbEnv, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
      APP_PUBLIC_ORIGIN: '', APP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      RECAPTCHA_SITE_KEY: '', RECAPTCHA_SECRET_KEY: '', RECAPTCHA_SECRET_KEY_FILE: '' },
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
    try { if ((await fetch(`${base}/healthz`)).ok) return { child, base }; }
    catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`Server failed to start: ${stderr}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
}

test('MariaDB keeps accounts and fiscal profiles after an API restart', { timeout: 30_000 }, async () => {
  const testDb = await createTestDatabase();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'factura-mariadb-persistence-'));
  let current: ChildProcess | undefined;
  try {
    const first = await startServer(dataDir, testDb.env);
    current = first.child;
    const email = 'restart@example.test';
    const password = 'correct horse battery staple';
    const registration = await fetch(`${first.base}/api/auth/register`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const { csrfToken } = await registration.json() as { csrfToken: string };
    const saved = await fetch(`${first.base}/api/profile`, { method: 'PUT',
      headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ rfc: 'XAXX010101000', nombre: 'PERSONA DE PRUEBA', codigoPostal: '06000',
        regimenFiscal: '612', usoCfdi: 'G03', facturaEmail: email }) });
    assert.equal(saved.status, 200);
    await stopServer(first.child);
    current = undefined;

    const [stored] = await testDb.query<{ email: string }>('SELECT email FROM users WHERE email=?', [email]);
    assert.ok(stored);
    assert.equal(stored.email, email, 'the account is stored in MariaDB');
    const second = await startServer(dataDir, testDb.env);
    current = second.child;
    const login = await fetch(`${second.base}/api/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(login.status, 200, 'the account remains usable after restart');
    const newCookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(newCookie);
    const profile = await fetch(`${second.base}/api/profile`, { headers: { cookie: newCookie } });
    assert.equal(profile.status, 200);
    assert.equal(((await profile.json()) as { rfc: string }).rfc, 'XAXX010101000');
  } finally {
    if (current) await stopServer(current);
    await testDb.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
