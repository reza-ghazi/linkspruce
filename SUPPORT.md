# LinkSpruce Support

Thank you for using **LinkSpruce — Bookmark Cleaner & Organizer** ([Chrome Web Store](https://chromewebstore.google.com/detail/linkspruce/fjcgjgpjfdkafoeelblhdppahkaikbnl)).

## Quick help

### Link checks show "Skipped: no permission"
Online checks need site access. Open the dashboard → **Overview & Link Health** → **Allow access to all http/https sites** (or only the sites in a chosen folder). You can revoke access in **Settings & Privacy** or at `chrome://extensions`.

### A link shows "Network error", "Timed out" or "Access restricted"
These are not proof that a link is dead. Sites may block automated requests, require a login, or be temporarily down. Use **Recheck selected** later. LinkSpruce never deletes bookmarks automatically.

### "Remove selected not-found…" says a bookmark isn't eligible
A "Not found" (404/410) result must be confirmed by a second check at least 60 minutes later (configurable in Settings) before removal is offered.

### On-device AI says "Model download required" or "Unavailable"
Chrome's built-in AI needs a supported desktop OS, about 22 GB of free disk space and a capable GPU (or 16 GB RAM). Click **Enable free on-device AI** once to download the model. If your device is not supported, LinkSpruce uses its offline rules automatically.

### A bookmark was filed in the wrong category
Open **Auto-filing Activity** → **Change category** (or **Undo**). LinkSpruce remembers your choice and won't move that bookmark again.

### I want to reverse a bulk change
**Backup & Restore → Recent changes → Undo**. Every bulk change saves a verified snapshot first. See the [recovery guide](docs/recovery.md).

### Nothing happens after saving a bookmark
Auto-filing is off by default: **Settings & Privacy → Auto-file new bookmarks → Turn on**. Bookmarks are filed a few seconds after saving; ambiguous ones stay where you saved them. Many bookmarks created at once (imports) are held for review.

## Report a problem

[Open a bug report](https://github.com/reza-ghazi/linkspruce/issues/new?template=bug_report.yml)

Please include the LinkSpruce version, Chrome version, operating system, the feature involved, exact steps, and expected vs. actual behavior.

**Do not include private bookmark titles or URLs, passwords, API keys or other sensitive information in a public issue.**

## Request a feature

[Open a feature request](https://github.com/reza-ghazi/linkspruce/issues/new?template=feature_request.yml)

## Direct contact

For privacy questions or matters that should not be posted publicly, email [contact@brightarcadia.com](mailto:contact@brightarcadia.com).

## More

- [User guide](docs/user-guide.md)
- [Privacy Policy](PRIVACY.md)
- [Permissions explained](docs/permissions.md)
- [Known limitations](docs/known-limitations.md)
