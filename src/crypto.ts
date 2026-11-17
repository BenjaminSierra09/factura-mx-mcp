import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

function scrypt(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derived) => error ? reject(error) : resolve(derived));
  });
}
const PASSWORD_N = 16384;
const PASSWORD_R = 8;
const PASSWORD_P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: PASSWORD_N, r: PASSWORD_R, p: PASSWORD_P });
  return `scrypt:${PASSWORD_N}:${PASSWORD_R}:${PASSWORD_P}:${salt.toString('base64')}:${key.toString('base64')}`;
}

export async function verifyPassword(password: string, record: string): Promise<boolean> {
  const parts = record.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (n !== PASSWORD_N || r !== PASSWORD_R || p !== PASSWORD_P) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt, 64, { N: n, r, p });
  return timingSafeEqual(actual, expected);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function encrypt(data: Buffer, key: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}

export function decrypt(data: Buffer, key: Buffer, aad: string): Buffer {
  if (data.length < 29 || data[0] !== 1) throw new Error('Archivo cifrado inválido');
  const iv = data.subarray(1, 13);
  const tag = data.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]);
}

export function encryptText(value: string, key: Buffer, aad: string): string {
  return encrypt(Buffer.from(value, 'utf8'), key, aad).toString('base64');
}

export function decryptText(value: string, key: Buffer, aad: string): string {
  return decrypt(Buffer.from(value, 'base64'), key, aad).toString('utf8');
}
