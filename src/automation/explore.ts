import { AutomationRun, validatePublicHttpsUrl } from './runner.js';
import { visibleElements } from './generic.js';
import type { PortalExploreInput, PortalExploration } from './types.js';

/** Observe only the first portal screen. It never types, uploads or clicks. */
export async function exploreInvoicePortal(input: PortalExploreInput): Promise<PortalExploration> {
  const portalUrl = (await validatePublicHttpsUrl(input.portalUrl)).toString();
  for (const host of input.allowedHosts ?? []) await validatePublicHttpsUrl(`https://${host}/`);
  const run = new AutomationRun({
    provider: 'generic', portalUrl, outputDir: input.outputDir,
    allowedHosts: input.allowedHosts, browser: input.browser,
    fiscal: { rfc: '', razonSocial: '', codigoPostal: '', regimenFiscal: '', usoCfdi: '', email: '' },
  }, {}, portalUrl);
  try {
    await run.start();
    await run.navigate(portalUrl);
    await run.page.waitForTimeout(500);
    const elements = await visibleElements(run.page);
    const fields = elements.filter(element =>
      ['input', 'select', 'textarea'].includes(element.tag) || ['textbox', 'combobox'].includes(element.role),
    ).filter(element => !['hidden', 'password', 'submit', 'button', 'reset', 'checkbox', 'radio'].includes(element.type))
      .map(element => ({
        label: element.label || element.placeholder || element.name || 'Campo sin etiqueta',
        type: element.type || element.role || element.tag,
        required: element.required,
        options: element.options,
      }));
    const contactEmails = [...new Map(elements.flatMap(element => {
      if (element.tag !== 'a' || !element.href?.toLowerCase().startsWith('mailto:')) return [];
      try {
        const address = decodeURIComponent(new URL(element.href).pathname).trim().toLowerCase();
        if (!/^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/.test(address)) return [];
        return [[address, { address, label: (element.text || element.label || 'Contacto por correo').slice(0, 120) }] as const];
      } catch { return []; }
    })).values()].slice(0, 10);
    const notes = ['Sólo se observó la primera pantalla. El portal puede pedir más datos tras validar el ticket.'];
    if (run.lastHttpStatus && run.lastHttpStatus >= 400) notes.push(`El portal respondió HTTP ${run.lastHttpStatus}; el formulario puede no estar disponible desde este navegador.`);
    if (run.pendingHostReview) notes.push(`El portal pidió abrir ${run.pendingHostReview.host}; ese dominio requiere revisión del usuario y no se siguió durante la exploración.`);
    if (run.blockedNavigationHost) notes.push(`Redirección bloqueada a ${run.blockedNavigationHost}; añade el dominio público tras verificarlo.`);
    if (await run.challengeVisible()) notes.push('La primera pantalla muestra una verificación humana.');
    if (elements.some(element => element.type === 'password')) notes.push('La pantalla incluye acceso de cuenta; algunos campos pueden pertenecer al inicio de sesión y no al trámite sin cuenta.');
    if (!fields.length) notes.push('No se encontraron campos de formulario en esta pantalla.');
    if (contactEmails.length) notes.push('Los correos visibles son candidatos; confirma que el emisor los publique para solicitar CFDI antes de usarlos.');
    return { portalUrl: run.page.url(), fields, contactEmails, notes, screenshot: await run.screenshot('exploracion-inicial') };
  } catch (error) {
    console.error('No se pudo inspeccionar el portal', { type: error instanceof Error ? error.name : typeof error });
    let screenshot: string | undefined;
    try { if (run.page && !run.page.isClosed()) screenshot = await run.screenshot('exploracion-bloqueada'); } catch { /* no page */ }
    return { portalUrl: run.page?.url() || portalUrl, fields: [], contactEmails: [],
      notes: ['No se pudo inspeccionar el formulario. Revisa la captura o intenta de nuevo.',
        ...(run.pendingHostReview ? [`El portal pidió abrir ${run.pendingHostReview.host}; ese dominio requiere revisión del usuario y no se siguió durante la exploración.`] : []),
        'Sólo se intentó abrir la primera pantalla; no se enviaron datos ni se pulsó emitir.'],
      ...(screenshot ? { screenshot } : {}),
    };
  } finally {
    await run.close();
  }
}
