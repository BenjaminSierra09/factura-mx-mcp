import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsRecaptcha, validateRecaptchaConfiguration, verifyRecaptchaToken } from '../src/recaptcha.js';

test('public origins require reCAPTCHA configuration', () => {
  assert.equal(needsRecaptcha('', ['localhost', '127.0.0.1']), false);
  assert.equal(needsRecaptcha('https://facturas.example.com', ['localhost']), true);
  assert.equal(needsRecaptcha('', ['facturas.example.com']), true);
  assert.throws(() => validateRecaptchaConfiguration('', '', 'https://facturas.example.com', ['facturas.example.com']),
    /requiere RECAPTCHA_SITE_KEY/);
  assert.throws(() => validateRecaptchaConfiguration('site-only', '', '', ['localhost']), /juntos/);
  assert.throws(() => validateRecaptchaConfiguration(
    '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
    '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
    'https://facturas.example.com', ['facturas.example.com'],
  ), /claves de prueba/);
  assert.doesNotThrow(() => validateRecaptchaConfiguration(
    '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
    '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
    '', ['localhost'],
  ));
});

test('server refuses to start a public origin without reCAPTCHA keys', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'factura-recaptcha-test-'));
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: process.cwd(), timeout: 10_000, encoding: 'utf8',
      env: { ...process.env, DATA_DIR: dataDir, PORT: '0', APP_PUBLIC_ORIGIN: 'https://facturas.example.com',
        APP_ALLOWED_HOSTS: 'facturas.example.com', RECAPTCHA_SITE_KEY: '', RECAPTCHA_SECRET_KEY: '',
        RECAPTCHA_SECRET_KEY_FILE: '' },
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Un despliegue público requiere RECAPTCHA_SITE_KEY/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('reCAPTCHA verifies with Google and accepts only the request hostname', async () => {
  let calls = 0;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls++;
    assert.equal(url, 'https://www.google.com/recaptcha/api/siteverify');
    assert.equal(init.method, 'POST');
    const data = init.body as URLSearchParams;
    assert.equal(data.get('secret'), 'server-secret');
    assert.equal(data.get('response'), 'visitor-token');
    return Response.json({ success: true, hostname: 'facturas.example.com' });
  };
  const options = { secret: 'server-secret', fetchImpl };
  assert.equal(await verifyRecaptchaToken(undefined, 'facturas.example.com', options), 'invalid');
  assert.equal(calls, 0, 'a missing token is never sent to Google');
  assert.equal(await verifyRecaptchaToken('visitor-token', 'facturas.example.com', options), 'valid');
  assert.equal(await verifyRecaptchaToken('visitor-token', 'otro.example.com', options), 'invalid');
});

test('reCAPTCHA fails closed when Google cannot validate a token', async () => {
  assert.equal(await verifyRecaptchaToken('visitor-token', 'facturas.example.com', {
    secret: 'server-secret', fetchImpl: async () => new Response('', { status: 502 }),
  }), 'unavailable');
  assert.equal(await verifyRecaptchaToken('visitor-token', 'facturas.example.com', {
    secret: 'server-secret', fetchImpl: async () => Response.json({ success: false, hostname: 'facturas.example.com' }),
  }), 'invalid');
  assert.equal(await verifyRecaptchaToken('visitor-token', 'facturas.example.com', {
    secret: 'server-secret', fetchImpl: async () => Response.json({ success: true }),
  }), 'invalid');
});

test('Google test keys report their fixed hostname only for local development', async () => {
  const options = { secret: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
    fetchImpl: async () => Response.json({ success: true, hostname: 'testkey.google.com' }) };
  assert.equal(await verifyRecaptchaToken('visitor-token', 'localhost', options), 'valid');
  assert.equal(await verifyRecaptchaToken('visitor-token', '127.0.0.1', options), 'valid');
  assert.equal(await verifyRecaptchaToken('visitor-token', 'facturas.example.com', options), 'invalid');
});
