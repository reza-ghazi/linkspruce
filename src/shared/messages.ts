/**
 * Typed extension message protocol with runtime validation.
 * Only extension pages can send these (no content scripts, no
 * externally_connectable). The background still validates sender and
 * payloads, and exposes no arbitrary fetch or bookmark-mutation bridge.
 */
import type { ProviderId } from '../core/ai/types.ts';
import type { TaxonomyEdit } from '../core/taxonomy/taxonomy.ts';

export type Msg =
  | { type: 'ping' }
  | { type: 'updateSettings'; patch: unknown }
  | { type: 'auditStart'; mode: 'stale' | 'all'; folderIds: string[]; ids: string[] }
  | { type: 'jobControl'; job: 'audit' | 'classify' | 'discover'; action: 'pause' | 'resume' | 'cancel' }
  | { type: 'auditRetry'; ids: string[] }
  | { type: 'removeApply'; removeIds: string[]; reason: 'duplicates' | 'dead-links' }
  | { type: 'discoverStart'; provider: ProviderId; folderIds: string[] }
  | { type: 'taxonomyFromFolders' }
  | { type: 'taxonomyParse'; text: string }
  | { type: 'taxonomyEdit'; target: 'draft' | 'current'; edit: TaxonomyEdit }
  | { type: 'taxonomyAdopt' }
  | { type: 'taxonomyDiscardDraft' }
  | { type: 'classifyStart'; provider: ProviderId; scope: 'uncertain' | 'all'; folderIds: string[] }
  | { type: 'planBuild' }
  | { type: 'planApply'; planId: string; fingerprint: string }
  | { type: 'batchUndo'; batchId: string }
  | { type: 'snapshotNow' }
  | { type: 'snapshotDelete'; id: string }
  | { type: 'snapshotRestore'; id: string; parentId: string }
  | { type: 'restoreApply'; parentId: string; label: 'Restored Bookmarks' | 'Imported Bookmarks' }
  | { type: 'autofileEnable'; enabled: boolean }
  | { type: 'autofilePause'; paused: boolean }
  | { type: 'autofileUndo'; activityId: string }
  | { type: 'autofileChange'; bookmarkId: string; categoryId: string }
  | { type: 'autofileRelease'; ids: string[]; action: 'file' | 'dismiss' }
  | { type: 'assign'; bookmarkIds: string[]; categoryId: string | null }
  | { type: 'ruleAdd'; kind: 'domain' | 'url-prefix' | 'title-contains'; pattern: string; categoryId: string }
  | { type: 'ruleApprove'; id: string; approved: boolean }
  | { type: 'ruleDelete'; id: string }
  | { type: 'geminiKeySet'; key: string; persist: boolean }
  | { type: 'geminiKeyClear' }
  | { type: 'geminiTest' }
  | { type: 'cloudConsent'; granted: boolean }
  | { type: 'aiAvailability' }
  | { type: 'estimate'; task: 'discover' | 'classify'; scope: 'uncertain' | 'all'; folderIds: string[] }
  | { type: 'clearCaches' }
  | { type: 'deleteAllData' }
  | { type: 'permissionsChanged' };

export type MsgType = Msg['type'];

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_:.-]{1,64}$/;

const isStr = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length <= max;
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isIdList = (v: unknown, max = 100_000): v is string[] => Array.isArray(v) && v.length <= max && v.every(isId);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string>(v: unknown, opts: readonly T[]): v is T => typeof v === 'string' && (opts as readonly string[]).includes(v);

const PROVIDERS = ['auto', 'rules', 'chrome-ai', 'gemini'] as const;

/** Validate an incoming message; returns the typed message or an error string. */
export function validateMsg(raw: unknown): Msg | string {
  if (typeof raw !== 'object' || raw === null) return 'Message must be an object';
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ping':
    case 'taxonomyFromFolders':
    case 'taxonomyAdopt':
    case 'taxonomyDiscardDraft':
    case 'planBuild':
    case 'snapshotNow':
    case 'geminiKeyClear':
    case 'geminiTest':
    case 'aiAvailability':
    case 'clearCaches':
    case 'deleteAllData':
    case 'permissionsChanged':
      return { type: m.type } as Msg;
    case 'updateSettings':
      return typeof m.patch === 'object' && m.patch !== null ? { type: 'updateSettings', patch: m.patch } : 'Invalid settings patch';
    case 'auditStart':
      return oneOf(m.mode, ['stale', 'all'] as const) && isIdList(m.folderIds, 1000) && isIdList(m.ids)
        ? { type: 'auditStart', mode: m.mode, folderIds: m.folderIds, ids: m.ids }
        : 'Invalid audit request';
    case 'jobControl':
      return oneOf(m.job, ['audit', 'classify', 'discover'] as const) && oneOf(m.action, ['pause', 'resume', 'cancel'] as const)
        ? { type: 'jobControl', job: m.job, action: m.action }
        : 'Invalid job control';
    case 'auditRetry':
      return isIdList(m.ids) ? { type: 'auditRetry', ids: m.ids } : 'Invalid ids';
    case 'removeApply':
      return isIdList(m.removeIds) && m.removeIds.length > 0 && oneOf(m.reason, ['duplicates', 'dead-links'] as const)
        ? { type: 'removeApply', removeIds: m.removeIds, reason: m.reason }
        : 'Invalid selection';
    case 'discoverStart':
      return oneOf(m.provider, PROVIDERS) && isIdList(m.folderIds, 1000) ? { type: 'discoverStart', provider: m.provider, folderIds: m.folderIds } : 'Invalid discovery request';
    case 'taxonomyParse':
      return isStr(m.text, 200_000) ? { type: 'taxonomyParse', text: m.text } : 'Invalid taxonomy text';
    case 'taxonomyEdit':
      return oneOf(m.target, ['draft', 'current'] as const) && typeof m.edit === 'object' && m.edit !== null && isStr((m.edit as { op?: unknown }).op, 20)
        ? { type: 'taxonomyEdit', target: m.target, edit: m.edit as TaxonomyEdit }
        : 'Invalid taxonomy edit';
    case 'classifyStart':
      return oneOf(m.provider, PROVIDERS) && oneOf(m.scope, ['uncertain', 'all'] as const) && isIdList(m.folderIds, 1000)
        ? { type: 'classifyStart', provider: m.provider, scope: m.scope, folderIds: m.folderIds }
        : 'Invalid classification request';
    case 'planApply':
      return isId(m.planId) && isStr(m.fingerprint, 64) ? { type: 'planApply', planId: m.planId, fingerprint: m.fingerprint } : 'Invalid plan';
    case 'batchUndo':
      return isId(m.batchId) ? { type: 'batchUndo', batchId: m.batchId } : 'Invalid batch';
    case 'snapshotDelete':
      return isId(m.id) ? { type: 'snapshotDelete', id: m.id } : 'Invalid snapshot';
    case 'snapshotRestore':
      return isId(m.id) && isId(m.parentId) ? { type: 'snapshotRestore', id: m.id, parentId: m.parentId } : 'Invalid restore';
    case 'restoreApply':
      return isId(m.parentId) && oneOf(m.label, ['Restored Bookmarks', 'Imported Bookmarks'] as const) ? { type: 'restoreApply', parentId: m.parentId, label: m.label } : 'Invalid restore';
    case 'autofileEnable':
      return isBool(m.enabled) ? { type: 'autofileEnable', enabled: m.enabled } : 'Invalid';
    case 'autofilePause':
      return isBool(m.paused) ? { type: 'autofilePause', paused: m.paused } : 'Invalid';
    case 'autofileUndo':
      return isId(m.activityId) ? { type: 'autofileUndo', activityId: m.activityId } : 'Invalid';
    case 'autofileChange':
      return isId(m.bookmarkId) && isId(m.categoryId) ? { type: 'autofileChange', bookmarkId: m.bookmarkId, categoryId: m.categoryId } : 'Invalid';
    case 'autofileRelease':
      return isIdList(m.ids, 10_000) && oneOf(m.action, ['file', 'dismiss'] as const) ? { type: 'autofileRelease', ids: m.ids, action: m.action } : 'Invalid';
    case 'assign':
      return isIdList(m.bookmarkIds, 50_000) && (m.categoryId === null || isId(m.categoryId)) ? { type: 'assign', bookmarkIds: m.bookmarkIds, categoryId: m.categoryId as string | null } : 'Invalid assignment';
    case 'ruleAdd':
      return oneOf(m.kind, ['domain', 'url-prefix', 'title-contains'] as const) && isStr(m.pattern, 300) && m.pattern.trim() && isId(m.categoryId)
        ? { type: 'ruleAdd', kind: m.kind, pattern: m.pattern.trim(), categoryId: m.categoryId }
        : 'Invalid rule';
    case 'ruleApprove':
      return isId(m.id) && isBool(m.approved) ? { type: 'ruleApprove', id: m.id, approved: m.approved } : 'Invalid';
    case 'ruleDelete':
      return isId(m.id) ? { type: 'ruleDelete', id: m.id } : 'Invalid';
    case 'geminiKeySet':
      return isStr(m.key, 200) && /^[A-Za-z0-9_\-.]{20,200}$/.test(m.key) && isBool(m.persist) ? { type: 'geminiKeySet', key: m.key, persist: m.persist } : 'That does not look like a Gemini API key';
    case 'cloudConsent':
      return isBool(m.granted) ? { type: 'cloudConsent', granted: m.granted } : 'Invalid';
    case 'estimate':
      return oneOf(m.task, ['discover', 'classify'] as const) && oneOf(m.scope, ['uncertain', 'all'] as const) && isIdList(m.folderIds, 1000)
        ? { type: 'estimate', task: m.task, scope: m.scope, folderIds: m.folderIds }
        : 'Invalid estimate request';
    default:
      return 'Unknown message type';
  }
}

/** Send a message from an extension page and unwrap the reply. */
export async function send<T = unknown>(msg: Msg): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  if (!r) throw new Error('No response from LinkSpruce background');
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
