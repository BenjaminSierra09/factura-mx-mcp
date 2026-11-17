import fs from 'node:fs';
import * as z from 'zod/v4';
import { config } from './config.js';

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
// Google's published v2 test keys always verify successfully and must never guard a public site.
const googleTestSiteKey = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
const googleTestSecretKey = '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';
const siteKey = process.env.RECAPTCHA_SITE_KEY?.trim() || '';
const secretFile = process.env.RECAPTCHA_SECRET_KEY_FILE?.trim();
const directSecret = process.env.RECAPTCHA_SECRET_KEY?.trim();

if (secretFile && directSecret) throw new Error('Configura sólo una fuente para RECAPTCHA_SECRET_KEY');
const secretKey = secretFile ? fs.readFileSync(secretFile, 'utf8').trim() : directSecret || '';

export const recaptchaSiteKey: string | null = siteKey || null;

export function needsRecaptcha(publicOrigin: string, allowedHosts: readonly string[]): boolean {
  const publicOriginHost = publicOrigin ? new URL(publicOrigin).hostname.toLowerCase() : null;
  return (publicOriginHost !== null && !localHosts.has(publicOriginHost)) ||
    allowedHosts.some(host => !localHosts.has(host.toLowerCase()));
}

export function validateRecaptchaConfiguration(
  configuredSiteKey: string,
  configuredSecretKey: string,
  publicOrigin: string,
  allowedHosts: readonly string[],
): void {
  const hasSiteKey = Boolean(configuredSiteKey);
  const hasSecretKey = Boolean(configuredSecretKey);
  if (hasSiteKey !== hasSecretKey) {
    throw new Error('Configura RECAPTCHA_SITE_KEY y RECAPTCHA_SECRET_KEY juntos');
  }
  const publicDeployment = needsRecaptcha(publicOrigin, allowedHosts);
  if (publicDeployment && !hasSiteKey) {
    throw new Error('Un despliegue público requiere RECAPTCHA_SITE_KEY y RECAPTCHA_SECRET_KEY');
  }
  if (publicDeployment &&
      (configuredSiteKey === googleTestSiteKey || configuredSecretKey === googleTestSecretKey)) {
    throw new Error('Las claves de prueba de reCAPTCHA no se permiten en un despliegue público');
  }
}

export function assertRecaptchaConfiguration(): void {
  validateRecaptchaConfiguration(siteKey, secretKey, config.publicOrigin, config.allowedHosts);
}

const verificationSchema = z.object({ success: z.boolean(), hostname: z.string().optional() });
export type RecaptchaResult = 'valid' | 'invalid' | 'unavailable';

/** Verify a single-use v2 checkbox token with Google and bind it to this request's host. */
export async function verifyRecaptchaToken(
  token: string | undefined,
  requestHostname: string,
  options: { secret?: string; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> } = {},
): Promise<RecaptchaResult> {
  if (!token || !token.trim() || token.length > 4096) return 'invalid';
  const secret = options.secret ?? secretKey;
  if (!secret) return 'unavailable';
  try {
    const response = await (options.fetchImpl ?? fetch)('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return 'unavailable';
    const parsed = verificationSchema.safeParse(await response.json());
    if (!parsed.success) return 'unavailable';
    // Google's public test secret reports testkey.google.com even on localhost.
    // Public origins cannot start with this secret (see validateRecaptchaConfiguration).
    const testKeyOnLocalhost = secret === googleTestSecretKey && localHosts.has(requestHostname.toLowerCase()) &&
      parsed.data.hostname?.toLowerCase() === 'testkey.google.com';
    return parsed.data.success && (parsed.data.hostname?.toLowerCase() === requestHostname.toLowerCase() || testKeyOnLocalhost)
      ? 'valid' : 'invalid';
  } catch (error) {
    console.error('No se pudo verificar reCAPTCHA', { type: error instanceof Error ? error.name : typeof error });
    return 'unavailable';
  }
}
