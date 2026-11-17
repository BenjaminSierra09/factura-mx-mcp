import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, chmod, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { isIP, BlockList } from 'node:net';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  AutomationHooks,
  AutomationResult,
  HumanActionSession,
  InvoiceAutomationInput,
  InvoiceDownload,
} from './types.js';

const blockedIps = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedIps.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8],
] as const) blockedIps.addSubnet(address, prefix, 'ipv6');

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return true;
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) {
    return isPrivateAddress(address.slice(7));
  }
  return blockedIps.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export async function validatePublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('La URL del portal no es válida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('El portal debe usar HTTPS sin credenciales ni puerto personalizado.');
  }
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('No se permiten portales internos o locales.');
  }
  if (isIP(host)) {
    throw new Error('Use el dominio público del portal, no una dirección IP.');
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('El dominio del portal resuelve a una red privada.');
  }
  return url;
}

async function inspectDownload(filePath: string): Promise<InvoiceDownload['kind'] | null> {
  if ((await stat(filePath)).size > 30 * 1024 * 1024) return null;
  const content = await readFile(filePath);
  if (content.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (content.subarray(0, 4).toString('hex') === '504b0304') return 'zip';
  const text = content.subarray(0, Math.min(content.length, 50_000)).toString('utf8');
  if (/<(?:\w+:)?Comprobante\b/.test(text) && /cfdi|http:\/\/www\.sat\.gob\.mx\/cfd/i.test(text)) return 'xml';
  return null;
}

/** Extract only invoice file types from a modest ZIP; never trust archive paths. */
export async function extractInvoicesFromZip(zipPath: string, outputDir: string): Promise<InvoiceDownload[]> {
  if ((await stat(zipPath)).size > 30 * 1024 * 1024) return [];
  const archive = await readFile(zipPath);
  if (archive.length > 30 * 1024 * 1024) return [];
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) return [];
  const entries = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const files: InvoiceDownload[] = [];
  let totalExpanded = 0;
  for (let index = 0; index < Math.min(entries, 100); index++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const originalName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    const basename = path.basename(originalName.replaceAll('\\', '/'));
    const extension = path.extname(basename).toLowerCase();
    if (!basename || !['.pdf', '.xml'].includes(extension) || ![0, 8].includes(method) ||
        uncompressedSize > 15 * 1024 * 1024 || totalExpanded + uncompressedSize > 50 * 1024 * 1024) continue;
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const dataOffset = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > archive.length) continue;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    let content: Buffer;
    try { content = method === 8 ? inflateRawSync(compressed, { maxOutputLength: 15 * 1024 * 1024 }) : compressed; }
    catch { continue; }
    if (content.length !== uncompressedSize) continue;
    totalExpanded += content.length;
    const safeName = basename.replace(/[^\w.()-]/g, '_').slice(0, 100);
    const filePath = path.join(outputDir, `${randomUUID()}-${safeName}`);
    await writeFile(filePath, content, { mode: 0o600 });
    const actualKind = await inspectDownload(filePath);
    const expectedKind = extension === '.pdf' ? 'pdf' : 'xml';
    files.push({ path: filePath, filename: basename, kind: expectedKind, valid: actualKind === expectedKind });
  }
  return files;
}

export class AutomationRun {
  readonly input: InvoiceAutomationInput;
  readonly hooks: AutomationHooks;
  readonly portalUrl: string;
  readonly screenshots: string[] = [];
  readonly downloads: InvoiceDownload[] = [];
  readonly steps: string[] = [];
  readonly allowedHosts: Set<string>;
  blockedNavigationHost: string | null = null;
  pendingHostReview: { host: string; url: string } | null = null;
  sensitiveDataEntered = false;
  lastHttpStatus: number | null = null;
  private dynamicHostCount = 0;
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;
  private downloadTasks: Promise<void>[] = [];

  constructor(input: InvoiceAutomationInput, hooks: AutomationHooks, portalUrl: string) {
    this.input = input;
    this.hooks = hooks;
    this.portalUrl = portalUrl;
    this.allowedHosts = new Set([new URL(portalUrl).hostname.toLowerCase(), ...(input.allowedHosts ?? []).map((s) => s.toLowerCase())]);
  }

  approvePublicHost(host: string): boolean {
    const hostname = host.toLowerCase();
    if (this.allowedHosts.has(hostname)) return true;
    if (this.dynamicHostCount >= 4) return false;
    this.allowedHosts.add(hostname);
    this.dynamicHostCount++;
    return true;
  }

  stageHostReview(sourceAllowed: boolean, url: URL): boolean {
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        this.input.provider === 'primera_plus' || !sourceAllowed || this.sensitiveDataEntered ||
        this.allowedHosts.has(host) || this.dynamicHostCount >= 4) return false;
    this.pendingHostReview = { host, url: url.toString() };
    return true;
  }

  approveReviewedHost(review: { host: string; url: string }): boolean {
    if (this.pendingHostReview !== review || this.sensitiveDataEntered) return false;
    if (!this.approvePublicHost(review.host)) return false;
    this.pendingHostReview = null;
    return true;
  }

  async start(): Promise<void> {
    await mkdir(this.input.outputDir, { recursive: true, mode: 0o700 });
    await chmod(this.input.outputDir, 0o700);
    if (this.input.browser?.cdpEndpoint) {
      this.browser = await chromium.connectOverCDP(this.input.browser.cdpEndpoint);
    } else {
      this.browser = await chromium.launch({
        headless: this.input.browser?.headless ?? true,
        executablePath: this.input.browser?.executablePath,
        chromiumSandbox: process.platform === 'linux' && process.env.CHROMIUM_SANDBOX !== 'false',
      });
    }
    this.context = await this.browser.newContext({
      acceptDownloads: true,
      locale: 'es-MX',
      viewport: { width: 1280, height: 900 },
      serviceWorkers: 'block',
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15_000);
    this.page.setDefaultNavigationTimeout(this.input.navigationTimeoutMs ?? 30_000);
    await this.context.route('**/*', async (route) => {
      const request = route.request();
      let mainNavigation = request.isNavigationRequest();
      try { mainNavigation &&= request.frame() === request.frame().page().mainFrame(); }
      catch { /* initial navigation or popup: retain navigation protection */ }
      const rawUrl = request.url();
      if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl === 'about:blank') {
        await route.continue();
        return;
      }
      let url: URL;
      try {
        url = await validatePublicHttpsUrl(rawUrl);
      } catch {
        await route.abort();
        await this.emit('error', 'Recurso de red no público bloqueado');
        return;
      }
      if (mainNavigation) {
        const officialDownload = this.input.provider === 'primera_plus' && /\.(?:pdf|xml|zip)$/i.test(url.pathname);
        if (!this.allowedHosts.has(url.hostname.toLowerCase()) && !officialDownload) {
          let sourceAllowed = false;
          try {
            const previous = request.redirectedFrom()?.url() ?? request.frame().url();
            sourceAllowed = this.allowedHosts.has(new URL(previous).hostname.toLowerCase());
          } catch { /* initial navigation */ }
          if (this.stageHostReview(sourceAllowed, url)) {
            await route.abort();
            await this.emit('step', `El portal solicita revisar el nuevo dominio público ${url.hostname}`);
            return;
          } else {
            this.blockedNavigationHost = url.hostname.toLowerCase();
            await route.abort();
            await this.emit('error', `Navegación bloqueada a ${url.hostname}`);
            return;
          }
        }
      }
      await route.continue();
    });
    const attachDownloadHandler = (downloadPage: Page) => downloadPage.on('download', (download) => {
      const task = (async () => {
        const suggested = path.basename(download.suggestedFilename()).replace(/[^\w.()-]/g, '_').slice(0, 100);
        const filename = `${randomUUID()}-${suggested || 'archivo'}`;
        const filePath = path.join(this.input.outputDir, filename);
        await download.saveAs(filePath);
        if ((await stat(filePath)).size > 30 * 1024 * 1024) {
          await rm(filePath, { force: true });
          await this.emit('error', 'La descarga supera el límite de 30 MB');
          return;
        }
        await chmod(filePath, 0o600);
        const actualKind = await inspectDownload(filePath);
        const extension = path.extname(suggested).toLowerCase();
        const kind = actualKind ?? (extension === '.pdf' ? 'pdf' : extension === '.xml' ? 'xml' : extension === '.zip' ? 'zip' : 'other');
        const valid = actualKind !== null && actualKind === kind;
        this.downloads.push({ path: filePath, filename: suggested, kind, valid });
        await this.emit('download', valid ? `Archivo ${kind.toUpperCase()} descargado` : 'Descarga recibida sin formato de factura verificable', filePath);
        if (actualKind === 'zip') {
          for (const invoice of await extractInvoicesFromZip(filePath, this.input.outputDir)) {
            this.downloads.push(invoice);
            await this.emit('download', invoice.valid ? `Factura ${invoice.kind.toUpperCase()} extraída` : 'Archivo de ZIP sin formato de factura verificable', invoice.path);
          }
        }
      })().catch(async (error: unknown) => {
        console.error('No se pudo guardar una descarga del navegador', { type: error instanceof Error ? error.name : typeof error });
        await this.emit('error', 'No se pudo guardar una descarga del portal.');
      });
      this.downloadTasks.push(task);
    });
    this.context.on('page', (newPage) => {
      attachDownloadHandler(newPage);
      void newPage.waitForLoadState('domcontentloaded', { timeout: 15_000 }).then(async () => {
        const host = new URL(newPage.url()).hostname.toLowerCase();
        if (this.allowedHosts.has(host)) {
          this.page = newPage;
          this.page.setDefaultTimeout(15_000);
          this.page.setDefaultNavigationTimeout(this.input.navigationTimeoutMs ?? 30_000);
          await this.emit('navigated', `Ventana del portal abierta: ${host}`, undefined, newPage.url());
        }
      }).catch(() => {});
    });
    attachDownloadHandler(this.page);
    await this.emit('started', 'Navegador iniciado');
  }

  async navigate(url: string): Promise<void> {
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    this.lastHttpStatus = response?.status() ?? null;
    await this.emit('navigated', 'Portal abierto', undefined, this.page.url());
  }

  async step(message: string): Promise<void> {
    this.steps.push(message);
    await this.emit('step', message);
  }

  async screenshot(label: string): Promise<string> {
    const filename = `${String(this.screenshots.length + 1).padStart(2, '0')}-${label.replace(/[^a-z0-9_-]/gi, '-')}.png`;
    const filePath = path.join(this.input.outputDir, filename);
    await this.page.screenshot({ path: filePath, fullPage: true });
    await chmod(filePath, 0o600);
    this.screenshots.push(filePath);
    await this.emit('screenshot', label, filePath);
    return filePath;
  }

  async waitForDownloads(timeoutMs = 12_000): Promise<void> {
    await this.page.waitForTimeout(timeoutMs).catch(() => {});
    await Promise.all(this.downloadTasks);
  }

  hasVerifiedInvoice(): boolean {
    return this.downloads.some((file) => file.valid && (file.kind === 'pdf' || file.kind === 'xml'));
  }

  async challengeVisible(): Promise<boolean> {
    return this.page.evaluate(() => {
      const text = (document.body?.innerText ?? '').toLowerCase();
      const challengeText = /(?:no soy un robot|i'm not a robot|verifica que eres humano|resuelve (?:el )?captcha|complete (?:the )?captcha)/i.test(text);
      const frame = [...document.querySelectorAll('iframe')].some((el) => {
        const rectangle = el.getBoundingClientRect();
        return /recaptcha|hcaptcha|turnstile/i.test(el.src) && !/size=invisible/i.test(el.src) &&
          rectangle.width >= 100 && rectangle.height >= 60 && getComputedStyle(el).visibility !== 'hidden';
      });
      return challengeText || frame;
    });
  }

  async requestHumanAction(reason: string, readOnly = false): Promise<boolean> {
    await this.screenshot('accion-humana');
    await this.emit('human_action', reason);
    if (!this.hooks.onHumanAction) return false;

    let resolveDecision!: (value: boolean) => void;
    const decision = new Promise<boolean>((resolve) => { resolveDecision = resolve; });
    let active = true;
    const session: HumanActionSession = {
      screenshot: async () => {
        if (!active) throw new Error('La sesión ya terminó.');
        return this.page.screenshot({ type: 'png' });
      },
      click: async (x, y) => {
        if (!active) throw new Error('La sesión ya terminó.');
        if (readOnly) throw new Error('Durante la revisión del dominio sólo se puede continuar o cancelar.');
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1280 || y > 900) throw new Error('Coordenadas fuera del navegador.');
        await this.page.mouse.click(x, y);
      },
      type: async (value) => {
        if (!active) throw new Error('La sesión ya terminó.');
        if (readOnly) throw new Error('Durante la revisión del dominio sólo se puede continuar o cancelar.');
        if (value.length > 2000) throw new Error('Texto demasiado largo.');
        if (value.length) this.sensitiveDataEntered = true;
        await this.page.keyboard.type(value);
      },
      press: async (key) => {
        if (!active) throw new Error('La sesión ya terminó.');
        if (readOnly) throw new Error('Durante la revisión del dominio sólo se puede continuar o cancelar.');
        if (!/^[a-zA-Z0-9+ -]{1,32}$/.test(key)) throw new Error('Tecla no permitida.');
        await this.page.keyboard.press(key);
      },
      pageUrl: () => this.page.url(),
      continue: () => resolveDecision(true),
      cancel: () => resolveDecision(false),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      void Promise.resolve().then(() => this.hooks.onHumanAction?.(session)).catch(() => resolveDecision(false));
      const timeout = Math.min(Math.max(this.input.humanActionTimeoutMs ?? 600_000, 1000), 3_600_000);
      return await Promise.race([decision, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeout); })]);
    } finally {
      if (timer) clearTimeout(timer);
      active = false;
    }
  }

  result(status: AutomationResult['status'], message: string, reason?: string): AutomationResult {
    return { status, message, reason, portalUrl: this.page?.url() ?? this.portalUrl, screenshots: this.screenshots, downloads: this.downloads, steps: this.steps };
  }

  async finish(result: AutomationResult): Promise<AutomationResult> {
    await Promise.all(this.downloadTasks);
    await this.emit('finished', result.message);
    return result;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  private async emit(type: Parameters<NonNullable<AutomationHooks['onEvent']>>[0]['type'], message: string, filePath?: string, url?: string): Promise<void> {
    try { await this.hooks.onEvent?.({ type, at: new Date().toISOString(), message, path: filePath, url }); }
    catch { /* reporting must not interrupt invoicing */ }
  }
}
