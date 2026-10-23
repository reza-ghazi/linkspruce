/**
 * Gemini API adapter (bring-your-own-key, opt-in).
 *
 * Default style: the Interactions API (POST /v1beta/interactions), which
 * the Gemini structured-output docs use (checked 2026-10-22), with
 * response_format JSON schema, thinking_level "minimal" and store:false.
 * Alternate style: models/{model}:generateContent with responseMimeType +
 * responseSchema. The model, style and endpoint are settings, not constants
 * buried in code.
 *
 * The key is passed per call from session storage (or opt-in local
 * storage) and is never logged, persisted here, or included in errors.
 */
import type { FetchLike } from '../platform.ts';
import { parseModelJson } from './validate.ts';
import { estimateTokens, ProviderError, type AiProvider, type Availability, type GenerateRequest, type GenerateResult, type JsonSchema } from './types.ts';

export type GeminiApiStyle = 'interactions' | 'generateContent';

export interface GeminiConfig {
  model: string;
  apiStyle: GeminiApiStyle;
  endpointBase: string;
  timeoutMs: number;
  batchClassify: number;
  batchDiscover: number;
}

export const DEFAULT_GEMINI: GeminiConfig = {
  model: 'gemini-3.5-flash-lite',
  apiStyle: 'interactions',
  endpointBase: 'https://generativelanguage.googleapis.com/v1beta',
  timeoutMs: 60_000,
  batchClassify: 60,
  batchDiscover: 80,
};

export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com/*';

/** Gemini model ids look like "gemini-3.5-flash-lite"; reject anything else so it can't alter the URL path. */
export function validModelId(model: string): boolean {
  return /^[a-z0-9][a-z0-9.\-]{2,63}$/.test(model);
}

/** Convert a JSON-Schema subset to the OpenAPI-style schema generateContent accepts. */
export function toOpenApiSchema(s: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  let type = s.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');
    if (type.includes('null')) out.nullable = true;
    type = nonNull[0];
  }
  if (typeof type === 'string') out.type = type.toUpperCase();
  if (s.enum) out.enum = s.enum;
  if (s.maxItems !== undefined) out.maxItems = s.maxItems;
  if (s.required) out.required = s.required;
  if (s.items) out.items = toOpenApiSchema(s.items as JsonSchema);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, JsonSchema>).map(([k, v]) => [k, toOpenApiSchema(v)]));
  }
  return out;
}

function parseRetryDelay(body: unknown, header: string | null): number | undefined {
  if (header && /^\d+$/.test(header)) return Number(header) * 1000;
  const details = (body as { error?: { details?: Array<Record<string, unknown>> } })?.error?.details ?? [];
  for (const d of details) {
    const rd = d.retryDelay;
    if (typeof rd === 'string') {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(rd);
      if (m) return Math.round(Number(m[1]) * 1000);
    }
  }
  return undefined;
}

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini' as const;
  readonly kind = 'cloud' as const;
  readonly cfg: GeminiConfig;
  private readonly fetchFn: FetchLike;
  private readonly getKey: () => Promise<string | undefined>;
  private readonly hasPermission: () => Promise<boolean>;

  constructor(fetchFn: FetchLike, getKey: () => Promise<string | undefined>, cfg: Partial<GeminiConfig> = {}, hasPermission: () => Promise<boolean> = async () => true) {
    this.fetchFn = fetchFn;
    this.getKey = getKey;
    this.hasPermission = hasPermission;
    this.cfg = { ...DEFAULT_GEMINI, ...cfg };
    if (!validModelId(this.cfg.model)) throw new ProviderError('invalid-request', 'Invalid model id');
    if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1(beta)?$/.test(this.cfg.endpointBase)) {
      throw new ProviderError('invalid-request', 'Endpoint must be the Gemini API at generativelanguage.googleapis.com');
    }
  }

  get model(): string {
    return this.cfg.model;
  }
  get batch() {
    return { discover: this.cfg.batchDiscover, classify: this.cfg.batchClassify };
  }
  get contextTokens(): number {
    return 200_000;
  }

  async availability(): Promise<Availability> {
    if (!(await this.getKey())) return { state: 'needs-key' };
    if (!(await this.hasPermission())) return { state: 'needs-permission', origins: [GEMINI_ORIGIN] };
    return { state: 'available' };
  }

  private body(req: GenerateRequest): { url: string; body: unknown } {
    if (this.cfg.apiStyle === 'interactions') {
      return {
        url: `${this.cfg.endpointBase}/interactions`,
        body: {
          model: this.cfg.model,
          system_instruction: req.system,
          input: req.prompt,
          response_format: { type: 'text', mime_type: 'application/json', schema: req.schema },
          generation_config: { max_output_tokens: req.maxOutputTokens, thinking_level: 'minimal' },
          store: false,
        },
      };
    }
    return {
      url: `${this.cfg.endpointBase}/models/${encodeURIComponent(this.cfg.model)}:generateContent`,
      body: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toOpenApiSchema(req.schema),
          maxOutputTokens: req.maxOutputTokens,
          temperature: 0.1,
        },
      },
    };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const key = await this.getKey();
    if (!key) throw new ProviderError('auth', 'No Gemini API key is set for this session.', { retryable: false });
    const { url, body } = this.body(req);
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.cfg.timeoutMs);
    const onAbort = () => ctrl.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: ctrl.signal,
      });
    } catch {
      if (req.signal?.aborted) throw new ProviderError('aborted', 'Cancelled', { retryable: false });
      if (timedOut) throw new ProviderError('timeout', `Gemini did not respond within ${this.cfg.timeoutMs / 1000}s`);
      throw new ProviderError('network', 'Could not reach the Gemini API (offline, blocked, or missing host permission).');
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
    let json: unknown;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) throw this.httpError(res.status, json, res.headers.get('retry-after'));
    return this.parse(json, req);
  }

  private httpError(status: number, body: unknown, retryAfter: string | null): ProviderError {
    const err = (body as { error?: { message?: string; status?: string } })?.error;
    // Never echo full messages that could contain request echoes; keep a short, key-free summary.
    const msg = (err?.message ?? '').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]').slice(0, 200);
    const st = err?.status ?? '';
    const retryAfterMs = parseRetryDelay(body, retryAfter);
    if (status === 400 && /api key|API_KEY/i.test(`${msg} ${st}`)) return new ProviderError('auth', 'The Gemini API key was rejected.', { status, retryable: false });
    if (status === 401 || status === 403) return new ProviderError('auth', `Gemini refused the request (${st || status}). Check the key and that the Gemini API is enabled for it.`, { status, retryable: false });
    if (status === 404) return new ProviderError('model-not-found', `Model "${this.cfg.model}" or endpoint not found. Choose a currently documented model in Settings.`, { status, retryable: false });
    if (status === 429) {
      const quota = /quota|exhaust/i.test(msg) && !/rate/i.test(msg);
      return new ProviderError(quota ? 'quota' : 'rate-limit', quota ? 'Gemini quota exhausted for this key.' : 'Gemini rate limit reached; will retry later.', { status, retryAfterMs, retryable: !quota || retryAfterMs !== undefined });
    }
    if (status >= 500) return new ProviderError('server', `Gemini server error ${status}.`, { status, retryAfterMs });
    return new ProviderError('invalid-request', `Gemini rejected the request (${status}${st ? ` ${st}` : ''}): ${msg}`, { status, retryable: false });
  }

  private parse(json: unknown, req: GenerateRequest): GenerateResult {
    const j = json as Record<string, unknown>;
    let text: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    if (this.cfg.apiStyle === 'interactions') {
      if (j.status === 'failed' || j.status === 'cancelled') {
        const e = (j.errors as Array<{ message?: string }> | undefined)?.[0]?.message ?? String(j.status);
        throw new ProviderError('server', `Gemini interaction ${String(j.status)}: ${e.slice(0, 160)}`);
      }
      const steps = (j.steps as Array<Record<string, unknown>> | undefined) ?? [];
      const outputs = (j.outputs as Array<Record<string, unknown>> | undefined) ?? [];
      const texts: string[] = [];
      for (const s of steps) {
        if (s.type !== 'model_output') continue;
        for (const c of (s.content as Array<Record<string, unknown>> | undefined) ?? []) if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
      }
      for (const o of outputs) if (o.type === 'text' && typeof o.text === 'string') texts.push(o.text);
      text = texts.join('');
      const u = j.usage as Record<string, number> | undefined;
      if (u) {
        inputTokens = u.total_input_tokens;
        outputTokens = (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0);
      }
      if (j.status === 'incomplete' && !text) throw new ProviderError('context-overflow', 'Gemini stopped before producing output (max tokens).');
    } else {
      const cands = (j.candidates as Array<Record<string, unknown>> | undefined) ?? [];
      const block = (j.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
      if (block) throw new ProviderError('blocked', `Gemini blocked the prompt (${block}).`, { retryable: false });
      const c0 = cands[0];
      const finish = c0?.finishReason as string | undefined;
      if (finish && !['STOP', 'MAX_TOKENS'].includes(finish)) throw new ProviderError('blocked', `Gemini stopped: ${finish}`, { retryable: false });
      const parts = ((c0?.content as { parts?: Array<{ text?: string; thought?: boolean }> } | undefined)?.parts ?? []).filter((p) => !p.thought);
      text = parts.map((p) => p.text ?? '').join('');
      const um = j.usageMetadata as Record<string, number> | undefined;
      if (um) {
        inputTokens = um.promptTokenCount;
        outputTokens = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
      }
      if (finish === 'MAX_TOKENS' && !text) throw new ProviderError('context-overflow', 'Gemini hit the output token limit.');
    }
    if (!text) throw new ProviderError('malformed', 'Gemini returned no text.');
    let data: unknown;
    try {
      data = parseModelJson(text);
    } catch {
      throw new ProviderError('malformed', 'Gemini returned invalid JSON.');
    }
    const estimated = inputTokens === undefined || outputTokens === undefined;
    return {
      data,
      usage: {
        inputTokens: inputTokens ?? estimateTokens(req.system + req.prompt + JSON.stringify(req.schema)),
        outputTokens: outputTokens ?? estimateTokens(text),
        estimated,
      },
    };
  }
}
