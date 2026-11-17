export interface FiscalData {
  rfc: string;
  razonSocial: string;
  codigoPostal: string;
  regimenFiscal: string;
  usoCfdi: string;
  email: string;
  domicilio?: string;
  estado?: string;
  ciudad?: string;
  colonia?: string;
  calle?: string;
  numeroExterior?: string;
  numeroInterior?: string;
}

export interface InvoiceAutomationInput {
  /** Omit for the current Primera Plus / Grupo Flecha Amarilla portal. */
  portalUrl?: string;
  provider?: 'primera_plus' | 'oxxo' | 'alsea' | 'la_comer' | 'generic';
  operation?: 'issue' | 'recover';
  ticketFiles?: string[];
  /** Reviewed ticket facts. Only known fields are offered to the browser planner. */
  ticketData?: Record<string, string | number | null>;
  csfFile?: string;
  tokens?: string[];
  fiscal: FiscalData;
  outputDir: string;
  /** Required for portals using the adaptive browser planner. Never logged here. */
  apiKey?: string;
  model?: string;
  /** Extra public HTTPS hosts that an unfamiliar portal may redirect to. */
  allowedHosts?: string[];
  maxSteps?: number;
  navigationTimeoutMs?: number;
  humanActionTimeoutMs?: number;
  browser?: {
    headless?: boolean;
    executablePath?: string;
    /** Chrome DevTools Protocol endpoint of an existing Chromium instance. */
    cdpEndpoint?: string;
  };
}

export interface PortalExploreInput {
  portalUrl: string;
  outputDir: string;
  allowedHosts?: string[];
  browser?: InvoiceAutomationInput['browser'];
}

export interface PortalExploration {
  portalUrl: string;
  fields: { label: string; type: string; required: boolean; options: string[] }[];
  contactEmails: { address: string; label: string }[];
  notes: string[];
  screenshot?: string;
}

export type AutomationStatus = 'completed' | 'needs_action' | 'failed';

export interface InvoiceDownload {
  path: string;
  filename: string;
  kind: 'pdf' | 'xml' | 'zip' | 'other';
  valid: boolean;
}

export interface AutomationEvent {
  type: 'started' | 'navigated' | 'step' | 'screenshot' | 'download' | 'human_action' | 'finished' | 'error';
  at: string;
  message: string;
  path?: string;
  url?: string;
}

export interface AutomationResult {
  status: AutomationStatus;
  reason?: string;
  message: string;
  portalUrl: string;
  screenshots: string[];
  downloads: InvoiceDownload[];
  steps: string[];
}

/**
 * This session is live only while `runInvoiceAutomation` is waiting. A caller may
 * expose these methods behind an authenticated API to let the account owner solve
 * an unexpected challenge by viewing and clicking the browser screenshot.
 */
export interface HumanActionSession {
  screenshot(): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  pageUrl(): string;
  continue(): void;
  cancel(): void;
}

export interface AutomationHooks {
  onEvent?: (event: AutomationEvent) => void | Promise<void>;
  onHumanAction?: (session: HumanActionSession) => void | Promise<void>;
}
