// content: Google Shared Drive → OneDrive for Business
//
// The source is seeded by ShareddriveToOnedriveTestDataAgent: everything DriveTestDataAgent seeds
// (it resolves the Shared Drive by name from context.sourceSharedDriveName, then writes the file
// formats, nested folders and permission matrix), plus one grant at each of the four permission
// positions this combination is judged on.
//
// Those four are not a preference. A measured seed showed DriveTestDataAgent grants only on FOLDERS
// two segments deep, so 2.2 was exercised while 2.1, 2.3 and 2.4 — half this combination's
// permission features — were silently not. The shared agent is left alone because three other
// combinations depend on what it seeds.
//
// Eight in-scope features only: four migration, four permissions. Versions, shared links,
// timestamps and external shares are out of scope for this pair — see
// backend/data/feature-scope/google-shared-drive-to-onedrive-inscope.md and -outscope.md.
//
// The destination is a PERSONAL OneDrive, reached at /users/{upn}/drive rather than through a
// SharePoint site, so validation uses clients/onedriveClient. Reading it needs the Files.*
// application permission consented in the destination tenant; without it Graph answers 404
// itemNotFound and every drive in the tenant reads as "does not exist".
const { register } = require('../../agentRegistry');
const TestDataAgent = require('../../../agents/drive/ShareddriveToOnedriveTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/googleshareddriveToOnedrive');

register('content', 'googleshareddrive', 'onedrive', {
  TestDataAgent,
  ValidationAgent,
});
