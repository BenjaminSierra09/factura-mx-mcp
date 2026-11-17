import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import * as z from 'zod/v4';

export const profileSchema = z.object({
  rfc: z.string().trim().toUpperCase().regex(/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/, 'RFC inválido'),
  nombre: z.string().trim().min(3).max(250),
  codigoPostal: z.string().regex(/^\d{5}$/, 'Código postal inválido'),
  regimenFiscal: z.string().regex(/^\d{3}$/, 'Régimen fiscal inválido'),
  usoCfdi: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3}$/, 'Uso CFDI inválido'),
  facturaEmail: z.email().max(254),
  domicilio: z.string().trim().max(500).default(''),
});

export const smtpSchema = z.object({
  host: z.string().trim().max(253).default(''),
  port: z.number().int().refine(value => [465, 587, 2525].includes(value), 'Puerto SMTP no admitido').default(587),
  secure: z.boolean().default(false),
  user: z.string().max(254).default(''),
  from: z.email().max(254).or(z.literal('')).default(''),
  password: z.string().max(512).optional(),
});

function isPublicAddress(value: string): boolean {
  const parsed = ipaddr.parse(value);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    return (parsed as ipaddr.IPv6).toIPv4Address().range() === 'unicast';
  }
  return parsed.range() === 'unicast';
}

export async function assertPublicHostname(hostname: string): Promise<void> {
  const host = hostname.trim().toLowerCase();
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host === 'localhost') throw new Error('El destino debe ser un dominio público');
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('El destino resuelve a una dirección no pública');
}

export async function validatePortalUrl(raw: string): Promise<string> {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('URL del portal inválida'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('El portal debe usar HTTPS público');
  await assertPublicHostname(url.hostname);
  url.hash = '';
  return url.toString();
}
