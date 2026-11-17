import { runGeneric } from './generic.js';
import { exploreInvoicePortal } from './explore.js';
import { runPrimeraPlus } from './primeraPlus.js';
import { AutomationRun, validatePublicHttpsUrl } from './runner.js';
import type { AutomationHooks, AutomationResult, InvoiceAutomationInput } from './types.js';

export type {
  AutomationEvent,
  AutomationHooks,
  AutomationResult,
  AutomationStatus,
  FiscalData,
  HumanActionSession,
  InvoiceAutomationInput,
  InvoiceDownload,
  PortalExploreInput,
  PortalExploration,
} from './types.js';

export { exploreInvoicePortal };

const PRIMERA_PLUS_URL = 'https://www.facturaelectronicagfa.mx/';

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const publicErrors = new Set([
    'La URL del portal no es válida.',
    'El portal debe usar HTTPS sin credenciales ni puerto personalizado.',
    'No se permiten portales internos o locales.',
    'Use el dominio público del portal, no una dirección IP.',
    'El dominio del portal resuelve a una red privada.',
    'El token debe tener entre 9 y 25 caracteres alfanuméricos.',
    'La constancia debe ser PDF, PNG o JPEG de máximo 4 MiB.',
  ]);
  if (publicErrors.has(message)) return message;
  if (/^El boleto .+ debe ser un archivo de 1 a 4 MiB\.$/.test(message)) return 'El boleto debe ser un archivo de 1 a 4 MiB.';
  if (/^El boleto .+ debe ser PDF, PNG o JPEG\.$/.test(message)) return 'El boleto debe ser PDF, PNG o JPEG.';
  if (message.startsWith('No se encontró la opción fiscal ')) return 'No se encontró la opción fiscal seleccionada en el portal.';
  console.error('Error inesperado en navegador', { type: error instanceof Error ? error.name : typeof error });
  return 'El navegador no pudo completar el trámite. Revisa la captura o intenta de nuevo.';
}

/**
 * Generate or recover a Mexican CFDI through the portal's public web UI.
 *
 * The Primera Plus adapter uses stable, observed controls. Unknown portals use
 * a constrained AI planner and require the account owner's OpenAI API key.
 * A run is `completed` only after a downloaded PDF or CFDI XML passes a basic
 * file signature check. This does not validate the SAT seal or issuer status.
 */
export async function runInvoiceAutomation(input: InvoiceAutomationInput, hooks: AutomationHooks = {}): Promise<AutomationResult> {
  if (input.provider && input.provider !== 'primera_plus' && !input.portalUrl) {
    return { status: 'failed', reason: 'invalid_portal', message: 'Falta la URL del portal para este emisor.',
      portalUrl: '', screenshots: [], downloads: [], steps: [] };
  }
  const requestedUrl = input.portalUrl || PRIMERA_PLUS_URL;
  let portalUrl: string;
  try {
    portalUrl = (await validatePublicHttpsUrl(requestedUrl)).toString();
    for (const host of input.allowedHosts ?? []) await validatePublicHttpsUrl(`https://${host}/`);
  } catch (error) {
    return { status: 'failed', reason: 'invalid_portal', message: safeError(error), portalUrl: requestedUrl, screenshots: [], downloads: [], steps: [] };
  }
  const provider = input.provider ?? (new URL(portalUrl).hostname.toLowerCase() === 'www.facturaelectronicagfa.mx' ? 'primera_plus' : 'generic');
  const run = new AutomationRun({ ...input, provider }, hooks, provider === 'primera_plus' ? PRIMERA_PLUS_URL : portalUrl);
  try {
    await run.start();
    const result = provider === 'primera_plus' ? await runPrimeraPlus(run) : await runGeneric(run);
    return await run.finish(result);
  } catch (error) {
    const message = safeError(error);
    try { if (run.page && !run.page.isClosed()) await run.screenshot('error'); } catch { /* browser may be closed */ }
    const knownInputError = /debe ser|máximo 4 MiB|token debe|opción fiscal/i.test(message);
    return await run.finish(run.result(knownInputError ? 'needs_action' : 'failed', message, knownInputError ? 'input_rejected' : 'automation_error'));
  } finally {
    await run.close();
  }
}
