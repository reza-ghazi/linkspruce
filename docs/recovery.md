# Recovery guide

## Undo a bulk change
Dashboard → **Backup & Restore → Recent changes → Undo**. Undo restores moved bookmarks to their previous folder and position, recreates removed bookmarks (new IDs; original creation dates cannot be restored by Chrome), and removes folders LinkSpruce created only if they are empty. Anything changed since (by you, another device or extension) is reported as a conflict and left as is.

## Undo an automatic filing
Dashboard → **Auto-filing Activity → Undo** (or the popup's *Undo*). The bookmark returns to where you saved it and is never filed again automatically.

## If Chrome closed or the extension restarted mid-change
Nothing to do: on the next start LinkSpruce inspects every step that was in progress, records what actually happened (without repeating it), and finishes the remaining steps with conflict checks. The result appears in *Recent changes*.

## Restore from a snapshot or file
- **Snapshot:** Backup & Restore → Snapshots → *Restore…* → choose a folder. A new "Restored Bookmarks <date>" folder is created; current bookmarks are untouched.
- **File:** Backup & Restore → *Restore from a file* (LinkSpruce `.json` or Chrome `.html` export). The file is validated and previewed first.
- Full-tree replacement is intentionally not offered. To return to a previous state exactly, restore into a new folder, compare, then delete what you no longer need using Chrome's bookmark manager.

## Retention and quota
The newest 12 snapshots (≤120 MB) are kept; older ones are deleted. The journal keeps the last 60 finished batches. If storage fails, bulk changes are refused before anything is modified, and auto-filing leaves the bookmark where you saved it.

## Uninstalling
Uninstalling removes all LinkSpruce data, including snapshots and any stored key. Your bookmarks remain. Download a backup first if you want one.

## Manual last resort
Every downloaded backup is plain JSON (`format: "linkspruce-backup"`) with the full hierarchy, titles, URLs and dates, and Chrome's own *Export bookmarks* is unaffected by LinkSpruce.
