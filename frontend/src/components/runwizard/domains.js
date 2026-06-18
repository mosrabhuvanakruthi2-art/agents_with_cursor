// Domain configuration for the Run Agent wizard.
//
// A "domain" is the kind of migration: mail, content (files/folders), or message (future).
// Each domain declares which cloud accounts you connect, and which provider services can
// act as source vs destination. Adding a new domain (e.g. 'message') is a single entry
// here plus its backend combination files — no wizard rewrite.
//
// `account` on a provider = which connected-account type (google | microsoft | box) backs
// it. User listing is done per ACCOUNT (Graph/Gmail/Box), while the migration runs against
// the finer content service (googledrive/onedrive/sharepoint/box).

export const PROVIDER_META = {
  google:      { label: 'Google Workspace', short: 'Google',     account: 'google' },
  microsoft:   { label: 'Microsoft 365',    short: 'Microsoft',  account: 'microsoft' },
  box:         { label: 'Box',              short: 'Box',        account: 'box' },
  googledrive: { label: 'Google Drive',     short: 'Drive',      account: 'google' },
  onedrive:    { label: 'OneDrive',         short: 'OneDrive',   account: 'microsoft' },
  sharepoint:  { label: 'SharePoint',       short: 'SharePoint', account: 'microsoft' },
};

export const DOMAINS = {
  mail: {
    key: 'mail',
    label: 'Mail',
    mode: 'email',
    connectAccounts: ['google', 'microsoft'],
    sourceProviders: ['google', 'microsoft'],
    destProviders: ['google', 'microsoft'],
    defaultSrc: 'google',
    defaultDst: 'microsoft',
  },
  content: {
    key: 'content',
    label: 'Content',
    mode: 'content',
    connectAccounts: ['box', 'google', 'microsoft'],
    sourceProviders: ['box', 'googledrive'],
    destProviders: ['onedrive', 'sharepoint'],
    defaultSrc: 'box',
    defaultDst: 'sharepoint',
  },
  // message: { … } — future domain; add here + backend combinations/message/*.js
};

export const DOMAIN_LIST = Object.values(DOMAINS);

/** The connected-account provider (google|microsoft|box) that backs a content/mail provider. */
export function accountProviderFor(providerKey) {
  return PROVIDER_META[providerKey]?.account || providerKey;
}
