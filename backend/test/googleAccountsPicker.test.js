/**
 * Run: npm test  (from backend/)
 */
const assert = require('assert');
const { pickCorrespondentEmail, pickCcEmail } = require('../src/utils/googleAccountsPicker');

function run() {
  const two = new Map([
    ['peter@cloudfuze.us', 't1'],
    ['other@cloudfuze.us', 't2'],
  ]);
  assert.strictEqual(pickCorrespondentEmail(two, 'peter@cloudfuze.us'), 'other@cloudfuze.us');
  assert.strictEqual(pickCorrespondentEmail(two, 'OTHER@cloudfuze.us'), 'peter@cloudfuze.us');
  assert.strictEqual(pickCorrespondentEmail(two, 'peter@cloudfuze.us'), 'other@cloudfuze.us');

  assert.strictEqual(pickCcEmail(two, 'peter@cloudfuze.us', 'other@cloudfuze.us'), 'peter@cloudfuze.us');
  assert.strictEqual(pickCcEmail(two, 'peter@cloudfuze.us', 'peter@cloudfuze.us'), 'other@cloudfuze.us');

  const three = new Map([
    ['a@x.com', '1'],
    ['b@x.com', '2'],
    ['c@x.com', '3'],
  ]);
  const cc3 = pickCcEmail(three, 'a@x.com', 'b@x.com');
  assert.ok(cc3 === 'a@x.com' || cc3 === 'c@x.com', `Cc should not be To: got ${cc3}`);

  const single = new Map([['only@x.com', 't']]);
  assert.strictEqual(pickCorrespondentEmail(single, 'only@x.com'), 'only@x.com');
  assert.strictEqual(pickCcEmail(single, 'only@x.com', 'only@x.com'), 'only@x.com');

  assert.strictEqual(pickCorrespondentEmail(new Map(), 'a@b.com'), 'a@b.com');

  console.log('googleAccountsPicker.test.js: ok');
}

run();
