# Known limitations

- **Chrome cannot tell who created a bookmark** (you, sync, another extension). Auto-filing treats older creation dates as likely sync arrivals and leaves them for review by default. Local locks cannot coordinate multiple synced devices; LinkSpruce never re-files a filed bookmark automatically to avoid back-and-forth moves.
- **Undo is best-effort within Chrome's limits**: recreated bookmarks get new IDs and Chrome cannot restore original creation dates; changes made after the batch are preserved and reported as conflicts.
- **Link checks** see only the final URL of a redirect chain (fetch hides intermediate hops), report DNS/TLS/connection failures as one "Network error", and can be blocked by bot protection. Sensitive-URL detection is heuristic.
- **On-device AI** requires supported hardware/OS, ~22 GB free disk and a one-time model download started by a click. Documented languages are English, Japanese, Spanish, German and French; Persian/Arabic titles may be categorized less reliably on-device.
- **Offline rules** are a vocabulary baseline, not AI: about one-third of a large real collection is categorized confidently offline; the rest needs AI or review.
- **Gemini Interactions API is beta**; `generateContent` is available as an alternate style in Settings.
- **Tags/facets** are stored in LinkSpruce (Chrome bookmarks have no tags) and are not visible in Chrome's bookmark manager.
- **Full-tree replacement restore is not offered** by design; restores go into a new folder.
- Uninstalling deletes all LinkSpruce data including snapshots (download a backup first).
