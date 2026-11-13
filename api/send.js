import nodemailer from "nodemailer";

/* ------------------------------------------------------------------ */
/*  In-memory idempotency cache (lives as long as the Fluid instance) */
/* ------------------------------------------------------------------ */
const seen = new Map();          // idempotencyKey → { status, messageId?, error? }
const CACHE_TTL_MS = 10 * 60_000; // 10 min

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of seen) {
    if (now - entry.ts > CACHE_TTL_MS) seen.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/*  Lazy-initialised SMTP transporter (reused across warm invocations) */
/* ------------------------------------------------------------------ */
let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE !== "false", // true for 465
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
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
  /* ---- Parse body ------------------------------------------------ */
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: "error", message: "Invalid JSON body" }, { status: 400 });
  }

  const { name, email, subject, message, idempotencyKey } = body;

  if (!name || !email || !subject || !message) {
    return Response.json(
      { status: "error", message: "All fields (name, email, subject, message) are required." },
      { status: 400 },
    );
  }

  if (!idempotencyKey) {
    return Response.json(
      { status: "error", message: "idempotencyKey is required." },
      { status: 400 },
    );
  }

  /* ---- Idempotency check ----------------------------------------- */
  pruneCache();

  const cached = seen.get(idempotencyKey);
  if (cached) {
    // If the previous attempt ended with a temporary error, allow retry.
    if (cached.status === "temporary_error") {
      seen.delete(idempotencyKey);
    } else {
      // Already processed — return the stored outcome.
      const httpStatus = cached.status === "accepted" ? 200 : cached.status === "error" ? 502 : 200;
      return Response.json(cached, { status: httpStatus });
    }
  }

  /* ---- Mark as in-flight ----------------------------------------- */
  seen.set(idempotencyKey, { status: "sending", ts: Date.now() });

  /* ---- Build mail ------------------------------------------------ */
  const recipient = process.env.RECIPIENT_EMAIL;
  if (!recipient) {
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

  /* ---- Send ------------------------------------------------------ */
  try {
    const info = await getTransporter().sendMail(mailOptions);

    const result = {
      status: "accepted",
      message: "Письмо принято почтовым сервером.",
      messageId: info.messageId,
      ts: Date.now(),
    };
    seen.set(idempotencyKey, result);
    return Response.json(result, { status: 200 });

  } catch (err) {
    console.error("[send] SMTP error:", err);

    // If the transporter broke, discard it so next call creates a fresh one.
    transporter = null;

    const temporary = isTemporary(err);
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
