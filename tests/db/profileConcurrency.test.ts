import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import { createTestDatabase } from '../support/mariadb.js';

test('concurrent partial profile updates preserve both changes', { timeout: 15_000 }, async () => {
  const testDb = await createTestDatabase();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'factura-profile-lock-'));
  Object.assign(process.env, testDb.env, { DATA_DIR: dataDir });
  let closeDatabase: (() => Promise<void>) | undefined;
  let blocker: Connection | undefined;
  let pendingUpdates: Promise<unknown>[] = [];
  try {
    const database = await import('../../src/db.js');
    closeDatabase = database.closeDatabase;
    const { updateProfile } = await import('../../src/service.js');
    await database.initializeDatabase();
    const userId = randomUUID();
    await database.execute('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)',
      [userId, 'concurrent@example.test', 'hash']);
    await database.execute('INSERT INTO profiles (user_id,factura_email) VALUES (?,?)',
      [userId, 'concurrent@example.test']);

    blocker = await mariadb.createConnection({ host: testDb.env.DB_HOST, port: Number(testDb.env.DB_PORT),
      user: testDb.env.DB_USER, password: testDb.env.DB_PASSWORD, database: testDb.env.DB_NAME });
    await blocker.beginTransaction();
    await blocker.query('SELECT user_id FROM profiles WHERE user_id=? FOR UPDATE', [userId]);

    // Both writers must wait on the same profile row before either can read it.
    const changeName = updateProfile(userId, { nombre: 'NOMBRE CONCURRENTE' });
    const changeAddress = updateProfile(userId, { domicilio: 'DOMICILIO CONCURRENTE' });
    pendingUpdates = [changeName, changeAddress];
    let waiters = 0;
    for (let attempt = 0; attempt < 200 && waiters < 2; attempt++) {
      const [state] = await testDb.query<{ n: number }>(`
        SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX trx
        JOIN information_schema.PROCESSLIST process ON process.ID=trx.TRX_MYSQL_THREAD_ID
        WHERE process.DB=? AND trx.TRX_STATE='LOCK WAIT'`, [testDb.env.DB_NAME]);
      waiters = Number(state?.n ?? 0);
      if (waiters < 2) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiters, 2, 'both writes reached the row lock concurrently');
    await blocker.commit();
    await Promise.all(pendingUpdates);
    const profile = await database.getProfile(userId);
    assert.equal(profile.nombre, 'NOMBRE CONCURRENTE');
    assert.equal(profile.domicilio, 'DOMICILIO CONCURRENTE');
  } finally {
    if (blocker) {
      try { await blocker.rollback(); } catch { /* already committed */ }
      await blocker.end();
    }
    await Promise.allSettled(pendingUpdates);
    if (closeDatabase) await closeDatabase();
    await testDb.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
