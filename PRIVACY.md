# LinkSpruce — Privacy Policy

_Last updated: October 22, 2026_

LinkSpruce is a Chrome extension that helps you clean up and organize your bookmarks. This policy explains what data the extension handles and where it goes.

## Summary
- LinkSpruce has **no server, no account and no analytics**. The publisher does not receive your data.
- Your bookmarks are read and changed **on your device** through Chrome's bookmarks API.
- Data leaves your device only in two optional situations you start yourself: **link checks** (requests to the bookmarked websites) and **Gemini cloud AI** (selected fields sent to Google with your own API key, after you consent).

## Data the extension handles
| Data | Purpose | Where it is stored | Shared with |
| --- | --- | --- | --- |
| Bookmark titles, URLs, folders, creation dates | Duplicate detection, link checks, categorization, organization, backups | Locally in Chrome extension storage | No one, except as described below |
| Link-check results (status codes, final URL, page title/description/canonical link from the first 256 KB of HTML) | Show link health; improve duplicate detection and categorization | Locally | No one |
| Categories, rules, your manual choices, activity log, operation journal, snapshots | Organization, undo and recovery | Locally | No one |
| Optional Gemini API key | Authenticate your own requests to Google | In memory for the browser session (default), or in local extension storage if you choose "Remember" | Sent only to Google's Gemini API in a request header |

## Link checks (optional)
When you start a link check, LinkSpruce sends HTTP requests directly from your browser to the websites in your bookmarks (HEAD and, when needed, a limited GET). Requests are sent **without cookies or login credentials**. The websites will see these requests and your IP address, as with any visit. Local-network addresses, URLs with embedded passwords, and URLs that look like they contain tokens or perform actions are skipped by default; automatic detection cannot recognize every sensitive URL, and you can add exclusions.

## On-device AI
Chrome's built-in AI runs entirely on your computer. Bookmark data processed this way is not sent anywhere by LinkSpruce. (Chrome downloads the model from Google once, as part of Chrome's own feature.)

## Gemini cloud AI (optional, your key)
Only after you give explicit consent, LinkSpruce sends to Google's Gemini API (`generativelanguage.googleapis.com`):
- bookmark titles (truncated to 140 characters);
- website host names and, if enabled, URL paths with query strings, fragments, credentials and ID-like segments removed;
- optionally (off by default) the last two folder names and cached page title/description;
- your category names and definitions.
Bookmarks in folders you exclude from AI are never sent. Google processes this data under the Gemini API terms associated with your key; on free tiers Google may use submitted content to improve its products. You can withdraw consent at any time in Settings, which stops all cloud processing. LinkSpruce requests that Google not store interactions for later retrieval (`store: false`).

## What LinkSpruce does not do
It does not collect browsing history, cookies, passwords or page contents beyond the limited link-check metadata above; does not use content scripts; does not sell, share or transfer data for advertising, credit or any purpose unrelated to its bookmark-management features; and does not use or allow human access to your data. Data use complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Retention and deletion
Data stays in your browser until you delete it. Settings & Privacy offers *Clear caches* and *Delete all LinkSpruce data*. Uninstalling the extension deletes all of its stored data, including snapshots and any stored key; your Chrome bookmarks remain. Backups you download are files you control; they contain bookmark titles and URLs (which may be private) but never API keys.

## Security
Requests to Google use HTTPS. Extension storage is protected by your Chrome profile but is not a secure vault; if you choose to remember your API key, anyone with access to your browser profile could read it.

## Children
LinkSpruce is a general-purpose productivity tool and is not directed at children.

## Changes
Material changes to data practices will be disclosed in the extension and in this policy before they take effect.

## Contact
For privacy questions, email [contact@brightarcadia.com](mailto:contact@brightarcadia.com). Support and bug reports: https://github.com/reza-ghazi/linkspruce/blob/main/SUPPORT.md
