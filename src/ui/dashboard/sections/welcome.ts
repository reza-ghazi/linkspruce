/** First-run onboarding: what LinkSpruce does, where folders go, optional features. */
import type { Availability } from '../../../core/ai/types.ts';
import { send } from '../../../shared/messages.ts';
import { append, h } from '../../shared/dom.ts';
import { availabilityText, downloadOnDeviceModel } from './ai-consent.ts';
import type { Ctx } from '../dashboard.ts';
import { act, folderSelect, sectionHead } from './common.ts';

export async function renderWelcome(el: HTMLElement, ctx: Ctx): Promise<void> {
  const dest = folderSelect(ctx.tree, { value: ctx.settings.destinationRootId ?? ctx.tree.roots.other ?? '', writableOnly: true, label: 'Destination folder' });
  const avail = await send<Record<'chrome-ai' | 'gemini', Availability>>({ type: 'aiAvailability' }).catch(() => undefined);
  const onDevice = avail?.['chrome-ai'];
  const aiStep = h(
    'li',
    null,
    h('b', null, 'Free AI, no key needed. '),
    'LinkSpruce uses Chrome’s built-in AI (Gemini Nano) on your computer — free, no account, nothing sent anywhere. ',
    onDevice?.state === 'available'
      ? h('span', { class: 'badge badge-ok' }, 'Ready and in use')
      : onDevice?.state === 'downloadable'
        ? h('button', { class: 'btn btn-small', onclick: async (e: Event) => { const b = e.target as HTMLButtonElement; b.disabled = true; await downloadOnDeviceModel((f) => (b.textContent = `Downloading ${Math.round(f * 100)}%…`)); await ctx.refresh(); } }, 'Enable free on-device AI (one-time download)')
        : h('span', { class: 'small muted' }, `${availabilityText(onDevice)}. Offline rules are used instead.`),
  );
  const finish = async (next: string) => {
    await act({ type: 'updateSettings', patch: { onboarded: true, destinationRootId: dest.value || null } });
    location.hash = next;
  };
  append(
    el,
    sectionHead('Welcome to LinkSpruce', 'Less clutter. Better bookmarks. Everything starts local and nothing changes without your say.'),
    h(
      'div',
      { class: 'panel' },
      h(
        'ol',
        { class: 'steps' },
        h('li', null, h('b', null, 'Review, then change. '), 'Duplicates, link checks and organization are shown as previews first. Bulk changes are protected by a verified snapshot and can be undone.'),
        h('li', null, h('b', null, 'Your own structure. '), 'LinkSpruce discovers categories from your bookmarks (offline, on-device AI, or Gemini with your key) and lets you edit them before anything moves.'),
        h('li', null, h('b', null, 'Organized folders go here: '), dest, h('div', { class: 'small muted' }, 'A “LinkSpruce” folder is created inside it. Your existing folders are left in place.')),
        aiStep,
        h('li', null, h('b', null, 'Optional extras. '), 'Online link checks need site access (asked when you start one). Automatic filing of new bookmarks is off until you turn it on in Settings.'),
      ),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary', onclick: () => finish('#overview') }, 'Get started'), h('button', { class: 'btn', onclick: () => finish('#organize') }, 'Organize my bookmarks'), h('button', { class: 'btn', onclick: () => finish('#settings-autofile') }, 'Set up auto-filing')),
    ),
    h('div', { class: 'notice' }, 'Privacy: LinkSpruce has no server, account or analytics. Bookmark data leaves your device only when you check links (requests go to the bookmarked sites) or when you explicitly enable Gemini (selected fields go to Google with your key).'),
  );
}
