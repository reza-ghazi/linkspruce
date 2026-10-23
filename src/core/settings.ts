/** Versioned user settings with defaults and forward migration. */
import { DEFAULT_BUDGET, type Budget } from './ai/budget.ts';
import { DEFAULT_GEMINI, type GeminiApiStyle } from './ai/gemini.ts';
import type { DataPolicy } from './ai/pipeline.ts';
import type { ProviderId } from './ai/types.ts';
import type { Band } from './classify/classifier.ts';
import type { KeepPolicy } from './duplicates.ts';
import type { GranularityPreset, LabelLanguage, TaxonomyMode } from './taxonomy/taxonomy.ts';

export const SETTINGS_VERSION = 1;

export interface Settings {
  v: number;
  onboarded: boolean;
  /** Destination for generated folders (a writable folder id); null until chosen. */
  destinationRootId: string | null;
  rootFolderName: string;
  protectedFolderIds: string[];
  /** Folders excluded from AI processing (local rules still allowed). */
  aiExcludedFolderIds: string[];
  labelLanguage: LabelLanguage;
  taxonomyMode: TaxonomyMode;
  granularity: GranularityPreset;
  includeBands: Band[];
  keepPolicy: KeepPolicy;

  audit: {
    timeoutMs: number;
    maxConcurrent: number;
    maxPerOrigin: number;
    originSpacingMs: number;
    maxAttempts: number;
    freshnessDays: number;
    fetchMetadata: boolean;
    exclusions: string[];
    skipSensitive: boolean;
    /** Minimum minutes between two not-found observations before cleanup is offered. */
    notFoundRecheckMinutes: number;
  };

  ai: {
    provider: ProviderId;
    /** Separate explicit consent for cloud transmission (Gemini). */
    cloudConsentAt: number | null;
    gemini: { model: string; apiStyle: GeminiApiStyle; persistKey: boolean };
    dataPolicy: DataPolicy;
    budget: Budget;
    /** Classify only items the offline rules are unsure about. */
    scope: 'uncertain' | 'all';
    sampleSize: number;
  };

  autoFile: {
    enabled: boolean;
    paused: boolean;
    activatedAt: number | null;
    provider: ProviderId;
    settleSeconds: number;
    minBand: Band;
    allowNewCategories: boolean;
    allowNewTopLevel: boolean;
    maxNewCategoriesPerDay: number;
    burstThreshold: number;
    burstWindowSeconds: number;
    /** What to do with bookmarks that look like sync arrivals (old dateAdded). */
    syncedArrivals: 'review' | 'file';
    fetchMetadataForWeakTitles: boolean;
    maxCloudRequestsPerDay: number;
  };

  ui: { theme: 'system' | 'light' | 'dark'; pageSize: number };
}

export function defaultSettings(): Settings {
  return {
    v: SETTINGS_VERSION,
    onboarded: false,
    destinationRootId: null,
    rootFolderName: 'LinkSpruce',
    protectedFolderIds: [],
    aiExcludedFolderIds: [],
    labelLanguage: 'en',
    taxonomyMode: 'discover',
    granularity: 'balanced',
    includeBands: ['high', 'medium'],
    keepPolicy: 'oldest',
    audit: {
      timeoutMs: 15_000,
      maxConcurrent: 4,
      maxPerOrigin: 1,
      originSpacingMs: 1500,
      maxAttempts: 3,
      freshnessDays: 14,
      fetchMetadata: true,
      exclusions: [],
      skipSensitive: true,
      notFoundRecheckMinutes: 60,
    },
    ai: {
      provider: 'auto',
      cloudConsentAt: null,
      gemini: { model: DEFAULT_GEMINI.model, apiStyle: DEFAULT_GEMINI.apiStyle, persistKey: false },
      dataPolicy: { includePath: true, includeFolderHints: false, includeMetadata: false },
      budget: { ...DEFAULT_BUDGET },
      scope: 'uncertain',
      sampleSize: 1200,
    },
    autoFile: {
      enabled: false,
      paused: false,
      activatedAt: null,
      provider: 'auto',
      settleSeconds: 10,
      minBand: 'medium',
      allowNewCategories: true,
      allowNewTopLevel: true,
      maxNewCategoriesPerDay: 15,
      burstThreshold: 12,
      burstWindowSeconds: 60,
      syncedArrivals: 'review',
      fetchMetadataForWeakTitles: false,
      maxCloudRequestsPerDay: 100,
    },
    ui: { theme: 'system', pageSize: 100 },
  };
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return (patch === undefined ? base : (patch as T));
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue; // drop unknown keys
    const b = out[k];
    if (typeof b === 'object' && b !== null && !Array.isArray(b)) out[k] = deepMerge(b, v);
    else if (v !== undefined && (typeof v === typeof b || b === null || v === null)) out[k] = v;
  }
  return out as T;
}

/** Load stored settings, filling defaults and migrating older versions. */
export function migrateSettings(raw: unknown): Settings {
  const merged = deepMerge(defaultSettings(), raw);
  merged.v = SETTINGS_VERSION;
  return clampSettings(merged);
}

/** Apply a partial update from the UI with validation and safety clamps. */
export function updateSettings(current: Settings, patch: unknown): Settings {
  return clampSettings(deepMerge(current, patch));
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

export function clampSettings(s: Settings): Settings {
  s.audit.timeoutMs = clamp(s.audit.timeoutMs, 2000, 25_000); // stay under the 30 s fetch limit in workers
  s.audit.maxConcurrent = clamp(Math.round(s.audit.maxConcurrent), 1, 5);
  s.audit.maxPerOrigin = clamp(Math.round(s.audit.maxPerOrigin), 1, Math.min(2, s.audit.maxConcurrent));
  s.audit.originSpacingMs = clamp(s.audit.originSpacingMs, 250, 60_000);
  s.audit.maxAttempts = clamp(Math.round(s.audit.maxAttempts), 1, 5);
  s.audit.freshnessDays = clamp(s.audit.freshnessDays, 1, 365);
  s.audit.notFoundRecheckMinutes = clamp(s.audit.notFoundRecheckMinutes, 1, 60 * 24 * 7);
  s.audit.exclusions = s.audit.exclusions.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 500);
  s.autoFile.settleSeconds = clamp(s.autoFile.settleSeconds, 2, 300);
  s.autoFile.burstThreshold = clamp(Math.round(s.autoFile.burstThreshold), 3, 500);
  s.autoFile.burstWindowSeconds = clamp(s.autoFile.burstWindowSeconds, 5, 3600);
  s.autoFile.maxNewCategoriesPerDay = clamp(Math.round(s.autoFile.maxNewCategoriesPerDay), 0, 200);
  s.autoFile.maxCloudRequestsPerDay = clamp(Math.round(s.autoFile.maxCloudRequestsPerDay), 0, 10_000);
  s.ai.sampleSize = clamp(Math.round(s.ai.sampleSize), 50, 5000);
  s.ai.budget.maxRequests = clamp(Math.round(s.ai.budget.maxRequests), 0, 100_000);
  s.ai.budget.maxCostUsd = clamp(s.ai.budget.maxCostUsd, 0, 1000);
  s.ui.pageSize = clamp(Math.round(s.ui.pageSize), 25, 500);
  s.rootFolderName = (s.rootFolderName || 'LinkSpruce').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'LinkSpruce';
  const isId = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_:.-]{1,64}$/.test(x);
  s.protectedFolderIds = [...new Set(s.protectedFolderIds.filter(isId))].slice(0, 500);
  s.aiExcludedFolderIds = [...new Set(s.aiExcludedFolderIds.filter(isId))].slice(0, 500);
  if (s.destinationRootId !== null && !isId(s.destinationRootId)) s.destinationRootId = null;
  s.includeBands = s.includeBands.filter((b): b is Band => b === 'high' || b === 'medium' || b === 'low');
  if (!s.includeBands.length) s.includeBands = ['high'];
  return s;
}
