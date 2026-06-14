# Quebec eSIM Telna Webhook

Node/Express service that receives Shopify `orders/paid` webhooks and provisions Telna eSIM packages.

## What This Service Does

1. Verifies the Shopify webhook HMAC signature.
2. Reads each line item's Shopify variant metafield `custom.telna_package_template_id`.
3. Finds an unused Telna eSIM ICCID in the configured Telna inventory.
4. Creates a Telna package on that ICCID using the selected package template.
5. Retrieves the Telna eUICC profile activation code.
6. Emails the customer a QR code using Resend.
7. Saves Telna provisioning details back onto the Shopify order metafields.
8. Marks the Shopify order as fulfilled.
9. Marks the order as processed so duplicate webhooks do not provision twice.

The service also has a protected cron endpoint that checks Telna package usage and emails customers once they cross the configured usage threshold.

## Runtime Files

- `index.js` - Express app, webhook route, email templates, cron route, Telna provisioning flow.
- `services/shopify.js` - Shopify Admin GraphQL helpers, metafields, locks, fulfillment, usage alert flags.
- `services/telna.js` - Telna API helpers for SIMs, packages, and eUICC profiles.
- `utils/http.js` - Small fetch wrapper with timeout support.
- `package.json` / `package-lock.json` - Node dependencies and start script.

## Required Environment Variables

Set these in Render for the deployed service.

```bash
WEBHOOK_API_SECRET=...
SHOPIFY_SHOP_DOMAIN=test-quebec-esim-2.myshopify.com
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
RESEND_API_KEY=...
EMAIL_FROM=...
TELNA_API_TOKEN=...
TELNA_BASE_URL=https://developer-api.telna.com/v2.1
TELNA_INVENTORY_ID=52399
CRON_SECRET=...
```

## Optional Environment Variables

```bash
SHOPIFY_API_VERSION=2025-01
INTERNAL_BCC=ops@example.com,admin@example.com
ALERT_EMAIL_TO=ops@example.com
TELNA_GROUP_ID=...
TELNA_DEFAULT_PACKAGE_TEMPLATE_ID=...
TELNA_LOCK_TTL_MS=900000
TELNA_REUSE_TERMINATED_ESIMS=false
TELNA_BLOCKING_PACKAGE_STATUSES=ACTIVE,NOT_ACTIVE
USAGE_ALERT_THRESHOLD_PERCENT=75
USAGE_ALERT_TEST_MODE=false
SIMULATE_CUSTOMER_EMAIL_FAILURE=false
SIMULATE_FULFILLMENT_FAILURE=false
SIMULATE_MISSING_VARIANT_TEMPLATE_ID=false
SIMULATE_MISSING_CUSTOMER_EMAIL=false
SIMULATE_NO_AVAILABLE_TELNA_ESIM=false
SIMULATE_TELNA_PACKAGE_CREATE_FAILURE=false
LOG_LEVEL=info
```

Notes:

- `TELNA_DEFAULT_PACKAGE_TEMPLATE_ID` is a sandbox fallback only. In production, each Shopify variant should have its own `custom.telna_package_template_id` metafield.
- `TELNA_INVENTORY_ID` tells the service which Telna inventory to search when choosing an unused eSIM ICCID.
- `TELNA_GROUP_ID` can narrow the search further if Telna provides separate groups/billing groups for production.
- `TELNA_REUSE_TERMINATED_ESIMS=true` is a sandbox/testing escape hatch. When enabled, the service can reuse an eSIM that has only terminated packages. Keep this disabled in production unless Telna explicitly confirms that reusing previously assigned ICCIDs is safe for your production flow.
- `TELNA_BLOCKING_PACKAGE_STATUSES` controls which package statuses prevent sandbox eSIM reuse when `TELNA_REUSE_TERMINATED_ESIMS=true`. The default is `ACTIVE,NOT_ACTIVE`.
- `USAGE_ALERT_TEST_MODE=true` enables protected cron testing parameters such as `mock_percent_used`. Keep this disabled in production.
- `SIMULATE_CUSTOMER_EMAIL_FAILURE=true` makes customer eSIM/top-up emails fail on purpose while keeping admin alerts available. Use only in sandbox testing.
- `SIMULATE_FULFILLMENT_FAILURE=true` makes Shopify fulfillment fail on purpose after Telna provisioning/email. Use only in sandbox testing.
- `SIMULATE_MISSING_VARIANT_TEMPLATE_ID=true` makes every purchased variant behave as if `custom.telna_package_template_id` were missing. Use only in sandbox testing.
- `SIMULATE_MISSING_CUSTOMER_EMAIL=true` makes the order behave as if no customer email were available. Use only in sandbox testing.
- `SIMULATE_NO_AVAILABLE_TELNA_ESIM=true` makes the next first-time purchase fail as if no unused ICCID were available. Use only in sandbox testing.
- `SIMULATE_TELNA_PACKAGE_CREATE_FAILURE=true` makes Telna package creation fail before calling Telna. Use only in sandbox testing.

## Shopify Variant Setup

Each sellable Shopify variant should have this metafield:

```text
namespace: custom
key: telna_package_template_id
type: single line text
value: <Telna package template ID>
```

Example:

```text
Product: Canada
Variant: 200MB / 1 Day
custom.telna_package_template_id = 21425998
```

Top-up behavior is automatic:

- If the Shopify customer does not have `custom.telna_iccid`, the service assigns a new Telna eSIM and sends the QR-code installation email.
- If the Shopify customer already has `custom.telna_iccid`, the service reuses that ICCID, adds the purchased package, and sends a different confirmation email without a QR code.

Optional override:

```text
namespace: custom
key: type_de_produit
type: single line text
value: new_esim
```

Use `new_esim` only if a variant should force a brand-new eSIM even for a returning customer.

## Telna Production Decisions

Confirmed operating assumptions for the Shopify integration:

- Production eSIM ICCIDs are purchased/provisioned in Telna before they can be sold. The webhook does not create ICCIDs; it selects an available ICCID from the configured Telna inventory.
- Use the current Telna inventory ID for production unless Telna later provisions a separate production inventory.
- First purchase for a customer: assign one available ICCID, create the purchased package on it, retrieve the activation code, and email the QR code.
- Returning customer/top-up: reuse the same Shopify customer `custom.telna_iccid` and create the new package on that same ICCID.
- Telna confirmed there is no known limit to how many packages can be assigned to one ICCID over time.
- Do not reuse an ICCID that previously belonged to another customer, even if all packages are terminated.
- Telna does not automatically notify when ICCID inventory is low; monitor available ICCIDs operationally.
- Keep old/inactive ICCIDs for about one year, then delete/purge inactive eSIMs after review.
- `TELNA_REUSE_TERMINATED_ESIMS=true` is sandbox-only and should be disabled before production.

## Importing Maya Plans As Telna Package Templates

The Maya CSV files can be converted into Telna package-template payloads with:

```bash
npm run telna:templates:preview
```

This reads `/Users/juliatrudel/Desktop/countries.csv` by default and writes review files to:

```text
outputs/telna-package-templates/countries-preview.csv
outputs/telna-package-templates/countries-payloads.json
```

The preview does not call Telna. It maps country names to ISO-3 country codes, converts `Data (GB)` to bytes, converts `Validity (Days)` to seconds, and marks rows that need a decision before import.

To create templates in Telna after reviewing the preview:

```bash
npm run telna:templates:create
```

To create a controlled test batch for only a few countries:

```bash
node scripts/telna-package-templates.js --create --countries Canada,Spain,Egypt
```

The importer checks existing Telna package-template names in the configured inventory before creating. Existing matches are marked as `exists` and reused instead of duplicated. Only use `--allow-duplicates` if duplicate templates are intentional.

Required environment variables for creation:

```bash
TELNA_API_TOKEN=...
TELNA_BASE_URL=https://developer-api.telna.com/v2.1
TELNA_INVENTORY_ID=...
```

Optional creation settings:

```bash
TELNA_ACTIVATION_TYPE=AUTO
TELNA_ACTIVATION_TIME_ALLOWANCE_DAYS=365
TELNA_AVAILABLE_DAYS=365
TELNA_TRAFFIC_POLICY_ID=...
TELNA_UNLIMITED_TRAFFIC_POLICY_ID=1299
TELNA_UNLIMITED_ALLOWANCE_GB_PER_DAY=5
```

Notes:

- Telna package templates do not contain Shopify pricing. Maya `WSP info` and `RRP info` are preserved in the preview/mapping files for Shopify product setup, but Telna only receives the package configuration.
- Fixed-data country plans can be imported directly. `TELNA_TRAFFIC_POLICY_ID` is optional for fixed plans; leave it empty unless Telna confirms a standard throttling policy should apply.
- Maya `Unlimited` plans are imported only when `--include-unlimited` is provided.
- The current unlimited import keeps only Maya's `Daily - 3GB per Day, then 1Mbps` plans and intentionally skips `Unlimited LITE` / `Unlimited MAX`.
- The unlimited import uses `TELNA_UNLIMITED_TRAFFIC_POLICY_ID` for throttling and `TELNA_UNLIMITED_ALLOWANCE_GB_PER_DAY` to create a high technical data allowance. Sheldon provided test traffic policy `1299`, described as `3GB per day at 20mbps, post this speed reduces to 1Mbps`.
- Do not run the full `--create --include-unlimited` import until Telna confirms the API field/value required to create package templates with Location Update (`LU`) activation. The API currently returns only `activation_type: "AUTO"` even for templates that the portal labels as PDP.
- Region plans need a confirmed list of ISO-3 countries per region before they can become Telna package templates.

Preview all fixed country plans plus the approved single unlimited option:

```bash
TELNA_UNLIMITED_TRAFFIC_POLICY_ID=1299 node scripts/telna-package-templates.js --include-unlimited
```

Expected preview shape, before any LU confirmation:

```text
rowsPrepared: 4592
rowsReadyToCreate: 3992
rowsSkippedIntentionally: 600
rowsNeedingDecision: 0
```

After Telna confirms the LU API field/value, update the template importer first, then create with:

```bash
TELNA_UNLIMITED_TRAFFIC_POLICY_ID=1299 node scripts/telna-package-templates.js --create --include-unlimited
```

## Creating Shopify Products From Telna Templates

After Telna templates have been created, use the generated mapping CSV to create Shopify products and variants.

Preview the Shopify catalog without changing Shopify:

```bash
npm run shopify:products:preview -- --countries Canada,Spain,Egypt
```

Create/update Shopify products:

```bash
npm run shopify:products:create -- --countries Canada,Spain,Egypt
```

The Shopify importer uses:

- Product title: country name, e.g. `Canada`
- Variant title: plan, e.g. `1GB / 5 Days`
- Variant price: Maya `RRP info`
- Variant inventory: not tracked (`inventoryItem.tracked = false`) so eSIM plans are not blocked by Shopify quantity `0`
- Variant shipping: disabled (`requiresShipping = false`)
- Variant metafield: `custom.telna_package_template_id`

This means the Shopify webhook can identify the exact Telna package template from the purchased variant.

## Shopify Order Metafields Written By The Service

The service writes these order metafields after provisioning:

```text
custom.telna_iccid
custom.telna_package_id
custom.telna_package_template_id
custom.telna_activation_code
custom.telna_euicc_state
custom.telna_esims_json
custom.telna_processed
custom.telna_processed_at
custom.usage_alerts_sent
```

## Error Case Test Plan

Use the sandbox store and Render logs to validate these before launch.

1. Variant missing `custom.telna_package_template_id`
   - Temporarily set `SIMULATE_MISSING_VARIANT_TEMPLATE_ID=true` in Render.
   - Redeploy/restart the web service.
   - Create a paid test order.
   - Expected: no Telna package is created, an admin alert is sent, and the order is not marked `telna_processed`.
   - Reset `SIMULATE_MISSING_VARIANT_TEMPLATE_ID=false` after the test.

2. No available Telna ICCID
   - Temporarily set `SIMULATE_NO_AVAILABLE_TELNA_ESIM=true` in Render.
   - Redeploy/restart the web service.
   - Create a paid test order with a new customer email.
   - Expected: provisioning fails, an admin alert is sent, and the order is not marked `telna_processed`.
   - Reset `SIMULATE_NO_AVAILABLE_TELNA_ESIM=false` after the test.

3. Telna package creation error
   - Temporarily set `SIMULATE_TELNA_PACKAGE_CREATE_FAILURE=true` in Render.
   - Redeploy/restart the web service.
   - Create a paid test order.
   - Expected: package creation fails, an admin alert is sent, and the order is not marked `telna_processed`.
   - Reset `SIMULATE_TELNA_PACKAGE_CREATE_FAILURE=false` after the test.

4. Customer email cannot be sent
   - Temporarily set `SIMULATE_CUSTOMER_EMAIL_FAILURE=true` in a sandbox environment.
   - Redeploy/restart the web service.
   - Create a paid test order.
   - Expected: Telna provisioning still completes, the order is marked `telna_processed` to avoid duplicate package creation, and an admin alert is sent.
   - Reset `SIMULATE_CUSTOMER_EMAIL_FAILURE=false` after the test.

5. Duplicate Shopify webhook
   - Use Shopify's webhook retry or send the same paid order payload twice.
   - Expected: one request acquires the processing lock; the other logs `locked` and does not create a second package.

6. Customer without email
   - Temporarily set `SIMULATE_MISSING_CUSTOMER_EMAIL=true` in Render.
   - Redeploy/restart the web service.
   - Create a paid test order.
   - Expected: Telna provisioning completes, the order is marked `telna_processed`, and an admin alert is sent because the customer email could not be sent.
   - Reset `SIMULATE_MISSING_CUSTOMER_EMAIL=false` after the test.

7. Shopify fulfillment failure
   - Temporarily set `SIMULATE_FULFILLMENT_FAILURE=true` in a sandbox environment.
   - Redeploy/restart the web service.
   - Expected: Telna provisioning and email still complete, an admin alert is sent, and the order is marked `telna_processed`.
   - Reset `SIMULATE_FULFILLMENT_FAILURE=false` after the test.

## Usage Alert Cron Testing

The production cron command should be:

```bash
curl -fsS "https://YOUR_RENDER_URL/cron/check-usage?token=$CRON_SECRET"
```

Dry-run without sending emails:

```bash
curl -fsS "https://YOUR_RENDER_URL/cron/check-usage?token=$CRON_SECRET&dry_run=1"
```

To test alert logic without consuming real eSIM data, temporarily set:

```bash
USAGE_ALERT_TEST_MODE=true
USAGE_ALERT_THRESHOLD_PERCENT=75
```

Then call:

```bash
curl -fsS "https://YOUR_RENDER_URL/cron/check-usage?token=$CRON_SECRET&dry_run=1&mock_percent_used=80"
```

Expected:

- `wouldAlert: true` for eligible packages.
- No email is sent when `dry_run=1`.

To send one real test alert email:

```bash
curl -fsS "https://YOUR_RENDER_URL/cron/check-usage?token=$CRON_SECRET&mock_percent_used=80"
```

Then run the same command again.

Expected:

- First run sends the usage alert and writes `custom.usage_alerts_sent` on the Shopify order.
- Second run increments `alreadySent` and does not send the email again.

After testing, set:

```bash
USAGE_ALERT_TEST_MODE=false
USAGE_ALERT_THRESHOLD_PERCENT=75
```

It also writes temporary lock metafields while an order is being processed:

```text
custom.telna_processing
custom.telna_processing_at
custom.telna_processing_token
```

## Testing A Paid Order

1. Confirm the Render service is deployed and live.
2. Confirm the Shopify webhook points to:

```text
https://<render-service>/webhooks/order-paid
```

3. Create a Shopify product/variant with `custom.telna_package_template_id`.
4. Create a test paid order in Shopify.
5. Watch Render logs for:

```text
HMAC MATCH: true
Telna provisioning completed
Shopify fulfillment result
Order marked as processed in Telna flow
```

6. Confirm the customer receives the eSIM email.
7. Confirm the Shopify order contains the Telna metafields.
8. Confirm the Telna SIM has the created package attached.

## Usage Alert Cron

Protected endpoint:

```text
GET /cron/check-usage?token=<CRON_SECRET>
```

Dry run:

```text
GET /cron/check-usage?token=<CRON_SECRET>&dry_run=1
```

The cron reads processed Shopify orders, checks their Telna packages, and sends an email when package usage is at or above `USAGE_ALERT_THRESHOLD_PERCENT`.

Render cron example:

```text
https://<render-service>/cron/check-usage?token=<CRON_SECRET>
```

## Local Development

```bash
npm install
npm start
```

Use `.env` or `.env.telna` locally. Do not commit either file.
