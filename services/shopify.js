// services/shopify.js
import crypto from "crypto";
import { safeFetch } from "../utils/http.js";

export function shopifyGraphqlUrl() {
  const shop = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
  const version = (process.env.SHOPIFY_API_VERSION || "2025-01").trim();

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!version) throw new Error("Missing SHOPIFY_API_VERSION env var");

  return `https://${shop}/admin/api/${version}/graphql.json`;
}

let cachedShopifyAccessToken = null;
let cachedShopifyAccessTokenExpiresAt = 0;

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

function truthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

async function shopifyToken() {
  const staticToken = (process.env.API_ACCESS_TOKEN || "").trim();
  if (staticToken) return staticToken;

  if (cachedShopifyAccessToken && Date.now() < cachedShopifyAccessTokenExpiresAt - 60_000) {
    return cachedShopifyAccessToken;
  }

  const shop = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
  const clientId = (process.env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!clientId || !clientSecret) {
    throw new Error("Missing API_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET env vars");
  }

  const resp = await safeFetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const json = await parseJsonSafe(resp);
  if (!resp.ok || !json?.access_token) {
    console.error("Shopify token exchange failed:", { status: resp.status, json });
    throw new Error(json?.error_description || json?.error || `Shopify token exchange failed (${resp.status})`);
  }

  cachedShopifyAccessToken = json.access_token;
  cachedShopifyAccessTokenExpiresAt = Date.now() + Number(json.expires_in || 86399) * 1000;
  return cachedShopifyAccessToken;
}

export async function shopifyGraphql(query, variables = {}) {
  const resp = await safeFetch(shopifyGraphqlUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await shopifyToken(),
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json?.errors) {
    console.error("Shopify GraphQL error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json;
}

function normalizeShopifyOption(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inferPurchaseTypeFromVariant({ selectedOptions = [], sku = "", productType = "" } = {}) {
  const explicitProductType = normalizeShopifyOption(productType);
  if (["new_esim", "nouvelle_esim"].includes(explicitProductType)) return "new_esim";
  if (["top_up", "topup", "recharge"].includes(explicitProductType)) return "top_up";

  const typeOption = selectedOptions.find((option) => {
    const name = normalizeShopifyOption(option?.name);
    return ["type_de_forfait", "type_forfait", "forfait_type", "plan_type"].includes(name);
  });

  const typeValue = normalizeShopifyOption(typeOption?.value);
  if (typeValue.includes("recharge") || typeValue.includes("topup") || typeValue.includes("top_up")) {
    return "top_up";
  }
  if (typeValue.includes("nouvelle") || typeValue.includes("new") || typeValue.includes("esim")) {
    return "new_esim";
  }

  const cleanSku = normalizeShopifyOption(sku);
  if (cleanSku.includes("topup") || cleanSku.includes("top_up") || cleanSku.includes("recharge")) return "top_up";
  if (cleanSku.includes("new") || cleanSku.includes("nouvelle")) return "new_esim";

  return null;
}

export async function getTelnaVariantConfig(variantId) {
  if (truthyEnv("SIMULATE_MISSING_VARIANT_TEMPLATE_ID")) {
    return { telnaPackageTemplateId: null, productType: null, purchaseType: null, selectedOptions: [], sku: null };
  }

  const gid = `gid://shopify/ProductVariant/${variantId}`;

  const query = `
    query ($id: ID!) {
      productVariant(id: $id) {
        sku
        selectedOptions { name value }
        telnaPackageTemplateId: metafield(namespace: "custom", key: "telna_package_template_id") { value }
        productType: metafield(namespace: "custom", key: "type_de_produit") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const variant = json?.data?.productVariant;
  const selectedOptions = Array.isArray(variant?.selectedOptions) ? variant.selectedOptions : [];
  const sku = (variant?.sku || "").trim() || null;
  const telnaPackageTemplateId =
    (variant?.telnaPackageTemplateId?.value || process.env.TELNA_DEFAULT_PACKAGE_TEMPLATE_ID || "").trim() || null;
  const productType = (variant?.productType?.value || "").trim().toLowerCase() || null;
  const purchaseType = inferPurchaseTypeFromVariant({ selectedOptions, sku, productType });

  return { telnaPackageTemplateId, productType, purchaseType, selectedOptions, sku };
}

export async function getTelnaIccidFromShopifyCustomer(shopifyCustomerId) {
  if (!shopifyCustomerId) return null;

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
  const query = `
    query ($id: ID!) {
      customer(id: $id) {
        telnaIccid: metafield(namespace: "custom", key: "telna_iccid") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  return (json?.data?.customer?.telnaIccid?.value || "").trim() || null;
}

export async function saveTelnaIccidToShopifyCustomer(shopifyCustomerId, iccid) {
  const value = String(iccid || "").trim();
  if (!shopifyCustomerId || !value) return true;

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
  await setMetafields([
    {
      ownerId: gid,
      namespace: "custom",
      key: "telna_iccid",
      type: "single_line_text_field",
      value,
    },
  ], "Failed to write telna_iccid on customer");

  return true;
}

async function getTelnaProvisioningRecordsFromOrder(orderId) {
  if (!orderId) return [];

  const gid = `gid://shopify/Order/${orderId}`;
  const query = `
    query ($id: ID!) {
      order(id: $id) {
        telnaEsimsJson: metafield(namespace: "custom", key: "telna_esims_json") { value }
      }
    }
  `;

  try {
    const json = await shopifyGraphql(query, { id: gid });
    const raw = json?.data?.order?.telnaEsimsJson?.value || "";
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("Could not read existing telna_esims_json before appending:", e?.message || e);
    return [];
  }
}

export async function getTelnaOrderProcessedFlag(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;
  const query = `
    query ($id: ID!) {
      order(id: $id) {
        processed: metafield(namespace: "custom", key: "telna_processed") { value }
        processedAt: metafield(namespace: "custom", key: "telna_processed_at") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const order = json?.data?.order;
  if (!order) return { processed: false, processedAt: null };

  return {
    processed: String(order?.processed?.value || "").trim().toLowerCase() === "true",
    processedAt: order?.processedAt?.value || null,
  };
}

export async function markTelnaOrderProcessed(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;
  await setMetafields([
    { ownerId: gid, namespace: "custom", key: "telna_processed", type: "boolean", value: "true" },
    { ownerId: gid, namespace: "custom", key: "telna_processed_at", type: "date_time", value: new Date().toISOString() },
  ], "Failed to mark Telna order processed");

  return true;
}

function uniqueNonEmpty(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function formatTelnaRecordSummary(record, index) {
  const type = String(record?.type || "").trim() === "top_up" ? "Recharge" : "Nouvelle eSIM";
  const country = String(record?.country || "").trim() || "Destination inconnue";
  const planName = String(record?.plan_name || record?.planName || "").trim() || "Forfait inconnu";
  const iccid = String(record?.iccid || "").trim() || "ICCID manquant";
  const packageId = String(record?.package_id || record?.packageId || "").trim() || "Package ID manquant";
  const templateId = String(record?.package_template_id || record?.packageTemplateId || "").trim() || "Template ID manquant";

  return `${index + 1}. ${type} | ${country} | ${planName} | ICCID: ${iccid} | Package: ${packageId} | Template: ${templateId}`;
}

export async function saveTelnaProvisioningToOrder(orderId, {
  iccid,
  packageId,
  packageTemplateId,
  activationCode,
  euiccState,
  type,
  country,
  planName,
  variantId,
} = {}) {
  if (!orderId) throw new Error("saveTelnaProvisioningToOrder: missing orderId");

  const gid = `gid://shopify/Order/${orderId}`;
  const metafields = [];
  const add = (key, value, type = "single_line_text_field") => {
    const cleanValue = String(value || "").trim();
    if (!cleanValue) return;
    metafields.push({ ownerId: gid, namespace: "custom", key, type, value: cleanValue });
  };

  add("telna_iccid", iccid);
  add("telna_package_id", packageId);
  add("telna_package_template_id", packageTemplateId);
  add("telna_activation_code", activationCode, "multi_line_text_field");
  add("telna_euicc_state", euiccState);

  const currentRecords = await getTelnaProvisioningRecordsFromOrder(orderId);
  const nextRecord = {
    type: String(type || "").trim() || null,
    country: String(country || "").trim() || null,
    plan_name: String(planName || "").trim() || null,
    variant_id: String(variantId || "").trim() || null,
    iccid: String(iccid || "").trim() || null,
    package_id: String(packageId || "").trim() || null,
    package_template_id: String(packageTemplateId || "").trim() || null,
    euicc_state: String(euiccState || "").trim() || null,
  };
  const records = currentRecords.filter((record) => {
    if (!nextRecord.package_id) return true;
    return String(record?.package_id || record?.packageId || "") !== nextRecord.package_id;
  });
  records.push(nextRecord);

  const lineBreak = "\n";

  add("telna_esims_json", JSON.stringify(records), "multi_line_text_field");
  add("telna_iccids", uniqueNonEmpty(records.map((record) => record?.iccid)).join(lineBreak), "multi_line_text_field");
  add("telna_package_ids", uniqueNonEmpty(records.map((record) => record?.package_id || record?.packageId)).join(lineBreak), "multi_line_text_field");
  add("telna_package_template_ids", uniqueNonEmpty(records.map((record) => record?.package_template_id || record?.packageTemplateId)).join(lineBreak), "multi_line_text_field");
  add("telna_items_summary", records.map(formatTelnaRecordSummary).join(lineBreak), "multi_line_text_field");

  if (!metafields.length) return true;
  await setMetafields(metafields, "Failed to write Telna provisioning metafields");
  return true;
}

export async function fulfillShopifyOrder(orderId, { notifyCustomer = false } = {}) {
  if (!orderId) throw new Error("fulfillShopifyOrder: missing orderId");

  const gid = `gid://shopify/Order/${orderId}`;
  const query = `
    query ($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 50) {
          nodes {
            id
            supportedActions { action }
            lineItems(first: 100) {
              nodes { id remainingQuantity }
            }
          }
        }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const fulfillmentOrders = json?.data?.order?.fulfillmentOrders?.nodes || [];
  const fulfillable = fulfillmentOrders
    .filter((fo) => (fo?.supportedActions || []).some((a) => String(a?.action || "").toUpperCase() === "CREATE_FULFILLMENT"))
    .map((fo) => {
      const lineItems = (fo?.lineItems?.nodes || [])
        .filter((lineItem) => Number(lineItem?.remainingQuantity || 0) > 0)
        .map((lineItem) => ({
          id: lineItem.id,
          quantity: Number(lineItem.remainingQuantity),
        }));

      return lineItems.length ? { fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: lineItems } : null;
    })
    .filter(Boolean);

  if (!fulfillable.length) return { fulfilled: false, reason: "no_fulfillable_orders" };

  const mutation = `
    mutation fulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
      fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
        fulfillment { id status }
        userErrors { field message }
      }
    }
  `;

  const result = await shopifyGraphql(mutation, {
    fulfillment: {
      notifyCustomer,
      lineItemsByFulfillmentOrder: fulfillable,
    },
    message: "eSIM provisioned and QR code sent.",
  });

  const userErrors = result?.data?.fulfillmentCreate?.userErrors || [];
  if (userErrors.length) throw new Error(userErrors[0]?.message || "Failed to fulfill Shopify order");

  return {
    fulfilled: true,
    fulfillmentId: result?.data?.fulfillmentCreate?.fulfillment?.id || null,
    status: result?.data?.fulfillmentCreate?.fulfillment?.status || null,
  };
}

const LOCK_TTL_MS = Number(process.env.TELNA_LOCK_TTL_MS || 15 * 60 * 1000);

function isStale(isoDate) {
  if (!isoDate) return true;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > LOCK_TTL_MS;
}

export async function getOrderProcessingLock(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;
  const query = `
    query ($id: ID!) {
      order(id: $id) {
        processing: metafield(namespace: "custom", key: "telna_processing") { value }
        processingAt: metafield(namespace: "custom", key: "telna_processing_at") { value }
        processingToken: metafield(namespace: "custom", key: "telna_processing_token") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const order = json?.data?.order;
  const processing = String(order?.processing?.value || "").trim().toLowerCase() === "true";

  return {
    processing,
    processingAt: order?.processingAt?.value || null,
    processingToken: order?.processingToken?.value || null,
    stale: processing ? isStale(order?.processingAt?.value) : false,
  };
}

export async function tryAcquireOrderProcessingLock(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;
  const before = await getOrderProcessingLock(orderId);

  if (before.processing && !before.stale) return { acquired: false, reason: "locked" };

  const token = crypto.randomUUID();
  await setMetafields([
    { ownerId: gid, namespace: "custom", key: "telna_processing", type: "boolean", value: "true" },
    { ownerId: gid, namespace: "custom", key: "telna_processing_token", type: "single_line_text_field", value: token },
    { ownerId: gid, namespace: "custom", key: "telna_processing_at", type: "date_time", value: new Date().toISOString() },
  ], "Failed to acquire Telna processing lock");

  const after = await getOrderProcessingLock(orderId);
  const weOwnIt = after.processing === true && String(after.processingToken || "") === String(token);

  if (!weOwnIt) return { acquired: false, reason: "lost_race" };
  return { acquired: true, token };
}

export async function releaseOrderProcessingLock(orderId, token) {
  const gid = `gid://shopify/Order/${orderId}`;
  const current = await getOrderProcessingLock(orderId);

  if (!current.processing) return { released: false, reason: "not_locked" };
  if (String(current.processingToken || "") !== String(token || "")) {
    return { released: false, reason: "token_mismatch" };
  }

  await setMetafields([
    { ownerId: gid, namespace: "custom", key: "telna_processing", type: "boolean", value: "false" },
  ], "Failed to release Telna processing lock");

  return { released: true };
}

const USAGE_ALERTS_FIELD_KEY = "usage_alerts_sent";

export function usageAlertKey(threshold, identifier) {
  const t = String(threshold || "").trim();
  const i = String(identifier || "").trim();
  if (!t || !i) throw new Error("usageAlertKey: missing threshold or identifier");
  return `usage_alert_${t}_${i}`;
}

function parseUsageAlertsSent(value) {
  return String(value || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function getUsageAlertFlag(orderId, key) {
  const gid = `gid://shopify/Order/${orderId}`;
  const query = `
    query UsageAlertSentList($id: ID!) {
      order(id: $id) {
        usageAlertsSent: metafield(namespace: "custom", key: "${USAGE_ALERTS_FIELD_KEY}") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const current = parseUsageAlertsSent(json?.data?.order?.usageAlertsSent?.value);
  return { sent: current.includes(String(key || "").trim()), sentAt: null };
}

export async function markUsageAlertSent(orderId, key) {
  const gid = `gid://shopify/Order/${orderId}`;
  const k = String(key || "").trim();
  if (!k) throw new Error("markUsageAlertSent: missing key");

  let current = [];
  try {
    const query = `
      query UsageAlertSentList($id: ID!) {
        order(id: $id) {
          usageAlertsSent: metafield(namespace: "custom", key: "${USAGE_ALERTS_FIELD_KEY}") { value }
        }
      }
    `;
    const json = await shopifyGraphql(query, { id: gid });
    current = parseUsageAlertsSent(json?.data?.order?.usageAlertsSent?.value);
  } catch (e) {
    console.warn("Could not read usage_alerts_sent before writing:", e?.message || e);
  }

  if (!current.includes(k)) current.push(k);

  await setMetafields([
    {
      ownerId: gid,
      namespace: "custom",
      key: USAGE_ALERTS_FIELD_KEY,
      type: "multi_line_text_field",
      value: current.join("\n"),
    },
  ], "Failed to write Shopify usage_alerts_sent metafield");

  return true;
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getOrdersWithTelnaPackages({ daysBack = 365 } = {}) {
  const sinceDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const query = `
    query OrdersWithTelnaPackages($first: Int!, $query: String!) {
      orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            email
            customer { firstName email }
            telnaProcessed: metafield(namespace: "custom", key: "telna_processed") { value }
            telnaIccid: metafield(namespace: "custom", key: "telna_iccid") { value }
            telnaPackageId: metafield(namespace: "custom", key: "telna_package_id") { value }
            telnaPackageTemplateId: metafield(namespace: "custom", key: "telna_package_template_id") { value }
            telnaEsimsJson: metafield(namespace: "custom", key: "telna_esims_json") { value }
          }
        }
      }
    }
  `;

  // Shopify order search does not reliably index metafields, so fetch recent
  // orders and inspect Telna metafields directly in code.
  const searchQuery = `created_at:>='${sinceDate}'`;
  const json = await shopifyGraphql(query, { first: 100, query: searchQuery });
  const edges = json?.data?.orders?.edges || [];

  return edges
    .map(({ node }) => {
      const orderId = String(node?.id || "").split("/").pop();
      const orderName = String(node?.name || "").trim();
      const email = String(node?.email || node?.customer?.email || "").trim();
      const firstName = String(node?.customer?.firstName || "").trim();

      const telnaProcessed = String(node?.telnaProcessed?.value || "").trim().toLowerCase() === "true";
      if (!telnaProcessed) return null;

      const singleIccid = String(node?.telnaIccid?.value || "").trim();
      const singlePackageId = String(node?.telnaPackageId?.value || "").trim();
      const singlePackageTemplateId = String(node?.telnaPackageTemplateId?.value || "").trim();

      const packagesFromJson = parseJsonArray(node?.telnaEsimsJson?.value)
        .map((e) => ({
          iccid: String(e?.iccid || "").trim(),
          packageId: String(e?.package_id || e?.packageId || "").trim(),
          packageTemplateId: String(e?.package_template_id || e?.packageTemplateId || "").trim(),
        }))
        .filter((e) => e.iccid && e.packageId);

      const telnaPackages = packagesFromJson.length
        ? packagesFromJson
        : (singleIccid && singlePackageId
          ? [{ iccid: singleIccid, packageId: singlePackageId, packageTemplateId: singlePackageTemplateId }]
          : []);

      if (!orderId || !telnaPackages.length) return null;
      return { orderId, orderName, email, firstName, telnaPackages };
    })
    .filter(Boolean);
}

async function setMetafields(metafields, errorMessage) {
  if (!metafields?.length) return true;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const json = await shopifyGraphql(mutation, { metafields });
  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) throw new Error(userErrors[0]?.message || errorMessage || "Failed to write metafields");

  return true;
}
