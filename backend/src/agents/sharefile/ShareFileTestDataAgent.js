/**
 * Seeds ShareFile source data for the `sharefile → sharepoint` combination.
 *
 * Every folder below traces to BOTH a numbered feature in
 * `backend/data/feature-scope/sharefile-to-sharepoint-inscope.md` (11 features) AND to the QA team's
 * own Xray cases — the `/Smoke Test cases/Citrix to SPO` (34 cases) and `/CITRIX TO SPO-PROD`
 * (34 cases) folders in the Test Repository. The mapping is on each `_seed*` method, so a reader can
 * tell which QA cases stop being exercised if a piece is removed.
 *
 * ── Deliberate non-features, stated up front so none looks like an omission ────────────────────
 *
 *   - **Delta migration is NOT seeded.** Unlike every sibling combination, the ShareFile → SharePoint
 *     document lists only One-time (feature 1.2) — Delta is absent. The Xray repository is full of
 *     Citrix delta cases, but they belong to the OneDrive/Drive combinations whose documents do list
 *     Delta. Seeding a delta pass here would exercise behaviour nobody has declared in scope.
 *
 *   - **Permission grants ARE applied, but the verdict on them is still NOT ASSESSED.** The ladder
 *     below plants the ~20 permission cases the Xray repository names (five access levels ×
 *     root/sub × user/group) as real grants on real principals. What it does NOT do is let the
 *     validator claim those permissions arrived correctly: this combination publishes no
 *     ShareFile-role → SharePoint-role mapping, so validation/roleMaps/sharefile_to_sharepoint.js
 *     reports every grant as not-comparable, by the combination owner's decision.
 *
 *     Seeding them anyway is the point. The grants are READ at both ends and printed side by side,
 *     so a human can see what ShareFile held and what SharePoint received — which is impossible if
 *     nothing was ever granted. The moment a mapping table is published, the data these cases need
 *     is already in place and only the roleMap changes.
 *
 *     Principals are discovered from the CONNECTED ACCOUNT at run time (its employees and groups),
 *     never hardcoded and never required in env: SHAREFILE_TEST_INTERNAL_USERS / _GROUPS only
 *     express a preference when set. An account with no second user simply reports the ladder as
 *     skipped with the reason — it never fails the run and never pretends to have granted.
 *
 *   - **Google/Paper files are not seeded.** Those Xray cases ("verify by migrating the google
 *     files", "the dropbox paper files") belong to combinations with those source formats. ShareFile
 *     stores ordinary binaries and has no native document format, so there is nothing to seed.
 *
 * ── Names the SOURCE may refuse ────────────────────────────────────────────────────────────────
 *
 * The special-character and space cases deliberately use names SharePoint rejects, because feature
 * 5.1 is precisely about CloudFuze replacing them. ShareFile may refuse some of those names itself.
 * Every create is therefore recorded individually: a name ShareFile will not accept is reported as
 * `rejectedBySource`, never as seeded and never as a crash. A seeding run that silently skipped a
 * case would leave the validator reporting that feature as passing on data that was never planted.
 */
const { BaseAgent } = require('../core/BaseAgent');
const sharefileClient = require('../../clients/sharefileClient');
const { generateTestFileBuffer } = require('../../utils/testFileGenerator');
const core = require('../../validation/shared/deepContentCore');
const logger = require('../../utils/logger');
const env = require('../../config/env');

/**
 * Characters SharePoint Online rejects in an item name. Feature 5.1 says CloudFuze replaces them
 * with `_` or `-`, so each gets its own file to prove the replacement happens per character rather
 * than only for the first one found.
 *
 * `/` and `\` are excluded on purpose — they are path separators, so no cloud accepts them inside a
 * single item name and a "file" containing one would just be a folder. Testing them would test
 * nothing.
 */
const SP_ILLEGAL_CHARS = [
  { char: '#', label: 'hash' },
  { char: '%', label: 'percent' },
  { char: '&', label: 'ampersand' },
  { char: '{', label: 'brace-open' },
  { char: '}', label: 'brace-close' },
  { char: '~', label: 'tilde' },
  { char: '^', label: 'caret' },
  { char: '$', label: 'dollar' },
  { char: '@', label: 'at' },
  { char: '!', label: 'bang' },
  { char: '+', label: 'plus' },
  { char: '=', label: 'equals' },
  { char: "'", label: 'apostrophe' },
  { char: ';', label: 'semicolon' },
  { char: ',', label: 'comma' },
  { char: '[', label: 'bracket-open' },
  { char: ']', label: 'bracket-close' },
  { char: '(', label: 'paren-open' },
  { char: ')', label: 'paren-close' },
];

/**
 * Characters this test set deliberately does NOT use, and why.
 *
 * `: * ? " < > |` are the ones SharePoint most famously rejects, so they look like the obvious test
 * subjects — and an earlier version of this agent used exactly them. Verified on the live tenant on
 * 2026-09-10, ShareFile SANITISES them on write: a file created as `sp-char-colon-:-file.txt` is
 * stored as `sp-char-colon--file.txt`, and `"` becomes `'`. The source cannot hold them, so nothing
 * reaches the destination to be replaced and feature 5.1 would be tested against names that never
 * contained the character. The set above is the one ShareFile preserves, and it matches the folder
 * the QA team actually uses — `Special &!^@%#$~(_-=+,.;')[]$%^` in figure 5.1.1 of the feature
 * document.
 *
 * The same applies to LEADING and TRAILING SPACES (Xray: "leading space file", "trailing space
 * folder"): ShareFile trims them on write, so only a space before a file extension survives. Those
 * cases are seeded anyway and the result reports whether the name actually landed as asked — a case
 * that cannot be exercised from this source must be visible, not silently absent.
 */
const SP_CHARS_SOURCE_STRIPS = [':', '*', '?', '"', '<', '>', '|'];

/** Formats the "all file formats" Xray cases name. Each is real, openable content. */
const FILE_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'csv', 'txt', 'zip'];

/**
 * The permission ladder — the five access levels the Xray cases step through. Each rung is a strict
 * SUPERSET of the one before, which is what makes the set a ladder rather than five unrelated
 * grants: if the destination collapses two adjacent rungs into the same SharePoint role, that is
 * visible only when both exist side by side.
 *
 * ── Two deviations from the Xray wording, both forced by ShareFile and both verified live ──────
 *
 * The cases read "view / +upload / +download / +admin / +delete", which puts admin BELOW delete.
 * ShareFile will not store that rung. Probed on the live tenant on 2026-09-11: a grant of
 * `CanManagePermissions` with `CanDelete` false is accepted with HTTP 200 and then silently stored
 * WITHOUT the manage flag — rung 4 would have been an identical copy of rung 3, and two rungs that
 * are byte-identical at the source prove nothing whatever about the destination. Delete and admin
 * are therefore swapped, so rung 4 adds delete and rung 5 adds admin on top of it. The five access
 * levels are unchanged; only the order they are reached in is.
 *
 * `CanAddFolder` is absent for the same reason. It is a real flag on the READ side (ShareFile
 * reports it in an item's ACL) but is not settable through AccessControls — asked for on rungs 4
 * and 5, it came back dropped every time. Sending it anyway would put a permanent "dropped
 * CanAddFolder" on two rungs of every run, training whoever reads the report to ignore the one
 * field that tells them a grant came out weaker than asked.
 *
 * Every rung is written with ALL flags stated — the ungranted ones as `false` by the client — so a
 * rung cannot quietly inherit a neighbour's access.
 */
/**
 * The OUT-OF-SCOPE negative control.
 *
 * Every other folder this agent seeds is a POSITIVE control: it must arrive. A suite of positive
 * controls alone cannot tell a working validator from one that says "yes" to everything — the run
 * that migrated 202 of 202 items and the run that was reported as 202 of 202 look identical from
 * inside the report.
 *
 * This folder is the other half. It sits BESIDE the seeding root at the account root, not inside
 * it, so the path mapping never names it and CloudFuze has no instruction to touch it. Anything
 * from here appearing at the destination means the migration copied data it was never asked to —
 * a scope violation with no ambiguity about it.
 *
 * Deliberately NOT built from the features the document omits (Delta, Shared Links, Embedded Links,
 * Selective Versions, File Conversion). Those are absent from the document, which is not the same
 * as forbidden: if CloudFuze migrated a shared link, that would be undocumented behaviour, not a
 * defect, and failing a run on it would be inventing a rule — the mistake this repo already
 * recorded when it filed a defect over an embedded link in an unsupported file type.
 *
 * "Outside the folder you were told to migrate" needs no document. It is wrong under any reading.
 *
 * The name is deliberately unlike the seeding root: `core.namesMatch` pairs names across the two
 * clouds, and a control that could be mistaken for the thing it is controlling would be worse than
 * no control at all.
 */
const OUT_OF_SCOPE = {
  root: 'ZZ-OutOfScope-DoNotMigrate',
  /**
   * The IN-TREE out-of-scope controls, seeded inside the migrated folder.
   *
   * Different in kind from the sibling folder above. These items ARE in scope and must arrive — it
   * is a PROPERTY of them that is out of scope and must not. A shared link is the clear case: the
   * file must migrate, its link must not, and the two verdicts are independent.
   */
  inTreeFolder: '10-OutOfScope-Controls',
  sharedLinkFile: 'shared-link-source.txt',
  /** Out-of-scope feature 7. A .docx whose hyperlink points at another file in THIS account. */
  embeddedLinkFile: 'embedded-link-source.docx',
  /** The file the link points at. It must migrate; the LINK to it must not be rewritten. */
  embeddedLinkTarget: 'embedded-link-target.txt',
  files: [
    'out-of-scope-root-file.txt',
    'out-of-scope-second-file.txt',
  ],
  subfolder: 'out-of-scope-subfolder',
  subfolderFile: 'out-of-scope-nested-file.txt',
};

const PERMISSION_LADDER = [
  { n: 1, slug: 'view', flags: { CanView: true } },
  { n: 2, slug: 'view-upload', flags: { CanView: true, CanUpload: true } },
  {
    n: 3,
    slug: 'view-upload-download',
    flags: { CanView: true, CanUpload: true, CanDownload: true },
  },
  {
    n: 4,
    slug: 'view-upload-download-delete',
    flags: { CanView: true, CanUpload: true, CanDownload: true, CanDelete: true },
  },
  {
    n: 5,
    slug: 'full-control-with-admin',
    flags: {
      CanView: true, CanUpload: true, CanDownload: true, CanDelete: true,
      CanManagePermissions: true,
    },
  },
];


/**
 * A .docx carrying one hyperlink to another file in the same ShareFile account.
 *
 * Out-of-scope feature 7 (Embedded Links) is described as rewriting a link's address into the
 * destination's format. Out of scope means it must NOT happen, so the destination copy has to come
 * back with its ShareFile URL intact. A plain text file cannot express this — the link has to live
 * inside a real document part, which is why this builds an actual Word file rather than writing a
 * URL into a .txt.
 *
 * TWO links, pointing at deliberately different things:
 *
 *   IN-SCOPE      a file inside the migrated folder. Its target DOES migrate, so a destination URL
 *                 exists to rewrite to — meaning a rewrite here would be a real one, not something
 *                 the migration was unable to do.
 *   OUT-OF-SCOPE  a file in the sibling folder that is never migrated. No destination URL exists,
 *                 so this link staying unchanged proves nothing on its own and must never be read
 *                 as evidence that the feature was suppressed.
 *
 * Seeding only the second kind would make the check unfalsifiable: the link could not be rewritten
 * even by a system that wanted to. The first kind is what gives the verdict its teeth.
 *
 * `docx` is already a dependency (it writes the DOCX validation reports), so nothing new is added.
 * The link is read back with utils/docxLinks, the same helper the Dropbox combination uses for its
 * own embedded-link check — one definition of "what links does this document contain".
 */
async function buildEmbeddedLinkDocx(inScopeUrl, outOfScopeUrl) {
  const { Document, Packer, Paragraph, TextRun, ExternalHyperlink } = require('docx');
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [new TextRun({
            text: 'CloudFuze QA — Embedded Links negative control (OUT OF SCOPE)',
            bold: true,
          })],
        }),
        new Paragraph({
          children: [new TextRun(
            'The hyperlink below points at another file in the SAME ShareFile account. Embedded '
            + 'Links is an OUT-OF-SCOPE feature for ShareFile to SharePoint, so after migration this '
            + 'address must still be the ShareFile one. If it has been rewritten to a SharePoint '
            + 'address, an out-of-scope feature migrated.'
          )],
        }),
        new Paragraph({
          children: [new ExternalHyperlink({
            children: [new TextRun({ text: 'link to an IN-SCOPE file', style: 'Hyperlink' })],
            link: inScopeUrl,
          })],
        }),
        new Paragraph({
          children: [new ExternalHyperlink({
            children: [new TextRun({ text: 'link to an OUT-OF-SCOPE file', style: 'Hyperlink' })],
            link: outOfScopeUrl,
          })],
        }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

class ShareFileTestDataAgent extends BaseAgent {
  constructor() {
    super('ShareFileTestDataAgent');
    /** Per-item outcome. Everything seeded, skipped or refused lands here and reaches the report. */
    this.manifest = [];
    /** One row per permission-ladder grant that was actually written. Surfaced in the result. */
    this.grants = [];
  }

  /** Record one outcome. `status` is 'seeded' | 'rejectedBySource' | 'skipped'. */
  _record(feature, kind, path, status, detail) {
    this.manifest.push({ feature, kind, path, status, detail: detail || '' });
  }

  /**
   * Create a folder, recording the outcome. Returns the created OR existing item, or null.
   *
   * An existing folder answers HTTP 409, and this used to treat that as a refusal and return null —
   * which made the caller skip the entire branch beneath it. The effect was that re-running the
   * seeder did nothing at all past the first level: a corrected test case could never be added to a
   * tree that had already been seeded once, and the run reported success having changed nothing.
   *
   * A 409 means the folder is already there, which is the desired end state, so it is resolved by
   * listing the parent and reused. Seeding is then idempotent — safe to re-run after a fix.
   */
  async _folder(parentId, name, feature, parentPath) {
    const path = `${parentPath}/${name}`;
    try {
      const made = await sharefileClient.createFolder(this.account, parentId, name);
      if (!made?.id) throw new Error('no id returned');
      this._record(feature, 'folder', path, 'seeded');
      return { ...made, path };
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) {
        try {
          const siblings = await sharefileClient.listChildren(this.account, parentId, parentPath);
          const existing = siblings.find((s) => s.type === 'folder' && s.name === name)
            || siblings.find((s) => s.type === 'folder' && core.namesMatch(s.name, name));
          if (existing?.id) {
            this._record(feature, 'folder', path, 'seeded', 'already existed — reused');
            return { ...existing, path };
          }
        } catch (lookupErr) {
          this.log.warn(`[sharefile-seed] 409 on ${path} but lookup failed: ${lookupErr.message}`);
        }
      }
      const msg = status ? `HTTP ${status}` : err.message;
      this._record(feature, 'folder', path, 'rejectedBySource', msg);
      this.log.warn(`[sharefile-seed] folder refused: ${path} — ${msg}`);
      return null;
    }
  }

  /**
   * Upload a file, recording the outcome.
   *
   * `note` becomes readable content inside the file. A migrated file that opens and states which
   * case it belongs to can be checked by eye at the destination; a padded blob cannot, and someone
   * spot-checking SharePoint would have no way to tell a correctly migrated file from a truncated
   * one. Text-ish types carry the note verbatim; binary formats (pdf/docx/xlsx/png…) come from the
   * shared generator, which produces genuinely openable files at a target size.
   */
  async _file(parentId, name, feature, parentPath, { sizeMB = 0.02, note = '' } = {}) {
    const path = `${parentPath}/${name}`;
    try {
      const ext = (name.split('.').pop() || '').toLowerCase();
      const textish = ['txt', 'csv', 'log', 'md', 'json'].includes(ext);
      const buf = textish
        ? Buffer.from(
          `CloudFuze QA — ShareFile → SharePoint migration test\n`
          + `Feature      : ${feature}\n`
          + `Source path  : ${path}\n`
          + `Purpose      : ${note || 'content payload, so this folder is not migrated empty'}\n`
          + `Seeded at    : ${new Date().toISOString()}\n`
          + `${'-'.repeat(70)}\n`
          + `If you are reading this at the destination, the file's CONTENT survived migration,\n`
          + `not merely its name. Compare the source path above with where you found it.\n`,
          'utf8')
        : generateTestFileBuffer(name, sizeMB);
      await sharefileClient.uploadFile(this.account, parentId, name, buf);
      this._record(feature, 'file', path, 'seeded', `${buf.length} bytes`);
      return true;
    } catch (err) {
      const msg = err?.response?.status ? `HTTP ${err.response.status}` : err.message;
      this._record(feature, 'file', path, 'rejectedBySource', msg);
      this.log.warn(`[sharefile-seed] file refused: ${path} — ${msg}`);
      return false;
    }
  }

  /**
   * Plant a file in every folder that ended up empty.
   *
   * An empty folder is a weak test: it proves the folder was created at the destination and nothing
   * else. If content is lost at depth 17, a tree of empty folders still arrives looking complete —
   * the migration would appear to pass while having moved no data at that level.
   *
   * Written as a SWEEP over the re-read tree rather than as a file per `_folder()` call, so the
   * invariant holds no matter how the tree is built: any folder added later is covered without
   * anyone remembering to add a file next to it.
   */
  async _fillEmptyFolders(base) {
    let walk;
    try {
      walk = await sharefileClient.buildFolderTree(this.account, base.id, {
        rootPath: base.path, maxDepth: 40,
      });
    } catch (err) {
      this.log.warn(`[sharefile-seed] could not sweep for empty folders: ${err.message}`);
      return;
    }

    const folders = walk.items.filter((i) => i.type === 'folder');
    const parentsWithFiles = new Set(
      walk.items.filter((i) => i.type === 'file').map((f) => f.path.replace(/\/[^/]+$/, ''))
    );
    const empty = folders.filter((f) => !parentsWithFiles.has(f.path));

    if (empty.length === 0) {
      this.log.info('[sharefile-seed] no empty folders — every folder carries data');
      return;
    }

    this.log.info(`[sharefile-seed] filling ${empty.length} empty folder(s) so none migrates without data`);
    for (const f of empty) {
      const depth = f.path.split('/').filter(Boolean).length;
      await this._file(f.id, 'folder-content.txt', 'fill', f.path, {
        note: `payload for an otherwise-empty folder at depth ${depth}; proves content reached this level`,
      });
    }
  }

  async execute(context) {
    this.log = logger.child({ agent: this.name, executionId: context.executionId });
    this.account = context.sourceEmail || undefined;

    // The folder this RUN names, not a fixed setting. Precedence: the wizard's per-user rows, then
    // the resolved mappings, then the run's base folder name, and only then the SHAREFILE_TEST_ROOT
    // default. Reading the setting first meant every run seeded the same folder regardless of which
    // account or folder was chosen in the UI.
    const rootPathName = String(
      (Array.isArray(context.contentUserFolders) && context.contentUserFolders[0]
        && context.contentUserFolders[0].sourceFolderName)
      || (Array.isArray(context.userFolderMappings) && context.userFolderMappings[0]
        && context.userFolderMappings[0].sourcePath)
      || context.sourceFolderName
      || env.SHAREFILE_TEST_ROOT
      || '/QA-Automation'
    ).trim().replace(/^\/+/, '');

    // Resolve the seeding root, CREATING it when absent.
    //
    // This used to throw if the folder was missing, on the reasoning that creating it would let a
    // typo silently seed a brand-new folder while the validator read the old one. That reasoning no
    // longer holds and the guard became a bug: CleanupAgent now DELETES this folder before seeding,
    // so "missing" is the normal state at this point and the run would fail at step 1 every time.
    //
    // The typo risk it guarded against is covered elsewhere — the folder name comes from the run
    // itself (the wizard's per-user row or base name), and the validator derives its source path
    // from the same context, so both sides always agree on which folder they mean.
    const accountRoot = await sharefileClient.getRoot(this.account);
    const top = await sharefileClient.listChildren(this.account, accountRoot.id, '');
    let seedRoot = top.find((i) => i.type === 'folder' && core.namesMatch(i.name, rootPathName));
    if (!seedRoot) {
      this.log.info(`[sharefile-seed] "${rootPathName}" not present — creating it`);
      const made = await sharefileClient.createFolder(this.account, accountRoot.id, rootPathName);
      if (!made?.id) {
        throw new Error(
          `ShareFile: could not create the seeding root "${rootPathName}" under ${accountRoot.name}. `
          + 'Check the connected account can write there.'
        );
      }
      seedRoot = { ...made, path: `/${made.name || rootPathName}` };
      this._record('root', 'folder', seedRoot.path, 'seeded', 'created by the seeder');
    }

    const base = { id: seedRoot.id, path: `/${rootPathName}` };
    this.log.info(`[sharefile-seed] seeding into ${base.path} (${seedRoot.id})`);

    await this._seedRootFiles(base);
    await this._seedNestedStructure(base);
    await this._seedSpecialCharacters(base);
    await this._seedSpaces(base);
    await this._seedLongPaths(base);
    await this._seedFileFormats(base);
    await this._seedVersions(base);
    await this._seedLargeFile(base);
    await this._seedPermissionTargets(base);
    // The sibling control is planted FIRST: the embedded-link document links INTO it, so its
    // file has to exist before the document that references it is written.
    await this._seedOutOfScopeControl(accountRoot);
    await this._seedOutOfScopeFeatures(base, accountRoot);

    // Last, deliberately: it sweeps whatever the steps above actually produced, so a folder any of
    // them left empty is caught regardless of which step created it.
    await this._fillEmptyFolders(base);

    return this._buildResult(base);
  }

  /**
   * Feature 1.1 — structure. Xray: "root file from root to root", "root file from root to folder".
   * Files directly at the seeding root, so a root→root and root→folder mapping both have a subject.
   */
  async _seedRootFiles(base) {
    const f = await this._folder(base.id, '01-Root-Files', '1.1', base.path);
    if (!f) return;
    await this._file(f.id, 'root-file.txt', '1.1', f.path);
    await this._file(f.id, 'root-report.pdf', '1.1', f.path, { sizeMB: 0.1 });
    await this._file(f.id, 'root-sheet.xlsx', '1.1', f.path, { sizeMB: 0.05 });
  }

  /**
   * Feature 1.1 — nested structure. Xray: "inner file from root to root / root to folder /
   * folder to folder / folder to root", "nested structure folder from root to root / root to folder".
   *
   * A file is placed at EVERY level, not just the deepest: the Xray cases distinguish inner files by
   * which level they came from, and a single leaf file cannot tell a root→folder failure from a
   * folder→folder one.
   */
  async _seedNestedStructure(base) {
    const top = await this._folder(base.id, '02-Nested-Structure', '1.1', base.path);
    if (!top) return;
    let parent = top;
    for (let level = 1; level <= 5; level += 1) {
      const next = await this._folder(parent.id, `Level${level}`, '1.1', parent.path);
      if (!next) return;
      await this._file(next.id, `file-at-level-${level}.txt`, '1.1', next.path);
      parent = next;
    }
  }

  /**
   * Feature 5.1 — special character replacement. Xray: "special character file from root to root /
   * root to folder", "special character folder from root to root", "Verify using Special characters
   * on Sub File / Sub Folder".
   *
   * One file per illegal character, so the report names WHICH character failed to be replaced rather
   * than just that replacement is broken. Plus a folder and a sub-file, because the Xray cases treat
   * root-level and sub-level as separate tests.
   */
  async _seedSpecialCharacters(base) {
    const top = await this._folder(base.id, '03-Special-Characters', '5.1', base.path);
    if (!top) return;

    for (const { char, label } of SP_ILLEGAL_CHARS) {
      await this._file(top.id, `sp-char-${label}-${char}-file.txt`, '5.1', top.path);
    }

    // The exact folder name the QA team uses (figure 5.1.1), so our result is comparable with
    // theirs rather than being a parallel test of a different string.
    const qaName = "Special &!^@%#$~(_-=+,.;')[]";
    const weird = await this._folder(top.id, qaName, '5.1', top.path);
    if (weird) {
      await this._file(weird.id, 'sub-file-in-special-folder.txt', '5.1', weird.path,
        { note: 'sub-level file inside a special-character folder (Xray: "Special characters on Sub File")' });
      await this._file(weird.id, `sub ${qaName}.txt`, '5.1', weird.path,
        { note: 'sub-level FILE whose own name needs replacement' });
    }

    // RESERVED NAMES — the only part of feature 5.1 a ShareFile source can actually exercise.
    //
    // The 19 characters above are all ACCEPTED by SharePoint (its invalid set is " * : < > ? / \ |),
    // and the seven it does reject are stripped by ShareFile on write. The intersection is empty, so
    // those files cannot test replacement at all — they test structure and content, which is worth
    // having, but the validator must not read a 5.1 verdict off them.
    //
    // Reserved names close that gap. Probed on the live tenant on 2026-09-11: ShareFile stores
    // `con`, `nul`, `aux`, `prn`, `forms`, `com1`, `lpt1` and `desktop.ini` exactly as given, and
    // SharePoint reserves every one of them — so a correct migration has to rename them and a
    // migration that drops them is a real defect the report can now name.
    //
    // `.lock` is deliberately absent: the same probe showed ShareFile stores it as `lock`, stripping
    // the leading dot, so the case cannot be planted from this source.
    const reserved = await this._folder(top.id, 'reserved-names', '5.1', top.path);
    if (reserved) {
      for (const name of ['con', 'nul', 'aux', 'prn', 'forms', 'com1', 'lpt1']) {
        const rf = await this._folder(reserved.id, name, '5.1', reserved.path);
        if (rf) {
          await this._file(rf.id, `inside-${name}.txt`, '5.1', rf.path,
            { note: `child of a SharePoint-reserved folder name ("${name}") — proves the rename kept its contents` });
        }
      }
      await this._file(reserved.id, 'desktop.ini', '5.1', reserved.path,
        { note: 'SharePoint reserves this file name; ShareFile stores it unchanged' });
      this._record('5.1', 'note', `${reserved.path}/.lock`, 'skipped',
        'ShareFile stores ".lock" as "lock", stripping the leading dot — the case cannot be planted '
        + 'from this source');
    }

    // Seeded knowing the source strips these, so the gap is visible in the report rather than
    // absent from it. _buildResult compares what was asked for against what landed.
    for (const ch of SP_CHARS_SOURCE_STRIPS) {
      await this._file(top.id, `stripped-by-source-${ch}-file.txt`, '5.1-untestable', top.path,
        { note: `ShareFile is expected to strip "${ch}" on write; if the stored name still contains it, this case IS testable after all` });
    }
  }

  /**
   * Xray: "leading space file", "trailing space file", "leading space folder", "trailing space
   * folder". SharePoint disallows leading and trailing spaces outright, so these prove CloudFuze
   * trims rather than failing the item.
   *
   * ShareFile may trim them on creation itself — in which case the case is untestable from this
   * source, and that is reported rather than hidden: the manifest records the name asked for, and
   * verification compares it against what actually landed.
   */
  async _seedSpaces(base) {
    const top = await this._folder(base.id, '04-Spaces', '5.1', base.path);
    if (!top) return;
    await this._file(top.id, ' leading-space-file.txt', '5.1', top.path);
    await this._file(top.id, 'trailing-space-file .txt', '5.1', top.path);
    await this._folder(top.id, ' leading-space-folder', '5.1', top.path);
    await this._folder(top.id, 'trailing-space-folder ', '5.1', top.path);
  }

  /**
   * Feature 6.1 — long file/folder path. Xray: "long file path from root to root / root to folder /
   * folder to folder / folder to root", "long folder path" in the same four directions, "long folder
   * path by adding folders in Nested Structure with Short Folder names (10 to 15 characters)".
   *
   * Two distinct cases, and they fail differently:
   *   - a long PATH built from many short segments — trips SharePoint's ~400-char total limit
   *   - a long NAME in one segment — trips the 255-char per-segment limit
   * A single deep tree of long names would hit both at once and the report could not say which rule
   * relocated the item.
   */
  async _seedLongPaths(base) {
    const top = await this._folder(base.id, '05-Long-Paths', '6.1', base.path);
    if (!top) return;

    // Many short segments. 12-char names x ~30 levels comfortably exceeds 400 characters.
    const deepRoot = await this._folder(top.id, 'deep-by-count', '6.1', top.path);
    if (deepRoot) {
      // A control file at the shallow end: without it, "the deep file is missing" cannot be told
      // apart from "this whole branch is missing". Mirrors DropboxTestDataAgent._seedLongPath.
      await this._file(deepRoot.id, 'short-path-control.txt', '6.1', deepRoot.path,
        { note: 'control — a file at a SHORT path, to prove the branch itself migrated' });

      let parent = deepRoot;
      for (let i = 1; i <= 30; i += 1) {
        const next = await this._folder(parent.id, `seg-${String(i).padStart(2, '0')}-abcd`, '6.1', parent.path);
        if (!next) break;
        parent = next;
        // Checkpoints, so the report can say WHERE behaviour changed rather than only that the
        // deepest item vanished. The sweep fills the rest.
        if ([5, 10, 15, 20, 25, 30].includes(i)) {
          await this._file(parent.id, `checkpoint-depth-${i}.txt`, '6.1', parent.path,
            { note: `checkpoint at nesting depth ${i}; encoded path ${core.encodedPathLength(parent.path)} chars` });
        }
      }
      this._record('6.1', 'note', deepRoot.path, 'seeded',
        `encoded path length at leaf: ${core.encodedPathLength(parent.path)} chars (SharePoint limit 400)`);
    }

    // One very long segment, in the 200-250 char band the Xray cases name.
    const longName = `long-name-${'x'.repeat(210)}`;
    const longFolder = await this._folder(top.id, longName, '6.1', top.path);
    if (longFolder) await this._file(longFolder.id, 'file-in-long-named-folder.txt', '6.1', longFolder.path);
    await this._file(top.id, `${longName}.txt`, '6.1', top.path);
  }

  /**
   * Xray: "verify root file versions (all file formats)", "verify inner file versions (all file
   * formats)". Also underpins feature 1.1 — a structure check on one file type proves little.
   */
  async _seedFileFormats(base) {
    const top = await this._folder(base.id, '06-File-Formats', '1.1', base.path);
    if (!top) return;
    for (const ext of FILE_FORMATS) {
      await this._file(top.id, `sample-format.${ext}`, '1.1', top.path, { sizeMB: 0.05 });
    }
  }

  /**
   * Feature 4.1 — version history. Xray: "Verify 10 versions on root files", "verify root/inner file
   * versions (all file formats)", "Verify the metadata on versions in Root files".
   *
   * Versions are made by uploading the SAME name repeatedly with overwrite — that is what produces a
   * version chain rather than N separate files. Each upload carries different content and a
   * different size, so a destination that kept only one version is distinguishable from one that
   * kept all of them by size alone.
   *
   * 10 versions because that is the number the Xray case names. Feature 4.1 says ALL versions
   * migrate and records no consolidation caveat, so the validator compares counts exactly.
   */
  async _seedVersions(base) {
    const top = await this._folder(base.id, '07-Versions', '4.1', base.path);
    if (!top) return;

    const tenName = 'ten-versions.docx';
    let made = 0;
    for (let v = 1; v <= 10; v += 1) {
      const ok = await this._file(top.id, tenName, '4.1', top.path, { sizeMB: 0.02 * v });
      if (!ok) break;
      made = v;
    }
    this._record('4.1', 'note', `${top.path}/${tenName}`, made === 10 ? 'seeded' : 'skipped',
      `${made} of 10 version uploads succeeded`);

    // A shorter chain on a plain text file, to separate "versions broken" from "docx broken".
    const threeName = 'three-versions.txt';
    for (let v = 1; v <= 3; v += 1) {
      await this._file(top.id, threeName, '4.1', top.path, { sizeMB: 0.01 * v });
    }

    // Versions on an inner file — the Xray cases test root and inner separately.
    const inner = await this._folder(top.id, 'inner', '4.1', top.path);
    if (inner) {
      for (let v = 1; v <= 3; v += 1) {
        await this._file(inner.id, 'inner-versioned.xlsx', '4.1', inner.path, { sizeMB: 0.02 * v });
      }
    }
  }

  /**
   * Xray: "large size file from root to root".
   *
   * Size is configurable and defaults modestly, because this is the one case whose cost is measured
   * in minutes of upload rather than seconds — and a seeding step that appears to hang is the fastest
   * way to have someone kill a run half-planted.
   */
  async _seedLargeFile(base) {
    const top = await this._folder(base.id, '08-Large-File', '1.1', base.path);
    if (!top) return;
    const sizeMB = Number(env.SHAREFILE_LARGE_FILE_MB || 25);
    this.log.info(`[sharefile-seed] uploading large file (${sizeMB} MB) — this is the slow step`);
    await this._file(top.id, `large-file-${sizeMB}mb.pdf`, '1.1', top.path, { sizeMB });
  }

  /**
   * Features 2.1-2.4 — the PERMISSION LADDER.
   *
   * Twenty cases: five access levels x {root-level, sub-level} x {user, group}. Each gets its OWN
   * folder holding one file, so the report can name the exact rung that failed instead of saying
   * "permissions are wrong somewhere". Sharing one folder between the user and group grants would
   * halve the folder count and destroy that resolution — a folder carrying two grants cannot tell
   * you which of them did not arrive.
   *
   * The file inside each rung matters too: SharePoint applies folder permissions to contained items
   * by inheritance, so a rung with no file proves the folder ACL migrated and nothing about whether
   * anything underneath it inherited correctly.
   *
   * Nothing here fails the run. A grant ShareFile refuses (a principal without a licence, an item
   * type that will not take a flag) is recorded and the ladder continues — a half-planted ladder
   * that says which rungs exist is far more useful than an exception at rung 2.
   */
  async _seedPermissionTargets(base) {
    const top = await this._folder(base.id, '09-Permissions', '2.1', base.path);
    if (!top) return;

    // The original flat targets stay. They are what the earlier runs' reports refer to, and the
    // validator's pair list is capped at 50 items — keeping them means the cheap case is still
    // covered if the ladder below cannot be planted at all.
    const rootFolder = await this._folder(top.id, 'root-folder-permissions', '2.1', top.path);
    if (rootFolder) await this._file(rootFolder.id, 'root-perm-file.txt', '2.1', rootFolder.path);

    const subParent = await this._folder(top.id, 'sub', '2.2', top.path);
    if (subParent) {
      const subFolder = await this._folder(subParent.id, 'sub-folder-permissions', '2.2', subParent.path);
      if (subFolder) await this._file(subFolder.id, 'inner-perm-file.txt', '2.2', subFolder.path);
    }

    const principals = await this._resolvePermissionPrincipals();

    // Root level — feature 2.1 (user grants) and 2.3 (group grants).
    const ladderRoot = await this._folder(top.id, 'ladder-root', '2.1', top.path);
    if (ladderRoot) await this._grantLadder(ladderRoot, principals, 'root', '2.1', '2.3');

    // Sub level — feature 2.2. Nested one folder deeper on purpose: the Xray cases separate
    // root-folder permissions from sub-folder permissions because inheritance behaves differently.
    const ladderSubParent = await this._folder(top.id, 'ladder-sub', '2.2', top.path);
    if (ladderSubParent) {
      const nested = await this._folder(ladderSubParent.id, 'nested', '2.2', ladderSubParent.path);
      if (nested) await this._grantLadder(nested, principals, 'sub', '2.2', '2.3');
    }

    this._record('2.1-2.4', 'note', top.path, this.grants.length ? 'seeded' : 'skipped',
      this.grants.length
        ? `${this.grants.length} grant(s) applied across the permission ladder `
          + `(user: ${principals.user ? principals.user.email || principals.user.name : 'none'}, `
          + `group: ${principals.group ? principals.group.name : 'none'}). `
          + 'Permissions remain NOT ASSESSED for this combination — no published role mapping — so '
          + 'the grants are reported at both ends rather than judged.'
        : `No grants applied: ${principals.note}`);
  }

  /**
   * Pick the principals the ladder grants to, from whatever the CONNECTED ACCOUNT actually has.
   *
   * Discovery, not configuration. SHAREFILE_TEST_INTERNAL_USERS / _GROUPS express a preference when
   * someone has set them, but an unset env must not stop the ladder — otherwise the agent only works
   * on one person's machine, which is exactly the hardcoding this combination has been bitten by
   * before. Any ShareFile account that can be connected has employees and groups; those are used.
   *
   * The acting account is excluded as a grantee. It already owns the items, so granting to it writes
   * a row that was always going to be there and tests nothing.
   */
  async _resolvePermissionPrincipals() {
    const out = { user: null, group: null, note: '' };
    let acting = '';
    try {
      acting = String(sharefileClient.resolveAccount(this.account)?.email || '').toLowerCase();
    } catch {
      /* resolveAccount throws only when several accounts are connected; the listings below fail for
         the same reason and report it there. */
    }

    try {
      // Clients (external share recipients) are included: feature 2.4 is about EXTERNAL shares, and
      // an account whose only non-owner principal is a client should still exercise the ladder.
      const users = await sharefileClient.listUsers(this.account, { includeClients: true });
      const candidates = users.filter((u) => u.email && u.email !== acting && u.id);
      const preferred = (env.SHAREFILE_TEST_INTERNAL_USERS || [])
        .concat(env.SHAREFILE_TEST_EXTERNAL_USER || [])
        .map((e) => String(e).toLowerCase())
        .filter(Boolean);
      out.user = candidates.find((u) => preferred.includes(u.email)) || candidates[0] || null;
      if (!out.user) {
        out.note = `no grantee user: the account lists ${users.length} user(s) and the only one is `
          + 'the account doing the seeding, which already owns these items';
      }
    } catch (err) {
      out.note = `user listing failed (${err.message})`;
    }

    try {
      const groups = await sharefileClient.listGroups(this.account);
      const wanted = (env.SHAREFILE_TEST_GROUPS || []).map((g) => String(g).toLowerCase());
      out.group = groups.find((g) => wanted.includes(String(g.name).toLowerCase()))
        || groups.find((g) => g.id) || null;
      if (!out.group && !out.note) out.note = 'the account has no groups to grant to';
    } catch (err) {
      if (!out.note) out.note = `group listing failed (${err.message})`;
    }

    if (!out.note && (out.user || out.group)) {
      out.note = `user=${out.user ? out.user.email : 'none'}, group=${out.group ? out.group.name : 'none'}`;
    }
    this.log.info(`[sharefile-seed] permission principals — ${out.note}`);
    return out;
  }

  /**
   * Plant one full ladder (5 rungs x user + 5 rungs x group) under `parent`.
   *
   * `level` is 'root' or 'sub' and only names the folders; the difference between the two is where
   * the caller placed `parent`.
   */
  async _grantLadder(parent, principals, level, folderFeature, groupFeature) {
    const kinds = [
      { kind: 'user', principal: principals.user, feature: folderFeature },
      { kind: 'group', principal: principals.group, feature: groupFeature },
    ];

    for (const { kind, principal, feature } of kinds) {
      for (const rung of PERMISSION_LADDER) {
        const name = `${kind}-${rung.n}-${rung.slug}`;
        const folder = await this._folder(parent.id, name, feature, parent.path);
        if (!folder) continue;
        // Named after the rung so the file itself identifies the case at the destination, where the
        // folder it sits in may have been renamed by feature 5.1's replacement rules.
        await this._file(folder.id, `${name}-file.txt`, feature, folder.path, {
          note: `permission ladder: ${level}-level ${kind} grant of ${rung.slug.replace(/-/g, ' + ')}`,
        });

        if (!principal) {
          this._record(feature, 'grant', folder.path, 'skipped',
            `no ${kind} principal available on this account — folder seeded, grant not applied`);
          continue;
        }

        try {
          // `principalType` is load-bearing for groups: a group id posted as a plain principal is
          // rejected as an unknown USER. See sharefileClient FIELD.groupType.
          const res = await sharefileClient.setAccessControl(
            this.account, folder.id, principal.id, rung.flags, { principalType: kind }
          );
          const asked = res.asked.join('+');
          if (res.dropped.length) {
            // Written, but weaker than the rung asks for. Recorded as seeded (the grant exists) with
            // the shortfall named — a rung silently downgraded to a lower one would read at the
            // destination as if the migration collapsed two levels the source never held.
            this._record(feature, 'grant', folder.path, 'seeded',
              `${kind} ${principal.email || principal.name}: asked ${asked}, ShareFile stored `
              + `${res.applied.join('+') || 'nothing'} (dropped ${res.dropped.join('+')})`);
          } else {
            this._record(feature, 'grant', folder.path, 'seeded',
              `${kind} ${principal.email || principal.name}: ${asked}`);
          }
          this.grants.push({
            level,
            kind,
            rung: rung.n,
            slug: rung.slug,
            path: folder.path,
            principal: principal.email || principal.name,
            asked: res.asked,
            applied: res.applied,
            dropped: res.dropped,
          });
        } catch (err) {
          const msg = err?.response?.status ? `HTTP ${err.response.status}` : err.message;
          this._record(feature, 'grant', folder.path, 'rejectedBySource',
            `${kind} grant of ${rung.slug} refused — ${msg}`);
          this.log.warn(`[sharefile-seed] grant refused on ${folder.path}: ${msg}`);
        }
      }
    }
  }

  /**
   * Plant the OUT-OF-SCOPE feature controls that live INSIDE the migrated tree.
   *
   * The out-of-scope list for this combination has seven features; only some can be planted, and
   * the difference was measured rather than assumed:
   *
   *   Root / Inner File Permissions  NOT seedable — ShareFile answers 403 "Authorization failed:
   *                                  ItemUser" to a grant on a FILE from this account. The case is
   *                                  recorded as untestable, never as passing.
   *   Shared Links                   seedable — POST /Shares returns 200 and issues a link.
   *   In Line comment                no API to seed a per-file comment.
   *   Selective Versions / Delta     job settings, not data. Exercised by how a migration is
   *                                  REQUESTED, so nothing can be planted for them here.
   *
   * The shared-link control is deliberately placed inside the migrated folder: the FILE is in scope
   * and must arrive, while the LINK on it is out of scope and must not. A control outside the tree
   * could not make that distinction — its absence at the destination would prove nothing about
   * links, only about paths.
   */
  async _seedOutOfScopeFeatures(base, accountRoot) {
    const top = await this._folder(base.id, OUT_OF_SCOPE.inTreeFolder, 'out-of-scope', base.path);
    if (!top) return;

    // Shared Links (out-of-scope feature 5).
    const made = await this._file(top.id, OUT_OF_SCOPE.sharedLinkFile, 'out-of-scope', top.path, {
      note: 'This file carries a ShareFile SHARED LINK. The file itself is in scope and must arrive; '
        + 'the link is out of scope and must NOT. If the destination copy carries a sharing link, '
        + 'an out-of-scope feature migrated.',
    });
    if (made) {
      try {
        const kids = await sharefileClient.listChildren(this.account, top.id, top.path);
        const target = kids.find((k) => k.type === 'file' && k.name === OUT_OF_SCOPE.sharedLinkFile);
        if (target?.id) {
          const share = await sharefileClient.createShare(this.account, target.id, {
            title: 'QA negative control — shared link (out of scope)',
          });
          this._record('out-of-scope-5', 'note', `${top.path}/${OUT_OF_SCOPE.sharedLinkFile}`,
            'seeded', `shared link created (${share.id || 'no id'}) — must NOT reach the destination`);
        }
      } catch (err) {
        this._record('out-of-scope-5', 'note', top.path, 'skipped',
          `shared link not created: ${err.message}. The Shared Links control reports not exercised.`);
      }
    }

    // Embedded Links (out-of-scope feature 7).
    //
    // Two files: the TARGET, which is ordinary content and must migrate, and the DOCUMENT whose
    // hyperlink points at it. Both are in scope as files; only the link REWRITING is out of scope.
    // The target is uploaded first so its real ShareFile URL can be put inside the document — a
    // link to a made-up address would prove nothing about whether a genuine one gets rewritten.
    try {
      await this._file(top.id, OUT_OF_SCOPE.embeddedLinkTarget, 'out-of-scope', top.path, {
        note: 'the file the embedded link points at — ordinary content, must migrate normally',
      });
      const kids = await sharefileClient.listChildren(this.account, top.id, top.path);
      const target = kids.find((k) => k.type === 'file' && k.name === OUT_OF_SCOPE.embeddedLinkTarget);
      if (!target?.id) throw new Error('the link target was not found after upload');

      const acct = sharefileClient.resolveAccount(this.account);
      const host = String(acct?.host || '').replace(/^api\./, '');
      const urlFor = (id) => `https://${host}/Items(${id})`;
      const inScopeUrl = urlFor(target.id);

      // The out-of-scope target: a file in the sibling folder, which no path mapping names.
      let outOfScopeUrl = null;
      try {
        const top2 = await sharefileClient.listChildren(this.account, accountRoot.id, '');
        const sib = top2.find((i) => i.type === 'folder' && i.name === OUT_OF_SCOPE.root);
        if (sib) {
          const sibKids = await sharefileClient.listChildren(this.account, sib.id, `/${OUT_OF_SCOPE.root}`);
          const sibFile = sibKids.find((k) => k.type === 'file' && k.name === OUT_OF_SCOPE.files[0]);
          if (sibFile?.id) outOfScopeUrl = urlFor(sibFile.id);
        }
      } catch (err) {
        this.log.warn(`[sharefile-seed] could not resolve the out-of-scope link target: ${err.message}`);
      }

      // Falling back to the in-scope URL would silently turn a two-link control into a one-link one
      // and the report would claim a distinction it never planted. Recorded instead.
      if (!outOfScopeUrl) {
        this._record('out-of-scope-7', 'note', top.path, 'skipped',
          'the OUT-OF-SCOPE link target could not be resolved, so the document carries only the '
          + 'in-scope link. The report must not claim both kinds were exercised.');
      }

      const buf = await buildEmbeddedLinkDocx(inScopeUrl, outOfScopeUrl || inScopeUrl);
      await sharefileClient.uploadFile(this.account, top.id, OUT_OF_SCOPE.embeddedLinkFile, buf);

      this._record('out-of-scope-7', 'file', `${top.path}/${OUT_OF_SCOPE.embeddedLinkFile}`, 'seeded',
        `document carries ${outOfScopeUrl ? 'two hyperlinks' : 'one hyperlink'} — in-scope target `
        + `${inScopeUrl}${outOfScopeUrl ? `, out-of-scope target ${outOfScopeUrl}` : ''}. Neither may `
        + 'be rewritten at the destination: Embedded Links is out of scope for this combination.');
    } catch (err) {
      this._record('out-of-scope-7', 'note', top.path, 'skipped',
        `embedded-link control not planted: ${err.message}. The Embedded Links check reports not `
        + 'exercised rather than passing.');
      this.log.warn(`[sharefile-seed] embedded-link control not planted: ${err.message}`);
    }

    // Root / Inner File Permissions (out-of-scope features 2 and 3) — recorded as untestable.
    this._record('out-of-scope-2-3', 'note', top.path, 'skipped',
      'File-level permissions cannot be planted from this account: ShareFile answers HTTP 403 '
      + '"Authorization failed: ItemUser" to a grant on a file. Out-of-scope features 2 and 3 are '
      + 'NOT exercised — reported rather than passed.');

    this._record('out-of-scope-1-4-6', 'note', top.path, 'skipped',
      'Delta, In Line comment and Selective Versions cannot be seeded as data — the first two have '
      + 'no API to plant them and the third is a job setting. NOT exercised.');
  }

  /**
   * Plant the negative control beside the seeding root — see OUT_OF_SCOPE.
   *
   * Failure here is reported but never fatal: the control proves the validator can catch a scope
   * violation, and a run that could not plant it is worth finishing without it. What must NOT
   * happen is a run that silently skips the control and still reports the out-of-scope check as
   * passing — the validator reads the SOURCE to decide whether the control exists, so an unplanted
   * control reports `na` rather than a pass it did not earn.
   */
  async _seedOutOfScopeControl(accountRoot) {
    try {
      const top = await sharefileClient.listChildren(this.account, accountRoot.id, '');
      let root = top.find((i) => i.type === 'folder' && i.name === OUT_OF_SCOPE.root);
      if (!root) {
        const made = await sharefileClient.createFolder(this.account, accountRoot.id, OUT_OF_SCOPE.root);
        if (!made?.id) throw new Error('no id returned');
        root = { ...made, path: `/${OUT_OF_SCOPE.root}` };
      }
      const basePath = `/${OUT_OF_SCOPE.root}`;

      for (const name of OUT_OF_SCOPE.files) {
        await this._file(root.id, name, 'out-of-scope', basePath, {
          note: 'NEGATIVE CONTROL. This folder sits outside the migrated path and must NOT appear '
            + 'at the destination. If you are reading this in SharePoint, the migration copied data '
            + 'it was never asked to.',
        });
      }
      const sub = await this._folder(root.id, OUT_OF_SCOPE.subfolder, 'out-of-scope', basePath);
      if (sub) {
        await this._file(sub.id, OUT_OF_SCOPE.subfolderFile, 'out-of-scope', sub.path, {
          note: 'NEGATIVE CONTROL, one level deep — a scope violation that only copies top-level '
            + 'items would otherwise go unnoticed.',
        });
      }
      this.log.info(`[sharefile-seed] negative control planted at ${basePath} (outside the migrated folder)`);
    } catch (err) {
      this._record('out-of-scope', 'note', `/${OUT_OF_SCOPE.root}`, 'skipped',
        `could not plant the negative control: ${err.message}. The out-of-scope check will report `
        + 'na rather than pass.');
      this.log.warn(`[sharefile-seed] negative control not planted: ${err.message}`);
    }
  }

  /** Verify what actually landed, and summarise per feature. */
  async _buildResult(base) {
    // Re-read the tree rather than trusting the writes. A name the source silently TRIMMED (the
    // leading/trailing-space cases especially) was accepted by the API yet is not the name asked
    // for — and the space cases would then be testing nothing while appearing seeded.
    let planted = [];
    try {
      const walk = await sharefileClient.buildFolderTree(this.account, base.id, {
        rootPath: base.path, maxDepth: 40,
      });
      planted = walk.items;
    } catch (err) {
      this.log.warn(`[sharefile-seed] verification walk failed: ${err.message}`);
    }

    const seeded = this.manifest.filter((m) => m.status === 'seeded' && m.kind !== 'note');
    const refused = this.manifest.filter((m) => m.status === 'rejectedBySource');
    const skipped = this.manifest.filter((m) => m.status === 'skipped');

    // Names the source changed on us — reported, because a trimmed name silently retires a case.
    const askedNames = new Set(seeded.map((m) => m.path.split('/').pop()));
    const landedNames = new Set(planted.map((p) => p.name));
    const altered = [...askedNames].filter((n) => !landedNames.has(n));

    const byFeature = {};
    for (const m of this.manifest) {
      const f = byFeature[m.feature] || (byFeature[m.feature] = { seeded: 0, refused: 0, skipped: 0 });
      if (m.status === 'seeded' && m.kind !== 'note') f.seeded += 1;
      if (m.status === 'rejectedBySource') f.refused += 1;
      if (m.status === 'skipped') f.skipped += 1;
    }

    this.log.info(`[sharefile-seed] ${seeded.length} item(s) seeded, ${refused.length} refused by `
      + `ShareFile, ${planted.length} item(s) present in the tree`);

    return {
      sourceProvider: 'sharefile',
      // AgentOrchestrator gates its ENTIRE source-capture block on `rootFolderName`, and inside it
      // reads `rootFolderId` to hand CloudFuze a real folder id as fromRootId. Returning neither —
      // which this agent did — meant context.userFolderMappings was never built, so migrationClient
      // fell back to sourcePath '/' and CloudFuze scanned the whole ShareFile account instead of the
      // seeded folder. Four consecutive runs ended PROCESSED_EMPTY with totalFilesAndFolders=0 for
      // exactly this reason, each one looking like a CloudFuze or permissions problem.
      //
      // Same contract as DropboxTestDataAgent, which records the same warning in its own header.
      rootFolderName: base.path.replace(/^\/+/, ''),
      rootFolderId: base.id || null,
      seedRoot: base.path,
      counts: {
        seeded: seeded.length,
        refusedBySource: refused.length,
        skipped: skipped.length,
        presentInTree: planted.length,
        folders: planted.filter((p) => p.type === 'folder').length,
        files: planted.filter((p) => p.type === 'file').length,
      },
      byFeature,
      /**
       * Features 2.1-2.4. `expected` is the full Xray count (5 rungs x 2 levels x 2 principal
       * kinds); `applied` is what this account could actually take. They differ legitimately — an
       * account with no groups plants ten, not twenty — so both are reported rather than only the
       * count, which on its own reads as a failure.
       */
      permissionLadder: {
        expected: PERMISSION_LADDER.length * 2 * 2,
        applied: this.grants.length,
        downgraded: this.grants.filter((g) => g.dropped.length).length,
        grants: this.grants,
        assessed: false,
        note: 'Grants are seeded and read at both ends, but NOT judged: this combination publishes '
          + 'no ShareFile-role to SharePoint-role mapping. See '
          + 'validation/roleMaps/sharefile_to_sharepoint.js.',
      },
      /** Names ShareFile accepted but stored differently — those cases are NOT exercised. */
      alteredBySource: altered,
      refused,
      skipped,
      manifest: this.manifest,
      outOfScopeControl: OUT_OF_SCOPE,
      deltaSeeded: false,
      deltaNote: 'Delta is not an in-scope feature for ShareFile → SharePoint (the document lists '
        + 'One-time only), so no delta pass was seeded.',
    };
  }
}

module.exports = ShareFileTestDataAgent;
/** Shared with the validator so both sides name the same control. */
module.exports.OUT_OF_SCOPE = OUT_OF_SCOPE;
