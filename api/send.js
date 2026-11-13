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
const seen = new Map();          // idempotencyKey → { status, messageId?, error?, ts }
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
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE !== "false",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
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
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "ENOTFOUND"].includes(code)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Parse request body (supports JSON and urlencoded)                 */
/* ------------------------------------------------------------------ */
async function parseRequestBody(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return await request.json();
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const obj = {};
    for (const [key, value] of params.entries()) {
      obj[key] = value;
    }
    return obj;
  }

  // Fallback: try json, then text
  try {
    return await request.json();
  } catch {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const obj = {};
    for (const [key, value] of params.entries()) {
      obj[key] = value;
    }
    return obj;
  }
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
    body = await parseRequestBody(request);
    log("Body received:", JSON.stringify({
      ...body,
      message: body.message ? (body.message.slice(0, 80) + "…") : undefined
    }));
  } catch (err) {
    logErr("Failed to parse request body:", err.message);
    return Response.json({ status: "error", message: "Не удалось разобрать данные запроса." }, { status: 400 });
  }

  const {
    name,
    phone,
    email,
    height,
    goal,
    course,
    price,
    formType,
    subject: rawSubject,
    message: rawMessage,
    site_url,
    idempotencyKey
  } = body;

  /* ---- Honeypot check -------------------------------------------- */
  if (typeof site_url === "string" && site_url.trim() !== "") {
    log("⚠️ Honeypot triggered! Bot detected (site_url is filled). Silently dropping.");
    return Response.json({
      status: "accepted",
      message: "Письмо принято почтовым сервером.",
      ts: Date.now(),
    }, { status: 200 });
  }

  /* ---- Validate required fields ---------------------------------- */
  const trimmedName = (name || "").trim();
  const trimmedPhone = (phone || "").trim();
  const trimmedEmail = (email || "").trim();

  if (!trimmedName) {
    logErr("Validation failed: missing name");
    return Response.json(
      { status: "error", message: "Пожалуйста, укажите имя." },
      { status: 400 },
    );
  }

  // Require either phone or email
  if (!trimmedPhone && !trimmedEmail) {
    logErr("Validation failed: missing phone and email");
    return Response.json(
      { status: "error", message: "Пожалуйста, укажите контакт для связи (телефон или email)." },
      { status: 400 },
    );
  }

  const effectiveKey = idempotencyKey || `${trimmedName}|${trimmedPhone}|${trimmedEmail}|${formType || ""}|${course || ""}|${Date.now()}`;
  log(`idempotencyKey: ${effectiveKey}`);

  /* ---- Idempotency check ----------------------------------------- */
  pruneCache();

  const cached = seen.get(effectiveKey);
  if (cached) {
    if (cached.status === "temporary_error") {
      log("Cache hit (temporary_error) — clearing, will retry. Key:", effectiveKey);
      seen.delete(effectiveKey);
    } else {
      log("Cache hit — returning stored result:", JSON.stringify(cached));
      const httpStatus = cached.status === "accepted" ? 200 : cached.status === "error" ? 502 : 200;
      return Response.json(cached, { status: httpStatus });
    }
  } else {
    log("Cache miss — new request");
  }

  /* ---- Mark as in-flight ----------------------------------------- */
  seen.set(effectiveKey, { status: "sending", ts: Date.now() });

  /* ---- Build mail subject & content ------------------------------ */
  const recipient = process.env.RECIPIENT_EMAIL;
  if (!recipient) {
    logErr("RECIPIENT_EMAIL is not set in environment!");
    const errResult = {
      status: "error",
      message: "Ошибка конфигурации сервера: RECIPIENT_EMAIL не задан.",
      ts: Date.now()
    };
    seen.set(effectiveKey, errResult);
    return Response.json(errResult, { status: 500 });
  }

  let mailSubject = rawSubject;
  if (!mailSubject) {
    if (formType === "course" || course) {
      mailSubject = `🛒 Заказ курса: ${trimmedName} (${trimmedPhone || trimmedEmail})`;
    } else if (formType === "lead" || height || goal) {
      mailSubject = `🏃 Заявка на занятие: ${trimmedName} (${trimmedPhone || trimmedEmail})`;
    } else {
      mailSubject = `📩 Новая заявка: ${trimmedName}`;
    }
  }

  const moscowTime = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "medium",
    timeStyle: "medium",
  });

  const detailsList = [
    `Имя: ${trimmedName}`,
    trimmedPhone ? `Телефон: ${trimmedPhone}` : null,
    trimmedEmail ? `Email: ${trimmedEmail}` : null,
    course ? `Курс: ${course} ${price ? `(${price})` : ""}` : null,
    height ? `Рост: ${height} см` : null,
    goal ? `Цель занятий: ${goal}` : null,
    rawMessage ? `Сообщение: ${rawMessage}` : null,
    `Время: ${moscowTime} (МСК)`,
  ].filter(Boolean);

  const plainText = [
    `=== ${mailSubject} ===`,
    "",
    ...detailsList,
    "",
    `Отправлено через Vercel Fluid Compute`
  ].join("\n");

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;">
      <div style="background: #111827; color: #ffffff; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px;">
        <h2 style="margin: 0; font-size: 18px; font-weight: 600;">${escapeHtml(mailSubject)}</h2>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <tbody>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 140px;"><strong>Имя:</strong></td>
            <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500;">${escapeHtml(trimmedName)}</td>
          </tr>
          ${trimmedPhone ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;"><strong>Телефон:</strong></td>
            <td style="padding: 8px 0; font-size: 15px;">
              <a href="tel:${escapeHtml(trimmedPhone.replace(/[^\d+]/g, ""))}" style="color: #2563eb; text-decoration: none; font-weight: 600;">${escapeHtml(trimmedPhone)}</a>
              &nbsp;&nbsp;
              <a href="https://wa.me/${escapeHtml(trimmedPhone.replace(/[^\d]/g, ""))}" style="color: #16a34a; text-decoration: none; font-size: 13px;" target="_blank">WhatsApp</a>
            </td>
          </tr>` : ""}
          ${trimmedEmail ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;"><strong>Email:</strong></td>
            <td style="padding: 8px 0; font-size: 15px;">
              <a href="mailto:${escapeHtml(trimmedEmail)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(trimmedEmail)}</a>
            </td>
          </tr>` : ""}
          ${course ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;"><strong>Товар / Курс:</strong></td>
            <td style="padding: 8px 0; color: #111827; font-size: 15px;"><strong>${escapeHtml(course)}</strong> ${price ? `<span style="color: #059669;">(${escapeHtml(price)})</span>` : ""}</td>
          </tr>` : ""}
          ${height ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;"><strong>Рост:</strong></td>
            <td style="padding: 8px 0; color: #111827; font-size: 15px;">${escapeHtml(height)} см</td>
          </tr>` : ""}
          ${goal ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;"><strong>Цель занятий:</strong></td>
            <td style="padding: 8px 0; color: #111827; font-size: 15px;">${escapeHtml(goal)}</td>
          </tr>` : ""}
          ${rawMessage ? `
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px; vertical-align: top;"><strong>Сообщение:</strong></td>
            <td style="padding: 8px 0; color: #111827; font-size: 15px;">${escapeHtml(rawMessage).replace(/\n/g, "<br/>")}</td>
          </tr>` : ""}
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;"><strong>Дата и время:</strong></td>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${escapeHtml(moscowTime)}</td>
          </tr>
        </tbody>
      </table>

      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
      <p style="margin: 0; font-size: 12px; color: #9ca3af; text-align: center;">
        Отправлено сайтом на Vercel Fluid Compute • Gmail SMTP
      </p>
    </div>
  `;

  const mailOptions = {
    from: `"${trimmedName.replace(/"/g, '')}" <${process.env.SMTP_USER}>`,
    replyTo: trimmedEmail || process.env.SMTP_USER,
    to: recipient,
    subject: mailSubject,
    text: plainText,
    html: htmlContent,
  };

  log("Mail prepared:", JSON.stringify({
    from: mailOptions.from,
    replyTo: mailOptions.replyTo,
    to: mailOptions.to,
    subject: mailOptions.subject,
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
    seen.set(effectiveKey, result);

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
      message: err.message || "Ошибка отправки через почтовый сервер.",
      code: err.responseCode || err.code || null,
      retryable: temporary,
      ts: Date.now(),
    };
    seen.set(effectiveKey, result);

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
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
