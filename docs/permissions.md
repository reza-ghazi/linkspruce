# Permission rationale

| Permission | Why it is needed | What happens without it |
| --- | --- | --- |
| `bookmarks` | Read the bookmark tree for duplicate detection, link checks, categorization and backups; create folders and move/remove bookmarks **only** after a confirmed preview, an explicit undo/restore, or under auto-filing that the user enables. | Core purpose impossible. |
| `storage` | Store settings, taxonomy, link-check results, categorizations, the operation journal and snapshots locally. Session storage holds an optional Gemini key in memory. | No durable jobs, undo or settings. |
| `unlimitedStorage` | Verified full snapshots (≈3 MB per 25k bookmarks, up to 12 kept) plus caches exceed the 10 MB default quota. No install warning. | Snapshots before bulk changes would fail on large libraries, blocking bulk changes. |
| `alarms` | Resume link checks, AI batches and auto-filing after Chrome stops the service worker (no keepalive loops). | Long jobs would stall when the worker sleeps. |
| Optional `https://*/*`, `http://*/*` | Requested by a user gesture: (a) online link checks contact the bookmarked sites (broad grant or only the sites in a chosen folder); (b) the Gemini API origin `https://generativelanguage.googleapis.com/*` when the user enables cloud AI. | Offline features (duplicates, organization, backups, offline/on-device AI) keep working; link checks mark items "Skipped: no permission". |

Not requested: `history`, `cookies`, `tabs` (opening a tab doesn't need it), `debugger`, `scripting`, content scripts, `offscreen`, `downloads` (Blob + `<a download>`), `notifications`, `identity`.

Content Security Policy (extension pages and service worker): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https: http:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`. `connect-src` allows http/https because link checks run from the service worker, which is governed by this policy; actual reach is still limited by host permissions.
