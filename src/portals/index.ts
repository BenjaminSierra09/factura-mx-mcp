import { isIP } from 'node:net';
import type { TicketAnalysis } from '../ingest/types.js';

export type ProviderId = 'primera_plus' | 'oxxo' | 'alsea' | 'la_comer' | 'generic';

export type TicketFieldKey =
  | 'folio' | 'fecha' | 'monto' | 'referencia'
  | 'numeroTicket' | 'numeroTienda' | 'fechaVenta' | 'horaVenta'
  | 'folioVenta' | 'idVenta' | 'caja' | 'transaccion'
  | 'marca' | 'totalSinPropina';

export interface PortalField {
  key: TicketFieldKey;
  label: string;
  required: boolean;
  help?: string;
}

export interface PortalDefinition {
  id: ProviderId;
  label: string;
  /** Official entry URL; null means the user must supply and review one. */
  portalUrl: string | null;
  /** Main-frame navigation hosts observed or linked from the official entry. */
  allowedHosts: readonly string[];
  ticketFields: readonly PortalField[];
  /** Alsea brand-specific ticket fields; the user still selects `marca` separately. */
  brandVariants?: Readonly<Record<string, readonly PortalField[]>>;
  /** Brand routes linked directly from Alsea's official billing page. */
  brandEntryUrls?: Readonly<Record<string, string>>;
  automation: 'dedicated' | 'ai';
  /** Official issuer page used to verify the portal, when accessible. */
  sourceUrl: string | null;
  notes: readonly string[];
}

export interface PortalDetection {
  provider: ProviderId;
  confidence: 'high' | 'medium' | 'low';
  /** Known provider entry URL; null for an unknown issuer. */
  portalUrl: string | null;
  /** A public-looking HTTPS URL printed on the ticket; it still needs network validation and user review. */
  candidateUrl: string | null;
  reasons: string[];
}

const PORTALS: Record<ProviderId, PortalDefinition> = {
  primera_plus: {
    id: 'primera_plus', label: 'Primera Plus',
    portalUrl: 'https://www.facturaelectronicagfa.mx/',
    allowedHosts: ['www.facturaelectronicagfa.mx'],
    ticketFields: [{ key: 'referencia', label: 'Token del boleto', required: false,
      help: 'El portal también puede procesar la imagen o PDF del boleto.' }],
    automation: 'dedicated',
    sourceUrl: 'https://www.primeraplus.com.mx/facturacion/',
    notes: ['El portal acepta la imagen o PDF del boleto y permite recuperar CFDI por RFC y token.'],
  },
  oxxo: {
    id: 'oxxo', label: 'OXXO',
    portalUrl: 'https://www4.oxxo.com/facturacionElectronica-web/views/layout/inicio.do',
    allowedHosts: ['www4.oxxo.com', 'www.oxxo.com'],
    ticketFields: [
      { key: 'fechaVenta', label: 'Fecha de venta', required: true },
      { key: 'folioVenta', label: 'Folio de venta', required: true },
      { key: 'idVenta', label: 'ID de venta', required: true },
      { key: 'monto', label: 'Total con dos decimales', required: true },
    ],
    automation: 'ai',
    sourceUrl: 'https://www4.oxxo.com/facturacionElectronica-web/views/layout/inicio.do',
    notes: ['El portal valida fecha, folio, ID y total antes de pedir los datos fiscales.',
      'Si el ticket aún no aparece, el portal ofrece dejar un correo para enviarlo cuando se recupere.'],
  },
  alsea: {
    id: 'alsea', label: 'Alsea y sus marcas',
    portalUrl: 'https://www.alsea.net/factura-electronica.html',
    allowedHosts: ['www.alsea.net', 'alsea.interfactura.com'],
    ticketFields: [
      { key: 'marca', label: 'Marca del restaurante', required: true },
      { key: 'numeroTicket', label: 'Número de ticket', required: true },
      { key: 'numeroTienda', label: 'Número de tienda', required: true },
      { key: 'fechaVenta', label: 'Fecha de consumo', required: true },
    ],
    brandVariants: {
      "Domino's": [
        { key: 'numeroTicket', label: 'Número de ticket', required: true, help: '9 dígitos.' },
        { key: 'numeroTienda', label: 'Número de tienda', required: true, help: '5 dígitos.' },
        { key: 'fechaVenta', label: 'Fecha de consumo', required: true },
      ],
      Starbucks: [
        { key: 'numeroTicket', label: 'Número de ticket', required: true, help: '9 dígitos.' },
        { key: 'numeroTienda', label: 'Número de tienda', required: true, help: '5 dígitos.' },
        { key: 'fechaVenta', label: 'Fecha de consumo', required: true },
      ],
      "P.F. Chang's": [
        { key: 'numeroTicket', label: 'Número de ticket', required: true, help: '18 dígitos.' },
        { key: 'totalSinPropina', label: 'Total sin propina', required: true },
      ],
    },
    brandEntryUrls: {
      'Burger King': 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=BurgerKing',
      "Chili's": 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=Chilis',
      "Domino's": 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=Dominos',
      "Italianni's": 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=Italiannis',
      "P.F. Chang's": 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=PFC',
      Starbucks: 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=Starbucks',
      'The Cheesecake Factory': 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=CCF',
      Vips: 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=Vips',
    },
    automation: 'ai',
    sourceUrl: 'https://www.alsea.net/factura-electronica.html',
    notes: ['Alsea pide seleccionar la marca y enlaza desde su página oficial a alsea.interfactura.com.',
      'Según Alsea, el ticket puede tardar entre 15 y 30 minutos en aparecer; el plazo publicado es de 30 días naturales.'],
  },
  la_comer: {
    id: 'la_comer', label: 'La Comer, Fresko, City Market y Sumesa',
    portalUrl: 'https://www.lacomer.com.mx/emision-cfdiwebangular/',
    allowedHosts: ['www.lacomer.com.mx', 'lacomer.com.mx'],
    ticketFields: [
      { key: 'numeroTicket', label: 'Código o folio del ticket', required: false,
        help: 'Confirma en el portal qué identificador solicita; la pantalla no pudo verificarse automáticamente.' },
      { key: 'monto', label: 'Total del ticket', required: false },
    ],
    automation: 'ai',
    sourceUrl: 'https://www.lacomer.com.mx/',
    notes: ['La URL está bajo el dominio de La Comer, pero su protección Cloudflare impidió verificar la pantalla de facturación.',
      'Puede requerir que el usuario complete una verificación humana antes de continuar.'],
  },
  generic: {
    id: 'generic', label: 'Otro emisor',
    portalUrl: null, allowedHosts: [], ticketFields: [], automation: 'ai', sourceUrl: null,
    notes: ['Confirma la dirección HTTPS de facturación que aparece en el ticket o en el sitio oficial del emisor.'],
  },
};

export function getPortalDefinition(id: ProviderId): PortalDefinition {
  return PORTALS[id] ?? PORTALS.generic;
}

export function listPortals(): PortalDefinition[] {
  return Object.values(PORTALS);
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function safeCandidateUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || isIP(host)) return null;
    return url.toString();
  } catch { return null; }
}

function providerForHost(host: string): ProviderId | null {
  const lowercase = host.toLowerCase();
  for (const portal of Object.values(PORTALS)) {
    if (portal.id !== 'generic' && portal.allowedHosts.includes(lowercase)) return portal.id;
  }
  return null;
}

const brandMatchers: { id: ProviderId; pattern: RegExp; reason: string }[] = [
  { id: 'primera_plus', pattern: /\bprimera\s+plus\b/i, reason: 'Marca Primera Plus detectada en el boleto' },
  { id: 'oxxo', pattern: /\boxxo\b/i, reason: 'Marca OXXO detectada en el ticket' },
  { id: 'la_comer', pattern: /\b(?:la\s+comer|city\s+market|fresko|sumesa)\b/i, reason: 'Marca del grupo La Comer detectada en el ticket' },
  { id: 'alsea', pattern: /\b(?:alsea|starbucks|domino'?s|vips|italian?ni'?s|chili'?s|p\.?\s*f\.?\s*chang'?s|the\s+cheesecake\s+factory)\b/i,
    reason: 'Marca que figura en la página oficial de Alsea detectada en el ticket' },
];

export function detectPortal(ticket: Partial<TicketAnalysis>): PortalDetection {
  const candidateUrl = safeCandidateUrl(ticket.qrUrl ?? ticket.url);
  const rawUrl = ticket.qrUrl ?? ticket.url;
  if (rawUrl) {
    try {
      const provider = providerForHost(new URL(rawUrl).hostname);
      if (provider) {
        const portal = getPortalDefinition(provider);
        return { provider, confidence: 'high', portalUrl: portal.portalUrl, candidateUrl,
          reasons: [`Dominio de ${portal.label} detectado en el QR o el ticket`] };
      }
    } catch { /* text may contain a partial URL */ }
  }

  const heading = normalized([ticket.empresa, (ticket as TicketAnalysis & { marca?: string | null }).marca, ticket.text?.slice(0, 500)]
    .filter(Boolean).join('\n'));
  for (const match of brandMatchers) {
    if (match.pattern.test(heading)) {
      const portal = getPortalDefinition(match.id);
      return { provider: match.id, confidence: 'medium', portalUrl: portal.portalUrl,
        candidateUrl, reasons: [match.reason] };
    }
  }
  return { provider: 'generic', confidence: 'low', portalUrl: null, candidateUrl,
    reasons: ['No se identificó con seguridad un portal conocido; revisa el emisor y su URL.'] };
}
