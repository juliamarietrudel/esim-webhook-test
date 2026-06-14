import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import dotenv from "dotenv";

const require = createRequire(import.meta.url);
const countries = require("i18n-iso-countries");
const en = require("i18n-iso-countries/langs/en.json");
countries.registerLocale(en);

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.telna", quiet: true });

const COUNTRY_ALIASES = new Map([
  ["bosnia", "Bosnia and Herzegovina"],
  ["bosnia and herzegovina", "Bosnia and Herzegovina"],
  ["bonaire", "Bonaire, Sint Eustatius and Saba"],
  ["british virgin islands", "Virgin Islands, British"],
  ["brunei", "Brunei Darussalam"],
  ["cape verde", "Cape Verde"],
  ["caribbean netherlands", "Bonaire, Sint Eustatius and Saba"],
  ["congo", "Congo"],
  ["congo democratic republic", "Congo, The Democratic Republic of the"],
  ["curacao", "Curaçao"],
  ["czech republic", "Czechia"],
  ["falkland islands", "Falkland Islands (Malvinas)"],
  ["hong kong", "Hong Kong"],
  ["ivory coast", "Côte d'Ivoire"],
  ["laos", "Lao People's Democratic Republic"],
  ["macau", "Macao"],
  ["macedonia", "North Macedonia"],
  ["moldova", "Moldova, Republic of"],
  ["netherlands antilles", "Bonaire, Sint Eustatius and Saba"],
  ["north macedonia", "North Macedonia"],
  ["palestine", "Palestine, State of"],
  ["russia", "Russian Federation"],
  ["saipan (cnmi)", "Northern Mariana Islands"],
  ["saint barthelemy", "Saint Barthélemy"],
  ["saint martin", "Saint Martin (French part)"],
  ["sint maarten", "Sint Maarten (Dutch part)"],
  ["st. vincent and the grenadines", "Saint Vincent and the Grenadines"],
  ["south korea", "Korea, Republic of"],
  ["swaziland", "Eswatini"],
  ["syria", "Syrian Arab Republic"],
  ["taiwan", "Taiwan, Province of China"],
  ["tanzania", "Tanzania"],
  ["turkey", "Türkiye"],
  ["u.s. virgin islands", "Virgin Islands, U.S."],
  ["united kingdom", "United Kingdom"],
  ["united states", "United States of America"],
  ["usa", "United States of America"],
  ["vietnam", "Vietnam"],
]);

function parseArgs(argv) {
  const args = {
    source: "/Users/juliatrudel/Desktop/countries.csv",
    regionSource: "/Users/juliatrudel/Desktop/region.csv",
    outDir: "outputs/telna-package-templates",
    create: false,
    limit: null,
    offset: 0,
    country: null,
    countries: null,
    includeRegions: false,
    allowDuplicates: false,
    includeUnlimited: false,
    unlimitedPolicy: "Daily - 3GB per Day, then 1Mbps",
    unlimitedAllowanceGbPerDay: Number(process.env.TELNA_UNLIMITED_ALLOWANCE_GB_PER_DAY || 5),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--source") args.source = next, i += 1;
    else if (arg === "--region-source") args.regionSource = next, i += 1;
    else if (arg === "--out-dir") args.outDir = next, i += 1;
    else if (arg === "--create") args.create = true;
    else if (arg === "--limit") args.limit = Number(next), i += 1;
    else if (arg === "--offset") args.offset = Number(next), i += 1;
    else if (arg === "--country") args.country = next, i += 1;
    else if (arg === "--countries") args.countries = next, i += 1;
    else if (arg === "--include-regions") args.includeRegions = true;
    else if (arg === "--allow-duplicates") args.allowDuplicates = true;
    else if (arg === "--include-unlimited") args.includeUnlimited = true;
    else if (arg === "--unlimited-policy") args.unlimitedPolicy = next, i += 1;
    else if (arg === "--unlimited-allowance-gb-per-day") args.unlimitedAllowanceGbPerDay = Number(next), i += 1;
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/telna-package-templates.js [options]

Safe preview:
  node scripts/telna-package-templates.js
  node scripts/telna-package-templates.js --country Canada --limit 5

Create in Telna, after reviewing the output:
  node scripts/telna-package-templates.js --create --country Canada --limit 1

Options:
  --source <path>          Country CSV path. Defaults to ~/Desktop/countries.csv
  --region-source <path>   Region CSV path. Defaults to ~/Desktop/region.csv
  --out-dir <path>         Output directory. Defaults to outputs/telna-package-templates
  --country <name>         Only process one country from the Region column
  --countries <names>      Only process comma-separated countries, e.g. Canada,Spain,Egypt
  --limit <n>              Process at most n rows
  --offset <n>             Skip n rows after filtering
  --include-regions        Also load region.csv into a separate preview file
  --create                 POST templates to Telna instead of dry-run only
  --allow-duplicates       Do not skip templates that already exist by name
  --include-unlimited      Include the approved unlimited policy in preview/create
  --unlimited-policy <txt> Maya traffic policy to include for unlimited plans.
                           Defaults to "Daily - 3GB per Day, then 1Mbps"
  --unlimited-allowance-gb-per-day <n>
                           Technical high-volume allowance per day. Defaults to 5

Unlimited env:
  TELNA_UNLIMITED_TRAFFIC_POLICY_ID is required when --include-unlimited is used.
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

function normalizeCountryName(value) {
  const cleaned = clean(value);
  const key = cleaned.toLowerCase();
  return COUNTRY_ALIASES.get(key) || cleaned;
}

function countryToIso3(value) {
  const normalized = normalizeCountryName(value);
  return countries.getAlpha3Code(normalized, "en") || null;
}

function moneyToNumber(value) {
  const cleaned = clean(value).replace(/[^0-9.-]/g, "");
  return cleaned ? Number(cleaned) : null;
}

function gbToBytes(value) {
  const cleaned = clean(value);
  if (!cleaned || cleaned.toLowerCase() === "unlimited") return null;
  const gb = Number(cleaned);
  if (!Number.isFinite(gb)) return null;
  return Math.round(gb * 1024 * 1024 * 1024);
}

function gbNumberToBytes(value) {
  const gb = Number(value);
  if (!Number.isFinite(gb)) return null;
  return Math.round(gb * 1024 * 1024 * 1024);
}

function isUnlimitedData(value) {
  return clean(value).toLowerCase() === "unlimited";
}

function daysToSeconds(value) {
  const days = Number(clean(value));
  if (!Number.isFinite(days)) return null;
  return Math.round(days * 24 * 60 * 60);
}

function daysNumber(value) {
  const days = Number(clean(value));
  return Number.isFinite(days) ? days : null;
}

function dayLabel(days) {
  return days === 1 ? "1 Day" : `${days} Days`;
}

function buildPlanName(row, { isUnlimitedPlan = false } = {}) {
  if (!isUnlimitedPlan) return clean(row.Name);

  const region = clean(row.Region);
  const days = daysNumber(row["Validity (Days)"]);
  return `${region} Unlimited - ${dayLabel(days)}`;
}

function selectedUnlimitedTrafficPolicyId() {
  const value = process.env.TELNA_UNLIMITED_TRAFFIC_POLICY_ID || "";
  const policyId = Number(value);
  return Number.isFinite(policyId) ? policyId : null;
}

function unlimitedDataBytes(row, args) {
  const days = daysNumber(row["Validity (Days)"]);
  const gbPerDay = Number(args.unlimitedAllowanceGbPerDay);
  if (!Number.isFinite(days) || !Number.isFinite(gbPerDay)) return null;
  return gbNumberToBytes(days * gbPerDay);
}

function buildPayload(row, iso3, { isUnlimitedPlan = false, dataBytes = null, args = null } = {}) {
  const inventory = process.env.TELNA_INVENTORY_ID ? Number(process.env.TELNA_INVENTORY_ID) : null;
  const trafficPolicy = isUnlimitedPlan
    ? selectedUnlimitedTrafficPolicyId()
    : (process.env.TELNA_TRAFFIC_POLICY_ID ? Number(process.env.TELNA_TRAFFIC_POLICY_ID) : null);
  const activationType = process.env.TELNA_ACTIVATION_TYPE || "AUTO";
  const activationWindowDays = Number(process.env.TELNA_ACTIVATION_TIME_ALLOWANCE_DAYS || 365);
  const availableDays = Number(process.env.TELNA_AVAILABLE_DAYS || 365);
  const now = Date.now();

  return {
    name: buildPlanName(row, { isUnlimitedPlan }),
    traffic_policy: trafficPolicy,
    supported_countries: [iso3],
    voice_usage_allowance: 0,
    data_usage_allowance: dataBytes ?? gbToBytes(row["Data (GB)"]),
    sms_usage_allowance: 0,
    activation_time_allowance: activationWindowDays * 24 * 60 * 60,
    activation_type: activationType,
    earliest_activation_date: now,
    earliest_available_date: now,
    latest_available_date: now + availableDays * 24 * 60 * 60 * 1000,
    notes: [
      `Imported from Maya plan ${clean(row.ID)}.`,
      `Maya WSP: ${clean(row["WSP info"])}.`,
      `Maya RRP: ${clean(row["RRP info"])}.`,
      `Wi-Fi hotspot: ${clean(row["Wi-Fi Hotspot"])}.`,
      `Maya traffic policy: ${clean(row["Traffic Policy"])}.`,
      isUnlimitedPlan
        ? `Unlimited import: technical allowance ${args?.unlimitedAllowanceGbPerDay || 5}GB/day with Telna traffic policy ${trafficPolicy}.`
        : "",
    ].join(" "),
    time_allowance: {
      duration: daysToSeconds(row["Validity (Days)"]),
      unit: "SECOND",
    },
    inventory,
  };
}

function toCsv(rows) {
  const headers = [
    "source",
    "maya_id",
    "maya_country_or_region",
    "iso3",
    "name",
    "data_gb",
    "plan_kind",
    "maya_traffic_policy",
    "validity_days",
    "data_bytes",
    "duration_seconds",
    "wsp_price",
    "rrp_price",
    "telna_inventory_id",
    "telna_traffic_policy_id",
    "telna_template_id",
    "status",
    "error",
  ];
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((h) => quote(row[h])).join(","))].join("\n") + "\n";
}

function prepareCountryRows(rows, sourceName, args) {
  return rows.map((row) => {
    const region = clean(row.Region);
    const iso3 = countryToIso3(region);
    const dataIsUnlimited = isUnlimitedData(row["Data (GB)"]);
    const mayaTrafficPolicy = clean(row["Traffic Policy"]);
    const includeThisUnlimited = dataIsUnlimited
      && args.includeUnlimited
      && mayaTrafficPolicy.toLowerCase() === clean(args.unlimitedPolicy).toLowerCase();
    const dataBytes = dataIsUnlimited
      ? (includeThisUnlimited ? unlimitedDataBytes(row, args) : null)
      : gbToBytes(row["Data (GB)"]);
    const durationSeconds = daysToSeconds(row["Validity (Days)"]);
    const payload = iso3 && dataBytes && durationSeconds
      ? buildPayload(row, iso3, { isUnlimitedPlan: includeThisUnlimited, dataBytes, args })
      : null;
    let status = "preview";
    let error = "";
    if (!iso3) {
      status = "unmapped_country";
      error = `Could not map '${region}' to ISO-3`;
    } else if (dataIsUnlimited && !args.includeUnlimited) {
      status = "unsupported_unlimited_or_data";
      error = "Unlimited plan skipped. Re-run with --include-unlimited after Telna traffic policy is confirmed.";
    } else if (dataIsUnlimited && !includeThisUnlimited) {
      status = "skipped_unlimited_policy";
      error = `Unlimited plan skipped because Maya traffic policy '${mayaTrafficPolicy}' does not match '${clean(args.unlimitedPolicy)}'.`;
    } else if (dataIsUnlimited && !selectedUnlimitedTrafficPolicyId()) {
      status = "missing_unlimited_traffic_policy";
      error = "TELNA_UNLIMITED_TRAFFIC_POLICY_ID is required for included unlimited plans.";
    } else if (!dataBytes) {
      status = "unsupported_unlimited_or_data";
      error = `Cannot create a fixed Telna data allowance from Data (GB)='${clean(row["Data (GB)"])}'`;
    } else if (!durationSeconds) {
      status = "invalid_duration";
      error = `Cannot convert Validity (Days)='${clean(row["Validity (Days)"])}' to seconds`;
    }

    return {
      source: sourceName,
      maya_id: clean(row.ID),
      maya_country_or_region: region,
      iso3,
      name: buildPlanName(row, { isUnlimitedPlan: includeThisUnlimited }),
      data_gb: clean(row["Data (GB)"]),
      plan_kind: dataIsUnlimited ? (includeThisUnlimited ? "unlimited" : "unlimited_skipped") : "fixed",
      maya_traffic_policy: mayaTrafficPolicy,
      validity_days: clean(row["Validity (Days)"]),
      data_bytes: dataBytes,
      duration_seconds: durationSeconds,
      wsp_price: moneyToNumber(row["WSP info"]),
      rrp_price: moneyToNumber(row["RRP info"]),
      telna_inventory_id: payload?.inventory ?? "",
      telna_traffic_policy_id: payload?.traffic_policy ?? "",
      telna_template_id: "",
      status,
      error,
      payload,
      raw: row,
    };
  });
}

function telnaConfig() {
  const baseUrl = (process.env.TELNA_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.TELNA_API_TOKEN;
  if (!baseUrl) throw new Error("TELNA_BASE_URL is required for --create");
  if (!token) throw new Error("TELNA_API_TOKEN is required for --create");
  return { baseUrl, token };
}

async function telnaRequest(pathname, options = {}) {
  const { baseUrl, token } = telnaConfig();
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Telna API failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

function normalizeName(value) {
  return clean(value).toLowerCase();
}

function existingTemplateName(template) {
  return (
    template?.name ||
    template?.package_template_name ||
    template?.packageTemplateName ||
    template?.package_template?.name ||
    ""
  );
}

function extractTemplateList(responseBody) {
  if (Array.isArray(responseBody)) return responseBody;
  const candidates = [
    responseBody?.package_templates,
    responseBody?.packageTemplates,
    responseBody?.templates,
    responseBody?.items,
    responseBody?.data,
    responseBody?.results,
  ];
  return candidates.find(Array.isArray) || [];
}

function extractTotal(responseBody, currentCount, offset) {
  const total = Number(responseBody?.total ?? responseBody?.total_count ?? responseBody?.count_total);
  if (Number.isFinite(total)) return total;
  return offset + currentCount;
}

async function listExistingPackageTemplates({ inventory }) {
  if (!inventory) throw new Error("TELNA_INVENTORY_ID is required for --create");

  const all = [];
  const count = 100;
  for (let offset = 0; ; offset += count) {
    const params = new URLSearchParams({
      count: String(count),
      offset: String(offset),
      inventory: String(inventory),
    });
    const body = await telnaRequest(`/pcr/package-templates?${params.toString()}`);
    const templates = extractTemplateList(body);
    all.push(...templates);

    const total = extractTotal(body, templates.length, offset);
    if (templates.length < count || all.length >= total) break;
  }
  return all;
}

function buildExistingTemplateIndex(templates) {
  const byName = new Map();
  for (const template of templates) {
    const name = normalizeName(existingTemplateName(template));
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, template);
  }
  return byName;
}

function markExistingTemplate(row, existingTemplate) {
  row.telna_template_id = extractTemplateId(existingTemplate);
  row.status = "exists";
  row.error = "Skipped because a Telna package template with this name already exists in this inventory.";
}

async function createTemplate(prepared) {
  if (!prepared.payload) throw new Error(prepared.error || "Missing payload");
  if (!prepared.payload.inventory) throw new Error("TELNA_INVENTORY_ID is required for --create");
  if (prepared.plan_kind === "unlimited" && !prepared.payload.traffic_policy) {
    throw new Error("TELNA_UNLIMITED_TRAFFIC_POLICY_ID is required for unlimited templates");
  }

  return await telnaRequest("/pcr/package-templates", {
    method: "POST",
    body: JSON.stringify(prepared.payload),
  });
}

function extractTemplateId(responseBody) {
  return responseBody?.id || responseBody?.package_template_id || responseBody?.package_template?.id || "";
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outDir, { recursive: true });

  const countriesText = fs.readFileSync(args.source, "utf8");
  let prepared = prepareCountryRows(parseCsv(countriesText), "countries", args);

  if (args.country) {
    const requested = clean(args.country).toLowerCase();
    prepared = prepared.filter((row) => row.maya_country_or_region.toLowerCase() === requested);
  }
  if (args.countries) {
    const requested = new Set(args.countries.split(",").map((country) => clean(country).toLowerCase()).filter(Boolean));
    prepared = prepared.filter((row) => requested.has(row.maya_country_or_region.toLowerCase()));
  }

  prepared = prepared.slice(args.offset, args.limit ? args.offset + args.limit : undefined);

  const createdResponses = [];
  if (args.create) {
    const inventory = prepared.find((row) => row.payload?.inventory)?.payload?.inventory;
    const existingByName = args.allowDuplicates
      ? new Map()
      : buildExistingTemplateIndex(await listExistingPackageTemplates({ inventory }));

    for (const row of prepared) {
      if (row.status !== "preview") {
        console.log(`skipped ${row.name}: ${row.error}`);
        continue;
      }

      const existingTemplate = existingByName.get(normalizeName(row.name));
      if (existingTemplate) {
        markExistingTemplate(row, existingTemplate);
        console.log(`exists ${row.name}: ${row.telna_template_id || "unknown id"}`);
        continue;
      }

      try {
        const responseBody = await createTemplate(row);
        row.telna_template_id = extractTemplateId(responseBody);
        row.status = "created";
        row.error = "";
        createdResponses.push({ maya_id: row.maya_id, response: responseBody });
        existingByName.set(normalizeName(row.name), responseBody);
        console.log(`created ${row.name}: ${row.telna_template_id || "unknown id"}`);
      } catch (error) {
        row.status = "error";
        row.error = error.message;
        console.error(`failed ${row.name}: ${error.message}`);
      }
    }
  }

  const csvRows = prepared.map(({ payload, raw, ...row }) => row);
  const payloads = prepared.map(({ raw, ...row }) => row);
  fs.writeFileSync(path.join(args.outDir, "countries-preview.csv"), toCsv(csvRows));
  fs.writeFileSync(path.join(args.outDir, "countries-payloads.json"), JSON.stringify(payloads, null, 2));
  if (createdResponses.length) {
    fs.writeFileSync(path.join(args.outDir, "created-responses.json"), JSON.stringify(createdResponses, null, 2));
  }

  if (args.includeRegions && fs.existsSync(args.regionSource)) {
    const regionRows = parseCsv(fs.readFileSync(args.regionSource, "utf8"));
    fs.writeFileSync(path.join(args.outDir, "regions-raw-preview.json"), JSON.stringify(regionRows, null, 2));
  }

  const unmapped = csvRows.filter((row) => row.status === "unmapped_country");
  const readyStatuses = new Set(["preview", "created", "exists"]);
  const intentionalSkipStatuses = new Set(["skipped_unlimited_policy"]);
  const unsupported = csvRows.filter((row) => !readyStatuses.has(row.status) && !intentionalSkipStatuses.has(row.status));
  const summary = {
    mode: args.create ? "create" : "dry-run",
    rowsPrepared: prepared.length,
    rowsWithIso3: csvRows.length - unmapped.length,
    rowsReadyToCreate: csvRows.filter((row) => readyStatuses.has(row.status)).length,
    rowsSkippedIntentionally: csvRows.filter((row) => intentionalSkipStatuses.has(row.status)).length,
    rowsNeedingDecision: unsupported.length,
    unmappedCountries: [...new Set(unmapped.map((row) => row.maya_country_or_region))],
    statuses: csvRows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {}),
    outputCsv: path.resolve(args.outDir, "countries-preview.csv"),
    outputJson: path.resolve(args.outDir, "countries-payloads.json"),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
