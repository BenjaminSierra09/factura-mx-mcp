import type { PaymentSuggestion } from '../payment.js';

export type SupportedMimeType =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

export interface TicketAnalysis {
  text: string;
  qrUrl: string | null;
  empresa: string | null;
  folio: string | null;
  fecha: string | null;
  monto: number | null;
  referencia: string | null;
  url: string | null;
  numeroTicket?: string | null;
  numeroTienda?: string | null;
  fechaVenta?: string | null;
  horaVenta?: string | null;
  folioVenta?: string | null;
  idVenta?: string | null;
  caja?: string | null;
  transaccion?: string | null;
  marca?: string | null;
  totalSinPropina?: number | null;
  formaPagoSugerida?: PaymentSuggestion | null;
  formaPagoUsuario?: (PaymentSuggestion & { confirmada?: boolean }) | null;
}

export interface CsfAnalysis {
  text: string;
  rfc: string | null;
  nombre: string | null;
  codigoPostal: string | null;
  regimenFiscal: string | null;
  email: string | null;
}
