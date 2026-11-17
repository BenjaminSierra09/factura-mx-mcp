import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, getMasterKey } from './config.js';
import { encrypt, decrypt } from './crypto.js';
import { db, type FileRow } from './db.js';

const fileDir = path.join(config.dataDir, 'files');
const screenshotDir = path.join(config.dataDir, 'screenshots');
fs.mkdirSync(fileDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });

export type StoredKind = 'ticket' | 'csf' | 'invoice_pdf' | 'invoice_xml';

export function sniffMime(data: Buffer): string | null {
  if (data.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (data.subarray(0, 5).toString().startsWith('<?xml') || data.subarray(0, 100).toString().includes('<cfdi:Comprobante')) return 'application/xml';
  return null;
}

export function saveFile(userId: string, kind: StoredKind, originalName: string, data: Buffer): FileRow {
  const mime = sniffMime(data);
  const allowed = kind === 'invoice_xml' ? ['application/xml'] : kind === 'invoice_pdf' ? ['application/pdf'] : ['application/pdf','image/png','image/jpeg','image/webp'];
  if (!mime || !allowed.includes(mime)) throw new Error('Formato de archivo no admitido');
  if (!data.length || data.length > 15 * 1024 * 1024) throw new Error('El archivo debe medir entre 1 byte y 15 MB');
  const id = randomUUID();
  const row: FileRow = { id, user_id: userId, kind, original_name: path.basename(originalName).slice(0, 200), mime_type: mime, size_bytes: data.length };
  const encrypted = encrypt(data, getMasterKey(), `${userId}:${id}:${kind}`);
  const filename = path.join(fileDir, `${id}.bin`);
  fs.writeFileSync(filename, encrypted, { flag: 'wx', mode: 0o600 });
  try {
    db.prepare('INSERT INTO files (id,user_id,kind,original_name,mime_type,size_bytes) VALUES (?,?,?,?,?,?)')
      .run(id, userId, kind, row.original_name, mime, data.length);
  } catch (error) {
    fs.rmSync(filename, { force: true });
    throw error;
  }
  return row;
}

export function getFile(userId: string, fileId: string): { row: FileRow; data: Buffer } {
  const row = db.prepare('SELECT * FROM files WHERE id=? AND user_id=?').get(fileId, userId) as FileRow | undefined;
  if (!row) throw new Error('Archivo no encontrado');
  const encrypted = fs.readFileSync(path.join(fileDir, `${row.id}.bin`));
  return { row, data: decrypt(encrypted, getMasterKey(), `${userId}:${row.id}:${row.kind}`) };
}

export async function withTemporaryFile<T>(userId: string, fileId: string, fn: (filePath: string, row: FileRow) => Promise<T>): Promise<T> {
  const { row, data } = getFile(userId, fileId);
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factura-mx-'));
  fs.chmodSync(temporaryDir, 0o700);
  const ext = row.mime_type === 'application/pdf' ? '.pdf' : row.mime_type === 'image/png' ? '.png' : row.mime_type === 'image/webp' ? '.webp' : row.mime_type === 'application/xml' ? '.xml' : '.jpg';
  const filePath = path.join(temporaryDir, `document${ext}`);
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  try { return await fn(filePath, row); }
  finally { fs.rmSync(temporaryDir, { recursive: true, force: true }); }
}

export function removeFile(userId: string, fileId: string): void {
  const row = db.prepare('SELECT id FROM files WHERE id=? AND user_id=?').get(fileId, userId) as { id: string } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM files WHERE id=? AND user_id=?').run(fileId, userId);
  fs.rmSync(path.join(fileDir, `${fileId}.bin`), { force: true });
}

export function saveJobScreenshot(userId: string, jobId: string, data: Buffer): void {
  if (data.length > 5 * 1024 * 1024 || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return;
  fs.writeFileSync(path.join(screenshotDir, `${jobId}.bin`), encrypt(data, getMasterKey(), `${userId}:${jobId}:screenshot`), { mode: 0o600 });
}

export function getJobScreenshot(userId: string, jobId: string): Buffer | null {
  const allowed = db.prepare('SELECT 1 FROM jobs WHERE id=? AND user_id=?').get(jobId, userId);
  if (!allowed) return null;
  const filePath = path.join(screenshotDir, `${jobId}.bin`);
  if (!fs.existsSync(filePath)) return null;
  return decrypt(fs.readFileSync(filePath), getMasterKey(), `${userId}:${jobId}:screenshot`);
}
