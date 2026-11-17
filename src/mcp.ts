import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getProfile } from './db.js';
import { createTicket, discoverTicket, exploreTicket, listTickets, publicProfile } from './service.js';
import { createInvoiceJob, getJob, getJobEvents, listJobs } from './jobs.js';
import { listPortals } from './portals/index.js';
import { publicInputErrorMessage } from './errors.js';

function answer(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function error(value: unknown) {
  const message = publicInputErrorMessage(value);
  if (!message) console.error('Error inesperado en MCP', { type: value instanceof Error ? value.name : typeof value });
  return { isError: true, content: [{ type: 'text' as const, text: message ?? 'Error interno. Intenta más tarde.' }] };
}

function createServer(userId: string): McpServer {
  const server = new McpServer({ name: 'factura-mx', version: '0.1.0' });

  server.registerTool('perfil_fiscal', {
    title: 'Consultar perfil fiscal',
    description: 'Consulta los campos CFDI 4.0 del usuario autenticado y si tiene constancia y API key configuradas. Nunca devuelve secretos ni la constancia.',
  }, async () => {
    try { return answer(publicProfile(getProfile(userId))); }
    catch (cause) { return error(cause); }
  });

  server.registerTool('cargar_ticket', {
    title: 'Cargar ticket',
    description: 'Guarda un boleto o ticket PDF/JPEG/PNG/WebP del usuario y extrae datos y QR. Base64 sin prefijo data:. Máximo 5 MB.',
    inputSchema: z.object({ filename: z.string().min(1).max(200), base64: z.string().min(4).max(7_000_000) }),
  }, async ({ filename, base64 }) => {
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('Base64 inválido');
      const data = Buffer.from(base64, 'base64');
      if (data.length > 5 * 1024 * 1024) throw new Error('El ticket supera 5 MB');
      return answer(await createTicket(userId, filename, data));
    } catch (cause) { return error(cause); }
  });

  server.registerTool('listar_tickets', {
    title: 'Listar tickets',
    description: 'Lista los tickets del usuario con sus campos extraídos y el identificador necesario para iniciar la factura.',
  }, async () => {
    try { return answer(listTickets(userId)); }
    catch (cause) { return error(cause); }
  });

  server.registerTool('listar_portales', {
    title: 'Portales de facturación conocidos',
    description: 'Lista emisores conocidos, campos de ticket, URL oficial y fuente. Es una ayuda; para otros emisores usa descubrir_portal.',
  }, async () => {
    try { return answer(listPortals()); }
    catch (cause) { return error(cause); }
  });

  server.registerTool('descubrir_portal', {
    title: 'Descubrir portal de facturación',
    description: 'Busca el portal del emisor indicado usando fuentes web. La búsqueda recibe sólo el nombre del emisor, nunca el ticket ni datos fiscales. Selecciona automáticamente sólo URL respaldada por el dominio del emisor.',
    inputSchema: z.object({ ticketId: z.uuid(), issuer: z.string().trim().min(3).max(120) }),
  }, async ({ ticketId, issuer }) => {
    try { return answer(await discoverTicket(userId, ticketId, issuer)); }
    catch (cause) { return error(cause); }
  });

  server.registerTool('explorar_portal', {
    title: 'Explorar formulario de facturación',
    description: 'Abre una URL HTTPS pública y observa los campos visibles sin enviar datos fiscales ni iniciar la factura. Puede requerir indicar o revisar una URL.',
    inputSchema: z.object({ ticketId: z.uuid(), portalUrl: z.url().optional() }),
  }, async ({ ticketId, portalUrl }) => {
    try { return answer(await exploreTicket(userId, ticketId, portalUrl)); }
    catch (cause) { return error(cause); }
  });

  server.registerTool('iniciar_factura', {
    title: 'Iniciar facturación',
    description: 'Inicia una solicitud de CFDI 4.0. Detecta el emisor y usa el portal conocido o uno descubierto con fuente oficial; para un emisor desconocido puede darse portalUrl revisada. ticketData permite corregir la extracción OCR y aportar otros campos. El canal email usa destinatario fijo de Primera Plus o recipientEmail revisado para otros emisores, con SMTP del usuario. No repite tickets ya enviados.',
    inputSchema: z.object({
      ticketId: z.uuid(), provider: z.enum(['auto','primera_plus','oxxo','alsea','la_comer','generic']).default('auto'),
      portalUrl: z.url().optional(), token: z.string().optional(),
      recipientEmail: z.email().max(254).optional(),
      ticketData: z.record(z.string().min(1).max(80), z.union([z.string().max(250), z.number().finite(), z.null()]))
        .refine(value => Object.keys(value).length <= 40, 'Demasiados campos del ticket').optional(),
      channel: z.enum(['portal','email']).default('portal'), includeCsf: z.boolean().default(false),
      operation: z.enum(['issue','recover']).default('issue'), force: z.boolean().default(false),
    }),
  }, async args => {
    try { return answer(await createInvoiceJob(userId, args)); }
    catch (cause) { return error(cause); }
  });

  server.registerTool('consultar_trabajo', {
    title: 'Consultar facturación',
    description: 'Devuelve el estado, eventos y documentos de una solicitud de factura. Un estado enviado o email_sent no confirma que exista un CFDI.',
    inputSchema: z.object({ jobId: z.uuid() }),
  }, async ({ jobId }) => {
    try {
      const job = getJob(userId, jobId);
      if (!job) throw new Error('Trabajo no encontrado');
      return answer({ job, events: getJobEvents(userId, jobId) });
    } catch (cause) { return error(cause); }
  });

  server.registerTool('listar_trabajos', {
    title: 'Listar solicitudes',
    description: 'Lista las solicitudes de factura del usuario y su estado actual.',
  }, async () => {
    try { return answer(listJobs(userId)); }
    catch (cause) { return error(cause); }
  });

  return server;
}

export const mcpHandler = createMcpHandler(({ authInfo }) => createServer(authInfo?.clientId || ''), {
  maxRequestBodySize: 10 * 1024 * 1024,
});
