## Telna sandbox configuration

For the Telna migration, the webhook provisions paid Shopify orders by selecting an unused Telna eSIM ICCID, adding the purchased package template to that ICCID, and emailing the activation QR code to the customer.

Recommended Telna environment variables:

- `TELNA_API_TOKEN`: Telna Connect API key.
- `TELNA_BASE_URL`: Telna API base URL, for example `https://developer-api.telna.com/v2.1`.
- `TELNA_INVENTORY_ID`: Optional but recommended. Pins eSIM selection to one Telna inventory. Current sandbox inventory: `52399`.
- `TELNA_GROUP_ID`: Optional. Pins eSIM selection to one Telna billing/group if needed.
- `TELNA_DEFAULT_PACKAGE_TEMPLATE_ID`: Temporary sandbox fallback only. For production, prefer setting `custom.telna_package_template_id` on each Shopify variant and removing this default.

Current safe production assumption while waiting for Telna confirmation:

- Classic/Global eSIM purchase: assign one unused eSIM ICCID per purchase.
- Same-ICCID top-up/reuse: technically possible through `POST /pcr/packages`, but should not become the default production behavior until Telna confirms it is recommended for Global/Classic eSIMs.

<!-- CREATE BASE N64 -->
echo -n 'API_KEY:API_SECRET' | base64

<!-- TYPE OF API -->
use connectivity rather than partners urls

<!-- REQUEST WITH AUTHENTICATION -->
<!-- get all products -->
curl --request GET \
  --url 'https://api.maya.net/connectivity/v1/account/products?region=europe&country=us' \
  --header 'Accept: application/json' \
  --header 'Authorization: Basic YjY4RWdDQjJLOVc5OmdscVBYcWVWcFk2bUVZTWZvMXJhSHlBR2JsdHhoT1N5TjdmdFJpNXc2UUxBRE1oc2NrM25IWFdydUpCdldLODM='

<!-- get customer info (for customer with id: ZMPSHYKZEEUF) -->
curl --request GET \
  --url 'https://api.maya.net/connectivity/v1/customer/9vFm72RchXf3' \
  --header 'Accept: application/json' \
  --header 'Authorization: Basic <BASIC_AUTH_BASE64>'

<!-- get esim information (for esim with id: 891030000003436056) -->
curl --request GET \
  --url 'https://api.maya.net/connectivity/v1/account/products?region=europe&country=us' \
  --header 'Accept: application/json' \
  --header 'Authorization: Basic YjY4RWdDQjJLOVc5OmdscVBYcWVWcFk2bUVZTWZvMXJhSHlBR2JsdHhoT1N5TjdmdFJpNXc2UUxBRE1oc2NrM25IWFdydUpCdldLODM='

<!-- get plan details -->
curl --request GET \
  --url 'https://api.maya.net/connectivity/v1/esim/8910300000049992500/plan/6PETHX8CQ6Z0' \
  --header 'Accept: application/json' \
  --header 'Authorization: Basic <BASIC_AUTH_BASE64>'



<!-- STEPS -->
1) Checkout + Payment

User completes checkout (guest allowed ✅).

_____

2) Webhook handler: different scenarios

When you receive the paid order:

A) Validate the order
	•	Verify webhook signature
	•	Confirm financial_status == paid
	•	Ensure required line item properties exist (plan/product id, intent)

B) Idempotency guard (very important)

Check your DB:
	•	If OrderProvisioning already exists with status completed → do nothing
	•	If processing → do nothing (or resume)
	•	If failed → decide retry rules (see below)

⸻

3) Resolve “who is this customer?”

Inputs you likely have
	•	email (always)
	•	shopify_customer_id (sometimes, even for guests Shopify may create/associate)
	•	phone (optional)

Resolution logic
	1.	Find CustomerIdentity by shopify_customer_id if present
	2.	Else find by normalized email
	3.	Else create new CustomerIdentity

If CustomerIdentity has maya_customer_id: reuse it
Else: create Maya customer (Connectivity POST /customer/) with:
	•	email, name, country
	•	tag: stable value (recommended: emailhash_<hash> or shopify_customer_<id>)

Save maya_customer_id in your DB.

⸻

4) Decide per line item: New eSIM vs Top up vs Multi-eSIM order

Loop through each eSIM line item.

Scenario 1 — First-time buyer (new eSIM)

Goal: issue a new eSIM and attach plan.

Typical steps (you’ll map to Maya endpoints you have access to):
	1.	Choose Maya product/plan based on line item
	2.	Create/allocate eSIM (or “order plan” that returns eSIM)
	3.	Associate eSIM + plan to maya_customer_id
	4.	Get QR / activation details
	5.	Save esim_id/iccid, qr_url, plan_id in DB
	6.	Email customer instructions + QR

Status transitions:
created → provisioning → waiting_for_qr → completed

Scenario 2 — Returning buyer, wants another new eSIM

Same as scenario 1, but:
	•	reuse existing maya_customer_id
	•	you create a new eSIMAsset record under the same customer

Scenario 3 — Returning buyer, top-up existing eSIM

You must know what to top up. Options:

3A) User selects an existing eSIM in UI (best UX)
	•	They choose from “My eSIMs” list (requires you to show history by email link or magic link)
	•	You get esim_id/iccid directly

3B) User enters an identifier (ICCID / eSIM ID / email + last 4 digits)
	•	You validate it belongs to them (match to DB record by email)
	•	If mismatch → manual review / support flow

Then:
	1.	Find eSIMAsset for that user + identifier
	2.	Purchase/add plan/top-up on that eSIM
	3.	Save new plan_id and update status
	4.	Email confirmation

Status transitions:
created → topup_processing → completed

Scenario 4 — Mixed cart (new eSIM + top-up in one order)

Process each line item independently.
	•	If any line fails, you still fulfill the ones that succeeded.
	•	Email should reflect partial fulfillment (and you flag support).

⸻

5) Failure and retry scenarios (critical)

Failure types & what to do

A) Maya returns 401/403 (no access)
	•	Mark order failed_auth
	•	Alert you + client immediately
	•	Do not retry automatically

B) Network timeout / 5xx
	•	Retry with backoff (e.g., 3 tries: 10s, 60s, 5m)
	•	Must be idempotent (don’t create duplicates)

C) Duplicate customer/email conflict
	•	Search existing customer by email (if endpoint exists) or use DB mapping
	•	Reuse existing maya_customer_id

D) Plan unavailable / product mismatch
	•	Mark failed_configuration
	•	Send internal alert; email user “we’re verifying your plan” (optional)

E) QR/activation not returned immediately
	•	Mark waiting_for_qr
	•	Poll a GET endpoint (or schedule a retry) until QR available
	•	Then send email

⸻

6) Email delivery scenarios

New eSIM email includes
	•	QR code (or download link)
	•	activation steps (iOS/Android)
	•	plan details
	•	support contact
	•	order number

Top-up email includes
	•	confirmation of top-up
	•	plan details + expiry
	•	no QR (unless plan requires re-download, usually not)

⸻

7) “My eSIMs” page (recommended even without accounts)

Since you don’t want user accounts, you can still offer:
	•	“Send me my eSIMs” form (email)
	•	Magic link to list their past eSIMs/top-ups (tokenized link)
	•	This makes top-up UX much easier and reduces support.


SUMMARY
	1.	Verify webhook signature (security)
	2.	Make the handler idempotent (so retries don’t double-provision)
	3.	Resolve Maya customer (create if needed)
	4.	Parse the order into “actions” based on the products bought
	5.	Execute actions (create eSIM / top up / change / delete)
	6.	Email results (QR codes, confirmations)
