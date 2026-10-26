# Test report — LinkSpruce 1.0.0 (2026-10-22)

Environment: Fedora 44, Node 22.23.1, Chromium 156.0.8078.4 (Playwright 1.64.1, Chrome for Testing build), Chrome 156 installed. All browser tests run in throwaway isolated profiles; no real bookmarks were used.

## Commands and outcomes

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npx vitest run` | **131 passed** (12 files) |
| `npm run test:e2e` | **10 passed**, 2 opt-in skipped (scale, screenshots). One intermittent failure of the 21-case fixture-matrix test was seen in 1 of 6 runs and could not be reproduced in 5 reruns; under investigation. |
| `SCALE=1 npx playwright test tests/e2e/scale.spec.ts` | **passed** (25,000 bookmarks; see below) |
| `SHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts` | passed (5 screenshots) |
| `npm run package` | audit passed; `release/linkspruce-1.0.0.zip`, 123,874 bytes, SHA-256 902f19133eb5bca9ed9ca70539fd45c70bca6e595190aa051afba2907ba61444, reproducible, commit 0aaf11b |

## Coverage by category

**Fixture/unit tests (Node, fakes)** — URL normalization (meaningful params, signed URLs, hash routes, fragments, unicode/IDN, protocol/path/www distinctions), sensitivity/private-network detection, redaction; Netscape import (omitted closing tags, entities, limits, script markup inert); HTML metadata (relative/base canonicals, javascript: canonicals rejected, challenge/login/soft-404); probe (HEAD→GET fallback, 405, non-HTML, byte limits, timeouts, 401/403/404/410/429/5xx, redirects, login convergence); scheduler (≤5 global, per-origin, spacing, cooldown, backoff, Retry-After); job runner (batches, worker death + lease reconcile, pause/resume/cancel, bounded retries, JobPause); duplicates (tiers, convergence guards, no transitive canonical merge, keep policies); taxonomy (edits, versions, retired ids, additive auto categories); semantic acceptance (same subject across domains, different subjects on GitHub/YouTube, English+Persian colocated, astronomy vs astrology, occultation vs occultism, folders can't override strong content, weak-title abstention, facets); precedence and rule suggestions; restore validation (format, schema, size, depth, script URLs); settings clamping.

**Integration (Node)** — plan→journal→undo; deterministic folder reuse; conflicts with concurrent user moves; crash between API call and journal completion (no duplicates); journal persistence failure refuses changes; managed bookmarks untouched; own-event recognition; snapshot verify/retention; exact order restoration on undo; **auto-filing**: normal save, missing category creation, weak metadata, title edit right after save, manual correction (during and after), two simultaneous saves needing the same new category, removal before completion, own-operation loops, restart during create/move, import bursts and rapid bursts, sync arrivals, provider failure + retries, injected-instruction titles, permission revocation, daily cloud budget, taxonomy change invalidating plans, undo + no re-filing, pause/resume, bootstrap with no taxonomy, journal unavailable; **background AI jobs** with a protocol-faithful fake Gemini endpoint: key + consent gating, bounded batches, usage ledger, budget pause/resume, auth pause, discovery across a worker restart + synthesis, consent withdrawal, settings can't flip consent, delete-all; `auto` provider resolution (never cloud).

**Mocked provider tests (NOT live validation)** — Gemini Interactions + generateContent request/response shapes, key only in header, `store:false`, invalid key, quota, rate limit with retryDelay, 5xx, 404 model, malformed JSON, network failure, key never echoed in errors, endpoint/model-id hardening; Chrome AI availability states, quota overflow, malformed output; malicious model output (unknown ids, duplicates, wrong indices, control/bidi chars, command-like JSON).

**Real-browser E2E (Chromium, isolated profile)** — production build loads with no console errors; offline features without host permissions; message validation; XSS-as-text; full HTTP fixture matrix (21 cases incl. localhost/ftp/javascript/token/no-permission skips) with server-side assertions: max 5 concurrent, max 1 per host, no cookies sent, token URLs never requested; service-worker termination mid-scan via CDP + resume; pause/resume/cancel; dead-link removal gated by confirmed recheck + snapshot + undo; organize flow through the UI (discover, rename, approve, categorize, preview, apply, undo → tree identical); re-apply without duplicate trees; stale preview refused; backup download (no keys) and restore into new folder; malformed file rejected; auto-filing in Chrome with UI undo, new category creation, ambiguous save left in place; pending auto-filing survives full browser restart.

## Scale (25,000 synthetic bookmarks, Chromium)

| Step | Time |
| --- | --- |
| Seed 25k via chrome.bookmarks | 4.7 s |
| Render overview / duplicates / organize | 0.29 s / 0.51 s / 0.11 s |
| Offline discovery | 1.2 s |
| Offline classification job | 5.6 s |
| Build preview (20,105 moves) | 2.4 s |
| Verified snapshot + start apply | 0.5 s |
| Apply 20,105 moves (journaled) | 17.3 s |
| Undo all moves | 39.6 s |

Dashboard heap ~100 MB; extension storage 27 MB; no console errors. Node core timings (scripts/perf-node.ts): inventory 0.94 s, classify-all 0.85 s, duplicates 85 ms.

Performance defects found by the first scale run and fixed: quadratic own-operation registry rewrites (apply 300 s → 17 s, undo 516 s → 40 s), per-batch tree/classifier rebuild and shard rewrites (classify 53 s → 5.6 s), dashboard re-rendering during bulk events, multi-minute undo inside a single message event (now continues in the background).

## Not yet validated live

- **On-device AI (Gemini Nano) on real hardware**: Chromium reports `unavailable` (no model component). Logic is covered with a mocked `LanguageModel`; a live check needs branded Chrome with the model downloaded on a supported device.
- **Gemini API live call**: requires a user-supplied key.
- **Classification accuracy**: not yet measured; requires human review of a stratified sample.
- **Branded Chrome manual load**: `dist/` should be loaded once via chrome://extensions in a fresh profile (branded Chrome ignores `--load-extension`, so this is a manual check).
