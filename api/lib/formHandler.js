import { sendEmail } from "./smtpMailer.js";

/* ------------------------------------------------------------------ */
/*  Debug Logger                                                      */
/* ------------------------------------------------------------------ */
function log(...args) {
  console.log(`[formHandler][${new Date().toISOString()}]`, ...args);
}
function logErr(...args) {
  console.error(`[formHandler][${new Date().toISOString()}]`, ...args);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/*  Core Form Logic: Validate, Build Email & Send                     */
/* ------------------------------------------------------------------ */
export async function processFormData(body = {}) {
  log("Processing form payload:", JSON.stringify({
    ...body,
    message: body.message ? (body.message.slice(0, 50) + "…") : undefined
  }));

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

  /* ---- 1. Honeypot check (anti-spam) ----------------------------- */
  if (typeof site_url === "string" && site_url.trim() !== "") {
    log("⚠️ Honeypot triggered! Bot detected (site_url is filled). Returning fake success.");
    return {
      httpStatus: 200,
      data: {
        status: "accepted",
        message: "Письмо принято почтовым сервером.",
        ts: Date.now()
      }
    };
  }

  /* ---- 2. Validation --------------------------------------------- */
  const trimmedName  = (name || "").trim();
  const trimmedPhone = (phone || "").trim();
  const trimmedEmail = (email || "").trim();

  if (!trimmedName) {
    logErr("Validation failed: missing name");
    return {
      httpStatus: 400,
      data: { status: "error", message: "Пожалуйста, укажите ваше имя." }
    };
  }

  // Must provide at least one contact channel
  if (!trimmedPhone && !trimmedEmail) {
    logErr("Validation failed: missing phone and email");
    return {
      httpStatus: 400,
      data: { status: "error", message: "Пожалуйста, укажите телефон или email для связи." }
    };
  }

  /* ---- 3. Build Subject & Email Content -------------------------- */
  let mailSubject = rawSubject;
  if (!mailSubject) {
    if (formType === "course" || course) {
      mailSubject = `🛒 Заказ курса: ${trimmedName} (${trimmedPhone || trimmedEmail})`;
    } else if (formType === "lead" || height || goal) {
      mailSubject = `🏃 Заявка на занятие: ${trimmedName} (${trimmedPhone || trimmedEmail})`;
    } else {
      mailSubject = `📩 Новая заявка с сайта: ${trimmedName}`;
    }
  }

  const moscowTime = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "medium",
    timeStyle: "medium",
  });

  const plainText = [
    `=== ${mailSubject} ===`,
    "",
    `Имя: ${trimmedName}`,
    trimmedPhone ? `Телефон: ${trimmedPhone}` : null,
    trimmedEmail ? `Email: ${trimmedEmail}` : null,
    course ? `Курс: ${course} ${price ? `(${price})` : ""}` : null,
    height ? `Рост: ${height} см` : null,
    goal ? `Цель занятий: ${goal}` : null,
    rawMessage ? `Сообщение: ${rawMessage}` : null,
    `Время заявки: ${moscowTime} (МСК)`,
    "",
    `Отправлено через Vercel Fluid Compute`
  ].filter(Boolean).join("\n");

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;">
      <div style="background: #111827; color: #ffffff; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px;">
        <h2 style="margin: 0; font-size: 18px; font-weight: 600;">${escapeHtml(mailSubject)}</h2>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <tbody>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 140px;"><strong>Имя:</strong></td>
            <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 600;">${escapeHtml(trimmedName)}</td>
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
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;"><strong>Курс / Товар:</strong></td>
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
        Заявка с сайта на Vercel Fluid Compute • Gmail SMTP
      </p>
    </div>
  `;

  /* ---- 4. Delegate to smtpMailer --------------------------------- */
  const effectiveKey = idempotencyKey || `${trimmedName}|${trimmedPhone}|${trimmedEmail}|${formType || ""}|${Date.now()}`;

  log(`Forwarding to smtpMailer (idempotencyKey: ${effectiveKey})…`);
  const sendResult = await sendEmail({
    to: process.env.RECIPIENT_EMAIL,
    subject: mailSubject,
    text: plainText,
    html: htmlContent,
    replyTo: trimmedEmail || undefined,
    senderName: trimmedName,
    idempotencyKey: effectiveKey
  });

  return {
    httpStatus: sendResult.httpStatus || 200,
    data: sendResult
  };
}

/* ------------------------------------------------------------------ */
/*  Universal Request Handler (Supports Web Standard & Node.js req/res)*/
/* ------------------------------------------------------------------ */
export async function handleFormRequest(reqOrRequest, optionalRes) {
  log("━━━ Incoming form request received ━━━");

  // Case A: Classic Node.js (req, res)
  if (optionalRes && typeof optionalRes.status === "function") {
    const req = reqOrRequest;
    const res = optionalRes;

    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      body = await parseNodeStream(req);
    }

    const { httpStatus, data } = await processFormData(body);
    return res.status(httpStatus).json(data);
  }

  // Case B: Web Standard Request (Fetch API)
  const request = reqOrRequest;
  let body = {};

  try {
    const contentType = request.headers?.get("content-type") || "";

    if (contentType.includes("application/json")) {
      body = await request.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      const params = new URLSearchParams(text);
      for (const [k, v] of params.entries()) {
        body[k] = v;
      }
    } else {
      // Fallback: try json, else text
      try {
        body = await request.json();
      } catch {
        const text = await request.text();
        const params = new URLSearchParams(text);
        for (const [k, v] of params.entries()) {
          body[k] = v;
        }
      }
    }
  } catch (err) {
    logErr("Failed to parse request body:", err.message);
    return Response.json(
      { status: "error", message: "Не удалось разобрать тело запроса." },
      { status: 400 }
    );
  }

  const { httpStatus, data } = await processFormData(body);
  return Response.json(data, { status: httpStatus });
}

/* Helper to read stream if req.body is undefined in Node.js */
function parseNodeStream(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        const params = new URLSearchParams(raw);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        resolve(obj);
      }
    });
    req.on("error", () => resolve({}));
  });
}
