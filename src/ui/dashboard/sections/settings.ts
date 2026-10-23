/** Settings & Privacy: destination, protection, auto-filing, network, AI providers, keys, data controls. */
import type { Availability } from '../../../core/ai/types.ts';
import { GEMINI_ORIGIN, validModelId } from '../../../core/ai/gemini.ts';
import { describeTransmission } from '../../../core/ai/pipeline.ts';
import { send } from '../../../shared/messages.ts';
import { hasBroadHostAccess } from '../../shared/data.ts';
import { append, confirmDialog, h, toast } from '../../shared/dom.ts';
import type { Ctx } from '../dashboard.ts';
import { availabilityText, downloadOnDeviceModel, ensureCloudReady, PROVIDER_LABEL } from './ai-consent.ts';
import { act, folderLabel, folderSelect, sectionHead } from './common.ts';

type Patch = Record<string, unknown>;

async function save(patch: Patch, ctx: Ctx, msg = 'Saved.') {
  if (await act({ type: 'updateSettings', patch }, msg)) await ctx.refresh();
}

function num(label: string, value: number, min: number, max: number, onSave: (v: number) => void, hint?: string, step = 1) {
  return h('label', { class: 'field' }, h('span', null, label, hint ? h('span', { class: 'hint' }, ` — ${hint}`) : null), h('input', { type: 'number', class: 'input', value, min, max, step, onchange: (e: Event) => onSave(Number((e.target as HTMLInputElement).value)) }));
}

function check(label: string, checked: boolean, onSave: (v: boolean) => void, hint?: string) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => onSave((e.target as HTMLInputElement).checked) }), h('span', null, label, hint ? h('div', { class: 'small muted' }, hint) : null));
}

function select(label: string, value: string, options: Array<[string, string]>, onSave: (v: string) => void, hint?: string) {
  const sel = h('select', { class: 'input', onchange: (e: Event) => onSave((e.target as HTMLSelectElement).value) }, ...options.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = value;
  return h('label', { class: 'field' }, h('span', null, label, hint ? h('span', { class: 'hint' }, ` — ${hint}`) : null), sel);
}

function folderList(ctx: Ctx, title: string, ids: string[], key: 'protectedFolderIds' | 'aiExcludedFolderIds', hint: string) {
  const sel = folderSelect(ctx.tree, { allLabel: 'Choose a folder…', label: `Add to ${title}` });
  return h(
    'div',
    { class: 'field' },
    h('span', null, title, h('span', { class: 'hint' }, ` — ${hint}`)),
    h('div', { class: 'chips' }, ...(ids.length ? ids.map((id) => { const f = ctx.tree.flat.folders.find((x) => x.id === id); return h('span', { class: 'badge badge-brand' }, f ? folderLabel(f) : `(missing folder ${id})`, ' ', h('button', { class: 'btn-icon', 'aria-label': 'Remove', onclick: () => save({ [key]: ids.filter((x) => x !== id) }, ctx) }, '×')); }) : [h('span', { class: 'muted small' }, 'None')])),
    h('div', { class: 'toolbar' }, sel, h('button', { class: 'btn btn-small', onclick: () => sel.value && save({ [key]: [...new Set([...ids, sel.value])] }, ctx) }, 'Add')),
  );
}

export async function renderSettings(el: HTMLElement, ctx: Ctx): Promise<void> {
  const s = ctx.settings;
  const [broad, gemOrigin, avail, keyStatus] = await Promise.all([
    hasBroadHostAccess(),
    chrome.permissions.contains({ origins: [GEMINI_ORIGIN] }),
    send<Record<'chrome-ai' | 'gemini', Availability>>({ type: 'aiAvailability' }).catch(() => undefined),
    chrome.storage.session.get('secret:gemini').then(async (x) => ({ session: typeof x['secret:gemini'] === 'string', persisted: typeof (await chrome.storage.local.get('secret:gemini'))['secret:gemini'] === 'string' })),
  ]);

  const enableAutofile = async (on: boolean) => {
    if (on) {
      const ok = await confirmDialog({
        title: 'Turn on automatic filing?',
        body: [
          h('p', null, 'From now on, when you save a new bookmark, LinkSpruce waits a few seconds (so you can finish editing), classifies it, and moves it into the matching category inside your LinkSpruce folder — without asking each time. If no category fits and the subject is clear, it may create a new category folder.'),
          h('ul', null, h('li', null, 'Existing bookmarks are not reorganized.'), h('li', null, 'Ambiguous bookmarks stay where you saved them and appear under Needs review.'), h('li', null, 'Nothing is ever deleted automatically.'), h('li', null, 'Every automatic move can be undone; bookmarks you move or undo are never filed again.'), h('li', null, 'Imports and bursts of many new bookmarks are held for bulk review.'), h('li', null, `Classification uses: ${PROVIDER_LABEL[s.autoFile.provider]}. Cloud use requires separate consent.`)),
        ],
        confirm: 'Turn on',
      });
      if (!ok) return;
      if (!s.destinationRootId) await act({ type: 'updateSettings', patch: { destinationRootId: ctx.tree.roots.other ?? null } });
    }
    await act({ type: 'autofileEnable', enabled: on }, on ? 'Auto-filing is on.' : 'Auto-filing is off.');
    await ctx.refresh();
  };

  const keyInput = h('input', { type: 'password', class: 'input', autocomplete: 'off', placeholder: keyStatus.session || keyStatus.persisted ? 'A key is set (hidden)' : 'Paste your Gemini API key', 'aria-label': 'Gemini API key' });
  const persistBox = h('input', { type: 'checkbox', checked: s.ai.gemini.persistKey });
  const saveKey = async () => {
    const key = keyInput.value.trim();
    if (!key) return toast('Paste a key first.', 'error');
    if (persistBox.checked) {
      const ok = await confirmDialog({ title: 'Remember the key on this device?', body: [h('p', null, 'The key will be stored in this browser profile’s extension storage so it survives restarts. Extension storage is not a secure vault: anyone with access to this browser profile could read it. It is never synced, exported, logged or included in backups.')], confirm: 'Remember' });
      if (!ok) return;
    }
    if (await act({ type: 'geminiKeySet', key, persist: persistBox.checked }, persistBox.checked ? 'Key saved on this device.' : 'Key saved for this browser session only.')) {
      keyInput.value = '';
      await ctx.refresh();
    }
  };

  const geminiPanel = h(
    'div',
    { class: 'panel' },
    h('h3', null, 'Gemini API (optional, cloud)'),
    h('p', { class: 'small muted' }, `Bring your own key from Google AI Studio. Status: ${availabilityText(avail?.gemini)}. LinkSpruce never ships a shared key and never falls back to the cloud on its own.`),
    h('div', { class: 'toolbar' }, keyInput, h('button', { class: 'btn btn-primary', onclick: saveKey }, 'Save key'), keyStatus.session || keyStatus.persisted ? h('button', { class: 'btn', onclick: () => act({ type: 'geminiKeyClear' }, 'Key removed.').then(ctx.refresh) }, 'Remove key') : null),
    h('label', { class: 'check' }, persistBox, h('span', null, 'Remember the key on this device', h('div', { class: 'small muted' }, 'Off (recommended): the key is kept only until the browser closes.'))),
    h('label', { class: 'field' }, h('span', null, 'Model', h('span', { class: 'hint' }, ' — a currently documented Gemini model id')), h('input', { class: 'input', value: s.ai.gemini.model, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); if (!validModelId(v)) return toast('Invalid model id', 'error'); void save({ ai: { gemini: { model: v } } }, ctx); } })),
    select('API style', s.ai.gemini.apiStyle, [['interactions', 'Interactions API (default)'], ['generateContent', 'generateContent']], (v) => save({ ai: { gemini: { apiStyle: v } } }, ctx)),
    h('p', { class: 'small' }, `Network access to the Gemini API: ${gemOrigin || broad ? 'granted' : 'not granted (requested when you first use it)'}.`),
    h('h4', null, 'What may be sent'),
    check('URL path (with queries, fragments and ID-like segments removed)', s.ai.dataPolicy.includePath, (v) => save({ ai: { dataPolicy: { includePath: v } } }, ctx), 'Off: only the host name is sent.'),
    check('Folder names as hints', s.ai.dataPolicy.includeFolderHints, (v) => save({ ai: { dataPolicy: { includeFolderHints: v } } }, ctx)),
    check('Page title/description from link checks', s.ai.dataPolicy.includeMetadata, (v) => save({ ai: { dataPolicy: { includeMetadata: v } } }, ctx)),
    h('p', { class: 'small muted' }, 'Currently sent: ', describeTransmission(s.ai.dataPolicy).join('; '), '.'),
    h('p', null, 'Consent: ', s.ai.cloudConsentAt ? h('span', null, h('span', { class: 'badge badge-ok' }, `Given ${new Date(s.ai.cloudConsentAt).toLocaleDateString()}`), ' ', h('button', { class: 'btn btn-small', onclick: () => act({ type: 'cloudConsent', granted: false }, 'Consent withdrawn. Cloud processing is off.').then(ctx.refresh) }, 'Withdraw')) : h('span', null, h('span', { class: 'badge' }, 'Not given'), ' ', h('button', { class: 'btn btn-small', onclick: () => ensureCloudReady(s).then(ctx.refresh) }, 'Review and consent…'))),
    h('h4', null, 'Spending limits (per run)'),
    h('div', { class: 'split' }, num('Max requests', s.ai.budget.maxRequests, 0, 100000, (v) => save({ ai: { budget: { maxRequests: v } } }, ctx)), num('Max estimated cost (USD)', s.ai.budget.maxCostUsd, 0, 1000, (v) => save({ ai: { budget: { maxCostUsd: v } } }, ctx), undefined, 0.05), num('Max input tokens', s.ai.budget.maxInputTokens, 0, 1e9, (v) => save({ ai: { budget: { maxInputTokens: v } } }, ctx)), num('Max output tokens', s.ai.budget.maxOutputTokens, 0, 1e9, (v) => save({ ai: { budget: { maxOutputTokens: v } } }, ctx))),
    num('Discovery sample size', s.ai.sampleSize, 50, 5000, (v) => save({ ai: { sampleSize: v } }, ctx), 'bookmarks sampled across subjects and languages'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: async () => { if (!s.ai.cloudConsentAt) return toast('Give consent first.', 'error'); const ok = await confirmDialog({ title: 'Send a test request?', body: [h('p', null, 'This sends one tiny request (no bookmark data) to check your key and model. It may count toward your quota or billing.')], confirm: 'Send test' }); if (!ok) return; const r = await act<{ ok: boolean; model: string; usage: { inputTokens: number; outputTokens: number } }>({ type: 'geminiTest' }); if (r) toast(r.ok ? `Gemini (${r.model}) responded correctly.` : 'Gemini responded, but not as expected.', r.ok ? 'success' : 'error'); } }, 'Test connection')),
  );

  const onDevice = avail?.['chrome-ai'];
  const onDevicePanel = h(
    'div',
    { class: 'panel' },
    h('h3', null, 'On-device AI (Chrome built-in)'),
    h('p', { class: 'small muted' }, `Status: ${availabilityText(onDevice)}. Runs Gemini Nano locally; nothing is sent to a server. Requires a supported desktop OS, enough disk space (about 22 GB free) and a capable GPU or CPU. Persian and Arabic titles may be handled less reliably than English on-device.`),
    onDevice?.state === 'downloadable' ? h('button', { class: 'btn', onclick: async (e: Event) => { const b = e.target as HTMLButtonElement; b.disabled = true; await downloadOnDeviceModel((f) => (b.textContent = `Downloading ${Math.round(f * 100)}%`)); await ctx.refresh(); } }, 'Download model') : null,
  );

  append(
    el,
    sectionHead('Settings & Privacy', 'LinkSpruce works locally by default: no account, no analytics, no server. Online link checks and cloud AI are optional and explained before use.'),
    h(
      'div',
      { class: 'panel', id: 'settings-general' },
      h('h2', null, 'Organizing'),
      h('label', { class: 'field' }, h('span', null, 'Destination for organized folders', h('span', { class: 'hint' }, ' — a LinkSpruce folder is created inside it')), folderSelect(ctx.tree, { value: s.destinationRootId ?? ctx.tree.roots.other ?? '', writableOnly: true, label: 'Destination folder', onchange: (v) => save({ destinationRootId: v }, ctx) })),
      h('label', { class: 'field' }, h('span', null, 'Generated folder name'), h('input', { class: 'input', value: s.rootFolderName, maxlength: 60, onchange: (e: Event) => save({ rootFolderName: (e.target as HTMLInputElement).value }, ctx) })),
      select('Include in bulk moves', s.includeBands.join(','), [['high,medium', 'High and medium confidence'], ['high', 'High confidence only']], (v) => save({ includeBands: v.split(',') }, ctx)),
      select('Duplicate keep policy', s.keepPolicy, [['oldest', 'Oldest copy'], ['newest', 'Newest copy'], ['shallowest', 'Shallowest folder']], (v) => save({ keepPolicy: v }, ctx)),
      select('Theme', s.ui.theme, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], (v) => save({ ui: { theme: v } }, ctx)),
      num('Rows per page', s.ui.pageSize, 25, 500, (v) => save({ ui: { pageSize: v } }, ctx)),
      folderList(ctx, 'Protected folders', s.protectedFolderIds, 'protectedFolderIds', 'never reorganized or auto-filed (e.g. quick-access or project collections)'),
      folderList(ctx, 'Excluded from AI', s.aiExcludedFolderIds, 'aiExcludedFolderIds', 'never sent to any AI provider; offline rules still apply'),
    ),
    h(
      'div',
      { class: 'panel', id: 'settings-autofile' },
      h('h2', null, 'Auto-file new bookmarks', s.autoFile.enabled ? h('span', { class: `badge ${s.autoFile.paused ? 'badge-warn' : 'badge-ok'}` }, s.autoFile.paused ? 'Paused' : 'On') : h('span', { class: 'badge' }, 'Off')),
      h('div', { class: 'btn-row' }, s.autoFile.enabled ? h('button', { class: 'btn', onclick: () => enableAutofile(false) }, 'Turn off') : h('button', { class: 'btn btn-primary', onclick: () => enableAutofile(true) }, 'Turn on…'), s.autoFile.enabled ? h('button', { class: 'btn', onclick: () => act({ type: 'autofilePause', paused: !s.autoFile.paused }).then(ctx.refresh) }, s.autoFile.paused ? 'Resume' : 'Pause') : null),
      select('Classifier for new bookmarks', s.autoFile.provider, [['auto', PROVIDER_LABEL.auto], ['rules', PROVIDER_LABEL.rules], ['chrome-ai', PROVIDER_LABEL['chrome-ai']], ['gemini', PROVIDER_LABEL.gemini]], async (v) => { if (v === 'gemini' && !(await ensureCloudReady(s))) return ctx.refresh(); await save({ autoFile: { provider: v } }, ctx); }, 'if the chosen AI is unavailable, offline rules are used and labelled — never another cloud service'),
      select('File automatically when confidence is at least', s.autoFile.minBand, [['high', 'High'], ['medium', 'Medium']], (v) => save({ autoFile: { minBand: v } }, ctx)),
      check('Create a new category when none fits and the subject is clear', s.autoFile.allowNewCategories, (v) => save({ autoFile: { allowNewCategories: v } }, ctx)),
      check('Allow new top-level categories', s.autoFile.allowNewTopLevel, (v) => save({ autoFile: { allowNewTopLevel: v } }, ctx)),
      num('Max new categories per day', s.autoFile.maxNewCategoriesPerDay, 0, 200, (v) => save({ autoFile: { maxNewCategoriesPerDay: v } }, ctx)),
      num('Wait before filing (seconds)', s.autoFile.settleSeconds, 2, 300, (v) => save({ autoFile: { settleSeconds: v } }, ctx), 'time to finish editing the title or folder'),
      num('Hold for review when this many arrive within the window', s.autoFile.burstThreshold, 3, 500, (v) => save({ autoFile: { burstThreshold: v } }, ctx)),
      num('Burst window (seconds)', s.autoFile.burstWindowSeconds, 5, 3600, (v) => save({ autoFile: { burstWindowSeconds: v } }, ctx)),
      select('Bookmarks that seem to arrive via sync or other tools', s.autoFile.syncedArrivals, [['review', 'Leave them for review (recommended)'], ['file', 'File them too']], (v) => save({ autoFile: { syncedArrivals: v } }, ctx), 'Chrome does not say who created a bookmark; an older creation date is used as a hint'),
      check('Fetch page title for generic titles (Home, Login…)', s.autoFile.fetchMetadataForWeakTitles, (v) => save({ autoFile: { fetchMetadataForWeakTitles: v } }, ctx), 'Requires site access; sends one request to that page.'),
      num('Max cloud requests per day', s.autoFile.maxCloudRequestsPerDay, 0, 10000, (v) => save({ autoFile: { maxCloudRequestsPerDay: v } }, ctx)),
      h('p', { class: 'small muted' }, 'With Chrome sync on several devices, run auto-filing on one device or accept occasional duplicate work: local locks cannot coordinate across devices. LinkSpruce never moves an already-filed bookmark again automatically, which prevents back-and-forth moves.'),
    ),
    h(
      'div',
      { class: 'panel', id: 'settings-network' },
      h('h2', null, 'Online link checks'),
      h('p', null, 'Site access: ', broad ? h('span', null, h('span', { class: 'badge badge-ok' }, 'All http/https sites'), ' ', h('button', { class: 'btn btn-small', onclick: async () => { await chrome.permissions.remove({ origins: ['https://*/*', 'http://*/*'] }); await act({ type: 'permissionsChanged' }); toast('Site access removed.'); await ctx.refresh(); } }, 'Revoke')) : h('span', null, h('span', { class: 'badge' }, 'Not granted for all sites'), ' ', h('button', { class: 'btn btn-small', onclick: async () => { const ok = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }); await act({ type: 'permissionsChanged' }); if (ok) toast('Site access granted.', 'success'); await ctx.refresh(); } }, 'Grant…'))),
      h('div', { class: 'split' }, num('Parallel requests (max 5)', s.audit.maxConcurrent, 1, 5, (v) => save({ audit: { maxConcurrent: v } }, ctx)), num('Parallel requests per site', s.audit.maxPerOrigin, 1, 2, (v) => save({ audit: { maxPerOrigin: v } }, ctx)), num('Spacing per site (ms)', s.audit.originSpacingMs, 250, 60000, (v) => save({ audit: { originSpacingMs: v } }, ctx)), num('Timeout (ms)', s.audit.timeoutMs, 2000, 25000, (v) => save({ audit: { timeoutMs: v } }, ctx)), num('Attempts per link', s.audit.maxAttempts, 1, 5, (v) => save({ audit: { maxAttempts: v } }, ctx)), num('Reuse results for (days)', s.audit.freshnessDays, 1, 365, (v) => save({ audit: { freshnessDays: v } }, ctx)), num('Recheck "not found" after (minutes)', s.audit.notFoundRecheckMinutes, 1, 10080, (v) => save({ audit: { notFoundRecheckMinutes: v } }, ctx), 'before removal is offered')),
      check('Read page title, description and canonical link (first 256 KB of HTML)', s.audit.fetchMetadata, (v) => save({ audit: { fetchMetadata: v } }, ctx)),
      check('Skip URLs that look sensitive (tokens, logout/delete/unsubscribe links)', s.audit.skipSensitive, (v) => save({ audit: { skipSensitive: v } }, ctx), 'Automatic detection cannot recognize every sensitive URL; add exclusions below. Private-network addresses and URLs with credentials are always skipped.'),
      h('label', { class: 'field' }, h('span', null, 'Exclusions', h('span', { class: 'hint' }, ' — one per line: a domain (example.com) or a URL prefix (https://example.com/private)')), h('textarea', { class: 'input', onchange: (e: Event) => save({ audit: { exclusions: (e.target as HTMLTextAreaElement).value.split('\n') } }, ctx) }, s.audit.exclusions.join('\n'))),
    ),
    h('div', { class: 'panel', id: 'settings-ai' }, h('h2', null, 'AI categorization'), h('p', { class: 'muted' }, 'Offline rules always work. AI providers are optional; choose one per task in Organization Preview and for auto-filing above.'), onDevicePanel, geminiPanel),
    h(
      'div',
      { class: 'panel', id: 'settings-data' },
      h('h2', null, 'Your data'),
      h('ul', null, h('li', null, 'Bookmarks are read and changed only on this device, through Chrome’s bookmarks API, and only after previews you confirm (or under auto-filing, which you enable).'), h('li', null, 'Link checks contact the bookmarked websites directly, without cookies.'), h('li', null, 'Cloud AI (Gemini) receives only the fields listed above, only after your consent, with your key.'), h('li', null, 'No analytics, no account, no LinkSpruce server.'), h('li', null, 'Uninstalling LinkSpruce deletes everything it stored, including snapshots. Download a backup first if you want one.')),
      h('p', null, h('a', { href: 'https://github.com/reza-ghazi/linkspruce/blob/main/PRIVACY.md', target: '_blank', rel: 'noopener noreferrer' }, 'Privacy policy'), ' · ', h('a', { href: 'https://github.com/reza-ghazi/linkspruce/blob/main/SUPPORT.md', target: '_blank', rel: 'noopener noreferrer' }, 'Help & support'), ' · ', h('a', { href: 'https://github.com/reza-ghazi/linkspruce', target: '_blank', rel: 'noopener noreferrer' }, 'Project page')),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn', onclick: async () => { if (await confirmDialog({ title: 'Clear caches?', body: [h('p', null, 'Deletes link-check results, categorizations and the current preview. Settings, taxonomy, rules, snapshots and history are kept.')], confirm: 'Clear caches' })) await act({ type: 'clearCaches' }, 'Caches cleared.').then(ctx.refresh); } }, 'Clear caches'),
        h('button', { class: 'btn btn-danger', onclick: async () => { if (await confirmDialog({ title: 'Delete all LinkSpruce data?', body: [h('p', null, 'Deletes settings, taxonomy, rules, link-check results, snapshots, history and any stored API key. Your Chrome bookmarks themselves are not changed.')], confirm: 'Delete everything', danger: true })) { await act({ type: 'deleteAllData' }, 'All LinkSpruce data deleted.'); location.hash = '#welcome'; await ctx.refresh(); } } }, 'Delete all LinkSpruce data'),
      ),
    ),
  );
}

