import type { CsfAnalysis, TicketAnalysis } from './types.js';
import { suggestPaymentForm } from '../payment.js';

function clean(value: string | null | undefined, maxLength = 160): string | null {
  if (!value) return null;
  const trimmed = value.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function capture(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return clean(match[1]);
  }
  return null;
}

function normaliseUrl(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const raw = candidate.trim().replace(/[),.;]+$/, '');
  try {
    const url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function extractUrl(text: string): string | null {
  const match = text.match(/\b(?:https?:\/\/|www\.)[^\s<>"']+/i);
  return normaliseUrl(match?.[0]);
}

function queryValue(url: string | null, names: string[]): string | null {
  if (!url) return null;
  const params = new URL(url).searchParams;
  for (const name of names) {
    for (const [key, value] of params) {
      if (key.toLowerCase() === name) return clean(value, 80);
    }
  }
  return null;
}

export function normaliseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$|^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!match) return null;
  const year = Number(match[1] ?? match[6]);
  const month = Number(match[2] ?? match[5]);
  const day = Number(match[3] ?? match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function normaliseAmount(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (!value) return null;
  const raw = value.replace(/(?:MXN|M\.?N\.?|\$|\s)/gi, '');
  if (!/^\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw.replaceAll(',', ''));
  return Number.isFinite(amount) ? amount : null;
}

export function parseTicketText(text: string, qrData?: string | null): TicketAnalysis {
  const qrUrl = extractUrl(qrData ?? '');
  const bodyUrl = extractUrl(text);
  const url = qrUrl ?? bodyUrl;
  const marca = (['Starbucks', "Domino's", 'Vips', 'Burger King', "Chili's", "P.F. Chang's", 'Italiannis'] as const)
    .find(name => text.toUpperCase().includes(name.toUpperCase())) ?? null;
  const empresa = /\bPRIMERA\s+PLUS\b/i.test(text) ? 'Primera Plus'
    : /\bOXXO\b/i.test(text) ? 'OXXO'
    : /\bLA\s+COMER\b/i.test(text) ? 'La Comer'
    : /\bALSEA\b/i.test(text) ? 'Alsea'
    : marca ?? capture(text, [/^\s*([A-ZÁÉÍÓÚÑ0-9 .,&-]+(?:S\.?A\.?\s+DE\s+C\.?V\.?))\s*$/im]);
  const numeroTicket = capture(text, [
    /\b(?:N[ÚU]M(?:ERO)?\.?\s*(?:DE\s*)?TICKET|TICKET\s*(?:NO\.?|N[ÚU]M(?:ERO)?\.?)?|NO\.?\s*TICKET)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,39})\b/i,
  ]);
  const numeroTienda = capture(text, [
    /\b(?:N[ÚU]M(?:ERO)?\.?\s*(?:DE\s*)?TIENDA|NO\.?\s*TIENDA|TIENDA)\s*[:#-]?\s*(\d{1,8})\b/i,
  ]);
  const folioVenta = capture(text, [/\bFOLIO\s*(?:DE\s*)?VENTA\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,39})\b/i]);
  const idVenta = capture(text, [/\bID\s*(?:DE\s*)?VENTA\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,39})\b/i]);
  const caja = capture(text, [/\bCAJA\s*[:#-]?\s*(\d{1,8})\b/i]);
  const transaccion = capture(text, [/\b(?:TRANSACCI[ÓO]N|OPERACI[ÓO]N)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,39})\b/i]);
  const folio = capture(text, [
    /\b(?:FOLIO(?:\s+(?:DE\s+)?(?:BOLETO|TICKET))?|N[ÚU]MERO\s+DE\s+BOLETO|NO\.?\s*BOLETO)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,39})\b/i,
  ]) ?? queryValue(url, ['folio', 'ticket', 'numBoleto']);
  const fechaText = capture(text, [
    /\bFECHA(?:\s+DE\s+(?:COMPRA|VIAJE|EMISI[ÓO]N))?\s*[:#-]?\s*(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\b/i,
  ]);
  const montoText = capture(text, [
    /\b(?:TOTAL(?:\s+A\s+PAGAR)?|IMPORTE(?:\s+TOTAL)?|MONTO)\s*[:#-]?\s*(?:MXN\s*)?\$?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)\b/i,
  ]);
  const referencia = capture(text, [
    /\b(?:REFERENCIA|C[ÓO]DIGO\s+DE\s+RESERVA|CLAVE\s+DE\s+CONFIRMACI[ÓO]N)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,39})\b/i,
  ]) ?? queryValue(url, ['referencia', 'reference', 'ref']);
  const fechaVentaText = capture(text, [
    /\bFECHA\s*(?:DE\s*)?(?:VENTA|COMPRA|CONSUMO)\s*[:#-]?\s*(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\b/i,
    /\bFEC(?:HA)?\.?\s*[:#-]?\s*(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})\b/i,
  ]);
  const horaVenta = capture(text, [/\bHORA(?:\s+DE\s+VENTA)?\s*[:#-]?\s*(\d{1,2}:\d{2}(?::\d{2})?)\b/i]);
  const totalSinPropina = normaliseAmount(capture(text, [
    /\bTOTAL\s+SIN\s+(?:PROPINA|DONATIVO)\s*[:#-]?\s*(?:MXN\s*)?\$?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)\b/i,
  ]));
  return {
    text,
    qrUrl,
    empresa,
    folio: folio ?? folioVenta ?? numeroTicket,
    fecha: normaliseDate(fechaText) ?? normaliseDate(fechaVentaText),
    monto: normaliseAmount(montoText),
    referencia,
    url,
    numeroTicket, numeroTienda, fechaVenta: normaliseDate(fechaVentaText), horaVenta,
    folioVenta, idVenta, caja, transaccion, marca, totalSinPropina,
    formaPagoSugerida: suggestPaymentForm(text),
  };
}

export function normaliseRfc(value: string | null | undefined): string | null {
  const rfc = clean(value, 13)?.toUpperCase();
  return rfc && /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc) ? rfc : null;
}

export function normalisePostalCode(value: string | null | undefined): string | null {
  const code = clean(value, 5);
  return code && /^\d{5}$/.test(code) ? code : null;
}

export function parseCsfText(text: string): CsfAnalysis {
  const rfc = normaliseRfc(capture(text, [
    /\bR\.?F\.?C\.?\s*[:#-]?\s*([A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3})\b/i,
  ]) ?? text.match(/\b[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}\b/i)?.[0]);
  const razonSocial = capture(text, [
    /\b(?:DENOMINACI[ÓO]N\s*\/\s*RAZ[ÓO]N\s+SOCIAL|RAZ[ÓO]N\s+SOCIAL)\s*[:#-]?\s*([^\n]+)/i,
  ]);
  const nombres = capture(text, [/\bNOMBRE\s*\(?S\)?\s*[:#-]?\s*([^\n]+)/i]);
  const apellido1 = capture(text, [/\bPRIMER\s+APELLIDO\s*[:#-]?\s*([^\n]+)/i]);
  const apellido2 = capture(text, [/\bSEGUNDO\s+APELLIDO\s*[:#-]?\s*([^\n]+)/i]);
  const nombre = razonSocial ?? clean([nombres, apellido1, apellido2].filter(Boolean).join(' '));
  const codigoPostal = normalisePostalCode(capture(text, [
    /\bC[ÓO]DIGO\s+POSTAL\s*[:#-]?\s*(\d{5})\b/i,
    /\bC\.?P\.?\s*[:#-]?\s*(\d{5})\b/i,
  ]));
  const regimenFiscal = capture(text, [
    /\b(?:R[ÉE]GIMEN(?:ES)?(?:\s+FISCAL(?:ES)?)?)\s*[:#-]?\s*(\d{3}(?:\s*[-–]\s*[^\n]{1,100})?)/i,
    /\b(\d{3}\s*[-–]\s*R[ÉE]GIMEN[^\n]{1,100})/i,
  ]);
  const emailCandidate = capture(text, [
    /\b(?:CORREO\s+ELECTR[ÓO]NICO|E-?MAIL)\s*[:#-]?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
  ]);
  return {
    text,
    rfc,
    nombre: nombre && !/^(?:RFC|C[ÓO]DIGO|R[ÉE]GIMEN)/i.test(nombre) ? nombre : null,
    codigoPostal,
    regimenFiscal,
    email: emailCandidate?.toLowerCase() ?? null,
  };
}

export function mergeTicket(local: TicketAnalysis, vision: Partial<TicketAnalysis>): TicketAnalysis {
  const visionText = clean(vision.text, 100_000);
  const parsedVision = parseTicketText(visionText ?? '', vision.qrUrl);
  return {
    text: local.text || visionText || '',
    qrUrl: local.qrUrl ?? parsedVision.qrUrl,
    empresa: local.empresa ?? clean(vision.empresa) ?? parsedVision.empresa,
    folio: local.folio ?? clean(vision.folio, 40) ?? parsedVision.folio,
    fecha: local.fecha ?? normaliseDate(vision.fecha) ?? parsedVision.fecha,
    monto: local.monto ?? normaliseAmount(vision.monto) ?? parsedVision.monto,
    referencia: local.referencia ?? clean(vision.referencia, 40) ?? parsedVision.referencia,
    url: local.url ?? normaliseUrl(vision.url) ?? parsedVision.url,
    numeroTicket: local.numeroTicket ?? clean(vision.numeroTicket, 40) ?? parsedVision.numeroTicket,
    numeroTienda: local.numeroTienda ?? clean(vision.numeroTienda, 20) ?? parsedVision.numeroTienda,
    fechaVenta: local.fechaVenta ?? normaliseDate(vision.fechaVenta) ?? parsedVision.fechaVenta,
    horaVenta: local.horaVenta ?? clean(vision.horaVenta, 8) ?? parsedVision.horaVenta,
    folioVenta: local.folioVenta ?? clean(vision.folioVenta, 40) ?? parsedVision.folioVenta,
    idVenta: local.idVenta ?? clean(vision.idVenta, 40) ?? parsedVision.idVenta,
    caja: local.caja ?? clean(vision.caja, 20) ?? parsedVision.caja,
    transaccion: local.transaccion ?? clean(vision.transaccion, 40) ?? parsedVision.transaccion,
    marca: local.marca ?? clean(vision.marca, 80) ?? parsedVision.marca,
    totalSinPropina: local.totalSinPropina ?? normaliseAmount(vision.totalSinPropina) ?? parsedVision.totalSinPropina,
    formaPagoSugerida: local.formaPagoSugerida ?? parsedVision.formaPagoSugerida,
  };
}

export function mergeCsf(local: CsfAnalysis, vision: Partial<CsfAnalysis>): CsfAnalysis {
  const visionText = clean(vision.text, 100_000);
  const parsedVision = parseCsfText(visionText ?? '');
  return {
    text: local.text || visionText || '',
    rfc: local.rfc ?? normaliseRfc(vision.rfc) ?? parsedVision.rfc,
    nombre: local.nombre ?? clean(vision.nombre) ?? parsedVision.nombre,
    codigoPostal: local.codigoPostal ?? normalisePostalCode(vision.codigoPostal) ?? parsedVision.codigoPostal,
    regimenFiscal: local.regimenFiscal ?? clean(vision.regimenFiscal) ?? parsedVision.regimenFiscal,
    email: local.email ?? (vision.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vision.email) ? vision.email.toLowerCase() : null) ?? parsedVision.email,
  };
}
