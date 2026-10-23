/** Provider-neutral structured-generation interface. Providers return data only. */

export type JsonSchema = Record<string, unknown>;

export interface GenerateRequest {
  /** Stable task name for logs/usage (never includes user data). */
  task: 'discover' | 'synthesize' | 'classify' | 'autofile';
  system: string;
  prompt: string;
  schema: JsonSchema;
  maxOutputTokens: number;
  signal?: AbortSignal | undefined;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** True when counts are local estimates rather than provider-reported. */
  estimated: boolean;
}

export interface GenerateResult {
  data: unknown;
  usage: Usage;
}

/**
 * 'auto' = free on-device AI (Chrome built-in) when it is ready, otherwise
 * offline rules. It never selects a cloud provider.
 */
export type ProviderId = 'auto' | 'rules' | 'chrome-ai' | 'gemini';

export type Availability =
  | { state: 'available' }
  | { state: 'downloadable'; detail?: string }
  | { state: 'downloading'; progress?: number }
  | { state: 'unavailable'; reason: string }
  | { state: 'needs-key' }
  | { state: 'needs-permission'; origins: string[] }
  | { state: 'needs-consent' };

export interface AiProvider {
  readonly id: Exclude<ProviderId, 'rules' | 'auto'>;
  readonly kind: 'on-device' | 'cloud';
  readonly model: string;
  /** Items per request for each task (bounded context windows). */
  readonly batch: { discover: number; classify: number };
  /** Rough input-token budget per request. */
  readonly contextTokens: number;
  availability(): Promise<Availability>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export type ProviderErrorKind =
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'invalid-request'
  | 'model-not-found'
  | 'server'
  | 'network'
  | 'timeout'
  | 'blocked'
  | 'malformed'
  | 'unavailable'
  | 'aborted'
  | 'context-overflow';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
  readonly status?: number | undefined;
  constructor(kind: ProviderErrorKind, message: string, opts: { retryable?: boolean; retryAfterMs?: number | undefined; status?: number | undefined } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = opts.retryable ?? (kind === 'rate-limit' || kind === 'server' || kind === 'network' || kind === 'timeout' || kind === 'malformed');
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
  }
}

/**
 * Local token estimate. Latin text averages ~4 chars/token; Arabic-script
 * and other non-Latin text tokenizes more densely, so use ~2.5. This is an
 * estimate with roughly ±40% uncertainty.
 */
export function estimateTokens(text: string): number {
  let latin = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x250) latin++;
    else other++;
  }
  return Math.ceil(latin / 4 + other / 2.5);
}
