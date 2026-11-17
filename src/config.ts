import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  headless: process.env.HEADLESS !== 'false',
  publicOrigin: process.env.APP_PUBLIC_ORIGIN || '',
  allowedHosts: (process.env.APP_ALLOWED_HOSTS || 'localhost,127.0.0.1,::1').split(',').map(x => x.trim()).filter(Boolean),
};

export function getMasterKey(): Buffer {
  const fromEnv = process.env.APP_MASTER_KEY?.trim();
  if (fromEnv) {
    if (!/^[a-f\d]{64}$/i.test(fromEnv)) throw new Error('APP_MASTER_KEY debe tener 64 caracteres hexadecimales');
    return Buffer.from(fromEnv, 'hex');
  }
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(config.dataDir, 'master.key');
  try {
    const value = fs.readFileSync(keyFile);
    if (value.length !== 32) throw new Error('master.key inválida');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(32);
    try {
      fs.writeFileSync(keyFile, value, { flag: 'wx', mode: 0o600 });
      return value;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code === 'EEXIST') return fs.readFileSync(keyFile);
      throw writeError;
    }
  }
}
