# Changelog

## 1.0.0 — 2026-10-25

Published on the Chrome Web Store (item `fjcgjgpjfdkafoeelblhdppahkaikbnl`; submitted 2026-10-22).

First release.

- Link health checks: HEAD + bounded GET, conservative statuses, ≤5 concurrent / per-site limits, Retry-After and backoff, no cookies, safety skips, resumable jobs that survive service-worker termination and browser restarts.
- Duplicate detection with evidence tiers (identical, normalized, tracking variants; redirect/canonical suggestions kept separate) and review UI with keep policies.
- Taxonomy discovery: offline baseline, free on-device AI (Chrome built-in, default when available), optional Gemini (BYOK, consent, estimates, budgets). Editable draft, versioned frozen taxonomy, Compact/Balanced/Detailed presets, English/Persian/bilingual labels.
- Categorization with precedence (protected, manual, rules, AI, fallback), Needs Review, secondary tags and facets.
- Organization preview and apply into a LinkSpruce folder; deterministic folder reuse; verified snapshots; write-ahead journal; undo.
- Auto-filing of new bookmarks with settle period, burst/import holding, manual-move respect, category creation under limits, per-item undo.
- Backups (JSON), snapshot retention, validated restore into a new folder, bookmarks HTML analysis and import.
- Accessible dashboard and popup with light/dark themes and RTL-aware text.
