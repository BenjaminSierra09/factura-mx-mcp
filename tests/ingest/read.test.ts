import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractPdf, extractQrFromImage, readSupportedFile } from '../../src/ingest/read.js';
import { analyzeCsf, analyzeTicket } from '../../src/ingest/index.js';

function simplePdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('lee texto real de un PDF local y verifica su firma', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factura-ingest-'));
  const path = join(directory, 'constancia.pdf');
  try {
    await writeFile(path, simplePdf('RFC: ABCD010203A12'));
    const file = await readSupportedFile(path, 'application/pdf');
    const result = await extractPdf(file.buffer);
    assert.match(result.text, /RFC: ABCD010203A12/);
    await assert.rejects(() => readSupportedFile(path, 'image/png'), /no coincide/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rechaza contenido distinto de PDF o imagen aun con MIME declarado', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factura-ingest-'));
  const path = join(directory, 'archivo.pdf');
  try {
    await writeFile(path, 'contenido falso');
    await assert.rejects(() => readSupportedFile(path, 'application/pdf'), /Formato no permitido/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('decodifica QR de una imagen local', async () => {
  const image = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./fixtures/qr.png', import.meta.url)));
  const result = await extractQrFromImage(image);
  assert.equal(result, 'https://factura.example.com/inicio?folio=PP-0483821');
});

test('analiza un ticket con QR sin llave de IA y obtiene el folio del enlace', async () => {
  const result = await analyzeTicket(fileURLToPath(new URL('./fixtures/qr.png', import.meta.url)), 'image/png');
  assert.equal(result.qrUrl, 'https://factura.example.com/inicio?folio=PP-0483821');
  assert.equal(result.folio, 'PP-0483821');
  assert.equal(result.empresa, null);
});

test('analiza una constancia PDF local sin enviar datos a IA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factura-ingest-'));
  const path = join(directory, 'constancia.pdf');
  try {
    await writeFile(path, simplePdf('RFC: ABCD010203A12'));
    const result = await analyzeCsf(path, 'application/pdf');
    assert.equal(result.rfc, 'ABCD010203A12');
    assert.equal(result.codigoPostal, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
