import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { shopifyGraphql } from "../services/shopify.js";

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.telna", quiet: true });

function parseArgs(argv) {
  const args = {
    source: "outputs/telna-package-templates/countries-preview.csv",
    create: false,
    countries: null,
    limit: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--source") args.source = next, i += 1;
    else if (arg === "--countries") args.countries = next, i += 1;
    else if (arg === "--limit") args.limit = Number(next), i += 1;
    else if (arg === "--create") args.create = true;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/shopify-products-from-telna-templates.js [options]

Safe preview:
  node scripts/shopify-products-from-telna-templates.js --countries Canada,Spain,Egypt

Create/update Shopify catalog:
  node scripts/shopify-products-from-telna-templates.js --create --countries Canada,Spain,Egypt

Options:
  --source <path>       Telna mapping CSV. Defaults to outputs/telna-package-templates/countries-preview.csv
  --countries <names>   Only process comma-separated countries, e.g. Canada,Spain,Egypt
  --limit <n>           Limit number of variants per country
  --create              Create/update Shopify products and variant metafields
`);
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

function money(value) {
  const n = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function numberValue(value) {
  const n = Number(clean(value));
  return Number.isFinite(n) ? n : 0;
}

function isUnlimitedPlan(row) {
  return clean(row.plan_kind).toLowerCase() === "unlimited" || clean(row.data_gb).toLowerCase() === "unlimited";
}

function variantTitle(row) {
  const days = numberValue(row.validity_days);
  const dataLabel = isUnlimitedPlan(row)
    ? "Unlimited"
    : `${numberValue(row.data_gb)}GB`;
  const dayLabel = days === 1 ? "1 Day" : `${days} Days`;
  return `${dataLabel} / ${dayLabel}`;
}

function sku(country, row) {
  const slug = clean(country).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  const data = isUnlimitedPlan(row) ? "UNLIMITED" : `${clean(row.data_gb).replace(/[^0-9.]+/g, "")}GB`;
  const days = clean(row.validity_days).replace(/[^0-9]+/g, "");
  return `TELNA-${slug}-${data}-${days}D`;
}

function escapeSearch(value) {
  return clean(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function productDescription(country) {
  return [
    `<p>Travel eSIM data plan for ${country}.</p>`,
    "<p>If you already have a Telna eSIM from us, this purchase will be added as a top-up to your existing eSIM. If this is your first purchase, we will email your QR code after payment.</p>",
  ].join("\n");
}

function groupRows(rows, countriesFilter, limit) {
  const allowedStatuses = new Set(["created", "exists"]);
  const requested = countriesFilter
    ? new Set(countriesFilter.split(",").map((country) => clean(country).toLowerCase()).filter(Boolean))
    : null;

  const grouped = new Map();
  for (const row of rows) {
    const country = clean(row.maya_country_or_region);
    if (requested && !requested.has(country.toLowerCase())) continue;
    if (!allowedStatuses.has(clean(row.status))) continue;
    if (!clean(row.telna_template_id)) continue;

    if (!grouped.has(country)) grouped.set(country, []);
    grouped.get(country).push(row);
  }

  for (const [country, countryRows] of grouped.entries()) {
    countryRows.sort((a, b) => {
      if (isUnlimitedPlan(a) !== isUnlimitedPlan(b)) return isUnlimitedPlan(a) ? 1 : -1;
      const dataDiff = numberValue(a.data_gb) - numberValue(b.data_gb);
      if (dataDiff !== 0) return dataDiff;
      return numberValue(a.validity_days) - numberValue(b.validity_days);
    });
    if (limit) grouped.set(country, countryRows.slice(0, limit));
  }

  return grouped;
}

async function findProductByTitle(title) {
  const query = `
    query FindProduct($query: String!) {
      products(first: 10, query: $query) {
        nodes {
          id
          title
          variants(first: 250) {
            nodes {
              id
              title
              price
              selectedOptions { name value }
              telnaPackageTemplateId: metafield(namespace: "custom", key: "telna_package_template_id") { value }
            }
          }
        }
      }
    }
  `;

  const json = await shopifyGraphql(query, { query: `title:'${escapeSearch(title)}'` });
  const products = json?.data?.products?.nodes || [];
  return products.find((product) => clean(product?.title).toLowerCase() === clean(title).toLowerCase()) || null;
}

async function createProduct(title, firstVariantName) {
  const mutation = `
    mutation CreateProduct($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id title }
        userErrors { field message }
      }
    }
  `;

  const json = await shopifyGraphql(mutation, {
    product: {
      title,
      descriptionHtml: productDescription(title),
      status: "ACTIVE",
      vendor: "Quebec eSIM",
      productType: "eSIM",
      tags: ["Telna", "eSIM", title],
      productOptions: [
        {
          name: "Plan",
          values: [{ name: firstVariantName }],
        },
      ],
    },
  });

  const result = json?.data?.productCreate;
  const userErrors = result?.userErrors || [];
  if (userErrors.length) throw new Error(userErrors[0]?.message || "Shopify productCreate failed");
  return result?.product;
}

async function createVariants(productId, rows) {
  if (!rows.length) return [];

  const mutation = `
    mutation CreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants {
          id
          title
          selectedOptions { name value }
        }
        userErrors { field message }
      }
    }
  `;

  const variants = rows.map((row) => ({
    price: money(row.rrp_price),
    taxable: false,
    inventoryItem: {
      sku: sku(row.maya_country_or_region, row),
      tracked: false,
      requiresShipping: false,
    },
    optionValues: [
      {
        optionName: "Plan",
        name: variantTitle(row),
      },
    ],
  }));

  const json = await shopifyGraphql(mutation, { productId, variants });
  const result = json?.data?.productVariantsBulkCreate;
  const userErrors = result?.userErrors || [];
  if (userErrors.length) throw new Error(userErrors[0]?.message || "Shopify productVariantsBulkCreate failed");
  return result?.productVariants || [];
}

async function updateVariants(productId, variantRows) {
  if (!variantRows.length) return [];

  const mutation = `
    mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          title
          selectedOptions { name value }
        }
        userErrors { field message }
      }
    }
  `;

  const variants = variantRows.map(({ variantId, row }) => ({
    id: variantId,
    price: money(row.rrp_price),
    taxable: false,
    inventoryItem: {
      sku: sku(row.maya_country_or_region, row),
      tracked: false,
      requiresShipping: false,
    },
  }));

  const json = await shopifyGraphql(mutation, { productId, variants });
  const result = json?.data?.productVariantsBulkUpdate;
  const userErrors = result?.userErrors || [];
  if (userErrors.length) throw new Error(userErrors[0]?.message || "Shopify productVariantsBulkUpdate failed");
  return result?.productVariants || [];
}

async function setVariantTelnaMetafields(variantRows) {
  if (!variantRows.length) return true;

  const mutation = `
    mutation SetVariantMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const metafields = variantRows.map(({ variantId, row }) => ({
    ownerId: variantId,
    namespace: "custom",
    key: "telna_package_template_id",
    type: "single_line_text_field",
    value: clean(row.telna_template_id),
  }));

  const json = await shopifyGraphql(mutation, { metafields });
  const userErrors = json?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) throw new Error(userErrors[0]?.message || "Failed to set Telna variant metafield");
  return true;
}

function variantPlanValue(variant) {
  const option = (variant?.selectedOptions || []).find((o) => clean(o?.name).toLowerCase() === "plan");
  return clean(option?.value || variant?.title);
}

async function syncProduct(country, rows, { create }) {
  const desired = rows.map((row) => ({ row, title: variantTitle(row) }));

  if (!create) {
    return {
      country,
      mode: "dry-run",
      variantsReady: desired.length,
      variants: desired.map(({ row, title }) => ({
        title,
        price: money(row.rrp_price),
        inventoryTracked: false,
        requiresShipping: false,
        telnaPackageTemplateId: clean(row.telna_template_id),
      })),
    };
  }

  let product = await findProductByTitle(country);
  if (!product) {
    product = await createProduct(country, desired[0].title);
    product = await findProductByTitle(country);
  }
  if (!product?.id) throw new Error(`Could not create or find Shopify product '${country}'`);

  const existingByTitle = new Map((product?.variants?.nodes || []).map((variant) => [variantPlanValue(variant), variant]));
  const missing = desired.filter(({ title }) => !existingByTitle.has(title));

  let createdVariants = [];
  if (missing.length) {
    createdVariants = await createVariants(product.id, missing.map(({ row }) => row));
    product = await findProductByTitle(country);
  }

  const refreshedByTitle = new Map((product?.variants?.nodes || []).map((variant) => [variantPlanValue(variant), variant]));
  const metafieldUpdates = desired
    .map(({ row, title }) => {
      const variant = refreshedByTitle.get(title);
      return variant?.id ? { variantId: variant.id, row } : null;
    })
    .filter(Boolean);

  await updateVariants(product.id, metafieldUpdates);
  await setVariantTelnaMetafields(metafieldUpdates);

  return {
    country,
    mode: "create",
    productId: product.id,
    variantsReady: desired.length,
    variantsCreated: createdVariants.length,
    variantsExisting: desired.length - createdVariants.length,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const source = path.resolve(args.source);
  const rows = parseCsv(fs.readFileSync(source, "utf8"));
  const grouped = groupRows(rows, args.countries, args.limit);

  const results = [];
  for (const [country, countryRows] of grouped.entries()) {
    results.push(await syncProduct(country, countryRows, { create: args.create }));
  }

  console.log(JSON.stringify({
    mode: args.create ? "create" : "dry-run",
    source,
    countries: results.length,
    totalVariants: results.reduce((sum, result) => sum + Number(result.variantsReady || 0), 0),
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
