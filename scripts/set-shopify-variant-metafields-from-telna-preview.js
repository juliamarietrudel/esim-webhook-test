import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { shopifyGraphql } from "../services/shopify.js";

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.telna", quiet: true });

function parseArgs(argv) {
  const args = {
    source: "outputs/telna-package-templates/countries-preview.csv",
    countries: null,
    apply: false,
    limit: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--source") args.source = next, i += 1;
    else if (arg === "--countries") args.countries = next, i += 1;
    else if (arg === "--limit") args.limit = Number(next), i += 1;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--help") {
      console.log(`Usage:
  node scripts/set-shopify-variant-metafields-from-telna-preview.js [options]

Preview only:
  node scripts/set-shopify-variant-metafields-from-telna-preview.js --countries Canada,Albania

Apply metafields:
  node scripts/set-shopify-variant-metafields-from-telna-preview.js --apply --countries Canada,Albania

Options:
  --source <path>       Telna templates CSV. Defaults to outputs/telna-package-templates/countries-preview.csv
  --countries <names>   Only process comma-separated countries, e.g. Canada,Albania
  --limit <n>           Limit number of Telna template rows per country, before new/top-up expansion
  --apply               Actually write metafields to Shopify
`);
      process.exit(0);
    }
  }

  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((cell) => cell !== ""));
  return body.map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ""])));
}

function clean(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numberValue(value) {
  const n = Number(clean(value));
  return Number.isFinite(n) ? n : 0;
}

function isUnlimitedPlan(row) {
  return clean(row.plan_kind).toLowerCase() === "unlimited" || clean(row.data_gb).toLowerCase() === "unlimited";
}

function countrySlug(country) {
  return clean(country).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function skuFor(country, row, purchaseType) {
  const data = isUnlimitedPlan(row) ? "UNLIMITED" : `${clean(row.data_gb).replace(/[^0-9.]+/g, "")}GB`;
  const days = clean(row.validity_days).replace(/[^0-9]+/g, "");
  return `TELNA-${purchaseType}-${countrySlug(country)}-${data}-${days}D`;
}

function variantLabel(row) {
  const data = isUnlimitedPlan(row) ? "Unlimited" : `${numberValue(row.data_gb)}GB`;
  const days = numberValue(row.validity_days);
  return `${data} / ${days} ${days === 1 ? "Day" : "Days"}`;
}

function desiredVariantMetafields(rows, countriesFilter, limit) {
  const allowedStatuses = new Set(["created", "exists"]);
  const requested = countriesFilter
    ? new Set(countriesFilter.split(",").map((country) => clean(country).toLowerCase()).filter(Boolean))
    : null;

  const byCountry = new Map();
  for (const row of rows) {
    const country = clean(row.maya_country_or_region);
    if (requested && !requested.has(country.toLowerCase())) continue;
    if (!allowedStatuses.has(clean(row.status))) continue;
    if (!clean(row.telna_template_id)) continue;
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push(row);
  }

  const desired = [];
  for (const [country, countryRows] of byCountry.entries()) {
    countryRows.sort((a, b) => {
      if (isUnlimitedPlan(a) !== isUnlimitedPlan(b)) return isUnlimitedPlan(a) ? 1 : -1;
      const dataDiff = numberValue(a.data_gb) - numberValue(b.data_gb);
      if (dataDiff !== 0) return dataDiff;
      return numberValue(a.validity_days) - numberValue(b.validity_days);
    });

    const selectedRows = limit ? countryRows.slice(0, limit) : countryRows;
    for (const row of selectedRows) {
      for (const purchaseType of ["NEW", "TOPUP"]) {
        desired.push({
          country,
          plan: variantLabel(row),
          sku: skuFor(country, row, purchaseType),
          telnaTemplateId: clean(row.telna_template_id),
        });
      }
    }
  }

  return desired;
}

function escapeQueryValue(value) {
  return clean(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findVariantBySku(sku) {
  const query = `
    query FindVariantBySku($query: String!) {
      productVariants(first: 10, query: $query) {
        nodes {
          id
          sku
          title
          selectedOptions { name value }
          product { title }
          telnaPackageTemplateId: metafield(namespace: "custom", key: "telna_package_template_id") { value }
        }
      }
    }
  `;

  const json = await shopifyGraphql(query, { query: `sku:'${escapeQueryValue(sku)}'` });
  const variants = json?.data?.productVariants?.nodes || [];
  return variants.find((variant) => clean(variant?.sku) === sku) || null;
}

async function setVariantMetafields(updates) {
  const mutation = `
    mutation SetVariantMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const metafields = updates.map((update) => ({
    ownerId: update.variantId,
    namespace: "custom",
    key: "telna_package_template_id",
    type: "single_line_text_field",
    value: update.telnaTemplateId,
  }));

  const chunkSize = 25;
  for (let i = 0; i < metafields.length; i += chunkSize) {
    const chunk = metafields.slice(i, i + chunkSize);
    const json = await shopifyGraphql(mutation, { metafields: chunk });
    const userErrors = json?.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));
    console.log(`✅ Wrote metafields ${i + 1}-${i + chunk.length} of ${metafields.length}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const source = path.resolve(args.source);
  const rows = parseCsv(fs.readFileSync(source, "utf8"));
  const desired = desiredVariantMetafields(rows, args.countries, args.limit);

  console.log(`Mode: ${args.apply ? "APPLY" : "PREVIEW"}`);
  console.log(`Source: ${source}`);
  console.log(`Desired variant metafields: ${desired.length}`);

  const found = [];
  const missing = [];
  const alreadyCorrect = [];

  for (let i = 0; i < desired.length; i += 1) {
    const item = desired[i];
    console.log(`🔎 [${i + 1}/${desired.length}] ${item.sku} -> ${item.telnaTemplateId}`);
    const variant = await findVariantBySku(item.sku);
    if (!variant?.id) {
      missing.push(item);
      console.log(`   ⚠️ Variant not found in Shopify`);
      continue;
    }

    const currentValue = clean(variant?.telnaPackageTemplateId?.value);
    const update = {
      ...item,
      variantId: variant.id,
      productTitle: variant?.product?.title || null,
      variantTitle: variant?.title || null,
      currentValue,
    };

    if (currentValue === item.telnaTemplateId) {
      alreadyCorrect.push(update);
      console.log(`   ℹ️ Already correct`);
    } else {
      found.push(update);
      console.log(`   ✅ Found ${variant?.product?.title} / ${variant?.title} current=${currentValue || "empty"}`);
    }
  }

  if (args.apply && found.length) {
    await setVariantMetafields(found);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: args.apply ? "apply" : "preview",
    desired: desired.length,
    toUpdate: found.length,
    alreadyCorrect: alreadyCorrect.length,
    missing: missing.length,
    missingSkus: missing.map((item) => item.sku),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
