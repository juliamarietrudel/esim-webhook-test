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

export async function retrieveTelnaEuiccProfile(iccid) {
  const cleanIccid = String(iccid || "").trim();
  if (!cleanIccid) throw new Error("retrieveTelnaEuiccProfile: missing iccid");

  return await telnaFetch(`/esim-rsp/euicc-profiles/${encodeURIComponent(cleanIccid)}`);
}

export async function findAvailableTelnaEsim({ inventory, group } = {}) {
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
    const packagesResp = await listTelnaPackages({ sim: sim.iccid, count: 1, offset: 0 });
    const existingCount = Number(packagesResp?.total ?? packagesResp?.count ?? 0);
    if (existingCount === 0) return sim;
  }

  throw new Error("No available Telna eSIM found with zero existing packages");
}
