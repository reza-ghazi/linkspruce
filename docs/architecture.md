# Architecture

```
┌──────────── extension pages (read-only state, send messages) ────────────┐
│ popup.html/js     dashboard.html/js  (sections: overview, duplicates,     │
│                   organize, activity, backup, settings, welcome)          │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ chrome.runtime.sendMessage  (validated: src/shared/messages.ts)
┌───────────────▼─────────────── background.js (service worker) ────────────┐
│ index.ts   top-level listeners: bookmarks.on*, alarms, runtime, storage   │
│ app.ts     Background: jobs, audits, AI orchestration, planning, applying │
│            ├── JobRunner ×3 (audit / classify / discover)  ← durable      │
│            ├── RequestScheduler (≤5 global, per-origin limits)            │
│            ├── AutoFiler (queue, settle, classify, create, move, undo)    │
│            ├── Journal (write-ahead, recovery, undo)                      │
│            └── SnapshotStore (verified full snapshots, retention)         │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ interfaces: BookmarksApi, KeyValueStore, FetchLike, Clock
┌───────────────▼────────────── src/core (pure, unit-tested) ───────────────┐
│ url.ts  text.ts  netscape.ts  tree.ts  duplicates.ts  store.ts  jobs.ts   │
│ audit/{probe,html-meta,scheduler}.ts                                       │
│ taxonomy/{lexicon,taxonomy}.ts   classify/{features,classifier,precedence} │
│ discovery/discovery.ts   ai/{types,prompts,validate,budget,pipeline,       │
│ gemini,chrome-ai}.ts   journal.ts  backup.ts  plan.ts  autofile.ts         │
│ settings.ts  repo.ts                                                       │
└────────────────────────────────────────────────────────────────────────────┘
```

## Data flow

- **Audit:** `auditStart` → JobRunner(items) → per item: eligibility (scheme/private/credentials/sensitive/exclusions) → permission check → scheduler → `probeUrl` (HEAD → bounded GET) → `classifyProbe` → `HealthRecord` (sharded) → retries with backoff/Retry-After.
- **Discovery:** inventory → offline draft (rules) **or** stratified sample → discover batches (global candidates) → synthesis → draft taxonomy → user edits → `taxonomyAdopt` (freeze, versioned).
- **Classification:** precedence (protected → user assignment → user rule → stored AI/rules assignment if current → rules) ; AI batches validated; disagreements → Needs Review.
- **Organize:** `planBuild` (folders reused via folderMap/equivalence; fingerprint) → preview → `planApply` (fingerprint + taxonomy version check) → verified snapshot → journal batch → folderMap update.
- **Auto-file:** `onCreated` → queue (settling) → tick → re-read → classify → maybe create category (additive) → re-read → single-item journal batch → activity entry.

## Storage keys (chrome.storage.local)

`settings`, `taxonomy:current|draft|history|v:*`, `rules`, `corrections`, `folderMap`, `plan:current:*` (chunked), `as:N` assignments, `hl:N` health, `ov:N` overrides, `job:<type>`, `job:<type>:items:<id>`, `discovery:state|items`, `journal:index`, `journal:<id>:steps:*`, `journal:<id>:st:<page>`, `journal:own`, `snapshot:index`, `snapshot:<id>:*`, `autofile:queue|activity|burst|daily|snapshots`, `ledger:*`, `restore:pending:*`. Optional: `secret:gemini` (only if the user opts in to remembering the key). Session storage: `secret:gemini` (default).

## Deliverable mapping

The brief's named files map to the build output: `manifest.json`, `popup.html/css/js`, `background.js`, `dashboard.html/css/js`, `icons/`. Categorization logic ("categorizer") is `src/core/classify/*` + `src/core/discovery` + `src/core/ai/*`, bundled into shared chunks (`chunks/*.js`) used by both the worker and the dashboard. Settings live in the dashboard (also registered as the options page).
