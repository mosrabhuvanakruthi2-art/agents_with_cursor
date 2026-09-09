# Clients — grouped by product

Which client file belongs to which product. Some are **shared** across products
(kept in one place on purpose — duplicating them would drift). CloudFuze server +
endpoints per product: [`../config/cloudfuzeApis.js`](../config/cloudfuzeApis.js).

## 📧 Mail (Gmail / Outlook)
| Client | Role |
|---|---|
| `devemailClient.js` | CloudFuze mail migration (devemail) — `/auth/user` → `/mail/register` → `/mail/move/initiate` → `/mail/reports` |
| `migrationClient.js` | CloudFuze mail flow + `validateUser`, cloud lookup *(also content — shared)* |
| `gmailClient.js` | Gmail Admin SDK / Gmail API — list users, seed, validate |
| `calendarClient.js` | Google Calendar (seed / validate events) |
| `cloudfuzeDocsClient.js` | CloudFuze docs lookup used during mail validation |

## 📁 Content (Box / Drive / SharePoint / OneDrive)
| Client | Role |
|---|---|
| `migrationClient.js` | CloudFuze content migration (qarelease) — `/app/login`, `/content/initiate` *(shared with mail)* |
| `boxClient.js` | Box API — list users/files, seed, clean |
| `driveClient.js` | Google Drive API (DWD) — list users/files, seed, clean |

## 💬 Message (Slack / Teams / Google Chat)
| Client | Role |
|---|---|
| `chatMigrationClient.js` | CloudFuze chat migration (s2cdev / wizard) — `messagemove/*`, `get/all/cloud` |
| `slackClient.js` | Slack Web API — list channels/DMs/users, seed, counts |
| `googleChatClient.js` | Google Chat API — spaces, messages, counts |
| `messageSeedClient.js` | Seeds test messages into source channels/DMs |
| `outlookClient.js` | Teams Graph methods (`postTeamsMessage`, `readTeamsMessages`) *(shared with mail)* |

## 🔁 Shared (used by multiple products)
| Client | Used by |
|---|---|
| `outlookClient.js` | **Mail** (Outlook mailbox) + **Message** (Teams via Graph) |
| `migrationClient.js` | **Mail** + **Content** (CloudFuze flows) |
| `oauthTokenStore.js` | **All** — Google / Microsoft / Box / Slack token storage |

## ⚙️ Infrastructure (not product-specific, not CloudFuze migration)
| Client | Role |
|---|---|
| `jiraXrayClient.js`, `xrayCloudClient.js` | Test Repository (Xray / Jira) |
| `grafanaClient.js` | Log queries for the AI agent brain |
| `neutaraClient.js` | Orchestrator integration |
