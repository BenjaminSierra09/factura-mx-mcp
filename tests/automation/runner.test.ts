import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { extractInvoicesFromZip, validatePublicHttpsUrl } from '../../src/automation/runner.js';

function zipFixture(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralSize = Buffer.concat(centrals).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test('blocks non-public portal URLs before opening a browser', async () => {
  for (const url of ['http://example.com', 'https://localhost/', 'https://127.0.0.1/', 'https://169.254.169.254/']) {
    await assert.rejects(validatePublicHttpsUrl(url));
  }
});

test('extracts CFDI files from ZIP without trusting archive paths or extensions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'factura-zip-test-'));
  try {
    const zipPath = path.join(dir, 'download.zip');
    await writeFile(zipPath, zipFixture([
      { name: '../factura.xml', content: Buffer.from('<?xml version="1.0"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"/>') },
      { name: 'factura.pdf', content: Buffer.from('%PDF-1.4\ninvoice') },
      { name: 'falso.xml', content: Buffer.from('<html>no es factura</html>') },
      { name: '../../ejecutable.sh', content: Buffer.from('bad') },
    ]));
    const extracted = await extractInvoicesFromZip(zipPath, dir);
    assert.equal(extracted.length, 3);
    assert.equal(extracted.filter((file) => file.valid).length, 2);
    assert.ok(extracted.every((file) => path.dirname(file.path) === dir));
    assert.ok((await readFile(extracted.find((file) => file.kind === 'xml' && file.valid)!.path, 'utf8')).includes('Comprobante'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
