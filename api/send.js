import nodemailer from "nodemailer";

/* ------------------------------------------------------------------ */
/*  Debug logger                                                      */
/* ------------------------------------------------------------------ */
const DEBUG = process.env.DEBUG !== "false"; // on by default, set DEBUG=false to silence

function log(...args) {
  if (DEBUG) console.log(`[send][${new Date().toISOString()}]`, ...args);
}
function logErr(...args) {
  console.error(`[send][${new Date().toISOString()}]`, ...args);
}

/* ------------------------------------------------------------------ */
/*  In-memory idempotency cache (lives as long as the Fluid instance) */
/* ------------------------------------------------------------------ */
const seen = new Map();          // idempotencyKey → { status, messageId?, error? }
const CACHE_TTL_MS = 10 * 60_000; // 10 min

function pruneCache() {
  const before = seen.size;
  const now = Date.now();
  for (const [key, entry] of seen) {
    if (now - entry.ts > CACHE_TTL_MS) seen.delete(key);
  }
  if (before !== seen.size) {
    log(`Cache pruned: ${before} → ${seen.size} entries`);
  }
}

/* ------------------------------------------------------------------ */
/*  Lazy-initialised SMTP transporter (reused across warm invocations) */
/* ------------------------------------------------------------------ */
let transporter;
let transporterCreatedAt;

function getTransporter() {
  if (!transporter) {
    const config = {
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE !== "false",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS ? "***" : "(NOT SET)",
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    };
    log("Creating SMTP transporter:", JSON.stringify(config, null, 2));

    transporter = nodemailer.createTransport({
      ...config,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    transporterCreatedAt = new Date().toISOString();
    log("Transporter created at", transporterCreatedAt);
  } else {
    log("Reusing existing transporter (created at", transporterCreatedAt + ")");
  }
  return transporter;
}

/* ------------------------------------------------------------------ */
/*  Classify errors as temporary (retryable) or permanent             */
/* ------------------------------------------------------------------ */
function isTemporary(err) {
  if (!err) return false;
  const code = err.responseCode || err.code || "";
  // SMTP 4xx → temporary
  if (typeof code === "number" && code >= 400 && code < 500) return true;
  // Network / timeout errors
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET"].includes(code)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Handler: POST /api/send                                           */
/* ------------------------------------------------------------------ */
export async function POST(request) {
  const reqStart = Date.now();
  log("━━━ Incoming POST /api/send ━━━");

  /* ---- Parse body ------------------------------------------------ */
  let body;
  try {
    body = await request.json();
    log("Body parsed:", JSON.stringify({ ...body, message: body.message?.slice(0, 80) + "…" }));
  } catch {
    logErr("Failed to parse JSON body");
    return Response.json({ status: "error", message: "Invalid JSON body" }, { status: 400 });
  }

  const { name, email, subject, message, idempotencyKey } = body;

  if (!name || !email || !subject || !message) {
    logErr("Validation failed: missing fields", { name: !!name, email: !!email, subject: !!subject, message: !!message });
    return Response.json(
      { status: "error", message: "All fields (name, email, subject, message) are required." },
      { status: 400 },
    );
  }

  if (!idempotencyKey) {
    logErr("Validation failed: no idempotencyKey");
    return Response.json(
      { status: "error", message: "idempotencyKey is required." },
      { status: 400 },
    );
  }

  log(`idempotencyKey: ${idempotencyKey}`);

  /* ---- Idempotency check ----------------------------------------- */
  pruneCache();

  const cached = seen.get(idempotencyKey);
  if (cached) {
    if (cached.status === "temporary_error") {
      log("Cache hit (temporary_error) — clearing, will retry. Key:", idempotencyKey);
      seen.delete(idempotencyKey);
    } else {
      log("Cache hit — returning stored result:", JSON.stringify(cached));
      const httpStatus = cached.status === "accepted" ? 200 : cached.status === "error" ? 502 : 200;
      return Response.json(cached, { status: httpStatus });
    }
  } else {
    log("Cache miss — new request");
  }

  /* ---- Mark as in-flight ----------------------------------------- */
  seen.set(idempotencyKey, { status: "sending", ts: Date.now() });
  log("Cache size:", seen.size);

  /* ---- Build mail ------------------------------------------------ */
  const recipient = process.env.RECIPIENT_EMAIL;
  if (!recipient) {
    logErr("RECIPIENT_EMAIL is not set!");
    const errResult = { status: "error", message: "Server misconfiguration: RECIPIENT_EMAIL is not set.", ts: Date.now() };
    seen.set(idempotencyKey, errResult);
    return Response.json(errResult, { status: 500 });
  }

  const mailOptions = {
    from: `"${name}" <${process.env.SMTP_USER}>`,
    replyTo: email,
    to: recipient,
    subject: `[Заявка] ${subject}`,
    text: [
      `Имя: ${name}`,
      `Email: ${email}`,
      `Тема: ${subject}`,
      ``,
      message,
    ].join("\n"),
    html: `
      <h2>Новая заявка</h2>
      <p><strong>Имя:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Тема:</strong> ${escapeHtml(subject)}</p>
      <hr/>
      <p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>
    `,
  };

  log("Mail prepared:", JSON.stringify({
    from: mailOptions.from,
    replyTo: mailOptions.replyTo,
    to: mailOptions.to,
    subject: mailOptions.subject,
    textLength: mailOptions.text.length,
  }));

  /* ---- Send ------------------------------------------------------ */
  try {
    log("Connecting to SMTP and sending…");
    const sendStart = Date.now();

    const info = await getTransporter().sendMail(mailOptions);

    const sendDuration = Date.now() - sendStart;
    log(`✅ SMTP accepted! messageId=${info.messageId} response="${info.response}" duration=${sendDuration}ms`);

    const result = {
      status: "accepted",
      message: "Письмо принято почтовым сервером.",
      messageId: info.messageId,
      ts: Date.now(),
    };
    seen.set(idempotencyKey, result);

    const totalDuration = Date.now() - reqStart;
    log(`Request completed in ${totalDuration}ms (SMTP: ${sendDuration}ms)`);
    return Response.json(result, { status: 200 });

  } catch (err) {
    const sendDuration = Date.now() - reqStart;
    logErr(`❌ SMTP error after ${sendDuration}ms:`);
    logErr("  name:", err.name);
    logErr("  message:", err.message);
    logErr("  code:", err.code);
    logErr("  responseCode:", err.responseCode);
    logErr("  command:", err.command);
    if (err.stack) logErr("  stack:", err.stack);

    // If the transporter broke, discard it so next call creates a fresh one.
    transporter = null;
    log("Transporter discarded (will recreate on next request)");

    const temporary = isTemporary(err);
    log(`Error classified as: ${temporary ? "TEMPORARY (retryable)" : "PERMANENT"}`);

    const result = {
      status: temporary ? "temporary_error" : "error",
      message: err.message || "Unknown SMTP error",
      code: err.responseCode || err.code || null,
      retryable: temporary,
      ts: Date.now(),
    };
    seen.set(idempotencyKey, result);

    return Response.json(result, { status: temporary ? 503 : 502 });
  }
}

/* ---- Reject other methods ---------------------------------------- */
export function GET() {
  log("GET /api/send — rejected (405)");
  return Response.json({ error: "Use POST" }, { status: 405 });
}

/* ---- Helpers ----------------------------------------------------- */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
