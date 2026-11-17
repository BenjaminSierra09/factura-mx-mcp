import { readFile, stat } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import jsQR from 'jsqr';
import sharp from 'sharp';
import type { SupportedMimeType } from './types.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 10;
const MAX_RENDERED_PIXELS = 6_000_000;
const decodeQr = jsQR as unknown as (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: { inversionAttempts: 'attemptBoth' },
) => { data: string } | null;

function actualMime(buffer: Buffer): SupportedMimeType | null {
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export async function readSupportedFile(filePath: string, claimedMime: string): Promise<{ buffer: Buffer; mimeType: SupportedMimeType }> {
  const size = (await stat(filePath)).size;
  if (!size || size > MAX_FILE_BYTES) throw new Error('El archivo debe medir entre 1 byte y 20 MB.');
  const buffer = await readFile(filePath);
  const mimeType = actualMime(buffer);
  if (!mimeType) throw new Error('Formato no permitido: usa PDF, JPEG, PNG o WebP.');
  const claim = claimedMime.toLowerCase().split(';', 1)[0]?.trim();
  if (claim && claim !== mimeType && !(claim === 'image/jpg' && mimeType === 'image/jpeg')) {
    throw new Error('El tipo del archivo no coincide con su contenido.');
  }
  return { buffer, mimeType };
}

export async function extractQrFromImage(buffer: Buffer): Promise<string | null> {
  const image = sharp(buffer, { limitInputPixels: 24_000_000 }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) return null;
  const sizes = [Math.min(2200, Math.max(metadata.width, metadata.height)), 1200];
  for (const width of sizes) {
    const { data, info } = await image.clone()
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: width >= Math.max(metadata.width, metadata.height) })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) continue;
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    const result = decodeQr(pixels, info.width, info.height, { inversionAttempts: 'attemptBoth' });
    if (result?.data) return result.data.trim();
  }
  return null;
}

function pageText(items: Array<{ str: string; transform: number[] }>): string {
  const rows: Array<{ y: number; pieces: Array<{ x: number; str: string }> }> = [];
  for (const item of items) {
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    let row = rows.find((candidate) => Math.abs(candidate.y - y) < 2.5);
    if (!row) {
      row = { y, pieces: [] };
      rows.push(row);
    }
    row.pieces.push({ x, str: item.str });
  }
  return rows.sort((a, b) => b.y - a.y)
    .map((row) => row.pieces.sort((a, b) => a.x - b.x).map((piece) => piece.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join('\n');
}

export async function extractPdf(buffer: Buffer): Promise<{ text: string; qrData: string | null }> {
  const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, stopAtErrors: true });
  const document = await task.promise;
  const texts: string[] = [];
  let qrData: string | null = null;
  try {
    if (document.numPages > MAX_PDF_PAGES) throw new Error('El PDF supera el límite de 10 páginas.');
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } => 'str' in item && 'transform' in item);
      texts.push(pageText(items));
      if (!qrData && index <= 3) {
        const original = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.sqrt(MAX_RENDERED_PIXELS / (original.width * original.height)));
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        await page.render({ canvasContext: context, canvas, viewport } as never).promise;
        qrData = await extractQrFromImage(canvas.toBuffer('image/png'));
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { text: texts.join('\n'), qrData };
}
