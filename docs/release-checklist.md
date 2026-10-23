# Release checklist

## Build & verify (automated)
- [ ] `npm ci`
- [ ] `npm run typecheck` — clean
- [ ] `npm run lint` — clean
- [ ] `npm test` — all unit/integration pass
- [ ] `npm run test:e2e` — all E2E pass (isolated Chromium)
- [ ] `SCALE=1 npx playwright test tests/e2e/scale.spec.ts` — 25k passes, no console errors
- [ ] `npm run package` — audit passes; note SHA-256
- [ ] Load `dist/` unpacked in branded Chrome (fresh profile): no errors on chrome://extensions; popup + all dashboard sections open

## Package inspection
- [ ] ZIP contains only manifest, html, css, js, chunks, icons (no maps, tests, private data, keys)
- [ ] Manifest permissions = bookmarks, storage, unlimitedStorage, alarms; optional host permissions http/https only; no host_permissions
- [ ] Version matches package.json and CHANGELOG

## Listing (store/listing.md)
- [ ] Title, summary, description, category
- [ ] Icon 128, ≥1 screenshot 1280×800 (synthetic data), small promo 440×280, marquee 1400×560
- [ ] Single purpose, permission justifications, remote code = No
- [ ] Data usage disclosures and certifications
- [ ] Privacy policy URL (publicly hosted, publisher details filled in)
- [ ] Support email/URL
- [ ] Reviewer instructions pasted into "Test instructions"

## Approvals (user)
- [ ] Final package and listing approved
- [ ] Publication timing: deferred (default) or automatic after approval (only if explicitly authorized)

## Submission
- [ ] Upload ZIP in the Chrome Web Store developer dashboard
- [ ] Complete Store listing, Privacy practices, Distribution (public/unlisted, regions)
- [ ] Submit for review; record item ID, version, submission time
- [ ] After approval: publish (if deferred), verify public listing, install from store in a clean profile
