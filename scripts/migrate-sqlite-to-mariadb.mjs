// One-time import for installations created before MariaDB became the metadata store.
// Run with the old application stopped and the original DATA_DIR still mounted.
import { backup, DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import mariadb from 'mariadb';
import { config } from '../dist/src/config.js';
import { initializeDatabase, closeDatabase } from '../dist/src/db.js';

process.umask(0o077);

const tables = [
  'users', 'profiles', 'sessions', 'files', 'tickets', 'jobs', 'job_events', 'mcp_tokens',
];
const sourcePath = path.resolve(process.argv[2] || path.join(config.dataDir, 'app.sqlite'));
const backupPath = `${sourcePath}.pre-mariadb-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
const counts = new Map();
let source;
let connection;

function tableExists(name) {
  return Boolean(source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function sourceColumns(name) {
  return source.prepare(`PRAGMA table_info(\`${name}\`)`).all().map(row => row.name);
}

async function targetColumns(name) {
  const rows = await connection.query(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
    [config.db.database, name],
  );
  return new Set(rows.map(row => row.name));
}

async function main() {
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`No existe el archivo SQLite: ${sourcePath}`);
  }
  if (path.dirname(sourcePath) !== config.dataDir) {
    throw new Error('DATA_DIR debe apuntar a la carpeta del SQLite original para conservar archivos cifrados y master.key');
  }
  source = new DatabaseSync(sourcePath, { readOnly: true });
  if (!tableExists('users')) throw new Error('El archivo SQLite no contiene la tabla users');

  const fileCount = tableExists('files')
    ? Number(source.prepare('SELECT COUNT(*) AS total FROM files').get().total)
    : 0;
  const encryptedKeyCount = tableExists('profiles')
    ? Number(source.prepare('SELECT COUNT(*) AS total FROM profiles WHERE openai_key_enc IS NOT NULL OR smtp_pass_enc IS NOT NULL').get().total)
    : 0;
  if ((fileCount || encryptedKeyCount) && !process.env.APP_MASTER_KEY &&
      !fs.existsSync(path.join(config.dataDir, 'master.key'))) {
    throw new Error('Falta master.key o APP_MASTER_KEY; sin esa clave los archivos y secretos no se podrán descifrar');
  }
  if (fileCount) {
    for (const row of source.prepare('SELECT id FROM files').iterate()) {
      if (!fs.existsSync(path.join(config.dataDir, 'files', `${row.id}.bin`))) {
        throw new Error(`Falta el archivo cifrado del registro ${row.id}`);
      }
    }
  }

  await backup(source, backupPath);
  fs.chmodSync(backupPath, 0o600);
  await initializeDatabase();
  connection = await mariadb.createConnection({
    ...config.db,
    timezone: 'Etc/UTC',
    initSql: "SET time_zone = '+00:00'",
  });

  for (const name of tables) {
    const row = await connection.query(`SELECT COUNT(*) AS total FROM \`${name}\``);
    if (Number(row[0].total) !== 0) {
      throw new Error(`MariaDB ya contiene registros en ${name}; la importación requiere una base vacía`);
    }
  }

  await connection.beginTransaction();
  try {
    for (const name of tables) {
      if (!tableExists(name)) { counts.set(name, 0); continue; }
      const target = await targetColumns(name);
      const columns = sourceColumns(name).filter(column => target.has(column));
      if (!columns.length) throw new Error(`No hay columnas compatibles para ${name}`);
      const sql = `INSERT INTO \`${name}\` (${columns.map(column => `\`${column}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
      let count = 0;
      for (const row of source.prepare(`SELECT * FROM \`${name}\``).iterate()) {
        await connection.query(sql, columns.map(column => row[column]));
        count++;
      }
      const result = await connection.query(`SELECT COUNT(*) AS total FROM \`${name}\``);
      if (Number(result[0].total) !== count) throw new Error(`La verificación de ${name} no coincide`);
      counts.set(name, count);
    }
    // A portal may already have issued a CFDI before the old process stopped.
    await connection.query("UPDATE jobs SET status='needs_action', error_text='Proceso interrumpido. Revise el portal antes de volver a enviar.', updated_at=CURRENT_TIMESTAMP(3) WHERE status='running'");
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  console.log('Importación completada en MariaDB. Registros por tabla:');
  for (const [name, count] of counts) console.log(`  ${name}: ${count}`);
  console.log(`Copia consistente de SQLite: ${backupPath}`);
  console.log('Conserva DATA_DIR/files, DATA_DIR/screenshots y DATA_DIR/master.key.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await connection?.end();
  source?.close();
  await closeDatabase();
}
