'use strict';

/**
 * Box ↔ SharePoint permission role mapping for content-migration validation.
 *
 * Both sides are reduced to a canonical access LEVEL so they can be compared despite
 * different role vocabularies:
 *   FULL  (4) — owner / co-owner / full control
 *   EDIT  (3) — editor / write / contribute / upload
 *   READ  (2) — viewer / previewer / read
 *   NONE  (0) — no access
 *
 * CloudFuze maps Box roles to SharePoint roles roughly as below; we validate that the
 * destination grants AT LEAST the equivalent level for the same user.
 */
const LEVEL = { FULL: 4, EDIT: 3, READ: 2, NONE: 0 };

// Box collaboration roles → canonical level
const BOX_ROLE_LEVEL = {
  owner: 'FULL',
  'co-owner': 'FULL',
  editor: 'EDIT',
  uploader: 'EDIT',
  'viewer uploader': 'EDIT',
  'previewer uploader': 'EDIT',
  viewer: 'READ',
  previewer: 'READ',
};

// SharePoint / Graph permission roles → canonical level
const SP_ROLE_LEVEL = {
  owner: 'FULL',
  'sp.full control': 'FULL',
  'full control': 'FULL',
  write: 'EDIT',
  'sp.edit': 'EDIT',
  'sp.contribute': 'EDIT',
  contribute: 'EDIT',
  edit: 'EDIT',
  read: 'READ',
  'sp.read': 'READ',
  view: 'READ',
};

/** Human label for the SharePoint role a Box role should map to. */
const BOX_TO_SP_LABEL = {
  owner: 'Full Control',
  'co-owner': 'Full Control',
  editor: 'Edit',
  uploader: 'Contribute',
  'viewer uploader': 'Contribute',
  'previewer uploader': 'Contribute',
  viewer: 'Read',
  previewer: 'Read',
};

function boxRoleLevel(role) {
  return BOX_ROLE_LEVEL[String(role || '').toLowerCase().trim()] || 'NONE';
}

function spRolesLevel(roles) {
  let best = 'NONE';
  for (const r of roles || []) {
    const lvl = SP_ROLE_LEVEL[String(r || '').toLowerCase().trim()];
    if (lvl && LEVEL[lvl] > LEVEL[best]) best = lvl;
  }
  return best;
}

function expectedSpLabel(boxRole) {
  return BOX_TO_SP_LABEL[String(boxRole || '').toLowerCase().trim()] || 'Read';
}

/**
 * Compare a Box collaboration role against the SharePoint roles granted to the same user.
 * Returns { boxLevel, spLevel, match, expectedSpLabel }.
 * match = destination grants AT LEAST the equivalent access level.
 */
function compareAccess(boxRole, spRoles) {
  const boxLevel = boxRoleLevel(boxRole);
  const spLevel = spRolesLevel(spRoles);
  return {
    boxLevel,
    spLevel,
    match: LEVEL[spLevel] >= LEVEL[boxLevel] && LEVEL[boxLevel] > 0,
    expectedSpLabel: expectedSpLabel(boxRole),
  };
}

module.exports = { LEVEL, boxRoleLevel, spRolesLevel, expectedSpLabel, compareAccess };
