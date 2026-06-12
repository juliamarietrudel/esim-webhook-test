// services/telna.js
import crypto from "crypto";
import { safeFetch } from "../utils/http.js";

function telnaBaseUrl() {
  return (process.env.TELNA_BASE_URL || "https://developer-api.telna.com/v2.1").trim().replace(/\/$/, "");
}

function telnaAuthHeader() {
  const token = (process.env.TELNA_API_TOKEN || "").trim();
  if (!token) throw new Error("Missing TELNA_API_TOKEN env var");
  return `Bearer ${token}`;
}

async function parseJsonSafe(resp) {
  return await resp.json().catch(() => ({}));
}

async function telnaFetch(path, options = {}) {
  const resp = await safeFetch(`${telnaBaseUrl()}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: telnaAuthHeader(),
      "Request-ID": crypto.randomUUID(),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  const data = await parseJsonSafe(resp);

  if (!resp.ok) {
    console.error("Telna API error:", { path, status: resp.status, data });
    throw new Error(data?.error || data?.message || `Telna API failed (${resp.status})`);
  }

  return data;
}

export async function listTelnaSims({ count = 100, offset = 0, inventory, group, status } = {}) {
  const params = new URLSearchParams();
  params.set("count", String(count));
  params.set("offset", String(offset));
  if (inventory) params.set("inventory", String(inventory));
  if (group) params.set("group", String(group));
  if (status) params.set("status", String(status));

  return await telnaFetch(`/inventory/sim-registries?${params.toString()}`);
}

export async function listTelnaPackages({ count = 100, offset = 0, sim, status, packageTemplate } = {}) {
  const params = new URLSearchParams();
  params.set("count", String(count));
  params.set("offset", String(offset));
  if (sim) params.set("sim", String(sim));
  if (status) params.set("status", String(status));
  if (packageTemplate) params.set("package_template", String(packageTemplate));

  return await telnaFetch(`/pcr/packages?${params.toString()}`);
}

export async function createTelnaPackage({ iccid, packageTemplateId, timeAllowance }) {
  const sim = String(iccid || "").trim();
  const package_template = Number(packageTemplateId);

  if (!sim) throw new Error("createTelnaPackage: missing iccid");
  if (!Number.isFinite(package_template)) {
    throw new Error("createTelnaPackage: missing or invalid packageTemplateId");
  }

  const body = {
    sim,
    package_template,
    ...(timeAllowance ? { time_allowance: Number(timeAllowance) } : {}),
  };

  return await telnaFetch("/pcr/packages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function retrieveTelnaPackage(packageId) {
  const cleanPackageId = String(packageId || "").trim();
  if (!cleanPackageId) throw new Error("retrieveTelnaPackage: missing packageId");

  return await telnaFetch(`/pcr/packages/${encodeURIComponent(cleanPackageId)}`);
}

export async function retrieveTelnaEuiccProfile(iccid) {
  const cleanIccid = String(iccid || "").trim();
  if (!cleanIccid) throw new Error("retrieveTelnaEuiccProfile: missing iccid");

  return await telnaFetch(`/esim-rsp/euicc-profiles/${encodeURIComponent(cleanIccid)}`);
}

function truthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function packageCount(packagesResp) {
  if (Number.isFinite(Number(packagesResp?.total))) return Number(packagesResp.total);

  const packages =
    packagesResp?.packages ||
    packagesResp?.items ||
    packagesResp?.data ||
    packagesResp?.results ||
    [];

  if (Array.isArray(packages)) return packages.length;

  return Number(packagesResp?.count ?? 0);
}

function blockingPackageStatuses() {
  const raw = process.env.TELNA_BLOCKING_PACKAGE_STATUSES || "ACTIVE,NOT_ACTIVE";
  return raw
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
}

async function hasBlockingTelnaPackages(iccid) {
  for (const status of blockingPackageStatuses()) {
    const packagesResp = await listTelnaPackages({ sim: iccid, status, count: 1, offset: 0 });
    if (packageCount(packagesResp) > 0) return true;
  }

  return false;
}

export async function findAvailableTelnaEsim({ inventory, group } = {}) {
  const allowTerminatedReuse = truthyEnv("TELNA_REUSE_TERMINATED_ESIMS");
  const simsResp = await listTelnaSims({ count: 100, offset: 0, inventory, group });
  const sims = Array.isArray(simsResp?.sims) ? simsResp.sims : [];

  const candidates = sims.filter((sim) => {
    const iccid = String(sim?.iccid || "").trim();
    const simType = String(sim?.sim_type || "").trim().toLowerCase();
    const status = String(sim?.sim_status || "").trim().toLowerCase();

    if (!iccid) return false;
    if (simType !== "esim") return false;
    return ["pre-service", "pre_service", "available", "in_stock", "released"].includes(status);
  });

  for (const sim of candidates) {
    if (allowTerminatedReuse) {
      const hasBlockingPackages = await hasBlockingTelnaPackages(sim.iccid);
      if (!hasBlockingPackages) return sim;
      continue;
    }

    const packagesResp = await listTelnaPackages({ sim: sim.iccid, count: 1, offset: 0 });
    const existingCount = packageCount(packagesResp);
    if (existingCount === 0) return sim;
  }

  throw new Error(
    allowTerminatedReuse
      ? "No available Telna eSIM found without active or not-active packages"
      : "No available Telna eSIM found with zero existing packages",
  );
}
