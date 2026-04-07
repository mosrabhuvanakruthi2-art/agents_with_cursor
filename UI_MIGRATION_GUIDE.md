# CloudFuze Email Migration — UI Guide

Step-by-step process for running Gmail-to-Outlook migrations through the CloudFuze admin panel.

---

## Prerequisites

- Admin access to CloudFuze at `https://devemail.cloudfuze.com`
- Source cloud (Gmail) and destination cloud (Outlook) must be onboarded
- Admin accounts for both source and destination domains

### Account Structure

| Role | Example | Notes |
|------|---------|-------|
| Gmail Admin | `granger@cloudfuze.us` | Admin for the `cloudfuze.us` domain |
| Gmail User | `dan@cloudfuze.us` | User under `granger@cloudfuze.us` admin |
| Outlook Admin | `granger@gajha.com` | Admin for the `gajha.com` domain |
| Outlook User | `sophia@gajha.com` | User under `granger@gajha.com` admin |

Only admin accounts need to be onboarded. Users under those admins are automatically available for migration.

---

## Step 1: Onboard Clouds (One-Time Setup)

> Skip this step if Gmail and Outlook clouds are already added.

1. Log into CloudFuze: `https://devemail.cloudfuze.com`
2. Click **Clouds** in the left sidebar
3. You are on the **ADD CLOUDS** tab

### Add Gmail Cloud

4. Click the **Gmail** icon under Business Clouds
5. Authenticate with the Gmail admin account (`granger@cloudfuze.us`)
6. Grant the required permissions

### Add Outlook Cloud

7. Click the **Outlook** icon under Business Clouds
8. Authenticate with the Outlook admin account (`granger@gajha.com`)
9. Grant the required permissions

### Verify Clouds Are Added

10. Click the **MANAGE CLOUDS** tab
11. Confirm both Gmail and Outlook appear in the list
12. If either is missing, go back to ADD CLOUDS and add it

---

## Step 2: Navigate to Email Migration

1. Click **Email Migration** in the left sidebar
2. You will land on the **Selection** page (Step 1 of 5)

---

## Step 3: Selection — Choose Source and Destination Admins

### Select Source (Gmail Admin)

1. On the left panel under **Select Source**, find and select the Gmail admin
   - Example: **Granger G** (`cloudfuze.us`)

### Select Destination (Outlook Admin)

2. On the right panel under **Select Destination**, find and select the Outlook admin
   - Example: **Granger G** (`gajha.com`)

3. Click **Next** to proceed to the Mapping page

---

## Step 4: Mapping — Map Source Users to Destination Users

The Mapping page shows:
- **Source** panel (left): Lists all Gmail users under the selected admin
- **Mapped Pairs** (center): Shows currently mapped user pairs
- **Destination** panel (right): Lists all Outlook users under the selected admin

### Map Users

1. In the **Source** panel, find and click the source user checkbox
   - Example: `dan` (under `cloudfuze.us`)

2. In the **Destination** panel, find and click the destination user
   - Example: `sophia` (under `gajha.com`)

3. A new mapping will appear in the **Mapped Pairs** section:

   | Source Channel | Destination |
   |----------------|-------------|
   | dan@cloudfuze.us / | sophia@gajha.com / |

4. Check the **checkbox** next to the mapped pair to select it for migration

5. Click **Next** to proceed

---

## Step 5: Permission Mapping

1. Review the permission mapping settings (defaults are usually fine)
2. Click **Next** to proceed

---

## Step 6: Options & Preview — Configure Job Type

This is where the migration type from the frontend UI maps to CloudFuze settings:

### Migration Type Mapping

| Frontend Setting | CloudFuze Job Type | CloudFuze Options |
|------------------|--------------------|-------------------|
| **Full Migration** + Include Mail | **One-Time** | Migrate: Mail |
| **Full Migration** + Include Mail + Include Calendar | **One-Time** | Migrate: Mail + Calendar |
| **Delta Migration** + Include Mail | **Delta** | Migrate: Mail |
| **Delta Migration** + Include Mail + Include Calendar | **Delta** | Migrate: Mail + Calendar |

### Configure

1. **Job Type**: Select based on the mapping above
   - `One-Time` for Full Migration
   - `Delta` for Delta Migration

2. **Migrate Label As**: Select `Folders` (default)

3. Review the migration options

---

## Step 7: Start Migration

1. Click **Start Migration**
2. The migration job will be created and start processing
3. You will be redirected to the job status page

### Monitor Progress

- **Job Name**: `Job Created On-<timestamp>`
- **Status**: `In Progress` → `Processed`
- **Pairs**: Shows `X Pairs Migrated out of Y Pairs`

### Verify Completion

Once status shows **Processed**, check:
- **Total Count**: Number of items found in source
- **Processed Count**: Number of items migrated to destination
- Both counts should match for a successful migration

---

## Example: Full Migration (dan@cloudfuze.us → sophia@gajha.com)

| Step | Action |
|------|--------|
| 1 | Clouds > Verify Gmail + Outlook are onboarded |
| 2 | Email Migration > Selection |
| 3 | Source: Granger G (cloudfuze.us) |
| 4 | Destination: Granger G (gajha.com) |
| 5 | Next > Mapping |
| 6 | Source: dan, Destination: sophia |
| 7 | Check the mapped pair checkbox |
| 8 | Next > Permission Mapping > Next |
| 9 | Job Type: One-Time |
| 10 | Start Migration |
| 11 | Monitor until status = Processed |

---

## Troubleshooting

### "0 Pairs Migrated out of 0 Pairs"

- The source or destination user is not properly mapped
- The admin account does not have permission for the selected users
- The cloud authorization has expired — re-onboard the cloud

### "Not Matched" in Mapping

- The destination user does not exist under the selected destination admin
- Try a different destination admin that has the target user

### Migration Stuck at "In Progress"

- Check if the source account has data to migrate
- Verify cloud authorizations are still valid
- Contact CloudFuze support if the job doesn't progress after 30 minutes
