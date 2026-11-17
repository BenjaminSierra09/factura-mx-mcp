import { stat } from 'node:fs/promises';
import type { Locator, Page } from 'playwright';
import { AutomationRun } from './runner.js';
import type { AutomationResult, FiscalData } from './types.js';

const PORTAL = 'https://www.facturaelectronicagfa.mx/';
const LIMIT = 4 * 1024 * 1024;

function normalized(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function tokenList(tokens: string[] | undefined): string[] {
  return [...new Set((tokens ?? []).map((token) => token.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean))];
}

async function ticketBatches(paths: string[]): Promise<string[][]> {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const filePath of paths) {
    const file = await stat(filePath);
    if (!file.isFile() || file.size <= 0 || file.size > LIMIT) {
      throw new Error(`El boleto ${filePath} debe ser un archivo de 1 a 4 MiB.`);
    }
    if (!/\.(?:pdf|png|jpe?g)$/i.test(filePath)) {
      throw new Error(`El boleto ${filePath} debe ser PDF, PNG o JPEG.`);
    }
    if (current.length >= 10 || size + file.size > LIMIT) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(filePath);
    size += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function boletoCount(page: Page): Promise<number> {
  const text = await page.getByRole('region', { name: 'Boletos agregados' }).innerText().catch(() => '');
  return Number(/(\d+)\s+de\s+20\s+boletos/i.exec(text)?.[1] ?? 0);
}

async function portalMessage(page: Page): Promise<string> {
  const messages = await page.locator('[role="alert"], mat-error, .mat-mdc-snack-bar-label').allInnerTexts().catch(() => []);
  return messages.map((value) => value.trim()).filter(Boolean).join(' ').slice(0, 500);
}

async function uploadTickets(run: AutomationRun): Promise<number> {
  const page = run.page;
  const batches = await ticketBatches(run.input.ticketFiles ?? []);
  for (const [index, batch] of batches.entries()) {
    const before = await boletoCount(page);
    await page.locator('input[type="file"][multiple]').setInputFiles(batch);
    await page.getByRole('button', { name: 'Procesar archivos' }).click();
    await page.waitForFunction((previous) => {
      const text = [...document.querySelectorAll('*')].find((node) => node.textContent?.trim() === 'Boletos agregados')?.parentElement?.textContent ?? '';
      const match = /(\d+)\s+de\s+20\s+boletos/i.exec(text);
      return Number(match?.[1] ?? 0) > previous || !!document.querySelector('[role="alert"], mat-error, .mat-mdc-snack-bar-label');
    }, before, { timeout: 45_000 }).catch(() => {});
    await run.step(`Lote ${index + 1} de ${batches.length} procesado por el portal`);
    await run.screenshot(`boletos-lote-${index + 1}`);
    if ((await boletoCount(page)) === before) break;
  }
  return boletoCount(page);
}

async function addTokens(run: AutomationRun, tokens: string[]): Promise<number> {
  const page = run.page;
  if (!tokens.length) return boletoCount(page);
  await page.getByRole('button', { name: /Captura manual/ }).click();
  for (const token of tokens.slice(0, 20)) {
    if (!/^[A-Z0-9]{9,25}$/.test(token)) throw new Error('El token debe tener entre 9 y 25 caracteres alfanuméricos.');
    const before = await boletoCount(page);
    await page.getByRole('textbox', { name: /Token del Boleto/i }).fill(token);
    await page.getByRole('button', { name: 'Agregar boleto' }).click();
    await page.waitForTimeout(1500);
    if ((await boletoCount(page)) === before) {
      await run.step('El portal no agregó un token; requiere revisión');
      break;
    }
    await run.step('Token de boleto agregado');
  }
  return boletoCount(page);
}

async function fillInput(page: Page, selector: string, value: string | undefined): Promise<void> {
  if (value?.trim()) await page.locator(selector).fill(value.trim());
}

async function selectMatOption(page: Page, selector: string, value: string | undefined): Promise<void> {
  if (!value?.trim()) return;
  const control = page.locator(selector);
  await control.click();
  const wanted = normalized(value);
  const options = page.getByRole('option');
  const count = await options.count();
  for (let index = 0; index < count; index++) {
    const option = options.nth(index);
    const text = normalized(await option.innerText());
    if (text === wanted || text.startsWith(`${wanted} `) || text.startsWith(`${wanted}-`) ||
        (wanted.length > 3 && text.includes(wanted))) {
      await option.click();
      return;
    }
  }
  await page.keyboard.press('Escape');
  throw new Error(`No se encontró la opción fiscal ${value} en el portal.`);
}

async function hasValue(locator: Locator): Promise<boolean> {
  if (await locator.count() === 0) return false;
  const tag = await locator.first().evaluate((element) => element.tagName.toLowerCase());
  const value = tag === 'input' ? await locator.first().inputValue() : await locator.first().innerText();
  return Boolean(value.trim() && !/^SELECCIONE$/i.test(value.trim()));
}

async function fillFiscalData(run: AutomationRun): Promise<AutomationResult | null> {
  const page = run.page;
  const fiscal: FiscalData = run.input.fiscal;
  const missing = [fiscal.rfc, fiscal.razonSocial, fiscal.codigoPostal, fiscal.regimenFiscal, fiscal.email].some((v) => !v?.trim());
  if (missing && run.input.csfFile) {
    const csf = await stat(run.input.csfFile);
    if (!csf.isFile() || csf.size <= 0 || csf.size > LIMIT || !/\.(?:pdf|png|jpe?g)$/i.test(run.input.csfFile)) {
      throw new Error('La constancia debe ser PDF, PNG o JPEG de máximo 4 MiB.');
    }
    await page.locator('input[type="file"]').first().setInputFiles(run.input.csfFile);
    await page.getByRole('button', { name: /Procesar constancia/i }).click();
    await page.waitForFunction(() => (document.querySelector('#input-rfc') as HTMLInputElement | null)?.value, null, { timeout: 45_000 }).catch(() => {});
    await run.step('Constancia procesada por el portal');
  }

  await fillInput(page, '#input-rfc', fiscal.rfc);
  await fillInput(page, '#input-nombre', fiscal.razonSocial);
  await selectMatOption(page, '#select-regimenFiscal', fiscal.regimenFiscal);
  await selectMatOption(page, '#select-usoCFDI', fiscal.usoCfdi);
  await fillInput(page, '#input-correo', fiscal.email);
  await fillInput(page, '#input-domicilioFiscal', fiscal.codigoPostal);

  const required = [
    ['RFC', '#input-rfc'],
    ['razón social', '#input-nombre'],
    ['régimen fiscal', '#select-regimenFiscal'],
    ['uso CFDI', '#select-usoCFDI'],
    ['correo', '#input-correo'],
    ['código postal', '#input-domicilioFiscal'],
  ] as const;
  const absent: string[] = [];
  for (const [label, selector] of required) if (!(await hasValue(page.locator(selector)))) absent.push(label);
  await run.screenshot('datos-fiscales');
  if (absent.length) return run.result('needs_action', `Faltan datos fiscales: ${absent.join(', ')}.`, 'fiscal_data_missing');
  const review = page.getByRole('button', { name: /Revisar informaci/i });
  if (!(await review.isEnabled())) {
    const detail = await portalMessage(page);
    return run.result('needs_action', detail || 'El portal rechazó algún dato fiscal.', 'fiscal_validation');
  }
  await review.click();
  await page.waitForURL(/#\/emision\/confirmar-datos/, { timeout: 15_000 }).catch(() => {});
  await run.step('Datos fiscales capturados; revisión abierta');
  return null;
}

async function downloadPresentedInvoice(run: AutomationRun): Promise<void> {
  const page = run.page;
  const download = page.getByRole('link', { name: /Descargar Archivos/i }).or(page.getByRole('button', { name: /Descargar archivos/i }));
  if (await download.count()) {
    await download.first().click();
    await run.step('Descarga de CFDI solicitada');
  }
  await run.waitForDownloads(10_000);
}

async function issue(run: AutomationRun): Promise<AutomationResult> {
  const page = run.page;
  await run.navigate(`${PORTAL}#/emision/servicio`);
  await page.getByRole('radio', { name: /Coordinados Primera Plus/i }).check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.waitForURL(/#\/emision\/boletos/);
  await run.step('Facturación de boletos seleccionada');

  let count = 0;
  if (run.input.ticketFiles?.length) count = await uploadTickets(run);
  if (count === 0 && run.input.tokens?.length) count = await addTokens(run, tokenList(run.input.tokens));
  if (count === 0) {
    await run.screenshot('boleto-pendiente');
    const message = await portalMessage(page);
    return run.result('needs_action', message || 'El portal no aceptó el boleto. Revisa el archivo o el token.', 'ticket_not_accepted');
  }
  await page.getByRole('checkbox', { name: /Acepto el aviso de privacidad de datos/i }).check();
  const fiscalButton = page.getByRole('button', { name: 'Datos fiscales' });
  if (!(await fiscalButton.isEnabled())) {
    await run.screenshot('boleto-pendiente');
    return run.result('needs_action', 'El portal no habilitó la captura fiscal para este boleto.', 'ticket_validation');
  }
  await fiscalButton.click();
  await page.waitForURL(/#\/emision\/datos-fiscales/, { timeout: 15_000 }).catch(() => {});
  await run.step('Captura fiscal abierta');

  const fiscalIssue = await fillFiscalData(run);
  if (fiscalIssue) return fiscalIssue;
  await run.screenshot('confirmacion');

  const reviewText = normalized(await page.locator('main').innerText());
  const expectedRfc = normalized(run.input.fiscal.rfc);
  const expectedName = normalized(run.input.fiscal.razonSocial);
  const expectedCp = normalized(run.input.fiscal.codigoPostal);
  if ((expectedRfc && !reviewText.includes(expectedRfc)) ||
      (expectedName && !reviewText.includes(expectedName)) ||
      (expectedCp && !reviewText.includes(expectedCp))) {
    return run.result('needs_action', 'Los datos mostrados por el portal no coinciden con el perfil fiscal.', 'fiscal_review_mismatch');
  }
  const submit = page.getByRole('button', { name: /Generar Factura/i });
  if (!(await run.requestHumanAction(
    'Revisa RFC, razón social y código postal. Pulsa tú mismo «Generar Factura» en la captura para enviar la solicitud y después «Continuar trámite».',
  ))) {
    return run.result('needs_action', 'La emisión requiere confirmación del usuario en el portal.', 'submission_pending');
  }
  await run.step('Confirmación de envío manual realizada por el usuario');
  await page.waitForURL(/#\/emision\/facturas-emitidas/, { timeout: 45_000 }).catch(() => {});
  if (await run.challengeVisible()) {
    if (!(await run.requestHumanAction('El portal solicita una verificación humana.'))) {
      return run.result('needs_action', 'Se necesita resolver la verificación humana en el portal.', 'captcha');
    }
  }
  await run.screenshot('resultado-emision');
  await downloadPresentedInvoice(run);
  if (run.hasVerifiedInvoice()) return run.result('completed', 'Factura emitida y archivo CFDI descargado.');
  if (await submit.isVisible().catch(() => false)) {
    return run.result('needs_action', 'El botón «Generar Factura» sigue visible; no se confirmó que el portal recibiera la solicitud.', 'submission_pending');
  }
  const message = await portalMessage(page);
  return run.result('needs_action', message || 'El portal recibió la solicitud, pero no se pudo verificar la descarga del CFDI.', 'invoice_not_downloaded');
}

async function recover(run: AutomationRun): Promise<AutomationResult> {
  const page = run.page;
  const token = tokenList(run.input.tokens)[0];
  if (!token) return run.result('needs_action', 'Se necesita el token del boleto para recuperar la factura.', 'token_missing');
  if (!run.input.fiscal.rfc?.trim()) return run.result('needs_action', 'Se necesita el RFC para recuperar la factura.', 'rfc_missing');
  await run.navigate(`${PORTAL}#/recuperacion/recuperar-cfdi`);
  await page.getByRole('radio', { name: /Coordinados Primera Plus/i }).check();
  await page.getByRole('textbox', { name: /Token del boleto/i }).fill(token);
  await page.getByRole('textbox', { name: /^RFC$/i }).fill(run.input.fiscal.rfc.trim());
  await page.getByRole('button', { name: /Buscar factura/i }).click();
  await run.step('Búsqueda de CFDI enviada');
  await page.waitForTimeout(3000);
  await run.screenshot('resultado-recuperacion');
  const download = page.getByRole('button', { name: /Descargar archivos/i });
  if (await download.count()) await download.click();
  await run.waitForDownloads(10_000);
  if (run.hasVerifiedInvoice()) return run.result('completed', 'Factura recuperada y CFDI descargado.');
  const message = await portalMessage(page);
  return run.result('needs_action', message || 'No se encontró una factura descargable para este token y RFC.', 'invoice_not_found');
}

export async function runPrimeraPlus(run: AutomationRun): Promise<AutomationResult> {
  return run.input.operation === 'recover' ? recover(run) : issue(run);
}
