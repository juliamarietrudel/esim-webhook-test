import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { shopifyGraphql } from "../services/shopify.js";

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.telna", quiet: true });

function parseArgs(argv) {
  const args = {
    source: "outputs/shopify-import/site2-products-matched-to-11111-variants.csv",
    apply: false,
    limit: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--source") args.source = next, i += 1;
    else if (arg === "--limit") args.limit = Number(next), i += 1;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--help") {
      console.log(`Usage:
  node scripts/set-shopify-variant-metafields-from-shopify-import.js [options]

Preview only:
  node scripts/set-shopify-variant-metafields-from-shopify-import.js

Apply metafields:
  node scripts/set-shopify-variant-metafields-from-shopify-import.js --apply

Options:
  --source <path>  Shopify import CSV with Variant SKU and Telna metafield column.
  --limit <n>      Limit number of variants checked.
  --apply          Actually write metafields to Shopify.
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

function escapeQueryValue(value) {
  return clean(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function getTelnaTemplateId(row) {
  return clean(
    row["Variant Metafield: custom.telna_package_template_id [single_line_text_field]"] ||
      row["Telna Package Template ID (variant.metafields.custom.telna_package_template_id)"] ||
      row["custom.telna_package_template_id"] ||
      row["telna_package_template_id"]
  );
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
          product { id title handle }
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

  const desiredBySku = new Map();
  for (const row of rows) {
    const sku = clean(row["Variant SKU"] || row["SKU"]);
    const telnaTemplateId = getTelnaTemplateId(row);
    if (!sku || !telnaTemplateId) continue;
    desiredBySku.set(sku, {
      sku,
      telnaTemplateId,
      handle: clean(row.Handle),
      title: clean(row.Title),
      option1: clean(row["Option1 Value"]),
      option2: clean(row["Option2 Value"]),
    });
  }

  const desired = Array.from(desiredBySku.values()).slice(0, args.limit || undefined);

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
      console.log("   ⚠️ Variant not found in Shopify");
      continue;
    }

    const currentValue = clean(variant?.telnaPackageTemplateId?.value);
    const update = {
      ...item,
      variantId: variant.id,
      productTitle: variant?.product?.title || null,
      productHandle: variant?.product?.handle || null,
      variantTitle: variant?.title || null,
      currentValue,
    };

    if (currentValue === item.telnaTemplateId) {
      alreadyCorrect.push(update);
      console.log("   ℹ️ Already correct");
    } else {
      found.push(update);
      console.log(`   ✅ Found ${variant?.product?.title} / ${variant?.title} current=${currentValue || "empty"}`);
    }
  }

  if (args.apply && found.length) await setVariantMetafields(found);

  console.log("\nSummary");
  console.log(JSON.stringify({
    desired: desired.length,
    foundToUpdate: found.length,
    alreadyCorrect: alreadyCorrect.length,
    missing: missing.length,
    applied: Boolean(args.apply),
  }, null, 2));

  if (missing.length) {
    console.log("\nMissing variant SKUs:");
    for (const item of missing.slice(0, 100)) console.log(`- ${item.sku} (${item.handle})`);
    if (missing.length > 100) console.log(`...and ${missing.length - 100} more`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
