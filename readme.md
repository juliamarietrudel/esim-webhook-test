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
USAGE_ALERT_THRESHOLD_PERCENT=75
LOG_LEVEL=info
```

Notes:

- `TELNA_DEFAULT_PACKAGE_TEMPLATE_ID` is a sandbox fallback only. In production, each Shopify variant should have its own `custom.telna_package_template_id` metafield.
- `TELNA_INVENTORY_ID` tells the service which Telna inventory to search when choosing an unused eSIM ICCID.
- `TELNA_GROUP_ID` can narrow the search further if Telna provides separate groups/billing groups for production.

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
TELNA_TRAFFIC_POLICY_ID=...
```

Optional creation settings:

```bash
TELNA_ACTIVATION_TYPE=AUTO
TELNA_ACTIVATION_TIME_ALLOWANCE_DAYS=365
TELNA_AVAILABLE_DAYS=365
```

Notes:

- Telna package templates do not contain Shopify pricing. Maya `WSP info` and `RRP info` are preserved in the preview/mapping files for Shopify product setup, but Telna only receives the package configuration.
- Fixed-data country plans can be imported directly.
- Maya `Unlimited` plans need a separate Telna traffic-policy decision before they can be imported safely.
- Region plans need a confirmed list of ISO-3 countries per region before they can become Telna package templates.

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
