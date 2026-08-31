const { connectMongo, getDb } = require('../src/db/mongo');
const logger = require('../src/utils/logger');
const ID = 'f6290828-b801-4c93-a6b7-da3dc74580b3';
(async () => {
  await connectMongo(logger);
  const doc = await getDb().collection('executions').findOne({ _id: ID });
  const r = doc.result || {};
  console.log('migrationFailed: ' + r.migrationFailed + '   reason: ' + (r.migrationFailureReason || '(none)'));
  const per = (r.validationSummary || {}).perUser || [];
  console.log('perUser: ' + per.length);
  for (const u of per) {
    console.log('\n===== ' + u.destinationPath + ' [' + u.status + '] =====');
    const c = (u.checks || []).find((x) => /Permissions \(features/.test(x.name));
    console.log(c ? ('PERM [' + c.status + ']: ' + String(c.detail).slice(0, 1200)) : '(no permissions row)');
  }
})().catch((e) => console.error('ERR', e.message));
