'use strict';

/**
 * findCloudId must never substitute a cloud belonging to a different account.
 *
 * On 2026-08-25 the `granger@gajha.com` SharePoint registration was removed from the qarelease
 * CloudFuze account. findCloudId's cloudName-only fallback took `typedClouds[0]` — erik@voohalu.co's
 * SharePoint cloud — and returned it as the destination. The migration pair was therefore built
 * against the wrong tenant, and CloudFuze rejected it with "destination user granger@gajha.com is not
 * provisioned; Please Make this as Licensed user". That message sent the investigation after a licence
 * problem that did not exist: Microsoft Graph confirmed the account enabled with
 * SHAREPOINT_S_DEVELOPER=Success and SHAREPOINTSTANDARD=Success.
 *
 * Guessing a destination is worse than failing. At best it wastes a 20-minute run on a misleading
 * error; at worst it writes one tenant's data into another's. The fallback is now allowed only when
 * the server exposes no email on its cloud records at all — the case it was written for.
 */

const assert = require('assert');
const mc = require('../src/clients/migrationClient');

// The real qarelease cloud list at the time of the failure.
const CLOUDS = [
  { id: 'gsd-erik', cloudName: 'GOOGLE_SHARED_DRIVES', emailId: 'erik@filefuze.co' },
  { id: 'sp-voohalu', cloudName: 'SHAREPOINT_ONLINE_BUSINESS', emailId: 'erik@voohalu.co' },
  { id: 'sp-filefuze', cloudName: 'SHAREPOINT_ONLINE_BUSINESS', emailId: 'erik@filefuze.co' },
];

// ── The regression: an unregistered account must not resolve to anything ──────
{
  const hit = mc.findCloudId(CLOUDS, 'granger@gajha.com', 'SHAREPOINT_ONLINE_BUSINESS');
  assert.strictEqual(hit, null,
    'an account with no registration of the requested type must return null, never another '
    + "account's cloud of the same type");
}

// ── Registered accounts still resolve, and to the RIGHT cloud ────────────────
{
  const sp = mc.findCloudId(CLOUDS, 'erik@filefuze.co', 'SHAREPOINT_ONLINE_BUSINESS');
  assert.ok(sp, 'a registered account must still resolve');
  assert.strictEqual(sp.id, 'sp-filefuze',
    'and must not pick the other SharePoint cloud that happens to be listed first');

  const gsd = mc.findCloudId(CLOUDS, 'erik@filefuze.co', 'GOOGLE_SHARED_DRIVES');
  assert.strictEqual(gsd.id, 'gsd-erik', 'type scoping must still work');
}

// ── The fallback the code was written for is preserved ───────────────────────
{
  // Some servers return cloud records with no email field at all. There the type is the only thing
  // available to match on, so substituting is the intended behaviour rather than a guess.
  const noEmails = [{ id: 'only-one', cloudName: 'SHAREPOINT_ONLINE_BUSINESS' }];
  const hit = mc.findCloudId(noEmails, 'anyone@anywhere.com', 'SHAREPOINT_ONLINE_BUSINESS');
  assert.ok(hit, 'with no email data anywhere, the type-only match must still be allowed');
  assert.strictEqual(hit.id, 'only-one');
}

// ── A partially-populated list still counts as "emails known" ────────────────
{
  // One record carrying an email is enough to prove the server reports them, so a miss is a real
  // miss and must not fall through to the record that happens to lack one.
  const mixed = [
    { id: 'no-email', cloudName: 'SHAREPOINT_ONLINE_BUSINESS' },
    { id: 'has-email', cloudName: 'SHAREPOINT_ONLINE_BUSINESS', emailId: 'someone@else.com' },
  ];
  const hit = mc.findCloudId(mixed, 'granger@gajha.com', 'SHAREPOINT_ONLINE_BUSINESS');
  assert.strictEqual(hit, null,
    'a mixed list must be treated as email-bearing — otherwise the blank record becomes a silent '
    + 'substitute for any unregistered account');
}

// ── Domain matching within the right type is unaffected ──────────────────────
{
  const hit = mc.findCloudId(CLOUDS, 'someoneelse@filefuze.co', 'SHAREPOINT_ONLINE_BUSINESS');
  assert.ok(hit, 'same-domain match within the requested type is still permitted');
  assert.strictEqual(hit.id, 'sp-filefuze');
}

// ── No type hint: behaviour unchanged ────────────────────────────────────────
{
  const hit = mc.findCloudId(CLOUDS, 'erik@voohalu.co', null);
  assert.ok(hit, 'without a type hint an exact email match must still resolve');
  assert.strictEqual(hit.id, 'sp-voohalu');
}

// ── Provider key → cloud name, for the pairs whose names share no prefix ─────
//
// CloudFuze calls Google My Drive "G_SUITE". The wizard's provider key is `googledrive`, and
// GOOGLEDRIVE/GSUITE share no prefix in either direction — so no cloud matched the requested type,
// the cross-type fallback took the first cloud registered to the email, and a Dropbox → My Drive run
// was sent to CloudFuze as Dropbox → BOX_BUSINESS. The path mapping then saved 0 rows and the job
// polled 60 times reporting "Total Saved Count :0".
//
// This is the real qarelease list for erik@filefuze.co, Box first exactly as the server returns it.
{
  const REAL = [
    { id: 'box-erik', cloudName: 'BOX_BUSINESS', emailId: 'erik@filefuze.co' },
    { id: 'dbx-erik', cloudName: 'DROPBOX_BUSINESS', emailId: 'erik@filefuze.co' },
    { id: 'egn-erik', cloudName: 'EGNYTE_ADMIN', emailId: 'erik@filefuze.co' },
    { id: 'gsd-erik', cloudName: 'GOOGLE_SHARED_DRIVES', emailId: 'erik@filefuze.co' },
    { id: 'gsuite-erik', cloudName: 'G_SUITE', emailId: 'erik@filefuze.co' },
    { id: 'gsuite-other', cloudName: 'G_SUITE', emailId: 'someone@cloudfuze.com' },
  ];

  const myDrive = mc.findCloudId(REAL, 'erik@filefuze.co', 'googledrive');
  assert.ok(myDrive, 'a My Drive destination must resolve');
  assert.strictEqual(myDrive.cloudName, 'G_SUITE',
    'the `googledrive` provider key must resolve to G_SUITE, never to whichever cloud is listed first');
  assert.strictEqual(myDrive.id, 'gsuite-erik', 'and to THIS account’s G_SUITE, not another’s');

  // The bug in one assertion: it must not be Box.
  assert.notStrictEqual(myDrive.cloudName, 'BOX_BUSINESS',
    'falling back to Box silently migrated Dropbox into the wrong cloud');

  // Shared Drive already matched by prefix; prove the alias did not break it.
  const shared = mc.findCloudId(REAL, 'erik@filefuze.co', 'googleshareddrive');
  assert.strictEqual(shared.cloudName, 'GOOGLE_SHARED_DRIVES',
    '`googleshareddrive` must still resolve to GOOGLE_SHARED_DRIVES, not to G_SUITE');

  // Every provider that already worked must keep working — this function is shared by all
  // content combinations, so a regression here breaks Box→SharePoint and Drive→SharePoint too.
  assert.strictEqual(mc.findCloudId(REAL, 'erik@filefuze.co', 'dropbox').cloudName, 'DROPBOX_BUSINESS');
  assert.strictEqual(mc.findCloudId(REAL, 'erik@filefuze.co', 'box').cloudName, 'BOX_BUSINESS');
  assert.strictEqual(mc.findCloudId(REAL, 'erik@filefuze.co', 'egnyte').cloudName, 'EGNYTE_ADMIN');
  assert.strictEqual(
    mc.findCloudId(CLOUDS, 'erik@filefuze.co', 'sharepoint').cloudName,
    'SHAREPOINT_ONLINE_BUSINESS'
  );
}

console.log('findCloudIdSafety.test.js: ok');
