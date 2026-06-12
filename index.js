// index.js
import express from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.telna", override: false });

import {
  getTelnaVariantConfig,
  getTelnaIccidFromShopifyCustomer,
  saveTelnaIccidToShopifyCustomer,
  getTelnaOrderProcessedFlag,
  markTelnaOrderProcessed,
  saveTelnaProvisioningToOrder,
  getOrdersWithTelnaPackages,
  fulfillShopifyOrder,
  usageAlertKey,
  getUsageAlertFlag,
  markUsageAlertSent,
  tryAcquireOrderProcessingLock,
  releaseOrderProcessingLock,
} from "./services/shopify.js";

import {
  createTelnaPackage,
  findAvailableTelnaEsim,
  retrieveTelnaPackage,
  retrieveTelnaEuiccProfile,
} from "./services/telna.js";

const app = express();
console.log("BOOT MARKER: build-2026-02-15-01");

// -----------------------------
// Logging (reduce noise)
// -----------------------------
const LOG_LEVEL = String(process.env.LOG_LEVEL || "info").toLowerCase();
const log = {
  debug: (...a) => (LOG_LEVEL === "debug" ? console.log(...a) : undefined),
  info: (...a) => (["debug", "info"].includes(LOG_LEVEL) ? console.log(...a) : undefined),
  warn: (...a) => (["debug", "info", "warn"].includes(LOG_LEVEL) ? console.warn(...a) : undefined),
  error: (...a) => console.error(...a),
};

function truthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

// -----------------------------
// Usage alert settings (CRON)
// -----------------------------
const USAGE_ALERT_THRESHOLD_PERCENT = Number(process.env.USAGE_ALERT_THRESHOLD_PERCENT || 75);
// In-memory de-dupe so we don't email every cron run while the server stays up.
// NOTE: if the server restarts, this resets. For true "send once" you should persist a flag in Shopify metafields.

// -----------------------------
// Telna settings
// -----------------------------
function optionalEnvNumber(name) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number when provided`);
  }

  return value;
}

const TELNA_INVENTORY_ID = optionalEnvNumber("TELNA_INVENTORY_ID");
const TELNA_GROUP_ID = optionalEnvNumber("TELNA_GROUP_ID");

// -----------------------------
// Email (Resend)
// -----------------------------
const resendApiKey = (process.env.RESEND_API_KEY || "").trim();
const emailFrom = (process.env.EMAIL_FROM || "").trim();
const emailEnabled = Boolean(resendApiKey && emailFrom);
const resend = emailEnabled ? new Resend(resendApiKey) : null;
const INTERNAL_BCC = (process.env.INTERNAL_BCC || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!emailEnabled) {
  console.warn("⚠️ Email not configured. Set RESEND_API_KEY and EMAIL_FROM to send eSIM emails.");
}

async function generateQrPngBase64(payload) {
  if (!payload) return null;
  const pngBuffer = await QRCode.toBuffer(payload, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 6,
  });
  return pngBuffer.toString("base64");
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatEsimEmailHtml({
  firstName,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
  activationCode,
  manualCode,
  smdpAddress,
  apn,
  qrDataUrl,
}) {
  const safeName = (firstName || "").trim() || "client(e)";

  const row = (label, value) =>
    value
      ? `<tr><td style="padding:10px 0;"><b>${label} :</b> ${esc(value)}</td></tr>`
      : "";

  const codeRow = (label, value) =>
    value
      ? `<tr>
          <td style="padding:10px 0;">
            <b>${label} :</b>
            <code style="background:#F1F5F9; padding:4px 8px; border-radius:6px; display:inline-block;">
              ${esc(value)}
            </code>
          </td>
        </tr>`
      : "";

  const apnRow = apn ? `<tr><td style="padding:10px 0;"><b>APN :</b> ${esc(apn)}</td></tr>` : "";

  // ✅ Remplace ces liens par tes URLs réelles
  const links = {
    iphone: "https://quebecesim.ca/pages/installation-sur-appareil-iphone",
    samsung: "https://quebecesim.ca/pages/installer-ma-esim-dans-mon-appareil-samsung",
    pixel: "https://quebecesim.ca/pages/installation-sur-appareil-google-pixel",
    ipad: "https://quebecesim.ca/pages/installation-sur-ipad-compatible-esim-seulement",
    conso: "https://quebecesim.ca/pages/comment-suivre-ma-consommation",
    erreurs: "https://quebecesim.ca/pages/jobtiens-un-message-derreur-lors-de-linstallation",
    contact: "https://quebecesim.ca/pages/contactez-nous",
  };

  const bullet = (text) =>
    `<li style="margin:10px 0; line-height:1.45; color:#334155; font-size:14px;">${text}</li>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Votre eSIM est prête</title>
</head>

<body style="margin:0; padding:0; background:#F6FAFD; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding: 32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
          style="width:100%; max-width:800px; background:#FFFFFF; border-radius: 18px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); overflow:hidden;">

          <tr>
            <td style="padding: 20px 24px; border-bottom: 1px solid #E5E7EB;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <img 
                      src="https://quebecesim.ca/cdn/shop/files/1000008019.png?v=1737480349&width=600"
                      alt="Québec eSIM"
                      width="80"
                      style="display:block; max-width:140px; height:auto;"
                    />
                  </td>
                  <td align="right">
                    <span style="display:inline-block; padding:8px 12px; border-radius:999px; background:#0CA3EC; color:#FFFFFF; font-weight:600; font-size:12px;">
                      eSIM
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 28px 24px;">

              <h1 style="margin: 0 0 16px; font-size: 22px; color:#0F172A;">
                Votre eSIM est prête !
              </h1>

              <p style="font-size: 15px; color:#334155; margin: 0 0 14px;">
                Bonjour <b>${esc(safeName)}</b>,
              </p>

              <p style="font-size: 15px; color:#334155; margin: 0 0 18px;">
                Merci pour votre achat. Vous trouverez ci-dessous les informations nécessaires pour l’installation et l’activation de votre eSIM :
              </p>

              <ul style="margin:0 0 22px 18px; padding:0; color:#334155; font-size:14px;">
                ${bullet("Votre code QR")}
                ${bullet("Votre code d’activation manuel (iPhone et Android)")}
                ${bullet("Les liens vers nos procédures d’installation")}
              </ul>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 12px;">Détails du forfait</h2>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 22px;">
                ${row("Forfait", planName)}
                ${row("Destination", country)}
                ${row("Validité", validityDays ? `${validityDays} jours` : "")}
                ${row("Données", dataQuotaMb ? `${dataQuotaMb} Mo` : "")}
                ${codeRow("ICCID", iccid)}
              </table>

              <div style="text-align:center; margin: 18px 0 22px;">
                <img 
                    src="${qrDataUrl}"
                    alt="Scanner pour installer l’eSIM"
                    width="180"
                    style="border-radius:12px; border:1px solid #E5E7EB;"
                />
                <p style="font-size:12px; color:#64748B; margin-top:8px;">
                    Scannez ce code QR pour installer votre eSIM
                </p>
              </div>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin: 12px 0 22px;">
                <tr>
                  <td style="font-size: 13px; color:#475569; line-height:1.45;">
                    <b>Conseil :</b> Si vous utilisez le même téléphone, ouvrez ce courriel sur un autre appareil pour scanner le code QR.
                  </td>
                </tr>
              </table>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 10px;">Recommandations importantes</h2>
              <ul style="margin:0 0 18px 18px; padding:0;">
                ${bullet("Il est préférable d’installer vos eSIM <b>avant votre départ</b>. Les forfaits débutent à la première connexion au réseau de destination. Si votre forfait inclut le Canada, celui-ci débutera le jour de l’installation.")}
                ${bullet("Une connexion <b>Wi-Fi stable</b> est requise lors de l’installation (aucune installation possible sur le Wi-Fi d’un bateau de croisière).")}
                ${bullet("Message d’erreur « eSIM non compatible » : votre appareil est probablement verrouillé par votre fournisseur. Veuillez le contacter pour le déverrouiller.")}
                ${bullet(`Message d’erreur « Impossible d’activer l’eSIM » (iPhone) : votre eSIM est probablement bien installée. Consultez : <a href="${links.erreurs}" style="color:#0CA3EC; text-decoration:none;">Un message d’erreur s’affiche ?</a>`)}
                ${bullet("Avant de monter à bord de votre vol, désactivez votre carte SIM principale et activez votre eSIM à destination.")}
                ${bullet("Assurez-vous que l’itinérance des données est <b>ACTIVÉE</b> pour votre eSIM et que votre mode avion est <b>DÉSACTIVÉ</b>.")}
                ${bullet(`Votre eSIM est rechargeable avec un forfait de la même destination. Surveillez votre consommation : <a href="${links.conso}" style="color:#0CA3EC; text-decoration:none;">Comment suivre ma consommation ?</a>`)}
                ${bullet(`En cas de problème, <b>ne supprimez jamais votre eSIM</b>. Contactez-nous immédiatement : <a href="${links.contact}" style="color:#0CA3EC; text-decoration:none;">Contactez-nous</a>. Aucun remboursement sur une eSIM supprimée sans notre accord.`)}
              </ul>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 18px;">
                ${codeRow("Code d’activation ANDROID", activationCode)}
                ${codeRow("Code d’activation iPHONE", manualCode)}
                ${codeRow("Adresse SM-DP+", smdpAddress)}
                ${apnRow}
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 22px;">
                <tr>
                  <td style="font-size: 13px; color:#475569; line-height:1.45;">
                    <b>RAPPEL :</b> Pour que votre eSIM fonctionne, l’itinérance doit être <b>ACTIVÉE</b> et votre mode avion doit être <b>DÉSACTIVÉ</b>.
                  </td>
                </tr>
              </table>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 10px;">Procédures d’installation</h2>
              <ul style="margin:0 0 8px 18px; padding:0;">
                ${bullet(`<a href="${links.iphone}" style="color:#0CA3EC; text-decoration:none;">Installation d’une eSIM sur iPhone</a>`)}
                ${bullet(`<a href="${links.samsung}" style="color:#0CA3EC; text-decoration:none;">Installation eSIM sur appareil Samsung</a>`)}
                ${bullet(`<a href="${links.pixel}" style="color:#0CA3EC; text-decoration:none;">Installation sur appareil Google Pixel</a>`)}
                ${bullet(`<a href="${links.ipad}" style="color:#0CA3EC; text-decoration:none;">Installation sur iPad (compatible eSIM seulement)</a>`)}
              </ul>

              <p style="font-size: 14px; color:#334155; margin: 18px 0 0;">
                Nous vous souhaitons un excellent voyage avec votre eSIM Québec eSIM !
              </p>

              <p style="font-size: 14px; color:#334155; margin: 6px 0 0;">
                Cordialement,
              </p>

            </td>
          </tr>

          <tr>
            <td style="padding: 18px 24px; background:#F8FAFC; border-top: 1px solid #E5E7EB; font-size: 12px; color:#64748B;">
              <b>Besoin d’aide ?</b>
              <a href="${links.contact}" style="text-decoration:none; color: rgb(94, 94, 94);">
                Contactez-nous
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 18px 24px; background:#F8FAFC; border-top: 1px solid #E5E7EB; font-size: 12px; color:#64748B;">
              <b>© 2026 Québec eSIM</b>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
  </html>`;
}

async function sendEsimEmail({
  to,
  firstName,
  orderId,
  activationCode,
  manualCode,
  smdpAddress,
  apn,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
}) {
  if (!emailEnabled) {
    console.log("ℹ️ Skipping email send (email not configured).");
    return false;
  }
  if (!to) {
    console.warn("⚠️ No customer email found on order; cannot send eSIM email.");
    return false;
  }
  if (truthyEnv("SIMULATE_CUSTOMER_EMAIL_FAILURE")) {
    console.warn("🧪 Simulating customer eSIM email failure.");
    return false;
  }
  if (!activationCode) {
    console.warn("⚠️ Missing activation_code; cannot generate QR email.");
    return false;
  }

  const qrBase64 = await generateQrPngBase64(activationCode);
  if (!qrBase64) {
    console.warn("⚠️ Failed to generate QR code.");
    return false;
  }
  const qrDataUrl = `data:image/png;base64,${qrBase64}`;

  const subject = orderId
  ? `Votre eSIM – Code QR (Commande #${orderId})`
  : "Votre eSIM – Code QR";

  const html = formatEsimEmailHtml({
    firstName,
    planName,
    country,
    validityDays,
    dataQuotaMb,
    iccid,
    activationCode,
    manualCode,
    smdpAddress,
    apn,
    qrDataUrl,
  });

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    bcc: INTERNAL_BCC,
    subject,
    html,
    attachments: [{ filename: "esim-qr.png", content: qrBase64 }],
  });

  if (result?.error) {
    console.error("❌ Resend error:", result.error);
    return false;
  }

  console.log("✅ eSIM email sent via Resend:", { to, id: result?.data?.id });
  return true;
}

function formatTopUpEmailHtml({
  firstName,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
  activationCode,
  manualCode,
  qrDataUrl,
}) {
  const safeName = (firstName || "").trim() || "client(e)";

  const bullet = (text) =>
    `<li style="margin:10px 0; line-height:1.45; color:#334155; font-size:14px;">${text}</li>`;

  const row = (label, value) =>
    value
      ? `<tr><td style="padding:10px 0; font-size:14px; color:#334155;"><b>${label} :</b> ${esc(value)}</td></tr>`
      : "";

  const codeRow = (label, value) =>
    value
      ? `<tr>
          <td style="padding:10px 0; font-size:13px; color:#334155;">
            <b>${label} :</b>
            <code style="background:#F1F5F9; padding:4px 8px; border-radius:6px; display:inline-block; word-break:break-all;">
              ${esc(value)}
            </code>
          </td>
        </tr>`
      : "";

  const links = {
    conso: "https://quebecesim.ca/pages/comment-suivre-ma-consommation",
    contact: "https://quebecesim.ca/pages/contactez-nous",
  };

  const qrSection =
    qrDataUrl || activationCode
      ? `
              <h2 style="font-size: 16px; color:#0F172A; margin: 20px 0 10px;">Besoin de réinstaller votre eSIM ?</h2>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin: 12px 0 22px;">
                <tr>
                  <td style="font-size: 13px; color:#475569; line-height:1.45;">
                    Si votre eSIM Québec eSIM est déjà installée sur votre téléphone, vous n’avez pas besoin de scanner le code QR à nouveau.
                    Cette section est seulement là si vous devez réinstaller l’eSIM ou l’ajouter sur un nouvel appareil compatible.
                  </td>
                </tr>
              </table>

              ${
                qrDataUrl
                  ? `<div style="text-align:center; margin: 18px 0 22px;">
                      <img
                        src="${qrDataUrl}"
                        alt="Scanner pour réinstaller l’eSIM"
                        width="150"
                        style="border-radius:12px; border:1px solid #E5E7EB;"
                      />
                      <p style="font-size:12px; color:#64748B; margin-top:8px;">
                        Code QR de votre eSIM existante
                      </p>
                    </div>`
                  : ""
              }

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 18px;">
                ${codeRow("Code d’activation manuel", manualCode || activationCode)}
              </table>`
      : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Recharge eSIM appliquée</title>
</head>

<body style="margin:0; padding:0; background:#F6FAFD; font-family:-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding: 32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
          style="width:100%; max-width:800px; background:#FFFFFF; border-radius:18px; box-shadow:0 10px 30px rgba(15,23,42,0.08); overflow:hidden;">

          <tr>
            <td style="padding: 20px 24px; border-bottom: 1px solid #E5E7EB;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <img 
                      src="https://quebecesim.ca/cdn/shop/files/1000008019.png?v=1737480349&width=600"
                      alt="Québec eSIM"
                      width="80"
                      style="display:block; max-width:140px; height:auto;"
                    />
                  </td>
                  <td align="right">
                    <span style="display:inline-block; padding:8px 12px; border-radius:999px; background:#0CA3EC; color:#FFFFFF; font-weight:600; font-size:12px;">
                      Recharge eSIM
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 28px 24px;">

              <h1 style="margin: 0 0 16px; font-size: 22px; color:#0F172A;">
                Votre nouveau forfait a été ajouté
              </h1>

              <p style="font-size: 15px; color:#334155; margin: 0 0 14px;">
                Bonjour <b>${esc(safeName)}</b>,
              </p>

              <p style="font-size: 15px; color:#334155; margin: 0 0 18px;">
                Nous vous confirmons que votre nouveau forfait a bien été ajouté à votre eSIM Québec eSIM existante.
                Vous n’avez normalement rien à réinstaller : gardez simplement votre eSIM active et utilisez-la comme d’habitude.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin-bottom: 18px;">
                ${row("Forfait", planName)}
                ${row("Destination", country)}
                ${row("Validité", validityDays ? `${validityDays} jours` : "")}
                ${row("Données", dataQuotaMb ? `${dataQuotaMb} Mo` : "")}
                ${row("ICCID", iccid)}
                <tr><td style="padding:10px 0; font-size:14px; color:#334155;"><b>Activation :</b> le forfait s’activera automatiquement selon les règles de votre forfait Telna.</td></tr>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border: 1px solid #E5E7EB; border-radius: 14px; padding: 18px; margin: 12px 0 22px;">
                <tr>
                  <td style="font-size: 13px; color:#475569; line-height:1.45;">
                    <b>Important :</b> Ne supprimez jamais votre eSIM. En cas de souci, contactez-nous et nous vous aiderons rapidement.
                  </td>
                </tr>
              </table>

              <h2 style="font-size: 16px; color:#0F172A; margin: 0 0 10px;">Rappel rapide</h2>
              <ul style="margin:0 0 18px 18px; padding:0;">
                ${bullet("Vous n’avez pas besoin de scanner un nouveau code QR si votre eSIM Québec eSIM est déjà installée.")}
                ${bullet("Assurez-vous que l’itinérance des données est <b>ACTIVÉE</b> pour votre eSIM.")}
                ${bullet("Vérifiez que votre mode avion est <b>DÉSACTIVÉ</b>.")}
                ${bullet(`Vous pouvez suivre votre consommation ici : <a href="${links.conso}" style="color:#0CA3EC; text-decoration:none;">Comment suivre ma consommation ?</a>`)}
              </ul>

              ${qrSection}

              <p style="font-size: 14px; color:#334155; margin: 18px 0 0;">
                Nous vous souhaitons une excellente fin de séjour !
              </p>

              <p style="font-size: 14px; color:#334155; margin: 6px 0 0;">
                Cordialement,
              </p>

            </td>
          </tr>

          <tr>
            <td style="padding: 18px 24px; background:#F8FAFC; border-top: 1px solid #E5E7EB; font-size: 12px; color:#64748B;">
              <b>Besoin d’aide ?</b>
              <a href="${links.contact}" style="text-decoration:none; color: rgb(94, 94, 94);">
                Contactez-nous
              </a>
            </td>
          </tr>

          <tr>
            <td style="padding: 18px 24px; background:#F8FAFC; border-top: 1px solid #E5E7EB; font-size: 12px; color:#64748B;">
              <b>© 2026 Québec eSIM</b>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendTopUpEmail({
  to,
  firstName,
  orderId,
  planName,
  country,
  validityDays,
  dataQuotaMb,
  iccid,
  activationCode,
  manualCode,
}) {
  if (!emailEnabled) {
    console.log("ℹ️ Skipping top-up email (email not configured).");
    return false;
  }
  if (!to) {
    console.warn("⚠️ No recipient email; cannot send top-up email.");
    return false;
  }
  if (truthyEnv("SIMULATE_CUSTOMER_EMAIL_FAILURE")) {
    console.warn("🧪 Simulating customer top-up email failure.");
    return false;
  }

  const subject = orderId
    ? `Forfait ajouté à votre eSIM (Commande #${orderId})`
    : "Forfait ajouté à votre eSIM";

  const qrBase64 = activationCode ? await generateQrPngBase64(activationCode) : null;
  const qrDataUrl = qrBase64 ? `data:image/png;base64,${qrBase64}` : "";

  const html = formatTopUpEmailHtml({
    firstName,
    planName,
    country,
    validityDays,
    dataQuotaMb,
    iccid,
    activationCode,
    manualCode,
    qrDataUrl,
  });

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    bcc: INTERNAL_BCC,
    subject,
    html,
    ...(qrBase64 ? { attachments: [{ filename: "esim-qr.png", content: qrBase64 }] } : {}),
  });

  if (result?.error) {
    console.error("❌ Resend top-up error:", result.error);
    return false;
  }

  console.log("✅ Top-up email sent via Resend:", { to, id: result?.data?.id });
  return true;
}

async function sendUsageAlertEmail({
  to,
  firstName,
  orderId,
  percentUsed,
  thresholdPercent,
  iccid,
  planId,
}) {
  if (!emailEnabled) {
    console.log("ℹ️ Skipping usage alert email (email not configured).");
    return false;
  }
  if (!to) {
    console.warn("⚠️ No recipient email; cannot send usage alert email.");
    return false;
  }

  const safeName = (firstName || "").trim() || "there";
  const subject = orderId
    ? `Data usage alert (Order #${orderId})`
    : "Data usage alert";

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Alerte de consommation de données</title>
</head>

<body style="margin:0; padding:0; background:#F6FAFD; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding: 32px 0;">
    <tr>
      <td align="center">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
          style="width:100%; max-width:800px; background:#FFFFFF; border-radius:18px; box-shadow:0 10px 30px rgba(15,23,42,0.08); overflow:hidden;">

          <tr>
            <td style="padding:20px 24px; border-bottom:1px solid #E5E7EB;">
              <table width="100%">
                <tr>
                  <td>
                    <img 
                      src="https://quebecesim.ca/cdn/shop/files/1000008019.png?v=1737480349&width=600"
                      alt="Québec eSIM"
                      width="80"
                      style="display:block; max-width:140px; height:auto;"
                    />
                  </td>
                  <td align="right">
                    <span style="display:inline-block; padding:8px 12px; border-radius:999px; background:#0CA3EC; color:#FFFFFF; font-weight:600; font-size:12px;">
                      Alerte données
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:28px 24px;">

              <h1 style="margin:0 0 16px; font-size:22px; color:#0F172A;">
                Alerte de consommation
              </h1>

              <p style="font-size:15px; color:#334155; margin:0 0 14px;">
                Bonjour <b>${esc(safeName)}</b>,
              </p>

              <p style="font-size:15px; color:#334155; margin:0 0 18px;">
                Vous avez utilisé plus de <b>${thresholdPercent}%</b> de votre forfait de données.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#FFFFFF; border:1px solid #E5E7EB; border-radius:14px; padding:18px; margin-bottom:22px;">

                <tr>
                  <td style="padding:6px 0; font-size:14px; color:#475569;">
                    <b>Utilisation actuelle</b>
                  </td>
                  <td align="right" style="font-size:14px; color:#0F172A;">
                    ${percentUsed}%
                  </td>
                </tr>

                ${iccid ? `
                <tr>
                  <td style="padding:6px 0; font-size:14px; color:#475569;">
                    <b>ICCID</b>
                  </td>
                  <td align="right" style="font-size:14px; color:#0F172A;">
                    ${esc(iccid)}
                  </td>
                </tr>` : ""}

                ${planId ? `
                <tr>
                  <td style="padding:6px 0; font-size:14px; color:#475569;">
                    <b>ID du forfait</b>
                  </td>
                  <td align="right" style="font-size:14px; color:#0F172A;">
                    ${esc(planId)}
                  </td>
                </tr>` : ""}

              </table>

              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#F8FAFC; border:1px solid #E5E7EB; border-radius:14px; padding:18px; margin-bottom:22px;">
                <tr>
                  <td style="font-size:13px; color:#475569; line-height:1.45;">
                    Si vous prévoyez utiliser davantage de données, vous pouvez acheter une recharge à tout moment afin d’éviter toute interruption de service.
                  </td>
                </tr>
              </table>

              <p style="font-size:14px; color:#334155; margin:0;">
                Merci d’utiliser <b>Québec eSIM</b>.
              </p>

            </td>
          </tr>

          <tr>
            <td style="padding:18px 24px; background:#F8FAFC; border-top:1px solid #E5E7EB; font-size:12px; color:#64748B;">
              <b>Besoin d’aide ?</b>
              <a href="https://quebecesim.ca/pages/contactez-nous" style="text-decoration:none; color:rgb(94,94,94);">
                Contactez-nous
              </a>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;

  const result = await resend.emails.send({
    from: emailFrom,
    to,
    bcc: INTERNAL_BCC,
    subject,
    html,
  });

  if (result?.error) {
    console.error("❌ Resend usage alert error:", result.error);
    return false;
  }

  console.log("✅ Usage alert email sent via Resend:", { to, id: result?.data?.id });
  return true;
}

async function sendAdminAlertEmail({ subject, html }) {
  const to = (process.env.ALERT_EMAIL_TO || "").trim();
  if (!emailEnabled || !to) {
    console.warn("⚠️ Alert email not sent (missing RESEND config or ALERT_EMAIL_TO).");
    return false;
  }

  const result = await resend.emails.send({ from: emailFrom, to, bcc: INTERNAL_BCC, subject, html });

  if (result?.error) {
    console.error("❌ Resend alert error:", result.error);
    return false;
  }
  return true;
}

// -----------------------------
// Middleware: JSON + raw body capture (for HMAC)
// -----------------------------
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // Buffer (raw bytes)
    },
  })
);

app.get("/", (_req, res) => res.send("Webhook server running :)"));

app.get("/test-email", async (_req, res) => {
  try {
    console.log("🧪 /test-email hit");
    console.log("EMAIL_FROM =", emailFrom ? JSON.stringify(emailFrom) : "(empty)");
    console.log("EMAIL_ENABLED =", emailEnabled);

    if (!emailEnabled || !resend) {
      return res.status(500).send("Email not configured (missing RESEND_API_KEY or EMAIL_FROM)");
    }

    const result = await resend.emails.send({
      from: emailFrom, // must be a verified sender/domain in Resend
      to: "julia-marie@thewebix.ca",
      subject: "Resend test",
      html: "<p>Email works 🎉</p>",
    });

    console.log("📨 Resend result:", result);

    if (result?.error) {
      console.error("❌ Resend error:", result.error);
      return res.status(500).send(`Resend error: ${result.error.message || "unknown"}`);
    }

    return res.send(`Email queued ✅ id=${result?.data?.id || "no-id"}`);
  } catch (err) {
    console.error("❌ /test-email exception:", err);
    return res.status(500).send("Failed to send (exception)");
  }
});

// -----------------------------
// CRON (protected endpoint)
// -----------------------------
app.get("/cron/check-usage", async (req, res) => {
  const secret = (process.env.CRON_SECRET || "").trim();
  const token = String(req.query.token || "").trim();
  const dryRun = String(req.query.dry_run || "").trim() === "1";
  const usageAlertTestMode = truthyEnv("USAGE_ALERT_TEST_MODE");
  const mockPercentUsed = usageAlertTestMode ? Number(req.query.mock_percent_used) : NaN;
  const mockPackageStatus = usageAlertTestMode
    ? String(req.query.mock_package_status || "ACTIVE").trim().toUpperCase()
    : "";

  if (!secret) {
    console.error("❌ Missing CRON_SECRET env var");
    return res.status(500).send("Server not configured");
  }

  if (!token || token !== secret) {
    return res.status(401).send("Unauthorized");
  }

  log.info("🕒 CRON check-usage triggered:", { at: new Date().toISOString(), dryRun });

  try {
    const orders = await getOrdersWithTelnaPackages({ daysBack: 365 });
    log.info("✅ Orders with Telna packages found:", orders.length);
    const summary = {
      ok: true,
      dryRun,
      testMode: usageAlertTestMode,
      thresholdPercent: Number.isFinite(USAGE_ALERT_THRESHOLD_PERCENT) ? USAGE_ALERT_THRESHOLD_PERCENT : 75,
      ordersChecked: orders.length,
      packagesChecked: 0,
      alertsSent: 0,
      alreadySent: 0,
      skipped: [],
      packages: [],
    };

    for (const o of orders) {
      const { orderId, orderName, email, firstName, telnaPackages } = o;

      log.info(`\n🧾 Order ${orderName || orderId} — Telna packages found: ${telnaPackages.length}`);

      for (const e of telnaPackages) {
        const iccid = normalizeIccid(e?.iccid);
        const packageId = String(e?.packageId || "").trim();
        if (!iccid || !packageId) continue;
        summary.packagesChecked += 1;

        log.info(`🔎 Telna usage check — order ${orderId} — ICCID: ${iccid} — package: ${packageId}`);

        let telnaPackage = null;
        try {
          telnaPackage = await retrieveTelnaPackage(packageId);
        } catch (err) {
          log.warn("⚠️ Failed to retrieve Telna package usage:", {
            orderId,
            iccid,
            packageId,
            err: err?.message || err,
          });
          summary.skipped.push({
            orderId,
            iccid,
            packageId,
            reason: "telna_package_retrieve_failed",
            error: err?.message || String(err || ""),
          });
          continue;
        }

        let packageStatus = String(telnaPackage?.status || "").toUpperCase();
        const totalBytes = Number(telnaPackage?.package_template?.data_usage_allowance || 0);
        let remainingBytes = Number(telnaPackage?.data_usage_remaining ?? totalBytes);

        if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
          log.warn("⚠️ Invalid Telna data allowance", { orderId, iccid, packageId, totalBytes });
          summary.skipped.push({
            orderId,
            iccid,
            packageId,
            packageStatus,
            reason: "invalid_data_allowance",
          });
          continue;
        }

        if (usageAlertTestMode && Number.isFinite(mockPercentUsed)) {
          const safePercent = Math.max(0, Math.min(100, mockPercentUsed));
          remainingBytes = Math.round(totalBytes * ((100 - safePercent) / 100));
          packageStatus = mockPackageStatus || "ACTIVE";
        }

        const usedBytes = Math.max(0, totalBytes - Math.max(0, remainingBytes));
        const percentUsed = Math.min(100, Math.round((usedBytes / totalBytes) * 100));
        const packageSummary = {
          orderId,
          orderName,
          iccid,
          packageId,
          packageStatus,
          percentUsed,
          remainingBytes,
          totalBytes,
          wouldAlert: false,
          alertSent: false,
        };
        summary.packages.push(packageSummary);

        // Important summary log only
        log.info("📊 Telna usage", {
          orderId,
          iccid,
          packageId,
          packageStatus,
          percentUsed,
          remainingBytes,
          totalBytes,
        });

        const threshold = Number.isFinite(USAGE_ALERT_THRESHOLD_PERCENT)
          ? USAGE_ALERT_THRESHOLD_PERCENT
          : 75;

        if (packageStatus === "NOT_ACTIVE") {
          log.debug("ℹ️ Skipping Telna usage alert (package not active yet)", {
            iccid,
            packageId,
            packageStatus,
          });
          summary.skipped.push({
            orderId,
            iccid,
            packageId,
            packageStatus,
            reason: "package_not_active",
          });
          continue;
        }

        if (Number.isFinite(percentUsed) && percentUsed >= threshold) {
          packageSummary.wouldAlert = true;
          const key = usageAlertKey(threshold, `${iccid}_${packageId}`);

          let flag = { sent: false };
          try {
            flag = await getUsageAlertFlag(orderId, key);
          } catch (err) {
            log.error("❌ Could not read usage alert flag:", err?.message || err);
          }

          if (flag.sent) {
            summary.alreadySent += 1;
            log.info(`ℹ️ Usage alert already sent for ${orderId}:${key}, skipping.`);
          } else if (dryRun) {
            log.info(`🧪 Dry run: would send usage alert for ${orderId}:${key}`);
          } else {
            if (!email) {
              log.warn(
                `⚠️ Telna usage alert triggered (${percentUsed}%) but no customer email could be resolved. Order ${orderId}`
              );
            } else {
              try {
                await sendUsageAlertEmail({
                  to: email,
                  firstName,
                  orderId,
                  percentUsed,
                  thresholdPercent: threshold,
                  iccid,
                  planId: packageId,
                });

                await markUsageAlertSent(orderId, key);
                summary.alertsSent += 1;
                packageSummary.alertSent = true;
                log.info(`✅ Marked usage alert as sent on Shopify for ${orderId}:${key}`);
              } catch (err) {
                log.error("❌ Failed to send/mark usage alert email:", err?.message || err);
              }
            }
          }
        }
      }
    }

    return res.status(200).json(summary);
  } catch (e) {
    console.error("❌ Cron check-usage failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -----------------------------
// Small helpers
// -----------------------------
function normalizeIccid(x) {
  return String(x || "").replace(/\s+/g, "").trim();
}

function pickBuyerFromOrder(order) {
  const email = order?.email || order?.contact_email || "";

  const firstName =
    order?.customer?.first_name ||
    order?.billing_address?.first_name ||
    order?.shipping_address?.first_name ||
    "";

  const lastName =
    order?.customer?.last_name ||
    order?.billing_address?.last_name ||
    order?.shipping_address?.last_name ||
    "";

  const countryIso2 =
    order?.billing_address?.country_code ||
    order?.shipping_address?.country_code ||
    "US";

  return {
    email: truthyEnv("SIMULATE_MISSING_CUSTOMER_EMAIL") ? "" : email,
    firstName,
    lastName,
    countryIso2,
  };
}

// -----------------------------
// Shopify signature verification
// -----------------------------
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const secret = (process.env.WEBHOOK_API_SECRET || "").trim();

  if (!secret) {
    console.error("❌ Missing WEBHOOK_API_SECRET (or blank after trim)");
    return false;
  }
  if (!hmacHeader) {
    console.error("❌ Missing X-Shopify-Hmac-Sha256 header");
    return false;
  }
  if (!req.rawBody) {
    console.error("❌ Missing req.rawBody (raw bytes not captured)");
    return false;
  }

  const computed = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");

  // safe debug (doesn't expose the secret)
  log.debug("HMAC header length:", hmacHeader.length);
  log.debug("Computed HMAC length:", computed.length);
  log.debug("Header starts:", hmacHeader.slice(0, 10));
  log.debug("Computed starts:", computed.slice(0, 10));
  log.debug("SECRET length:", secret.length);

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "base64"),
      Buffer.from(hmacHeader, "base64")
    );
  } catch (e) {
    console.error("❌ timingSafeEqual error:", e.message);
    return false;
  }
}

async function handleTelnaOrderPaidWebhook(order, reqForHeaders = null) {
  const orderId = order?.id;
  const { email, firstName } = pickBuyerFromOrder(order);

  log.info("Telna order ID:", orderId);
  log.info("Telna buyer:", { email, firstName });

  if (!orderId) {
    console.warn("No order id in payload, exiting.");
    return { ok: true, skipped: true, reason: "missing_order_id" };
  }

  try {
    const flag = await getTelnaOrderProcessedFlag(orderId);
    if (flag?.processed) {
      console.log("Order already processed by Telna flow, skipping:", {
        orderId,
        processedAt: flag.processedAt,
      });
      return { ok: true, skipped: true, reason: "already_processed" };
    }
  } catch (e) {
    console.error("Could not read Telna processed flag:", e?.message || e);
  }

  let lockToken = null;
  let lockAcquired = false;

  try {
    const lock = await tryAcquireOrderProcessingLock(orderId);
    if (!lock?.acquired) {
      console.log("Order is already being processed by another webhook. Skipping.", { orderId });
      return { ok: true, skipped: true, reason: "locked" };
    }

    lockAcquired = true;
    lockToken = lock.token;
    console.log("Acquired processing lock:", { orderId, lockToken });
  } catch (e) {
    console.error("Failed to acquire processing lock:", e?.message || e);
    return { ok: true, skipped: true, reason: "lock_error" };
  }

  let shouldMarkProcessed = true;

  try {
    const items = Array.isArray(order?.line_items) ? order.line_items : [];
    const shopifyCustomerId = order?.customer?.id || order?.customer_id || null;
    let customerTelnaIccid = null;

    if (shopifyCustomerId) {
      try {
        customerTelnaIccid = await getTelnaIccidFromShopifyCustomer(shopifyCustomerId);
      } catch (e) {
        console.error("Could not read customer telna_iccid:", e?.message || e);
      }
    }

    console.log("Telna line items:", items.length);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const variantId = String(item.variant_id || "").trim();
      const qty = Number(item.quantity || 1);
      const cfg = await getTelnaVariantConfig(variantId);
      const packageTemplateId = cfg?.telnaPackageTemplateId;
      const productType = cfg?.productType;

      console.log(`Telna item #${i + 1}:`, {
        title: item.title,
        variant_title: item.variant_title,
        variant_id: variantId,
        quantity: qty,
        telna_package_template_id: packageTemplateId,
        product_type: productType,
      });

      if (!packageTemplateId) {
        shouldMarkProcessed = false;
        console.error("Missing custom.telna_package_template_id for variant:", variantId);
        await sendAdminAlertEmail({
          subject: `Telna provisioning config missing (Order #${orderId})`,
          html: `
            <p>A Shopify variant is missing <b>custom.telna_package_template_id</b>.</p>
            <ul>
              <li><b>Order ID</b>: ${esc(orderId)}</li>
              <li><b>Variant ID</b>: ${esc(variantId)}</li>
              <li><b>Product</b>: ${esc(item.title || "")}</li>
            </ul>
          `,
        });
        continue;
      }

      for (let q = 0; q < qty; q++) {
        let selectedIccid = null;
        let isNewEsim = false;

        try {
          const forceNewEsim = ["new_esim", "nouvelle_esim"].includes(productType);
          selectedIccid = forceNewEsim ? null : customerTelnaIccid;

          if (!selectedIccid) {
            const available = await findAvailableTelnaEsim({
              inventory: TELNA_INVENTORY_ID,
              group: TELNA_GROUP_ID,
            });
            selectedIccid = available.iccid;
            isNewEsim = true;
          }

          const telnaPackage = await createTelnaPackage({
            iccid: selectedIccid,
            packageTemplateId,
          });

          const euiccProfile = await retrieveTelnaEuiccProfile(selectedIccid);
          const activationCode = euiccProfile?.activation_code || "";

          if (isNewEsim && !activationCode) {
            throw new Error(`Telna eUICC profile missing activation_code for ${selectedIccid}`);
          }

          await saveTelnaProvisioningToOrder(orderId, {
            iccid: selectedIccid,
            packageId: telnaPackage?.id,
            packageTemplateId,
            activationCode,
            euiccState: euiccProfile?.state,
          });

          if (isNewEsim && shopifyCustomerId && !customerTelnaIccid) {
            await saveTelnaIccidToShopifyCustomer(shopifyCustomerId, selectedIccid);
            customerTelnaIccid = selectedIccid;
          }

          let customerEmailSent = false;
          if (isNewEsim) {
            customerEmailSent = await sendEsimEmail({
              to: email,
              firstName,
              orderId,
              activationCode,
              manualCode: activationCode,
              smdpAddress: "",
              apn: "globaldata",
              planName: item.variant_title,
              iccid: selectedIccid,
              country: item.title,
            });
          } else {
            customerEmailSent = await sendTopUpEmail({
              to: email,
              firstName,
              orderId,
              planName: item.variant_title,
              country: item.title,
              iccid: selectedIccid,
              activationCode,
              manualCode: activationCode,
            });
          }

          if (!customerEmailSent) {
            await sendAdminAlertEmail({
              subject: `Customer eSIM email was not sent (Order #${orderId})`,
              html: `
                <p>Telna provisioning succeeded, but the customer email was not sent.</p>
                <p>The order is still marked processed to avoid duplicate package creation.</p>
                <ul>
                  <li><b>Order ID</b>: ${esc(orderId)}</li>
                  <li><b>Email</b>: ${esc(email || "")}</li>
                  <li><b>ICCID</b>: ${esc(selectedIccid || "")}</li>
                  <li><b>Package ID</b>: ${esc(telnaPackage?.id || "")}</li>
                  <li><b>Package Template ID</b>: ${esc(packageTemplateId)}</li>
                  <li><b>Email type</b>: ${esc(isNewEsim ? "new_esim" : "top_up")}</li>
                </ul>
              `,
            });
          }

          try {
            if (truthyEnv("SIMULATE_FULFILLMENT_FAILURE")) {
              throw new Error("Simulated Shopify fulfillment failure");
            }
            const fulfillment = await fulfillShopifyOrder(orderId, { notifyCustomer: false });
            console.log("Shopify fulfillment result:", { orderId, fulfillment });
          } catch (fulfillmentErr) {
            console.error("Failed to auto-fulfill Shopify order:", fulfillmentErr?.message || fulfillmentErr);
            await sendAdminAlertEmail({
              subject: `Shopify fulfillment failed after Telna provisioning (Order #${orderId})`,
              html: `
                <p>Telna provisioning and customer email succeeded, but Shopify fulfillment failed.</p>
                <ul>
                  <li><b>Order ID</b>: ${esc(orderId)}</li>
                  <li><b>ICCID</b>: ${esc(selectedIccid || "")}</li>
                  <li><b>Package ID</b>: ${esc(telnaPackage?.id || "")}</li>
                </ul>
                <pre style="white-space:pre-wrap;">${esc(fulfillmentErr?.message || String(fulfillmentErr || ""))}</pre>
              `,
            });
          }

          console.log("Telna provisioning completed:", {
            orderId,
            iccid: selectedIccid,
            packageId: telnaPackage?.id,
            packageTemplateId,
            euiccState: euiccProfile?.state,
            isNewEsim,
          });
        } catch (e) {
          shouldMarkProcessed = false;
          console.error("Telna provisioning failed:", e?.message || e);
          await sendAdminAlertEmail({
            subject: `Telna provisioning failed (Order #${orderId})`,
            html: `
              <p>Telna provisioning failed for a Shopify paid order.</p>
              <ul>
                <li><b>Order ID</b>: ${esc(orderId)}</li>
                <li><b>Email</b>: ${esc(email || "")}</li>
                <li><b>Variant ID</b>: ${esc(variantId)}</li>
                <li><b>Package Template ID</b>: ${esc(packageTemplateId)}</li>
                <li><b>ICCID</b>: ${esc(selectedIccid || "")}</li>
              </ul>
              <pre style="white-space:pre-wrap;">${esc(e?.message || String(e || ""))}</pre>
            `,
          });
        }
      }
    }

    if (shouldMarkProcessed) {
      await markTelnaOrderProcessed(orderId);
      console.log("Order marked as processed in Telna flow:", orderId);
    } else {
      console.warn("Not marking Telna order as processed because at least one step failed:", orderId);
    }

    return { ok: true, skipped: false, reason: "processed" };
  } finally {
    if (lockAcquired && lockToken) {
      try {
        const released = await releaseOrderProcessingLock(orderId, lockToken);
        console.log("Released processing lock:", { orderId, released });
      } catch (e) {
        console.error("Failed to release processing lock:", e?.message || e);
      }
    }
  }
}

// -----------------------------
// Webhook: orders/paid - PROD
// -----------------------------
app.post("/webhooks/order-paid", async (req, res) => {
  const ok = verifyShopifyWebhook(req);

  console.log("🟨 Webhook shop =", req.get("x-shopify-shop-domain"));
  console.log("---- WEBHOOK DEBUG START ----");
  console.log("Topic:", req.get("X-Shopify-Topic"));
  console.log("Shop:", req.get("X-Shopify-Shop-Domain"));
  console.log("Content-Type:", req.get("content-type"));
  console.log("Buffer rawBody?", Buffer.isBuffer(req.rawBody));
  console.log("WEBHOOK_API_SECRET length:", (process.env.WEBHOOK_API_SECRET || "").trim().length);
  console.log("Raw body length:", req.rawBody?.length);
  console.log("HMAC MATCH:", ok);
  console.log("---- WEBHOOK DEBUG END ----");

  if (!ok) return res.status(401).send("Invalid signature");

  // Run the Telna handler.
  try {
    await handleTelnaOrderPaidWebhook(req.body || {}, req);
  } catch (e) {
    console.error("❌ handleTelnaOrderPaidWebhook failed:", e?.message || e);
    // still return 200 to avoid Shopify retry storms unless you explicitly want retries
  }

  return res.status(200).send("OK");
});

// -----------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
