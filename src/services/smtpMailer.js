import nodemailer from "nodemailer";

/* ------------------------------------------------------------------ */
/*  Debug Logger                                                      */
/* ------------------------------------------------------------------ */
function log(...args) {
  console.log(`[smtpMailer][${new Date().toISOString()}]`, ...args);
}
function logErr(...args) {
  console.error(`[smtpMailer][${new Date().toISOString()}]`, ...args);
}

/* ------------------------------------------------------------------ */
/*  In-memory idempotency cache (lives in the current process)       */
/* ------------------------------------------------------------------ */
const seen = new Map(); // idempotencyKey → { status, messageId, ts, message, retryable }
const CACHE_TTL_MS = 10 * 60_000; // 10 minutes

function pruneCache() {
  const before = seen.size;
  const now = Date.now();
  for (const [key, entry] of seen) {
    if (now - entry.ts > CACHE_TTL_MS) seen.delete(key);
  }
  if (before !== seen.size) {
    log(`Idempotency cache pruned: ${before} → ${seen.size} entries`);
  }
}

/* ------------------------------------------------------------------ */
/*  Transporter pool (reused while the process is running)            */
/* ------------------------------------------------------------------ */
let transporter = null;
let transporterCreatedAt = null;

function getTransporter() {
  if (!transporter) {
    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const port = Number(process.env.SMTP_PORT) || 465;
    const secure = process.env.SMTP_SECURE !== "false";
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    log("Initializing SMTP transporter:", JSON.stringify({
      host,
      port,
      secure,
      user,
      pass: pass ? "*** (length " + pass.length + ")" : "(NOT SET)"
    }, null, 2));

    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    transporterCreatedAt = new Date().toISOString();
    log("SMTP Transporter created at", transporterCreatedAt);
  } else {
    log("Reusing existing SMTP transporter (created at", transporterCreatedAt + ")");
  }
  return transporter;
}

/* ------------------------------------------------------------------ */
/*  Classify SMTP errors as temporary (retryable) or permanent        */
/* ------------------------------------------------------------------ */
function isTemporaryError(err) {
  if (!err) return false;
  const code = err.responseCode || err.code || "";
  // SMTP 4xx (421, 450, 451, 452) are temporary server issues
  if (typeof code === "number" && code >= 400 && code < 500) return true;
  // Network and socket errors
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Main Function: sendEmail                                          */
/* ------------------------------------------------------------------ */
export async function sendEmail({
  to,
  subject,
  text,
  html,
  replyTo,
  senderName,
  idempotencyKey
}) {
  const startTime = Date.now();
  log(`━━━ sendEmail start: "${subject}" (idempotencyKey: ${idempotencyKey || "none"}) ━━━`);

  /* ---- Idempotency check ----------------------------------------- */
  if (idempotencyKey) {
    pruneCache();
    const cached = seen.get(idempotencyKey);
    if (cached) {
      if (cached.status === "temporary_error") {
        log("Cache hit (temporary_error) — clearing to allow retry, key:", idempotencyKey);
        seen.delete(idempotencyKey);
      } else {
        log("Cache hit — returning stored response (deduplicated):", JSON.stringify(cached));
        return {
          cached: true,
          status: cached.status,
          message: cached.message,
          messageId: cached.messageId,
          retryable: false,
          httpStatus: cached.status === "accepted" ? 200 : 502
        };
      }
    }
    // Mark in-flight
    seen.set(idempotencyKey, { status: "sending", ts: Date.now() });
  }

  /* ---- Target recipient ------------------------------------------ */
  const recipient = to || process.env.RECIPIENT_EMAIL;
  if (!recipient) {
    logErr("No recipient specified and RECIPIENT_EMAIL is not set in environment!");
    const errResult = {
      status: "error",
      message: "Ошибка конфигурации сервера: RECIPIENT_EMAIL не задан в переменных окружения.",
      retryable: false,
      httpStatus: 500
    };
    if (idempotencyKey) seen.set(idempotencyKey, { ...errResult, ts: Date.now() });
    return errResult;
  }

  const fromAddress = process.env.SMTP_USER;
  const fromHeader = senderName
    ? `"${senderName.replace(/"/g, '')}" <${fromAddress}>`
    : fromAddress;

  const mailOptions = {
    from: fromHeader,
    to: recipient,
    replyTo: replyTo || fromAddress,
    subject,
    text,
    html,
  };

  /* ---- SMTP Send ------------------------------------------------- */
  try {
    log(`Connecting to SMTP and sending mail to: ${recipient}…`);
    const sendStart = Date.now();

    const info = await getTransporter().sendMail(mailOptions);

    const sendDuration = Date.now() - sendStart;
    log(`✅ SMTP accepted! messageId=${info.messageId} response="${info.response}" in ${sendDuration}ms`);

    const result = {
      status: "accepted",
      message: "Письмо принято почтовым сервером.",
      messageId: info.messageId,
      retryable: false,
      httpStatus: 200,
      ts: Date.now()
    };

    if (idempotencyKey) {
      seen.set(idempotencyKey, result);
    }

    log(`Total send duration: ${Date.now() - startTime}ms`);
    return result;

  } catch (err) {
    const sendDuration = Date.now() - startTime;
    logErr(`❌ SMTP error after ${sendDuration}ms:`, {
      name: err.name,
      message: err.message,
      code: err.code,
      responseCode: err.responseCode,
      command: err.command
    });

    // Invalidate cached transporter on socket/connection failure
    transporter = null;
    log("Transporter discarded (will be recreated on next attempt).");

    const temporary = isTemporaryError(err);
    log(`Error classified as: ${temporary ? "TEMPORARY (retryable)" : "PERMANENT"}`);

    const result = {
      status: temporary ? "temporary_error" : "error",
      message: err.message || "Ошибка отправки через почтовый сервер.",
      code: err.responseCode || err.code || null,
      retryable: temporary,
      httpStatus: temporary ? 503 : 502,
      ts: Date.now()
    };

    if (idempotencyKey) {
      seen.set(idempotencyKey, result);
    }

    return result;
  }
}
