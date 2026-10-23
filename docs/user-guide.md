# LinkSpruce user guide

## First run
The dashboard opens with a short welcome. Choose where organized folders go (a **LinkSpruce** folder is created inside it; your existing folders stay). If your device supports it, click **Enable free on-device AI** once — it's free, needs no key, and runs on your computer.

## Overview & Link Health
- **Start check** contacts each bookmarked site (no cookies, at most 5 at a time, one per site, spaced out). You'll be asked to grant site access: all sites, or only those in a chosen folder.
- Skipped automatically: local network addresses, URLs with passwords, and URLs that look like they carry tokens or perform actions (logout, delete, unsubscribe). Add your own exclusions in Settings.
- Statuses: Reachable · Redirected · Not found (404/410) · Access restricted (401/403, login pages, bot checks) · Rate limited · Temporary server error · Network error · Timed out · Inconclusive (e.g. a page that *looks* like "not found") · Skipped · Unsupported.
- A failed check is **not** proof a link is dead. Removal is offered only for "Not found" results confirmed by a second check later (default ≥ 60 min).
- Pause, resume, cancel, recheck selected, or rescan everything. Checks continue if you close the tab, and resume after Chrome restarts.

## Duplicates Review
- **High confidence:** identical URLs; URLs differing only in letter case of the site, default port, or an empty `?`/`#`; URLs differing only in tracking parameters (utm_*, fbclid, gclid and similar).
- **Kept distinct:** http vs https, www vs no-www, trailing slashes, `#anchors` and app routes, and any other query parameter.
- **Weaker suggestions** (same redirect destination or declared canonical page, from link checks) are shown separately and never removed in bulk. Shared login/home/error pages are never treated as duplicates.
- Pick a keep policy (oldest, newest, shallowest folder) or *Keep this one*. Copies in different folders are not preselected. "Added" dates are Chrome's stored creation dates and may reflect imports or sync.

## Organization Preview
1. **Build a taxonomy** — *Discover a new structure* (your old folders count only as weak hints), *Improve my existing folders* (with merge/split/misplaced suggestions), or *Use my own taxonomy* (type it, indented). Choose granularity (Compact / Balanced / Detailed) and label language (English, Persian or bilingual).
   - Provider: **Automatic** (free on-device AI if ready, else offline rules), offline rules, on-device AI, or Gemini (your key; asks for consent and shows an estimate first).
2. **Edit the draft** — rename, add subcategories, merge, split, move, pin, reject, exclude. Counts marked ≈ are estimates from a sample.
3. **Approve** — the taxonomy is frozen with stable category IDs and a version number.
4. **Categorize** — offline, on-device or Gemini. With AI you can send only the items the offline rules are unsure about. Progress survives restarts; spending limits stop processing gracefully.
5. **Needs review** — assign categories to ambiguous items (or *Keep where it is*). Your choices are remembered.
6. **Preview changes** — see every move and the target folder tree; then **Apply**. A verified snapshot is taken first; undo from Backup & Restore.

Secondary topics are stored as LinkSpruce tags (Chrome bookmarks have no native tags); tags are kept in LinkSpruce's data and exported in its backups, not visible in Chrome's bookmark manager.

## Auto-filing new bookmarks
Turn on in **Settings & Privacy → Auto-file new bookmarks**. After you save a bookmark, LinkSpruce waits a few seconds (to let you finish editing), classifies it and moves it to the best category — creating one if the subject is new and clear. Ambiguous saves stay where you put them. Bursts and imports are held for review. Every action appears in **Auto-filing Activity** with **Undo** and **Change category**. Pause any time from the popup.

## Backup & Restore
Download a JSON backup any time. Snapshots are taken automatically before bulk changes (newest 12 kept). Restore a snapshot or a file into a **new folder**; nothing is replaced. *Analyze a bookmarks HTML file* inspects an exported file locally without importing it.

## Settings & Privacy
Destination, protected folders (never touched), folders excluded from AI, network limits and exclusions, AI providers and spending limits, data controls (clear caches, delete all LinkSpruce data). See the privacy policy for exactly what data goes where.
