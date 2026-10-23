# Reviewer test instructions

No account or API key is needed to test LinkSpruce.

1. Install and open the dashboard (it opens automatically, or click the toolbar icon → **Open Dashboard**).
2. Create a few test bookmarks (or import any bookmarks HTML file through Chrome), including two copies of the same URL and one with `?utm_source=test` appended.
3. **Duplicates Review** shows them grouped with the evidence "Identical URL" / "Tracking parameters only". Select a copy and remove it — a confirmation explains that a snapshot is saved first; then **Backup & Restore → Recent changes → Undo** restores it.
4. **Organization Preview** → *Discover structure* (Automatic/offline mode works without any key) → *Approve taxonomy* → *Categorize* → *Build preview* → *Apply changes*. Bookmarks move into "Other bookmarks › LinkSpruce › …". Undo from Backup & Restore.
5. **Overview & Link Health** → *Start check* → Chrome asks for site access (optional). Results show statuses; nothing is deleted automatically.
6. **Settings & Privacy → Auto-file new bookmarks → Turn on**, then bookmark any page (e.g. a Wikipedia article about astronomy). After ~10 seconds it is moved into a category; **Auto-filing Activity** shows it with **Undo**.
7. Gemini (optional) requires the reviewer's own key and explicit consent in Settings; it is not needed to evaluate any feature.

Network: the extension contacts only bookmarked sites during a user-started link check, and `generativelanguage.googleapis.com` only if the user enables Gemini.
