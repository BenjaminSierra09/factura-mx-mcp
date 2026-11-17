import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import mariadb from 'mariadb';

/** Give each database-backed test its own disposable schema. */
export async function createTestDatabase(prefix = 'factura_test') {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const options = {
    host: process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT || process.env.DB_PORT || 3306),
    user: process.env.TEST_DB_USER || 'root',
    password: process.env.TEST_DB_PASSWORD ?? process.env.DB_ROOT_PASSWORD ?? '',
  };
  const admin = await mariadb.createConnection(options);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  const env = { DB_HOST: options.host, DB_PORT: String(options.port), DB_USER: options.user,
    DB_PASSWORD: options.password, DB_PASSWORD_FILE: '', DB_NAME: name };
  return {
    env,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const connection = await mariadb.createConnection({ ...options, database: name });
      try { return await connection.query(sql, params) as T[]; }
      finally { await connection.end(); }
    },
    async close(): Promise<void> {
      const connection = await mariadb.createConnection(options);
      try { await connection.query(`DROP DATABASE \`${name}\``); }
      finally { await connection.end(); }
    },
  };
}
