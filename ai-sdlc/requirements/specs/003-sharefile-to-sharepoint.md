# 003 — Citrix ShareFile → SharePoint Online (content combination)

| Field | Value |
|---|---|
| **Status** | Draft |
| **Requested by** | Bala.Raviteja@cloudfuze.com |
| **Approved by** | |
| **Date** | 2026-09-09 (revised 2026-09-09 — destination changed from Google Shared Drive to SharePoint Online; provider key settled as `sharefile`; blocker P2 cleared) |
| **Product** | content |
| **Combination key** | `sharefile → sharepoint` |

---

## Revision note

The first draft of this document specified **Google Shared Drive** as the destination. The user has
since settled it: *"SHAREPOINT_ONLINE_BUSINESS granger@gajha.com <- SharePoint / this one only"*.
The combination is **ShareFile → SharePoint Online**. Three consequences, all reflected below:

1. **The destination half is now overwhelmingly reuse, not new build** (§Destination reuse audit).
2. **The provider key is `sharefile`, not `citrix`** — decided by live evidence from CloudFuze.
3. **Blocker P2 is cleared** — a ShareFile cloud is registered and migration is now possible.

The user also confirmed Citrix ShareFile and ShareFile are the same product
(*"my Citrix ShareFile and sharefile are same they have told me"*), so the two names in the codebase
describe one cloud, not two.

---

## Restatement of the request

**Who is blocked:** the QA engineer who wants to run a Citrix ShareFile → SharePoint Online
migration test. **What the problem is:** ShareFile is a dead tile — it renders "coming soon" on the
Connect Clouds page and cannot be connected, so it can never be picked as a source in the run
wizard, even though CloudFuze itself now offers ShareFile and a ShareFile cloud is registered and
reporting 5 of 5 users at 100%. **What outcome they want:** ShareFile connectable in our frontend the
way Google and Microsoft are — one connect card whose single sign-in makes the ShareFile provider
selectable — followed by a real `sharefile → sharepoint` combination validated to the standard of the
existing SharePoint-destination combinations.

Confirmed and recorded so it is not re-litigated: **"like Google and Microsoft" means the UX shape,
not the identity provider.** Authentication is against Citrix ShareFile's own credentials. The shape
being copied is that `googledrive`/`googleshareddrive`/`onedrive`/`sharepoint` are four provider
entries served by only **two** connect cards, so one login unlocks several providers.

---

## Problem

ShareFile is advertised in the product and cannot be used. Today:

- `frontend/src/pages/ConnectClouds.jsx:21` lists `{ key: 'citrix', name: 'Citrix ShareFile' }` with
  **no `account` key**, and `ConnectClouds.jsx:225` renders the literal string `coming soon` for
  exactly that case, with the tile styled dashed and disabled.
- `frontend/src/components/runwizard/steps.jsx:64-100` (`StepConnect.cardFor`) branches on
  `google`, `microsoft`, `box`, `dropbox` and returns `null` for anything else — so no ShareFile
  card is rendered in the wizard either.
- `frontend/src/components/runwizard/steps.jsx:169` filters the Source panel to
  `wiz.accounts.filter((a) => srcTypes.includes(a.provider))`. With no way to create a ShareFile
  connected account, the ShareFile row can never appear, whatever `CONTENT_SERVICES` offers.
- `frontend/src/pages/TestCaseGenerator.jsx:54` **already offers `'ShareFile → SharePoint Online'`**
  as a test-case combination. The product therefore already asks QA to author cases for a
  combination that cannot be connected, let alone run.

The cost: a QA engineer cannot start a single ShareFile run, and cannot tell from the UI whether
ShareFile is unimplemented, misconfigured, or broken — the tile looks identical in all three cases.
The gap is now more acute, not less: CloudFuze has the cloud connected and healthy, so ours is the
only thing missing.

## Outcome

Observably true when this is done, without reading code:

1. On Connect Clouds → Content, the ShareFile tile is **not** labelled "coming soon" and is not
   disabled. Clicking it either starts a ShareFile sign-in or returns a named configuration error —
   never silence.
2. After a successful ShareFile connect, the connected-accounts list contains a ShareFile account,
   and the run wizard's **Source** panel shows a selectable ShareFile row.
3. Selecting ShareFile as source and SharePoint as destination produces a run that either validates
   the destination and reports per-feature verdicts, **or** fails with an error naming the missing
   prerequisite. It never reports `SUCCESS` having compared nothing.
4. A ShareFile in-scope / out-of-scope document is retrievable at
   `GET /api/scope/sharefile-to-sharepoint/inscope` and `…/outscope`, and every feature verdict in a
   ShareFile run report cites an id from a scope document.

---

## Findings from the repo that change the work

Verified on branch `srinidh` at commit `7fe7caa` on 2026-09-09.

1. **`TestCaseGenerator.jsx:51-54` already lists four ShareFile combinations** — `ShareFile → MyDrive`,
   `→ Shared Drive`, `→ OneDrive`, `→ SharePoint Online`. Only the last is in scope here. This is
   further evidence the product has promised ShareFile ahead of building it.
2. **Two provider key names are already in the tree.** `ConnectClouds.jsx:400` defines a `citrix`
   badge and `ConnectClouds.jsx:401` a `sharefile` badge. Settled in favour of `sharefile` (Q1,
   now closed).
3. **The `CITRIX` hint cannot resolve the registered cloud — a concrete defect.** See the dedicated
   section below.
4. **`CONTENT_PROVIDERS` omits both keys.** `backend/src/orchestrator/AgentOrchestrator.js:48` lists
   `['box','dropbox','sharepoint','onedrive','googledrive','googleshareddrive']`. For *this* pair the
   omission is masked, because `isContentProvidersFor` matches on the **destination** `sharepoint`.
   It would bite on ShareFile→ShareFile or ShareFile→Egnyte. The comment directly above that list
   records the same class of latent omission for `googleshareddrive`.
5. **Nothing else ShareFile-related exists in the backend.** No `clients/sharefileClient.js`, no
   test-data agent, no `validation/combinations/content/sharefile*`, no `utils/contentTolerance/`
   entry, no `validation/contentRoleMap.js` ShareFile block, no env vars, no feature-scope document.
6. **`SMOKE` is not a distinct tier for content.** `backend/src/models/MigrationContext.js:118-124`
   normalizes `SMOKE` to `SANITY`. The real tiers are **SANITY** and **E2E**.
7. **A scope document needs no new surface.** `backend/src/services/scopeService.js` derives
   combination keys from filenames in `backend/data/feature-scope/`, and `scopeRoutes.js` exposes
   GET and PUT for `inscope` / `outscope` / `testdata`.

### Defect: the `CITRIX` hint cannot resolve `SHAREFILE_BUSINESS`

Live cloud on `qarelease.cloudfuze.com` as of 2026-09-09:

```
6aa10605b17d0e315c812361   SHAREFILE_BUSINESS   zara@storefuze.com
```

`backend/src/clients/migrationClient.js:812` defines
`squash = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')`, so
`squash('SHAREFILE_BUSINESS')` is `SHAREFILEBUSINESS`. The type filter at
`migrationClient.js:819-820` accepts a cloud when
`cn === h || cn.startsWith(h) || h.startsWith(cn)`.

- With hint `CITRIX`: `SHAREFILEBUSINESS` is not equal to, does not start with, and is not a prefix
  of `CITRIX`. `typedClouds` is empty.
- `CONTENT_HINTS` (`migrationClient.js:858-861`) contains `'CITRIX'`, so the guard at
  `migrationClient.js:863` fires and `findCloudId` returns `null`.

**Precise correction to the briefing I was given:** the guard *does* fire — it does not silently
pass. But it fires **wrongly**: it logs `no "citrix" cloud registered for …` and lists
`SHAREFILE_BUSINESS` among the registered clouds, then refuses. So the failure is safe (it never
migrates into the wrong cloud) but false (the cloud is registered and healthy). A `citrix`-keyed run
can never resolve this cloud.

- With hint `SHAREFILE`: `SHAREFILEBUSINESS`.startsWith(`SHAREFILE`) is **true**, so the cloud
  resolves natively with no alias needed. This is the second, independent reason to standardise on
  `sharefile` (rule 12).
- `'SHAREFILE'` must additionally be **added** to `CONTENT_HINTS`, or the cross-cloud-family
  substitution protection does not apply to ShareFile at all (rule 13). Note the existing
  `HINT_ALIASES` mechanism at `migrationClient.js:817-823` exists for exactly the "provider key
  shares no prefix with the registered cloud name" case; with the key `sharefile` no alias entry is
  required.

### Destination reuse audit — what is reuse, what is new build

Requested explicitly. Compared against a Google Shared Drive destination, switching to SharePoint
moves most of the destination half from *new build* to *reuse of proven code*.

| Destination-side concern | Status for a SharePoint destination | Evidence |
|---|---|---|
| Invalid-character set and rename prediction | **Reuse.** `invalidChars()` returns a fresh `/["*:<>?/\\|]/g` per call | `validation/destinations/sharepoint.js:29-31` |
| Reserved names | **Reuse.** `RESERVED_NAMES` set + `isReservedName()`, incl. leading `~` | `destinations/sharepoint.js:35-45` |
| Total encoded-path limit | **Reuse.** `pathLengthLimit: 400` | `destinations/sharepoint.js:80` |
| Per-segment limit | **Reuse.** `segmentLengthLimit: 255` | `destinations/sharepoint.js:81-82` |
| OneDrive treated as the same engine | **Reuse.** Documented alias | `destinations/sharepoint.js:12` |
| Tree pairing, Tier B byte hashes, timestamp/version/link comparators | **Reuse.** Provider-agnostic; the SharePoint rules were deliberately *moved out* of this file so a destination is an added file, not an edit | `validation/shared/deepContentCore.js`; rationale at `destinations/sharepoint.js:4-11` |
| Destination reader (site/library/drive traversal, permissions) | **Reuse.** `SharePointValidationAgent` + `clients/sharepointClient.js` | required at `googledriveToSharepoint.js:19` |
| Feature checklist ids and roll-up | **Reuse of the machinery** — see the scope-doc verdict below | `validation/shared/contentFunctionalityChecklist.js` |
| Canonical access-level comparison against SharePoint roles | **Reuse.** `LEVEL`, `SP_ROLE_LEVEL`, `spRolesLevel`, `compareAccess`, `expectedSpLabel` | `validation/contentRoleMap.js:19-46,236-241` |
| Cross-tenant principal matching | **Reuse.** `normPrincipalKey()` already matches a principal across tenants by local part or display name | `googledriveToSharepoint.js:29-34`, used at `:900-912` |
| Tolerance bands | **Mostly reuse of shape, new file required.** `contentTolerance/googledriveToSharepoint.js` holds real SharePoint bands to copy from, but the one-combination-per-file rule means ShareFile gets its own file | `utils/contentTolerance/index.js` auto-loads by directory scan |
| **ShareFile source reader** | **New build.** No `sharefileClient.js` exists | — |
| **ShareFile source seeding** | **New build.** No test-data agent exists | — |
| **ShareFile role → canonical level mapping** | **New build.** `contentRoleMap.js` has `BOX_*` and `DRIVE_*` blocks only | `contentRoleMap.js:236-253` |

**Net:** the destination half is reuse; the **source half is the whole build**. With a Shared Drive
destination, `deepContentCore`'s Google destination path, the Shared Drive ownership model and the
Shared-Drive-specific bands would all have been in play as well.

**Risk that this reuse framing introduces — do not template on `boxToSharepoint`.** Both
`googledriveToSharepoint.js:62` and `boxToSharepoint.js:152` declare
`static supportsDeepValidation = true`, so both look like valid references. They are not equivalent:

- `boxToSharepoint.js` is an **earlier, divergent** implementation. It extends
  `ContentReportValidationAgent`, uses **none** of `deepContentCore` or `destinations/sharepoint.js`,
  and carries its own local rules — `SP_INVALID_CHARS = /[~"#%&*:<>?/\\{|}]/g`
  (`boxToSharepoint.js:12`), a hardcoded `SP_HOSTNAME = 'filefuze.sharepoint.com'` and
  `SP_SITE_PATH = '/sites/SANITYDATAA'` (`:8-9`), and `TREE_DEPTH = 4` (`:14`).
- Its character class **contradicts** the shared rules: `destinations/sharepoint.js:17-26` records
  that `~ # % & { }` have been permitted since the 2017 special-character update, and that treating
  them as invalid produced "one wrong character class, four wrong findings" on run `6a8d53d2`.

Templating ShareFile on `boxToSharepoint` would create a **third** parallel SharePoint rename rule
and reintroduce a known-wrong character class. The reference implementation must be
`googledriveToSharepoint.js` (rule 20).

### Verdict on the missing feature-scope document — confirmed narrower, not eliminated

Asked to confirm or refute that `google-shared-drive-to-sharepoint-inscope.md` supplies much of the
destination-side feature list. **Confirmed for the destination-shaped features and the numbering;
refuted for the permission and shared-link vocabulary.**

Confirmed: that document declares 38 features, and
`contentFunctionalityChecklist.js:11-13` names it explicitly as the source of its feature set. Its
`buildIds()` list (`:476-515`) is that document, id for id — `1.1, 1.2, 2.1, 3.1, 4.1–4.9, 5.1–5.16,
6.1, 6.2, 7.1, 8.1, 9.1, 9.2, 10.1, 11.1, 12.1` = 2+1+1+9+16+2+1+1+2+1+1+1 = **38**, matching the
document's own heading counts. So the checklist machinery, categories and numbering are already
SharePoint-destination-shaped and reusable.

Refuted, and this is the residual gap:

- Features **4.2–4.8** are named in **Google Drive** role terms — "Folder Permissions: Viewer /
  Commenter / Contributor / Content Manager", "File Permissions: Viewer / Commenter / Editor".
  `contentFunctionalityChecklist.js:24-30` maps them from **Drive API** roles (`reader`, `commenter`,
  `writer`, `fileorganizer`, `organizer`). ShareFile's role vocabulary is different and not recorded
  anywhere in this repo.
- Features **5.2–5.15** are named in Google link-audience terms, including "Sync Orbit" — a
  domain-scoped Google audience. ShareFile's share/link types and audiences are unknown.
- `contentRoleMap.js` has a `BOX_*` block and a `DRIVE_*` block and **no ShareFile block**
  (`:236-253`), which is the same gap seen from the code side.

**Therefore P1 narrows from "the whole 38-feature list" to "ShareFile's source-side vocabulary".**
What is still required before Phase B can be specified:

- **The ShareFile permission role set** (every role a ShareFile share can grant) and the intended
  SharePoint role for each, per scope: root folder, root file, sub-folder, inner file, and
  external/anonymous grants.
- **The ShareFile share/link types and audiences**, and the expected SharePoint sharing-link scope
  and type for each.
- **Any ShareFile-native object with no SharePoint equivalent** (the analogue of Dropbox Paper), and
  whether it is judged or reported.
- **Version history** behaviour, and whether selective versions are in scope.
- **A non-empty out-of-scope companion document.** Mandatory per `CLAUDE.md` §2. The Dropbox in-scope
  document is on record as ambiguous precisely because six behaviours sat in the in-scope file with
  only one out-of-scope entry (`dropbox-to-google-inscope.md:279-300`).
- **A test-data specification** (the `-testdata.md` analogue) saying what must exist in the ShareFile
  source account for the in-scope features to be exercised at all.

Whether the destination-shaped features may simply be inherited from
`google-shared-drive-to-sharepoint-inscope.md` rather than restated in a ShareFile document is **Q9**
— a documentation-ownership question, not a technical one.

---

## Scope: In

- Making the ShareFile tile on Connect Clouds → Content a live, clickable connect entry instead of a
  "coming soon" placeholder.
- **One** ShareFile connect card, in both Connect Clouds and wizard Step 1, authenticating against
  Citrix ShareFile's own credentials, making every ShareFile-backed provider selectable.
- Standardising on the single provider key `sharefile` across frontend and backend, and retiring
  `citrix` as a key (the user-facing **label** may remain "Citrix ShareFile").
- Making the registered `SHAREFILE_BUSINESS` cloud resolvable, and extending the
  cross-cloud-family substitution guard to cover ShareFile.
- Registering the content combination `sharefile → sharepoint` in the agent registry, and adding the
  ShareFile key to the content-provider list.
- Deterministic, named failure behaviour while the Citrix OAuth application is unavailable.
- Honest reporting: a ShareFile run that cannot validate must fail loudly and emit no feature
  verdicts.
- Publishing the ShareFile scope documents through the existing scope surface, once supplied.
- Source-side test-data seeding, deep validation and tolerance bands for `sharefile → sharepoint`
  **once the source-side scope material exists** (Phase B).
- Automated `node + assert` tests, wired into the `&&` chain in `backend/package.json`.

## Scope: Out

- **ShareFile as a migration destination.** `CONTENT_SERVICES` backs both `sourceProviders` and
  `destProviders` (`domains.js:47-48`), so the UI will offer it; the requirement is only that
  choosing it fails clearly (rule 11). No ShareFile writer is in scope.
- **`ShareFile → MyDrive`, `ShareFile → Shared Drive`, `ShareFile → OneDrive`** — all three are
  already offered in `TestCaseGenerator.jsx:51-53` and all three are out of scope here. This
  document covers one destination: SharePoint Online.
- **Egnyte.** The other "coming soon" tile; a separate combination.
- Mail and message products. ShareFile has no mail or chat surface.
- Registering the ShareFile cloud in CloudFuze (already done — P2 cleared) and obtaining the Citrix
  OAuth application (P3, external).
- Refactoring `boxToSharepoint.js` onto the shared destination rules. It is named here as a hazard to
  avoid templating on, not as work to do. Its divergence is pre-existing and belongs to that
  combination's owner.
- Changing the `SMOKE`→`SANITY` normalization, or any existing combination's files.
- Authoring the content of the ShareFile feature-scope document. QA/product supplies it.
- Any change to `validation/shared/deepContentCore.js`, `deepMailCore.js`, `deepMessageCore.js` or
  `utils/mailMigrationComparator.js`. Adding a ShareFile block to `validation/contentRoleMap.js` is
  in scope and is called out as a shared-file change requiring review (rule 19).
- Deployment, CI/CD, infrastructure, environment provisioning.

---

## Behaviour

Rules 1–13 are **buildable and genuinely testable today**. Rules 14–20 are **blocked**, each naming
its prerequisite.

### Phase A — buildable and verifiable now

1. On Connect Clouds → Content, the ShareFile tile renders **without** the text "coming soon", is
   not `disabled`, and carries the same solid (non-dashed) border styling as the Box and Dropbox
   tiles. Its `title` attribute reads `Connect Citrix ShareFile`, not
   `Citrix ShareFile — not implemented yet`.
2. Exactly **one** ShareFile connect card is rendered per surface — one on Connect Clouds → Content
   and one in wizard Step 1. A single successful ShareFile sign-in makes **every** provider whose
   `PROVIDER_META[...].account` equals `'sharefile'` selectable in the wizard. Today that is exactly
   one provider; the rule is written on the mapping, not the count, so a future second
   ShareFile-backed provider needs no second card.
3. Requesting the ShareFile sign-in URL while the ShareFile OAuth application is **not** configured
   returns HTTP `400` with a flat body `{ "error": "<SETTING NAME> not configured" }` naming the
   missing setting — mirroring `GET /api/auth/dropbox/url`
   (`backend/src/routes/authRoutes.js:546-547`). The UI surfaces that `error` string verbatim. No
   popup is opened and no partial account is recorded.
4. Requesting the ShareFile sign-in URL while the ShareFile **subdomain / account host** is not
   configured returns HTTP `400` naming that setting specifically, with a message distinct from
   rule 3's. ShareFile API calls are host-scoped, so a client id without a host cannot authenticate.
5. After a successful ShareFile sign-in, `GET /api/auth/accounts` includes exactly one entry with
   `provider: 'sharefile'` and the signed-in ShareFile account's email. No token, refresh token,
   client secret or subdomain secret appears anywhere in that response.
6. The Connect Clouds **Manage** view displays that account as `Citrix ShareFile` (or `ShareFile`),
   never the raw lowercased key. `ACCOUNT_NAME` in `ConnectClouds.jsx:41` has no ShareFile entry
   today, so an unfixed implementation would render the bare key.
7. Disconnecting the ShareFile account removes it from `GET /api/auth/accounts`, and the ShareFile
   row disappears from the wizard's Source panel on the next poll. The tile returns to the
   unconnected state — connectable, still not "coming soon".
8. `agentRegistry.resolve('content', 'sharefile', 'sharepoint')` returns a handler set containing
   **both** a `TestDataAgent` and a `ValidationAgent`, each a defined class. (Phase A may register a
   ValidationAgent that reports "not assessed" per rule 10; it must not register `undefined`.)
9. The content-provider list in `AgentOrchestrator` contains `'sharefile'`, so
   `isContentProvidersFor` returns `true` for a ShareFile source regardless of destination — not only
   for the `sharepoint` destination that currently masks the omission.
10. A ShareFile run that has **not** performed a source-to-destination comparison reports overall
    status `FAILED`, and its report contains **zero** `pass` feature verdicts. Where a functionality
    checklist would normally be rendered, it states that features were **not assessed** and names the
    reason. A ShareFile run must never produce `SUCCESS` with an empty or unexercised checklist.
11. Selecting ShareFile as the **destination** of a content run fails before any migration is
    triggered, with an error naming the requested pair and listing the registered combinations — the
    existing `No agents registered for content: … → …` behaviour (`AgentOrchestrator.js:35-41`). It
    must not fall through to a report-only validator.
12. Cloud resolution with the hint `sharefile` against a cloud list containing
    `SHAREFILE_BUSINESS (zara@storefuze.com)` resolves to cloud id `6aa10605b17d0e315c812361`.
    Resolution with the hint `citrix` against the same list must **not** resolve — the `citrix` key is
    retired, and the current false refusal documented above must not be left reachable from a live
    combination.
13. Cloud resolution with the hint `sharefile` against a cloud list containing **no** ShareFile cloud
    (e.g. only `BOX_BUSINESS` and `G_SUITE`) refuses to substitute a different cloud family, logs the
    registered cloud names, and returns no id — i.e. `'SHAREFILE'` participates in the
    `CONTENT_HINTS` guard at `migrationClient.js:858-871`. The run ends `FAILED`, never migrating
    into the wrong cloud.

**Provider-key rename inventory (rule 12).** Every occurrence that must change to standardise on
`sharefile`, enumerated as requested:

| Location | Current | Required |
|---|---|---|
| `frontend/src/components/runwizard/domains.js:22` | `citrix: { label: 'Citrix ShareFile', short: 'ShareFile', account: 'citrix' }` | keyed `sharefile`, `account: 'sharefile'`; label may stay "Citrix ShareFile" |
| `frontend/src/components/runwizard/domains.js:29` | `CONTENT_SERVICES` contains `'citrix'` | `'sharefile'` |
| `frontend/src/components/runwizard/domains.js:46` | `connectAccounts` contains `'citrix'` | `'sharefile'` |
| `frontend/src/components/runwizard/domains.js:26` | comment naming "Dropbox/Egnyte/Citrix" | wording follows the key |
| `frontend/src/components/runwizard/steps.jsx:10` | `citrix: CitrixIcon` in `ICONS` | keyed `sharefile` |
| `frontend/src/components/runwizard/steps.jsx:1203` | `function CitrixIcon` | may keep its name (it is the Citrix brand mark) as long as the map key is `sharefile` |
| `frontend/src/components/runwizard/steps.jsx:64-100` | no ShareFile branch in `cardFor` | a `sharefile` branch (rule 2) |
| `frontend/src/pages/ConnectClouds.jsx:21` | `{ key: 'citrix', name: 'Citrix ShareFile' }`, no `account` | `{ key: 'sharefile', name: 'Citrix ShareFile', account: 'sharefile' }` |
| `frontend/src/pages/ConnectClouds.jsx:400-401` | badges for **both** `citrix` and `sharefile` | exactly one, keyed `sharefile` |
| `frontend/src/pages/ConnectClouds.jsx:41` | `ACCOUNT_NAME` has no ShareFile entry | a `sharefile` entry (rule 6) |
| `backend/src/clients/migrationClient.js:858-861` | `CONTENT_HINTS` contains `'CITRIX'` | contains `'SHAREFILE'` (rule 13); `'CITRIX'` retired |
| `backend/src/orchestrator/AgentOrchestrator.js:48` | `CONTENT_PROVIDERS` has neither key | contains `'sharefile'` (rule 9) |

`frontend/src/pages/TestCaseGenerator.jsx:51-54` uses display strings, not provider keys, and needs
no rename; only the SharePoint entry is in scope for this combination.

### Phase B — blocked; each rule names its prerequisite

> **P1 (partially satisfied)** — the destination-shaped feature list and numbering already exist in
> `google-shared-drive-to-sharepoint-inscope.md` and `contentFunctionalityChecklist.js`. Still
> required: ShareFile's **source-side** role set, share/link types and audiences, version behaviour,
> any ShareFile-native object, a non-empty out-of-scope companion, and a test-data spec. See Q9.
> **P2 — CLEARED (2026-09-09).** `SHAREFILE_BUSINESS` / `zara@storefuze.com` /
> `6aa10605b17d0e315c812361` is registered on `qarelease.cloudfuze.com`, reporting 5 of 5 users at
> 100%. Migration is now possible.
> **P3 — PENDING, expected.** No Citrix OAuth application is registered yet. The user expects to
> obtain one (*"see if i get fro dropbox, sharedrive, sharepoint then we will get for the one also no
> issue"*). Treated as pending, not refused.

14. *(P1)* Every feature verdict in a ShareFile run report carries an id and title quoted from a
    scope document. A verdict with no corresponding document id is not emitted.
15. *(P1)* Every limitation listed in the ShareFile **out-of-scope** document is reported at `INFO`
    and never contributes a `FAIL`, per `CLAUDE.md` §2.
16. *(P1, P3)* Source seeding creates, in the ShareFile source account, exactly the data named in the
    ShareFile test-data document, and the run reports the count of items created. A seeding run that
    creates zero items fails rather than proceeding to migrate nothing.
17. *(P1, P3)* The combination reports per-feature verdicts from a real source-to-destination
    comparison — i.e. it declares `static supportsDeepValidation = true` and does not fall back to the
    report-only `ContentReportValidationAgent`, which compares nothing.
18. *(P1)* Tolerance bands live in this combination's **own** file under its own combination key, so
    they are tunable independently of `googledrive_to_sharepoint` and `box_to_sharepoint`.
    Structural counts are exact: a missing or extra item is a defect, never absorbed by a tolerance.
19. *(P1)* ShareFile role → canonical access level mapping is added to
    `validation/contentRoleMap.js` as its own block alongside `BOX_*` and `DRIVE_*`, leaving the
    existing Box and Drive exports byte-identical in behaviour. This is a **shared-file change** and
    must be flagged for review: `box → sharepoint` and `googledrive → sharepoint` both depend on that
    file.
20. *(P1, P3)* Destination name and path rules come from the shared SharePoint destination rules —
    invalid set `["*:<>?/\|]`, `pathLengthLimit: 400`, `segmentLengthLimit: 255`, reserved names —
    and **not** from a combination-local copy. Specifically, `~ # % &` and `{ }` in a source name
    must be expected **preserved** at the destination; predicting them replaced is the documented
    four-wrong-findings error from run `6a8d53d2`.
21. *(P3)* A source user in `storefuze.com` is mapped to its destination user in `gajha.com` per the
    run's user mapping, and a permission granted to a source principal is checked against the mapped
    destination principal — not against the same email string. The two tenants share no domain, so
    literal email equality would report every permission missing.

---

## Combinations affected

| Combination | Product | Effect of this work |
|---|---|---|
| `sharefile → sharepoint` (ShareFile → SharePoint Online) | content | **New.** The subject of this document. New files, plus the shared-surface edits listed in the rename inventory. |
| `sharefile → onedrive` | content | Out of scope. Offered in `TestCaseGenerator.jsx:53`; must fail at registry resolution with a named error (rule 11). |
| `sharefile → googledrive` | content | Out of scope. Offered in `TestCaseGenerator.jsx:51`; must fail at registry resolution. |
| `sharefile → googleshareddrive` | content | Out of scope. Offered in `TestCaseGenerator.jsx:52`; must fail at registry resolution. This was the destination in draft 1 of this document. |
| `googledrive → sharepoint` | content | **Highest regression risk.** The reference implementation, and it shares `contentRoleMap.js` (rule 19), `destinations/sharepoint.js`, `deepContentCore.js`, `SharePointValidationAgent` and the tolerance index. No behaviour change intended. |
| `box → sharepoint` | content | Shares `contentRoleMap.js` `BOX_*` exports (rule 19) and `findCloudId`. No behaviour change intended, and explicitly **not** refactored. |
| `googleshareddrive → sharepoint` | content | Shares `findCloudId`, the content-provider list and the SharePoint destination rules. No behaviour change intended. |
| `dropbox → googleshareddrive` | content | Shares `findCloudId`, `PROVIDER_META` and the connect-card surface. No behaviour change intended. |
| `dropbox → googledrive` | content | Shares `findCloudId` and the catalog. No behaviour change intended. |
| `box → onedrive` | content | Shares the catalog and connect-card surface. No behaviour change intended. |
| `googledrive → onedrive` | content | Shares the catalog and connect-card surface; also consumes `destinations/sharepoint.js` via the OneDrive alias. No behaviour change intended. |
| Gmail→Outlook | mail | Not affected. Different product, different connect cards. |
| Outlook→Gmail | mail | Not affected. |
| Gmail→Gmail | mail | Not affected. |
| Outlook→Outlook | mail | Not affected. |
| Slack↔Teams↔Google Chat | message | Not affected. Message uses its own panel (`domains.js:56 ownPanel: true`). |

**Shared surfaces touched, flagged for review:** the `ConnectClouds.jsx` catalog,
`runwizard/steps.jsx` connect cards, `runwizard/domains.js`, `migrationClient.js` `CONTENT_HINTS`,
the `AgentOrchestrator.js` content-provider list, `validation/contentRoleMap.js`, and
`services/api.js`. `contentRoleMap.js` and `CONTENT_HINTS` are the two that can break existing
combinations at run time.

## Products / test types affected

| | SANITY | E2E |
|---|---|---|
| **mail** | Not affected | Not affected |
| **content** | Rules 1–13 must hold. Rules 14–21 must hold for whatever subset of the scope document SANITY seeds. | Rules 1–21 must hold. |
| **message** | Not affected | Not affected |

`SMOKE` is not a distinct tier: `MigrationContext.js:118-124` normalizes it to `SANITY`. A request
specifying `SMOKE` must therefore satisfy the SANITY column. Which in-scope features a SANITY
ShareFile run must exercise is **Q5**, unanswerable before the test-data document exists.

## Data changes

- **New persisted shape:** a ShareFile connected account (provider key `sharefile`, account email,
  ShareFile host/subdomain, and its OAuth tokens) alongside the existing
  Google/Microsoft/Box/Dropbox/Slack accounts. Tokens and secrets must never appear in an API
  response, a log line, a PDF/DOCX/XLSX report, or a doc.
- **New execution values:** executions may now carry `sourceProvider: 'sharefile'` and the new
  combination label. No existing field changes type or meaning.
- **Records written before this change:** unaffected and must remain readable. No ShareFile execution
  exists today, so there is nothing to migrate or backfill. Existing `RUNNING`, `CANCELLED`,
  `INTERRUPTED` and `COMPLETED` records keep their current provider values and must continue to
  render in the executions list and in reports.
- **The retired `citrix` key:** no persisted record uses it, because no ShareFile account or
  execution has ever been created. The rename therefore needs no data migration — this must be
  re-verified at implementation time rather than assumed.
- **New data files:** ShareFile feature-scope markdown under `backend/data/feature-scope/`, picked up
  automatically by `scopeService.listCombinations()` from the filename suffix. A filename whose
  suffix is not `-inscope.md` / `-outscope.md` / `-testdata.md` becomes a phantom combination whose
  every fetch 404s (`scopeService.js:8-18`), so the naming must match.
- **Mongo fallback:** unchanged. ShareFile accounts and executions must survive `getDb()` returning
  `null` exactly as the existing ones do, via the JSON fallback under `backend/data/`.

## Interface changes

- **New endpoints:** a ShareFile OAuth start URL, an OAuth callback, and a signout — one set,
  mirroring the existing Box and Dropbox sets under `/api/auth/...`. Exact paths are the architect's
  call; the observable contract is rules 3–7.
- **Changed responses:** `GET /api/auth/accounts` may include a ShareFile account.
  `GET /api/auth/status` may include a ShareFile status.
- **New frontend functions** in `frontend/src/services/api.js` for the above. It remains the only
  axios instance.
- **UI surfaces:** the Connect Clouds → Content tile becomes live; a ShareFile connect card appears in
  wizard Step 1; a ShareFile row appears in the wizard Source panel once connected.
- **New env vars:** ShareFile OAuth client id, client secret, and account subdomain/host, plus the
  test-account settings the seeding agent needs. All read through `src/config/env.js`, all added to
  the **root `.env.example` as placeholders only**. `validateEnv()` warns rather than crashes, so a
  server with no ShareFile configuration must still start and must still serve every other
  combination.
- **No new dependency.** If ShareFile's API cannot be reached with what is already installed, that is
  Q8 for the architect, not a decision made here.

## Edge cases

| Input / condition | Expected result |
|---|---|
| ShareFile OAuth client id not configured | HTTP `400`, `{ error: "<SETTING> not configured" }`, no popup, no account recorded (rule 3) |
| ShareFile subdomain/host not configured | HTTP `400` naming the host setting, message distinct from the client-id one (rule 4) |
| Subdomain configured but wrong / non-existent host | Connect fails with an error naming the host that was tried; no account recorded; no unhandled rejection |
| User closes the ShareFile popup without signing in | No account recorded; the UI stops showing "Waiting for connection…"; no toast claiming success |
| Citrix returns `access_denied` on the callback | UI shows the provider's own error message; no account recorded |
| ShareFile refresh token expired or revoked | Run fails stating the ShareFile connection must be re-authorized. Not reported as a migration defect (same class as the known Google 7-day `invalid_grant`) |
| Cloud list contains `SHAREFILE_BUSINESS`, hint `sharefile` | Resolves to `6aa10605b17d0e315c812361` (rule 12) |
| Cloud list contains `SHAREFILE_BUSINESS`, hint `citrix` | Does not resolve. The retired key must not be reachable from a live combination (rule 12) |
| Cloud list contains no ShareFile cloud, hint `sharefile` | Refuses to substitute another family; logs the registered names; run `FAILED` (rule 13) |
| Two ShareFile clouds registered on the same account | Resolution must not pick arbitrarily; it reports the ambiguity naming both cloud names |
| Same ShareFile account connected twice | Exactly one entry in `GET /api/auth/accounts`; one ShareFile row in the wizard, not two |
| Two different ShareFile accounts connected | Two entries, two selectable rows, distinguished by email |
| ShareFile source account contains **zero** items | Seeding/validation fails with "no source items"; **not** a `SUCCESS` with 0 of 0 compared (rule 10) |
| Source name with `~ # % & { }`, e.g. `Q3 #1 &2 {draft}.docx` | Expected **preserved** at the destination. Predicting replacement is the documented run-`6a8d53d2` error (rule 20) |
| Source name with `" * : < > ? / \ |` | Each replaced per the shared SharePoint rules; the predicted destination name must come from `destinations/sharepoint.js`, not a local regex |
| Source name that is a SharePoint reserved name, or begins with `~` | Handled by `isReservedName()`; reported against the special-character feature, not as missing |
| Encoded destination path exceeding 400 characters | Reported against the long-path feature per the shared 400-char rule, not silently dropped |
| Single path segment exceeding 255 characters | Reported per the 255-char segment rule |
| Source names containing emoji or non-ASCII (e.g. `Отчёт 📊.docx`) | Compared after the shared SharePoint rename prediction. Emoji are not in the invalid set, so the expected name retains them |
| Duplicate item names in one ShareFile folder | Both items paired individually; a collapse from two to one is a FAIL naming both paths |
| Permission granted to `someone@storefuze.com` | Checked against the **mapped** `gajha.com` principal, not the literal source email (rule 21) |
| Permission arriving via a ShareFile group rather than a person | Reported against the group feature; SharePoint may show the group rather than the person, and that is not a FAIL by itself |
| Very large file (> 1 GB) | Either validated by size/hash within band, or explicitly reported as skipped with the reason and size. Never silently omitted from counts |
| Zero-byte file | Paired and compared; a zero-byte source must match a zero-byte destination |
| `GET /api/scope/sharefile-to-sharepoint/inscope` before the document exists | HTTP `404`. Must not return an empty document that reads as "no features" |
| Scope key containing traversal, e.g. `..%2F..%2Fetc` | Rejected as invalid; no filesystem read outside `backend/data/feature-scope` (existing `SAFE_KEY` allow-list, `scopeService.js:38`) |

## Failure modes

| Dependency down / degraded | What the user sees |
|---|---|
| **Citrix ShareFile API** unreachable or 5xx | Connect: an error naming ShareFile and the failure; the tile stays unconnected. Mid-run: the run ends `FAILED` naming the ShareFile call that failed; no partial verdicts, no `SUCCESS` |
| **Citrix ShareFile API** rate-limits (429) | Retried with backoff through the existing outbound retry path; if still failing, `FAILED` naming ShareFile throttling — never reported as a migration defect |
| **`qarelease.cloudfuze.com`** unreachable | Run ends `FAILED` stating the content migration server could not be reached; no verdicts emitted |
| **`qarelease.cloudfuze.com`** reachable but the ShareFile cloud has been removed | Run ends `FAILED` naming the missing ShareFile cloud type and listing the registered cloud names; refuses to substitute another cloud family (rule 13) |
| **Microsoft Graph / SharePoint Online** unreachable or 5xx | Run ends `FAILED` stating the destination could not be read; the checklist reports **not assessed** rather than all-pass or all-fail. This is now the destination, so a Graph outage blocks validation — a change from draft 1, where Graph was irrelevant |
| **Microsoft Graph** returns 401/403 (consent lapsed) | Message stating the Microsoft connection must be re-authorized/re-consented. Not reported as a migration defect |
| **Microsoft Graph** throttles (429 with `Retry-After`) | Retried with backoff; if still failing, `FAILED` naming Graph throttling. Never a silent partial tree that reads as items missing |
| **Gmail / Google Drive APIs** unavailable | No effect. Neither endpoint of this combination is Google; a Google outage must not fail or block a ShareFile → SharePoint run. The known Google 7-day `invalid_grant` is likewise irrelevant here |
| **MongoDB** unavailable at startup | The HTTP server still starts (`getDb()` may return `null`); ShareFile connect and runs still work against the JSON fallback under `backend/data/`; no unhandled exception and no 500 on the accounts list |
| **MongoDB** drops mid-run | The run continues; persistence falls back; the user is told the record may not be queryable later. The run does not silently vanish, leaving an orphaned `RUNNING` execution |
| **ShareFile source-side scope material missing** | The report states the affected features were **not assessed** and names what is missing; `GET /api/scope/sharefile-to-sharepoint/inscope` returns `404`. Never an all-pass checklist |
| **OpenAI / Anthropic analysis** unavailable | Verdicts unaffected; the AI summary section is omitted or marked unavailable. AI availability must never change a pass/fail |

## Test plan

Cases 1–17 are runnable now; 18–25 require the prerequisites named.

**Phase A — runnable now**

1. `ShareFile tile is live, not coming soon` — Connect Clouds → Content: enabled, solid border, no
   "coming soon" text, title reads "Connect Citrix ShareFile".
2. `One ShareFile connect card per surface` — exactly one card on Connect Clouds and one in wizard
   Step 1; counted, not eyeballed.
3. `ShareFile connect with no client id returns 400 naming the setting` — assert status and the
   `error` string.
4. `ShareFile connect with no subdomain returns a distinct 400` — assert the two messages differ and
   each names its own setting.
5. `ShareFile connect error is shown to the user verbatim` — the `error` string appears in the UI; no
   popup opens.
6. `Connected ShareFile account appears in the accounts list and wizard Source panel` — one row, the
   correct email.
7. `No ShareFile secret in any response` — inspect the accounts and status payloads for token, secret
   and subdomain values; expect none.
8. `ShareFile account friendly name in Manage view` — shows "Citrix ShareFile"/"ShareFile", not the
   raw key.
9. `Disconnect removes the ShareFile account and its wizard row`.
10. `Registry resolves content sharefile to sharepoint` — `node + assert`; both agent classes present
    and defined.
11. `ShareFile key is in the content-provider list` — `node + assert`.
12. `ShareFile as destination fails naming the pair` — the error lists registered combinations; no
    report-only fallback.
13. `sharefile hint resolves SHAREFILE_BUSINESS` — `node + assert` against a fake cloud list
    containing `SHAREFILE_BUSINESS (zara@storefuze.com)`; expect cloud id
    `6aa10605b17d0e315c812361`. Follows `findCloudIdSafety.test.js`.
14. `citrix hint no longer resolves ShareFile` — same list, hint `citrix`; expect no resolution, and
    assert the retired key is not referenced by a registered combination.
15. `sharefile hint with no ShareFile cloud refuses to substitute` — fake list of only `BOX_BUSINESS`
    and `G_SUITE`; expect refusal plus the registered names.
16. `A ShareFile run that compared nothing is FAILED with zero pass verdicts` — asserts rule 10.
17. `No existing combination regressed` — the full `npm test` chain passes and `npm run lint` is clean
    (0 errors) in `backend/`; `npm run lint` and `npm run build` are clean in `frontend/`. Must
    include the existing `contentPermissionMatrix`, `comparePermissionsRoleMap`,
    `contentCombinationSuite`, `destinationRules` and `findCloudIdSafety` cases, since
    `contentRoleMap.js` and `CONTENT_HINTS` are shared.

**Phase B — requires P1 (source-side) and P3**

18. `ShareFile scope documents are served` — `GET /api/scope/sharefile-to-sharepoint/inscope`,
    `…/outscope`, `…/testdata` return the documents; the key appears in the combinations list.
19. `Every feature verdict cites a scope-document id` — no verdict without an id.
20. `Out-of-scope limitations report INFO and never FAIL`.
21. `Seeding creates the documented test data and reports its count` — zero items fails.
22. `Deep validation runs — the report-only fallback is not used`.
23. `Shared SharePoint destination rules are used, not a local copy` — a source name containing
    `~ # % & { }` is expected **preserved**; the 400-char and 255-char limits and the reserved-name
    list behave identically to `googledrive → sharepoint`.
24. `Cross-tenant principal mapping` — a `storefuze.com` grantee is checked against its mapped
    `gajha.com` principal; a literal-email comparison would fail this case.
25. `Box and Drive role mapping unchanged by the ShareFile block` — the existing Box→SP and
    Drive→SP role expectations are byte-identical before and after rule 19.

**Not runnable, and to be reported NOT RUN until P3 lands:** any end-to-end ShareFile migration.
P2 is cleared, so the CloudFuze side can now migrate; but without a Citrix OAuth application this
system cannot read the ShareFile source to seed or validate it, so no end-to-end pass can be claimed.
Per the standing instruction, runs are started by the requester, not by an agent.

## Assumptions

1. **The user authenticates to ShareFile with Citrix credentials.** Explicitly confirmed. No Google
   or Microsoft token can authenticate to ShareFile.
2. **"Like Google and Microsoft" means the UX shape only.** Explicitly confirmed.
3. **Citrix ShareFile and ShareFile are one product.** Explicitly confirmed by the user; corroborated
   by CloudFuze registering it as `SHAREFILE_BUSINESS`.
4. **The destination is SharePoint Online at `granger@gajha.com`** — *"this one only"*. OneDrive,
   My Drive and Shared Drive are out of scope even though `TestCaseGenerator.jsx` offers them.
5. **The source is the registered `SHAREFILE_BUSINESS` cloud, account `zara@storefuze.com`,** cloud
   id `6aa10605b17d0e315c812361`, reporting 5 of 5 users at 100%.
6. **Source and destination are unrelated tenants** — `storefuze.com` → `gajha.com`. User mapping is
   therefore mandatory, and permission comparison cannot rely on email equality (rule 21).
   `normPrincipalKey` (`googledriveToSharepoint.js:29-34`) already matches principals across tenants
   by local part or display name, so this is reuse; but `zara`→`granger` is not a local-part match,
   so an explicit mapping is still required.
7. **ShareFile is source-only** for this work.
8. **The modern SharePoint destination path is the reference** — `googledriveToSharepoint.js` +
   `deepContentCore.js` + `destinations/sharepoint.js` + `contentTolerance`. `boxToSharepoint.js` is
   explicitly not the template (rule 20).
9. **The destination-shaped features may be inherited from the existing SharePoint scope document.**
   This is the working assumption behind the narrowed P1; it is Q9 and needs a documentation owner's
   confirmation, because a wrong assumption here means unwritten features silently unvalidated.
10. **A new ShareFile connect flow follows the popup shape** used by Microsoft, Box and Dropbox
    (`steps.jsx:78-100`), not Google's typed-admin-email Domain-Wide Delegation shape — DWD is a
    Google Workspace mechanism with no ShareFile equivalent.
11. **`SMOKE` requests satisfy the SANITY column**, per `MigrationContext.js:118-124`.
12. **No new npm dependency is needed.** If ShareFile's API cannot be reached with the installed set,
    that becomes Q8 for the architect rather than a silent addition.
13. **`validateEnv()` continuing to warn rather than crash** means a developer with no ShareFile
    configuration can still run every other combination. Required, not optional.
14. **No persisted record uses the `citrix` key**, because no ShareFile account or execution has ever
    been created — so the rename needs no data migration. To be re-verified at implementation time.
15. **Phase A can ship before Phase B.** Rules 1–13 are independently valuable and independently
    testable, which is the requester's "visible progress".

## Risks

- **Highest-risk file: `backend/src/validation/contentRoleMap.js`** (rule 19). It is shared by the two
  live SharePoint-destination combinations, `box → sharepoint` and `googledrive → sharepoint`, and its
  own header warns that "the Box exports keep their original behavior — the Box→SharePoint validator
  depends on them" (`:6-7`). A ShareFile block that perturbs `LEVEL`, `spRolesLevel` or
  `compareAccess` silently changes permission verdicts for both. *This displaces `ConnectClouds.jsx`
  as the top risk: switching the destination to SharePoint moved the work onto a shared
  pass/fail-deciding file.*
- **Second: `backend/src/clients/migrationClient.js` `CONTENT_HINTS`** (rule 13). Editing the set that
  decides when to refuse a cross-family substitution affects every content combination's cloud
  resolution. The comment above it records a real incident — `'googledrive'` falling through to
  `BOX_BUSINESS` by email.
- **Third: `frontend/src/pages/ConnectClouds.jsx`.** The single catalog for all three products and
  fifteen clouds; a mistake in the `CATALOG` shape or the `account`-key contract can break the Box,
  Dropbox, Google, Microsoft or Slack tiles, including for mail and message runs.
- **Fourth: `frontend/src/components/runwizard/steps.jsx`.** ~1200 lines shared by every mail and
  content run; owns the connect cards, the source/destination picker and the content-mapping step.
- **Fifth: `backend/src/orchestrator/AgentOrchestrator.js`** (rule 9) — a list read by every content
  run.
- **Templating on the wrong SharePoint validator.** `boxToSharepoint.js` and
  `googledriveToSharepoint.js` both declare `supportsDeepValidation = true`, but the former uses a
  local `SP_INVALID_CHARS` that treats `~ # % & { }` as invalid, contradicting
  `destinations/sharepoint.js` and reproducing a documented four-wrong-findings failure. An engineer
  copying the nearest-looking analogue (Box, another third-party EFSS → SharePoint) would pick the
  wrong one.
- **A half-renamed provider key.** `citrix` appears in five frontend locations plus `CONTENT_HINTS`,
  and a `sharefile` badge already coexists. Leaving both keys live yields two tiles, two account
  types, and a registry key that never resolves.
- **Cross-tenant mapping producing false FAILs.** `storefuze.com` → `gajha.com` share no domain, and
  `zara` → `granger` is not even a local-part match, so `normPrincipalKey`'s cross-tenant fallback
  will not rescue an absent mapping. Without an explicit map, every permission reads as missing.
- **Inventing the source-side feature list.** The residual P1 gap is ShareFile's role and link
  vocabulary. Guessing it is the documented failure mode — the Dropbox scope doc records a guessed
  rule producing a false failure on 92 ordinary notification emails and a "handled as documented"
  pass printed directly above a FAIL for the same thing (`dropbox-to-google-inscope.md:279-300`).
- **P3 is the only remaining hard blocker to an end-to-end pass.** Phase B could be built and pass
  unit tests while being wrong against the live ShareFile API. Any such state must be reported as
  NOT RUN, never as passing.
- **Test-chain invisibility.** A new `backend/test/*.test.js` file not added to the `&&` chain in
  `backend/package.json` never runs. The chain currently has 40 entries.

## Not doing

- Not building ShareFile as a migration destination.
- Not building `sharefile → onedrive`, `sharefile → googledrive` or `sharefile → googleshareddrive`,
  despite all three being offered in `TestCaseGenerator.jsx:51-53`.
- Not wiring Egnyte, Webex, Meta Workplace or Viva Engage, however similar their dead tiles look.
- Not refactoring `boxToSharepoint.js` onto the shared destination rules, and not "fixing" its
  divergent character class. Named as a hazard only.
- Not authenticating to ShareFile via Google or Microsoft, and not adding a Citrix option to the
  app's own login. The app login stays Microsoft-only.
- Not modelling ShareFile with Domain-Wide Delegation.
- Not changing `validation/shared/deepContentCore.js` or any shared mail/message contract. The
  `contentRoleMap.js` addition is the one shared-file change, and it is additive only.
- Not writing the ShareFile feature-scope document's content on the team's behalf, and not resolving
  the open in-scope/out-of-scope ambiguity recorded at `dropbox-to-google-inscope.md:279`.
- Not registering clouds in CloudFuze (already done) and not creating the Citrix OAuth application.
- Not changing the SMOKE/SANITY merge, and not adding a test runner, framework or dependency.
- Not shipping a tile that opens nothing — the interim state is rules 3–5, a card whose routes return
  a specific named error.
- Not touching deployment, CI/CD or infrastructure.
- Not starting any migration run. Runs touch shared cloud data and can auto-file real CloudFuze
  tickets; the requester starts them.

---

## Closed questions

- **Q1 — provider key. CLOSED: `sharefile`.** Decided by live evidence: CloudFuze registers the cloud
  as `SHAREFILE_BUSINESS`, and `squash('SHAREFILE_BUSINESS').startsWith('SHAREFILE')` is true while
  no form of `CITRIX` matches. The user-facing label may remain "Citrix ShareFile".
- **Q3 — CloudFuze cloud registration and `cloudName`. CLOSED.** `SHAREFILE_BUSINESS`, id
  `6aa10605b17d0e315c812361`, account `zara@storefuze.com`, 5 of 5 users at 100%. The predicted
  hint-mismatch risk is confirmed real and is now rules 12–13.
- **Q4 — destination. CLOSED: SharePoint Online at `granger@gajha.com`** (*"this one only"*). Note the
  source is `zara@storefuze.com`, a different tenant — hence rule 21.

## Open questions — must be answered before the requirements gate

**Q2 (blocking Phase B, now narrowed). Who supplies ShareFile's source-side role set, share/link
types and audiences, and by when?** The destination-shaped features are already covered by
`google-shared-drive-to-sharepoint-inscope.md` and `contentFunctionalityChecklist.js`. What is missing
is ShareFile's own vocabulary plus a non-empty out-of-scope document and a test-data spec.

**Q9 (blocking Phase B; documentation ownership). May the ShareFile in-scope document inherit the
destination-shaped features from `google-shared-drive-to-sharepoint-inscope.md` by reference, or must
all 38 be restated for ShareFile?** This decides whether the new document is a short source-side
delta or a full transcription. It must not be settled by an engineer mid-implementation: a feature
that is neither inherited nor restated is a feature nobody validates.

**Q5 (affects the test plan, not the design). Which in-scope features must a SANITY ShareFile run
exercise, versus E2E only?** Answerable once the test-data document exists.

**Q6 (changes the design if the answer is "no"). Will the Citrix OAuth application authorize an
account-wide/admin scope** able to read every user's files, groups and permissions? P3 is pending and
expected, but the *scope* it grants matters: Dropbox's card requires a Business team admin for exactly
this reason (`steps.jsx:87`), and CloudFuze already reports 5 of 5 users, implying admin-level access
on its side. If only a single-user scope is available, per-user coverage is out of reach and the scope
shrinks.

**Q7 (cosmetic, user-facing).** Should the ShareFile tile, once live but unconfigured, read something
more specific than "coming soon" — e.g. "not configured" — so a QA engineer can distinguish
*unimplemented* from *misconfigured* at a glance? Rules 3–5 make the click path explicit either way;
this is about the resting state of the tile.

**Q8 (for the architect, surfaced not decided).** ShareFile's API is reachable over HTTPS with the
installed HTTP client, so no new dependency is expected. If the architect finds otherwise, that is a
new-dependency decision requiring the user's approval on the design, not an implementation choice.

**Q10 (blocking a real run, new).** What is the **user mapping** from the five `storefuze.com`
ShareFile users to `gajha.com` destination users? The two tenants are unrelated and `zara` → `granger`
is not a local-part match, so no automatic fallback applies (rule 21).
