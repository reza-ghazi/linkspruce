/**
 * Chrome built-in AI adapter (Prompt API, Gemini Nano, global `LanguageModel`).
 *
 * Availability is detected at runtime; hardware, browser version, model
 * download state and policy all vary. Model download requires user
 * activation, so download is started only from a dashboard click
 * (startDownload). Background work uses the model only when it reports
 * "available". This adapter never falls back to a cloud provider.
 *
 * Documented input/output languages are en, ja, es, de and fr; Persian and
 * Arabic titles may be handled less reliably on-device.
 */
import { estimateTokens, ProviderError, type AiProvider, type Availability, type GenerateRequest, type GenerateResult } from './types.ts';

/** Minimal structural type for the Prompt API surface we use. */
export interface LMSession {
  prompt(input: string, opts?: { responseConstraint?: unknown; omitResponseConstraintInput?: boolean; signal?: AbortSignal }): Promise<string>;
  clone?(opts?: { signal?: AbortSignal }): Promise<LMSession>;
  destroy(): void;
  measureContextUsage?(input: string, opts?: unknown): Promise<number>;
  contextUsage?: number;
  contextWindow?: number;
  inputUsage?: number;
  inputQuota?: number;
}

export interface LMStatic {
  availability(opts?: unknown): Promise<string>;
  create(opts?: Record<string, unknown>): Promise<LMSession>;
}

const LANG_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

export function getLanguageModel(): LMStatic | undefined {
  const g = globalThis as unknown as { LanguageModel?: LMStatic };
  return g.LanguageModel;
}

export class ChromeAiProvider implements AiProvider {
  readonly id = 'chrome-ai' as const;
  readonly kind = 'on-device' as const;
  readonly model = 'gemini-nano (Chrome built-in)';
  readonly batch = { discover: 12, classify: 10 };
  readonly contextTokens = 3500;
  private readonly lm: () => LMStatic | undefined;
  private sessions = new Map<string, LMSession>();

  constructor(lm: () => LMStatic | undefined = getLanguageModel) {
    this.lm = lm;
  }

  async availability(): Promise<Availability> {
    const LM = this.lm();
    if (!LM) return { state: 'unavailable', reason: 'This browser does not expose the Prompt API (LanguageModel).' };
    let a: string;
    try {
      a = await LM.availability(LANG_OPTS);
    } catch (e) {
      return { state: 'unavailable', reason: `Availability check failed: ${(e as Error).message?.slice(0, 120)}` };
    }
    switch (a) {
      case 'available':
      case 'readily': // older spelling
        return { state: 'available' };
      case 'downloadable':
      case 'after-download':
        return { state: 'downloadable', detail: 'The on-device model must be downloaded first (requires a click; several GB, unmetered network).' };
      case 'downloading':
        return { state: 'downloading' };
      default:
        return { state: 'unavailable', reason: 'Chrome reports the on-device model is unavailable on this device (hardware, storage, OS or policy).' };
    }
  }

  /** Must be called from a user gesture in an extension page. */
  async startDownload(onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
    const LM = this.lm();
    if (!LM) throw new ProviderError('unavailable', 'Prompt API not available', { retryable: false });
    const s = await LM.create({
      ...LANG_OPTS,
      signal,
      monitor(m: EventTarget) {
        m.addEventListener('downloadprogress', (e) => onProgress(Number((e as unknown as { loaded: number }).loaded) || 0));
      },
    });
    s.destroy();
  }

  private async session(system: string, signal?: AbortSignal): Promise<LMSession> {
    const LM = this.lm();
    if (!LM) throw new ProviderError('unavailable', 'Prompt API not available', { retryable: false });
    let base = this.sessions.get(system);
    if (!base) {
      const av = await this.availability();
      if (av.state !== 'available') throw new ProviderError('unavailable', av.state === 'unavailable' ? av.reason : `On-device model is ${av.state}.`, { retryable: false });
      base = await LM.create({ ...LANG_OPTS, initialPrompts: [{ role: 'system', content: system }], signal });
      // Keep at most two base sessions (one per task) to bound memory.
      if (this.sessions.size >= 2) {
        const [k, old] = this.sessions.entries().next().value as [string, LMSession];
        old.destroy();
        this.sessions.delete(k);
      }
      this.sessions.set(system, base);
    }
    // Clone so earlier batches don't accumulate in the context window.
    return base.clone ? base.clone({ signal }) : base;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let s: LMSession;
    try {
      s = await this.session(req.system, req.signal);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('unavailable', `Could not start the on-device model: ${(e as Error).message?.slice(0, 120)}`);
    }
    let text: string;
    try {
      text = await s.prompt(req.prompt, { responseConstraint: req.schema, omitResponseConstraintInput: false, signal: req.signal });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (req.signal?.aborted || name === 'AbortError') throw new ProviderError('aborted', 'Cancelled', { retryable: false });
      if (name === 'QuotaExceededError') throw new ProviderError('context-overflow', 'Batch too large for the on-device context window.', { retryable: false });
      if (name === 'NotSupportedError') throw new ProviderError('unavailable', 'The on-device model does not support this request.', { retryable: false });
      throw new ProviderError('server', `On-device model error: ${(e as Error).message?.slice(0, 120)}`);
    } finally {
      if (s !== this.sessions.get(req.system)) s.destroy();
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError('malformed', 'On-device model returned invalid JSON.');
    }
    return { data, usage: { inputTokens: estimateTokens(req.system + req.prompt), outputTokens: estimateTokens(text), estimated: true } };
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.destroy();
    this.sessions.clear();
  }
}
