# Chrome Web Store listing (draft for approval)

**Title:** LinkSpruce — Bookmark Cleaner & Organizer
**Summary (≤132 chars):** Less clutter. Better bookmarks. Find broken links and duplicates, and organize bookmarks with local or optional AI help.
**Category (recommended):** Workflow & Planning (alternative: Tools)
**Language:** English

## Description

LinkSpruce helps you turn a sprawling bookmark collection into a tidy, searchable library — on your own terms.

FIND DUPLICATES SAFELY
• Groups identical links, equivalent URLs and tracking-parameter variants (utm_*, fbclid, gclid…)
• Keeps http/https, www, trailing slashes, anchors and meaningful parameters distinct
• Shows weaker evidence (shared redirects, canonical links) separately — never merged in bulk
• You choose which copy to keep; copies in different folders are never preselected

CHECK LINK HEALTH
• Reachable, redirected, not found, access restricted, rate limited, server errors, timeouts
• Polite by design: no cookies, at most 5 requests at a time, one per site, with backoff
• A failed check is never treated as proof of a dead link; removal requires a confirmed recheck and your approval

ORGANIZE WITH A STRUCTURE THAT FITS YOU
• Discovers categories from your own bookmarks instead of imposing a fixed list
• Edit before anything moves: rename, merge, split, move, pin, reject
• Free on-device AI (Chrome's built-in model) when your device supports it — no key, no account, nothing sent anywhere
• Optional Gemini cloud AI with your own key, only after clear consent and a cost estimate
• Works offline with built-in rules when AI isn't available
• English, Persian and Arabic titles supported

AUTO-FILE NEW BOOKMARKS (OPTIONAL)
• Turn it on once; newly saved bookmarks are filed into the right category automatically
• Ambiguous ones stay where you saved them; every move can be undone

SAFE BY DEFAULT
• Previews before every bulk change; verified snapshot first; one-click undo
• Restores always go into a new folder — nothing is overwritten
• Nothing is ever deleted automatically
• No account, no server, no analytics

Permissions: bookmarks (read and organize your bookmarks), storage + unlimited storage (local settings, results and backup snapshots), alarms (resume long tasks). Site access is optional and requested only when you start a link check or enable Gemini.

## Single purpose (Privacy practices tab)
LinkSpruce helps users clean up and organize their Chrome bookmarks: it detects duplicate and broken bookmarks, suggests and applies a category structure (with previews and undo), and can automatically file newly saved bookmarks into those categories.

## Permission justifications
- **bookmarks:** Core function — read bookmarks to find duplicates/broken links and to categorize them; create folders and move/remove bookmarks only after the user confirms a preview, requests undo/restore, or enables auto-filing.
- **storage:** Save settings, link-check results, categories, the undo journal and backup snapshots locally on the device.
- **unlimitedStorage:** Full backup snapshots taken before bulk changes exceed the default 10 MB quota for large libraries (≈3 MB per 25,000 bookmarks).
- **alarms:** Resume link checks, categorization and auto-filing after Chrome suspends the service worker.
- **Optional host permissions (http/https):** Requested by user action only — to check whether bookmarked pages still load, and to reach the Gemini API when the user enables cloud AI with their own key.

## Remote code
No, I am not using remote code. All code ships in the package; AI responses are treated as validated JSON data only.

## Data usage disclosures (proposed)
Collected/handled: **Web browsing activity** (bookmark URLs and titles are processed; link checks contact bookmarked sites) — and, only if the user enables Gemini, bookmark titles and redacted URLs are **transferred to Google** for the categorization feature. Also possibly **User-generated content** (bookmark titles/folder names). Not collected: personally identifiable information, health, financial, authentication information (the optional API key is the user's own credential stored locally and sent only to Google), personal communications, location.
Certifications: no sale of data; no use or transfer unrelated to the single purpose; no use for creditworthiness or lending.

**Privacy policy URL:** https://github.com/reza-ghazi/linkspruce/blob/main/PRIVACY.md
**Support URL:** https://github.com/reza-ghazi/linkspruce/blob/main/SUPPORT.md
**Contact email (privacy/private matters):** contact@brightarcadia.com
**Homepage URL:** https://github.com/reza-ghazi/linkspruce

## Distribution (same as EZ Zoom)
- Visibility: Public · Price: Free · Regions: All regions
- Publishing: deferred (publish manually after approval) unless you explicitly choose automatic

## Graphics
- Icon: `public/icons/icon-128.png` (96×96 art + 16 px transparent padding)
- Screenshots (1280×800): `store/screenshots/*.png` (synthetic bookmarks only)
- Small promo tile 440×280: `store/promo-small-440x280.png`
- Marquee 1400×560: `store/promo-marquee-1400x560.png`
