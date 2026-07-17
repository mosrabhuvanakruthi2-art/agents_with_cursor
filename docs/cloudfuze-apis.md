# CloudFuze Migration Tool APIs — by Product

Each product migrates against a **different CloudFuze server** with its own subscriber account.
Canonical config in code: [`backend/src/config/cloudfuzeApis.js`](../backend/src/config/cloudfuzeApis.js).

| Product | CloudFuze Server | Config (env / source) | Client | Agent |
|---|---|---|---|---|
| **Mail** | `devemail.cloudfuze.com/proxyservices/v1` | `MIGRATION_API_URL` + `MIGRATION_API_*` | `clients/devemailClient.js`, `clients/migrationClient.js` | `agents/migration/MigrationAgent.js` |
| **Content** | `qarelease.cloudfuze.com` | `CONTENT_MIGRATION_SERVER_URL/_EMAIL/_PASSWORD` | `clients/migrationClient.js` (content path) | `agents/migration/MigrationAgent.js` |
| **Message** | `s2cdev.cloudfuze.com/proxyservices/v1` | **wizard** `migrationServer*` (env `CHAT_MIGRATION_API_*` fallback) | `clients/chatMigrationClient.js` | `agents/message/MessageMigrationAgent.js` |

> Server URLs/credentials are in `backend/.env` (gitignored) → read by `backend/src/config/env.js`.
> Endpoint paths are coded in the client files above. Message creds come from the UI per migration — no hardcoded account.

---

## 📧 Mail — Gmail / Outlook
Base: `MIGRATION_API_URL` (`devemail.cloudfuze.com/proxyservices/v1`)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/user` | login → App JWT |
| POST | `/mail/register` | App JWT → Mail JWT |
| POST | `/mail/move/initiate` | **start mail migration** |
| GET | `/mail/reports` | poll progress |
| GET | `/mail/clouds` | connected cloud accounts |
| GET | `/users/validateUser?searchUser=` | validate subscriber |

## 📁 Content — Box / Drive / SharePoint / OneDrive
Base: `CONTENT_MIGRATION_SERVER_URL` (`qarelease.cloudfuze.com`)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/email/app/login` or `/entapp/login` | login (email + **MD5** password) |
| POST | `/content/initiate` | **start content migration** |
| POST | `/move/newmultiuser/create` | multi-user content job |
| GET | `/mail/reports` | poll progress |

## 💬 Message — Slack / Teams / Google Chat
Base: `CHAT_MIGRATION_API_URL` (`s2cdev.cloudfuze.com/proxyservices/v1`) — or the wizard's Migration Server URL

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/user` | login → userId |
| GET | `/users/{userId}/get/all/cloud` | list Slack/Teams/Chat clouds |
| GET | `/users/validateUser?searchUser=` | validate subscriber |
| GET | `/messagemove/get/slack/channel` | list channels (+ `channelDate`) |
| GET | `/messagemove/get/slackdms` | list DMs |
| POST | `/messagemove/create/messagemove/custom` | **initiate channel migration** |
| POST | `/messagemove/create` (`directOrGroupMessage=true`) | **initiate DM migration** |
| GET | `/messagemove/get/moveJob` | reports / job status |
| POST | `/messagemove/close` | close completed jobs |

---

### Notes
- **Mail** = two-step JWT (`/auth/user` → `/mail/register`). **Content** = `/app/login` with MD5 password. **Message** = `/auth/user` then `messagemove/*`.
- **Message is cloud-account based** — it resolves `get/all/cloud` IDs before initiating; mail works off email addresses directly.
- Nothing CloudFuze-API related lives in the frontend; the UI only sends the message wizard's server credentials in the request body.
