/** Provider readiness, cloud consent and cost-estimate dialogs. */
import type { RunEstimate, Budget } from '../../../core/ai/budget.ts';
import { ChromeAiProvider } from '../../../core/ai/chrome-ai.ts';
import { GEMINI_ORIGIN } from '../../../core/ai/gemini.ts';
import { describeTransmission } from '../../../core/ai/pipeline.ts';
import type { Availability, ProviderId } from '../../../core/ai/types.ts';
import type { Settings } from '../../../core/settings.ts';
import { send } from '../../../shared/messages.ts';
import { confirmDialog, h, toast } from '../../shared/dom.ts';

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  auto: 'Automatic (free on-device AI when ready, otherwise offline rules)',
  rules: 'Offline rules (no AI)',
  'chrome-ai': 'On-device AI (Chrome built-in)',
  gemini: 'Gemini API (cloud, your key)',
};

export function availabilityText(a: Availability | undefined): string {
  if (!a) return 'Checking…';
  switch (a.state) {
    case 'available':
      return 'Ready';
    case 'downloadable':
      return 'Model download required';
    case 'downloading':
      return 'Model downloading…';
    case 'needs-key':
      return 'Needs an API key (Settings)';
    case 'needs-permission':
      return 'Needs network permission for the Gemini API';
    case 'needs-consent':
      return 'Needs your consent to send data';
    case 'unavailable':
      return `Unavailable: ${a.reason}`;
  }
}

/** Start the on-device model download from a click (requires user activation). */
export async function downloadOnDeviceModel(onProgress: (f: number) => void): Promise<boolean> {
  try {
    await new ChromeAiProvider().startDownload(onProgress);
    toast('On-device model is ready.', 'success');
    return true;
  } catch (e) {
    toast(`Model download failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

/** Ask for the Gemini host permission and explicit transmission consent. Returns true when ready. */
export async function ensureCloudReady(s: Settings): Promise<boolean> {
  const status = await send<Record<'chrome-ai' | 'gemini', Availability>>({ type: 'aiAvailability' });
  const g = status.gemini;
  if (g.state === 'needs-key') {
    toast('Add your Gemini API key in Settings & Privacy first.', 'error');
    location.hash = '#settings-ai';
    return false;
  }
  if (g.state === 'needs-permission') {
    const ok = await chrome.permissions.request({ origins: [GEMINI_ORIGIN] });
    if (!ok) {
      toast('Network access to the Gemini API was not granted.', 'error');
      return false;
    }
  }
  if (!s.ai.cloudConsentAt) {
    const ok = await confirmDialog({
      title: 'Send bookmark data to Google Gemini?',
      body: [
        h('p', null, 'Cloud processing is optional. If you continue, LinkSpruce sends the following to the Gemini API (generativelanguage.googleapis.com) using your own API key:'),
        h('ul', null, ...describeTransmission(s.ai.dataPolicy).map((x) => h('li', null, x))),
        h('p', null, 'Not sent: full URLs with query strings, cookies, page contents, your browsing history, or bookmarks in folders you excluded from AI.'),
        h('p', { class: 'muted' }, 'Google processes this data under its Gemini API terms. On the free tier, Google may use submitted content to improve its products. Titles and domains can themselves be sensitive; exclude private folders in Settings first if needed. You can withdraw consent at any time.'),
      ],
      confirm: 'I consent',
    });
    if (!ok) return false;
    await send({ type: 'cloudConsent', granted: true });
  }
  return true;
}

export async function confirmEstimate(task: 'discover' | 'classify', est: RunEstimate & { items: number; budget: Budget }): Promise<boolean> {
  const cost = est.costUsd === undefined ? 'unknown' : `about $${est.costUsd.toFixed(3)} (range $${est.costLowUsd!.toFixed(3)}–$${est.costHighUsd!.toFixed(3)})`;
  return confirmDialog({
    title: task === 'discover' ? 'Estimated usage for taxonomy discovery' : 'Estimated usage for categorization',
    body: [
      h('dl', { class: 'kv' }, h('dt', null, 'Bookmarks sent'), h('dd', null, est.items.toLocaleString()), h('dt', null, 'Requests'), h('dd', null, est.requests.toLocaleString()), h('dt', null, 'Input tokens'), h('dd', null, `~${est.inputTokens.toLocaleString()}`), h('dt', null, 'Output tokens'), h('dd', null, `~${est.outputTokens.toLocaleString()}`), h('dt', null, 'Estimated cost'), h('dd', null, cost), h('dt', null, 'Your ceilings'), h('dd', null, `${est.budget.maxRequests} requests, $${est.budget.maxCostUsd.toFixed(2)} per run`)),
      h('ul', { class: 'small muted' }, ...est.assumptions.map((a) => h('li', null, a))),
      h('p', { class: 'small' }, 'Processing stops gracefully at your ceilings and can be resumed after raising them.'),
    ],
    confirm: 'Start',
  });
}
