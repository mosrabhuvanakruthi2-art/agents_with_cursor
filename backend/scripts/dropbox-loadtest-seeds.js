/**
 * Upload the 60 format samples into /QA-LoadTest-500k, each a genuinely valid file of its type.
 *
 * Run BEFORE dropbox-loadtest.js, or again at any time to replace the samples in place:
 *   cd backend && node scripts/dropbox-loadtest-seeds.js
 *
 * This OVERWRITES the 60 `sample_*` files and deletes nothing. The `ld_*` files already in the
 * folder are left exactly as they are.
 *
 * The bytes come from scripts/loadtest-formats.js, which builds each format to its published spec
 * and is verified by backend/test/loadtestFormats.test.js. The earlier version of this script wrote
 * plain text under a binary extension for 36 of the 60 formats, so `sample_docx.docx` would not
 * open in Word; see that module's header for what changed and for the three validity tiers.
 *
 * Every file is uploaded with `client_modified` set to the moment it is written, so the samples
 * carry a real timestamp rather than inheriting one.
 */
const dbx = require('../src/clients/dropboxClient');
const { buildAll, MIN_BYTES } = require('./loadtest-formats');

const ROOT = process.env.LOADTEST_ROOT || '/QA-LoadTest-500k';
const EMAIL = process.env.LOADTEST_EMAIL || 'erik@filefuze.co';


(async () => {
  const formats = await buildAll();
  const memberId = await dbx.resolveTeamMemberId(EMAIL);
  await dbx.createFolder(ROOT, { asMemberId: memberId }).catch(() => {});

  console.log(`seeding ${formats.length} formats into ${ROOT} (min ${MIN_BYTES} bytes each)\n`);

  let ok = 0;
  const failed = [];
  const tiers = { real: 0, container: 0, header: 0 };

  for (const { ext, buf, validity, how } of formats) {
    const name = `sample_${ext}.${ext}`;
    try {
      await dbx.uploadFile(`${ROOT}/${name}`, buf, {
        asMemberId: memberId,
        mode: 'overwrite',
        clientModified: new Date(),
      });
      ok += 1;
      tiers[validity] += 1;
      const mark = validity === 'real' ? 'real     ' : `${validity.padEnd(9)}`;
      console.log(`  ${String(ok).padStart(2)}. ${name.padEnd(16)} ${String(buf.length).padStart(6)}b  `
        + `${mark} ${how}`);
    } catch (e) {
      failed.push(`${name}: ${String(e.message).slice(0, 90)}`);
    }
  }

  console.log(`\n${ok}/${formats.length} seeds uploaded into ${ROOT}`);
  console.log(`  real      ${tiers.real}  — opens in the format's own application`);
  console.log(`  container ${tiers.container}  — correct container, no renderable media track`);
  console.log(`  header    ${tiers.header}  — signature only; needs a proprietary encoder for more`);
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log(`   ${f}`));
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('FAILED', String(e.message).slice(0, 240));
  process.exit(1);
});
