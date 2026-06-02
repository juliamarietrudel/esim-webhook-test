// services/shopify.js
import { safeFetch } from "../utils/http.js";
import crypto from "crypto";

export function shopifyGraphqlUrl() {
  const shopRaw = process.env.SHOPIFY_SHOP_DOMAIN;
  const versionRaw = process.env.SHOPIFY_API_VERSION || "2025-01";

  const shop = (shopRaw || "").trim();
  const version = (versionRaw || "").trim();

  if (!shop) throw new Error("Missing SHOPIFY_SHOP_DOMAIN env var");
  if (!version) throw new Error("Missing SHOPIFY_API_VERSION env var");

  return `https://${shop}/admin/api/${version}/graphql.json`;
}

let cachedShopifyAccessToken = null;
let cachedShopifyAccessTokenExpiresAt = 0;

export async function shopifyGraphql(query, variables = {}) {
  const url = shopifyGraphqlUrl();
  const token = await shopifyToken();

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json?.errors) {
    console.error("❌ Shopify GraphQL error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json;
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

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

// ---------- Variant config ----------
export async function getVariantConfig(variantId) {
  const url = shopifyGraphqlUrl();
  const token = await shopifyToken();

  const gid = `gid://shopify/ProductVariant/${variantId}`;

  const query = `
    query ($id: ID!) {
      productVariant(id: $id) {
        id
        mayaPlanId: metafield(namespace: "custom", key: "maya_plan_id") { value }
        productType: metafield(namespace: "custom", key: "type_de_produit") { value }
      }
    }
  `;

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables: { id: gid } }),
  });

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify GraphQL error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  const v = json?.data?.productVariant;
  const mayaPlanId = (v?.mayaPlanId?.value || "").trim() || null;
  const productType = (v?.productType?.value || "").trim().toLowerCase() || null;

  return { mayaPlanId, productType };
}

// ---------- Telna variant config ----------
export async function getTelnaVariantConfig(variantId) {
  const gid = `gid://shopify/ProductVariant/${variantId}`;

  const query = `
    query ($id: ID!) {
      productVariant(id: $id) {
        id
        telnaPackageTemplateId: metafield(namespace: "custom", key: "telna_package_template_id") { value }
        productType: metafield(namespace: "custom", key: "type_de_produit") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const v = json?.data?.productVariant;
  const telnaPackageTemplateId =
    (v?.telnaPackageTemplateId?.value || process.env.TELNA_DEFAULT_PACKAGE_TEMPLATE_ID || "").trim() || null;
  const productType = (v?.productType?.value || "").trim().toLowerCase() || null;

  return { telnaPackageTemplateId, productType };
}

// ---------- Telna order/customer metafields ----------
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
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const json = await shopifyGraphql(mutation, {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: "telna_iccid",
        type: "single_line_text_field",
        value,
      },
    ],
  });

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Failed to write telna_iccid on customer");
  }

  return true;
}

export async function getTelnaOrderProcessedFlag(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;
  const query = `
    query ($id: ID!) {
      order(id: $id) {
        id
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
  const nowIso = new Date().toISOString();
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const json = await shopifyGraphql(mutation, {
    metafields: [
      { ownerId: gid, namespace: "custom", key: "telna_processed", type: "boolean", value: "true" },
      { ownerId: gid, namespace: "custom", key: "telna_processed_at", type: "date_time", value: nowIso },
    ],
  });

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Failed to mark Telna order processed");
  }

  return true;
}

export async function saveTelnaProvisioningToOrder(orderId, {
  iccid,
  packageId,
  packageTemplateId,
  activationCode,
  euiccState,
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

  const esimsJson = JSON.stringify([
    {
      iccid: String(iccid || "").trim() || null,
      package_id: String(packageId || "").trim() || null,
      package_template_id: String(packageTemplateId || "").trim() || null,
      euicc_state: String(euiccState || "").trim() || null,
    },
  ]);
  add("telna_esims_json", esimsJson, "multi_line_text_field");

  if (!metafields.length) return true;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const json = await shopifyGraphql(mutation, { metafields });
  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Failed to write Telna provisioning metafields");
  }

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
            status
            requestStatus
            supportedActions {
              action
            }
            lineItems(first: 100) {
              nodes {
                id
                remainingQuantity
              }
            }
          }
        }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const fulfillmentOrders = json?.data?.order?.fulfillmentOrders?.nodes || [];
  const fulfillable = fulfillmentOrders
    .filter((fo) => {
      const actions = Array.isArray(fo?.supportedActions) ? fo.supportedActions : [];
      return actions.some((a) => String(a?.action || "").toUpperCase() === "CREATE_FULFILLMENT");
    })
    .map((fo) => {
      const lineItems = (fo?.lineItems?.nodes || [])
        .filter((lineItem) => Number(lineItem?.remainingQuantity || 0) > 0)
        .map((lineItem) => ({
          id: lineItem.id,
          quantity: Number(lineItem.remainingQuantity),
        }));

      return lineItems.length
        ? {
            fulfillmentOrderId: fo.id,
            fulfillmentOrderLineItems: lineItems,
          }
        : null;
    })
    .filter(Boolean);

  if (!fulfillable.length) {
    return { fulfilled: false, reason: "no_fulfillable_orders" };
  }

  const mutation = `
    mutation fulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
      fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
        fulfillment {
          id
          status
        }
        userErrors {
          field
          message
        }
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
  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Failed to fulfill Shopify order");
  }

  return {
    fulfilled: true,
    fulfillmentId: result?.data?.fulfillmentCreate?.fulfillment?.id || null,
    status: result?.data?.fulfillmentCreate?.fulfillment?.status || null,
  };
}

// ---------- Customer Maya ID metafield ----------
export async function getMayaCustomerIdFromShopifyCustomer(shopifyCustomerId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const query = `
    query ($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "custom", key: "maya_customer_id") { value }
      }
    }
  `;

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables: { id: gid } }),
  });

  const json = await parseJsonSafe(resp);

  if (!resp.ok || json.errors) {
    console.error("❌ Shopify customer metafield read error:", json.errors || json);
    throw new Error(`Shopify GraphQL failed (${resp.status})`);
  }

  return json?.data?.customer?.metafield?.value || null;
}

export async function saveMayaCustomerIdToShopifyCustomer(shopifyCustomerId, mayaCustomerId) {
  const url = shopifyGraphqlUrl();
  const token = shopifyToken();

  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_customer_id",
        type: "single_line_text_field",
        value: String(mayaCustomerId),
      },
    ],
  };

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const json = await parseJsonSafe(resp);

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (!resp.ok || json.errors || userErrors.length) {
    console.error("❌ Shopify metafield write error:", { status: resp.status, json, userErrors });
    throw new Error(userErrors[0]?.message || "Failed to write Shopify customer metafield");
  }

  return true;
}

// ---------- Order Maya customer id metafield ----------
const ORDER_MAYA_CUSTOMER_ID_KEY = "maya_customer_id";
const ORDER_MAYA_CUSTOMER_ID_NAMESPACE = "custom";

export async function saveMayaCustomerIdToOrder(orderId, mayaCustomerId) {
  const value = String(mayaCustomerId || "").trim();
  if (!orderId) throw new Error("saveMayaCustomerIdToOrder: missing orderId");
  if (!value) throw new Error("saveMayaCustomerIdToOrder: missing mayaCustomerId");

  const gid = `gid://shopify/Order/${orderId}`;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: ORDER_MAYA_CUSTOMER_ID_NAMESPACE,
        key: ORDER_MAYA_CUSTOMER_ID_KEY,
        type: "single_line_text_field",
        value,
      },
    ],
  };

  const json = await shopifyGraphql(mutation, variables);
  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Failed to write maya_customer_id on order");
  }

  return true;
}

export async function getMayaCustomerIdFromOrder(orderId) {
  if (!orderId) throw new Error("getMayaCustomerIdFromOrder: missing orderId");

  const gid = `gid://shopify/Order/${orderId}`;

  const query = `
    query ($id: ID!) {
      order(id: $id) {
        mayaCustomerId: metafield(namespace: "${ORDER_MAYA_CUSTOMER_ID_NAMESPACE}", key: "${ORDER_MAYA_CUSTOMER_ID_KEY}") {
          value
        }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const raw = json?.data?.order?.mayaCustomerId?.value ?? "";
  const trimmed = String(raw).trim();
  return trimmed || null;
}

// --- IDEMPOTENCY SUR ORDER (tes fonctions, je les garde) ---
export async function getOrderProcessedFlag(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;

  const query = `
    query ($id: ID!) {
      order(id: $id) {
        id
        processed: metafield(namespace: "custom", key: "maya_processed") { value }
        processedAt: metafield(namespace: "custom", key: "maya_processed_at") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });

  const order = json?.data?.order;
  if (!order) {
    // This is important: if this happens, idempotency can never work
    console.warn("⚠️ getOrderProcessedFlag: order is null from Shopify", { orderId, gid });
    return { processed: false, processedAt: null };
  }

  const processed =
    String(order?.processed?.value || "").trim().toLowerCase() === "true";

  return {
    processed,
    processedAt: order?.processedAt?.value || null,
  };
}

// ---------- Order processing LOCK (prevents concurrent webhooks) ----------
// Uses a token so we can confirm who owns the lock.
// Also supports stale lock takeover (TTL).

const LOCK_TTL_MS = Number(process.env.MAYA_LOCK_TTL_MS || 15 * 60 * 1000); // 15 min default

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
        processing: metafield(namespace: "custom", key: "maya_processing") { value }
        processingAt: metafield(namespace: "custom", key: "maya_processing_at") { value }
        processingToken: metafield(namespace: "custom", key: "maya_processing_token") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const order = json?.data?.order;

  const processing =
    String(order?.processing?.value || "").trim().toLowerCase() === "true";

  return {
    processing,
    processingAt: order?.processingAt?.value || null,
    processingToken: order?.processingToken?.value || null,
    stale: processing ? isStale(order?.processingAt?.value) : false,
  };
}

export async function tryAcquireOrderProcessingLock(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;

  // Read current lock
  const before = await getOrderProcessingLock(orderId);

  // If locked and not stale -> do not acquire
  if (before.processing && !before.stale) {
    return { acquired: false, reason: "locked" };
  }

  // If locked but stale -> we can take over
  const token = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      { ownerId: gid, namespace: "custom", key: "maya_processing", type: "boolean", value: "true" },
      { ownerId: gid, namespace: "custom", key: "maya_processing_token", type: "single_line_text_field", value: token },
      { ownerId: gid, namespace: "custom", key: "maya_processing_at", type: "date_time", value: nowIso },
    ],
  };

  await shopifyGraphql(mutation, variables);

  // ✅ Verify we own the lock (prevents double-provision on race)
  const after = await getOrderProcessingLock(orderId);
  const weOwnIt =
    after.processing === true && String(after.processingToken || "") === String(token);

  if (!weOwnIt) {
    return { acquired: false, reason: "lost_race" };
  }

  return { acquired: true, token };
}

// ---------- Order processing LOCK (prevents concurrent webhooks) ----------

export async function releaseOrderProcessingLock(orderId, token) {
  const gid = `gid://shopify/Order/${orderId}`;

  const query = `
    query ($id: ID!) {
      order(id: $id) {
        token: metafield(namespace:"custom", key:"maya_processing_token") { value }
        processing: metafield(namespace:"custom", key:"maya_processing") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const currentToken = String(json?.data?.order?.token?.value || "");
  const processing =
    String(json?.data?.order?.processing?.value || "").toLowerCase() === "true";

  if (!processing) return { released: false, reason: "not_locked" };
  if (currentToken !== token) return { released: false, reason: "token_mismatch" };

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }
  `;

  // ✅ On ne touche pas maya_processing_at ici (c’est la date de lock, pas de release)
  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_processing",
        type: "boolean",
        value: "false",
      },
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_processing_token",
        type: "single_line_text_field",
        value: "",
      },
    ],
  };

  await shopifyGraphql(mutation, variables);

  return { released: true };
}

// ---------- Order eSIM list (JSON) ----------
const ESIMS_JSON_KEY = "maya_esims_json";

export async function getEsimsJsonFromOrder(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;

  const query = `
    query GetEsimsJson($id: ID!) {
      order(id: $id) {
        esims: metafield(namespace: "custom", key: "${ESIMS_JSON_KEY}") { value }
      }
    }
  `;

  const json = await shopifyGraphql(query, { id: gid });
  const raw = json?.data?.order?.esims?.value;

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function appendEsimToOrderEsimsJson(orderId, { iccid, uid } = {}) {
  if (!orderId) throw new Error("appendEsimToOrderEsimsJson: missing orderId");
  if (!iccid && !uid) return true;

  const gid = `gid://shopify/Order/${orderId}`;
  const current = await getEsimsJsonFromOrder(orderId);

  const cleanIccid = String(iccid || "").trim();
  const cleanUid = String(uid || "").trim();

  const exists = current.some((e) => {
    const eIccid = String(e?.iccid || "").trim();
    const eUid = String(e?.uid || "").trim();
    if (cleanIccid) return eIccid === cleanIccid;
    return cleanUid && eUid === cleanUid;
  });

  const next = exists
    ? current
    : [...current, { iccid: cleanIccid || null, uid: cleanUid || null }];

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: ESIMS_JSON_KEY,
        type: "multi_line_text_field",
        value: JSON.stringify(next),
      },
    ],
  };

  const result = await shopifyGraphql(mutation, variables);
  const userErrors = result?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "Failed to write maya_esims_json");
  }

  return true;
}
// ---------- Usage alert idempotency (stored in ONE order metafield) ----------
// We store keys line-by-line in custom.usage_alerts_sent (multi_line_text_field)

const USAGE_ALERTS_FIELD_KEY = "usage_alerts_sent";

export function usageAlertKey(threshold, iccid) {
  const t = String(threshold || "").trim();
  const i = String(iccid || "").trim();
  if (!t || !i) throw new Error("usageAlertKey: missing threshold or iccid");
  // e.g. usage_alert_20_8910300000057318645
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
  const sent = current.includes(String(key || "").trim());

  return { sent, sentAt: null };
}

export async function markUsageAlertSent(orderId, key) {
  const gid = `gid://shopify/Order/${orderId}`;
  const k = String(key || "").trim();
  if (!k) throw new Error("markUsageAlertSent: missing key");

  // 1) read current list
  let current = [];
  try {
    const flag = await getUsageAlertFlag(orderId, k);
    // re-read the list (we need full list)
    const query = `
      query UsageAlertSentList($id: ID!) {
        order(id: $id) {
          usageAlertsSent: metafield(namespace: "custom", key: "${USAGE_ALERTS_FIELD_KEY}") { value }
        }
      }
    `;
    const json = await shopifyGraphql(query, { id: gid });
    current = parseUsageAlertsSent(json?.data?.order?.usageAlertsSent?.value);
    if (flag.sent) return true; // already present
  } catch (e) {
    // If read fails, we’ll still try writing just this key (better than doing nothing)
    console.warn("⚠️ Could not read usage_alerts_sent before writing:", e?.message || e);
    current = [];
  }

  // 2) append if missing
  if (!current.includes(k)) current.push(k);

  // 3) write back to ONE metafield
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: USAGE_ALERTS_FIELD_KEY,
        type: "multi_line_text_field",
        value: current.join("\n"),
      },
    ],
  };

  const json = await shopifyGraphql(mutation, variables);

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    console.error("❌ Shopify markUsageAlertSent userErrors:", { orderId, key: k, userErrors });
    throw new Error(userErrors[0]?.message || "Failed to write Shopify usage_alerts_sent metafield");
  }

  return true;
}

// ---------- Order eSIM details metafields (for usage tracking) ----------
export async function saveEsimToOrder(orderId, { iccid, esimUid } = {}) {
  if (!orderId) throw new Error("saveEsimToOrder: missing orderId");

  const gid = `gid://shopify/Order/${orderId}`;

  const metafields = [];

  if (iccid) {
    metafields.push({
      ownerId: gid,
      namespace: "custom",
      key: "maya_iccid",
      type: "single_line_text_field",
      value: String(iccid),
    });
  }

  if (esimUid) {
    metafields.push({
      ownerId: gid,
      namespace: "custom",
      key: "maya_esim_uid",
      type: "single_line_text_field",
      value: String(esimUid),
    });
  }

  if (!metafields.length) return true;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = { metafields };

  const json = await shopifyGraphql(mutation, variables);

  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    console.error("❌ Shopify saveEsimToOrder userErrors:", { orderId, userErrors });
    throw new Error(userErrors[0]?.message || "Failed to write Shopify order metafields");
  }

  // Also append to JSON list so we keep ALL eSIMs on the order
  try {
    await appendEsimToOrderEsimsJson(orderId, {
      iccid,
      uid: esimUid,
    });
  } catch (e) {
    console.error("❌ Failed to append eSIM to maya_esims_json:", e?.message || e);
  }
  return true;
}

// ---------- Find orders that have eSIMs saved (maya_esims_json OR maya_iccid) ----------
function parseEsimsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
export async function markOrderProcessed(orderId) {
  const gid = `gid://shopify/Order/${orderId}`;
  const nowIso = new Date().toISOString();

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_processed",
        type: "boolean",
        value: "true",
      },
      {
        ownerId: gid,
        namespace: "custom",
        key: "maya_processed_at",
        type: "date_time",
        value: nowIso,
      },
    ],
  };

  const result = await shopifyGraphql(mutation, variables);
  const userErrors = result?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) throw new Error(userErrors[0]?.message || "Failed to mark processed");

  return true;
}
export async function getOrdersWithEsims({ daysBack = 120 } = {}) {
  const sinceDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const searchQuery =
    `created_at:>='${sinceDate}' ` +
    `(metafield:custom.${ESIMS_JSON_KEY} OR metafield:custom.maya_iccid) ` +
    `AND metafield:custom.maya_customer_id:*`;

  const query = `
    query OrdersWithEsims($first: Int!, $query: String!) {
      orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            mayaCustomerId: metafield(namespace: "custom", key: "maya_customer_id") { value }
            mayaIccid: metafield(namespace: "custom", key: "maya_iccid") { value }
            mayaEsimUid: metafield(namespace: "custom", key: "maya_esim_uid") { value }
            esimsJson: metafield(namespace: "custom", key: "${ESIMS_JSON_KEY}") { value }
          }
        }
      }
    }
  `;

  const json = await shopifyGraphql(query, { first: 100, query: searchQuery });
  const edges = json?.data?.orders?.edges || [];

  return edges
    .map(({ node }) => {
      const orderGid = node?.id || "";
      const orderId = orderGid.split("/").pop();
      const orderName = String(node?.name || "").trim();

      const mayaCustomerId = String(node?.mayaCustomerId?.value || "").trim() || null;

      // ✅ REQUIRE maya_customer_id no matter what
      if (!mayaCustomerId) return null;

      const singleIccid = (node?.mayaIccid?.value || "").trim();
      const singleUid = (node?.mayaEsimUid?.value || "").trim();

      const esims = parseEsimsJson(node?.esimsJson?.value)
        .map((e) => ({ iccid: String(e?.iccid || "").trim(), uid: String(e?.uid || "").trim() }))
        .filter((e) => e.iccid);

      const finalEsims = esims.length
        ? esims
        : (singleIccid ? [{ iccid: singleIccid, uid: singleUid || "" }] : []);

      if (!orderId || !finalEsims.length) return null;

      return { orderId, orderName, mayaCustomerId, esims: finalEsims };
    })
    .filter(Boolean);
}
