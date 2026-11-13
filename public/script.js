/* =================================================================
   Client-side form handler with retries & idempotency
   ================================================================= */

(() => {
  "use strict";

  const form      = document.getElementById("contactForm");
  const submitBtn = document.getElementById("submitBtn");
  const statusEl  = document.getElementById("status");

  /* ── Idempotency map (lives while the tab is open) ─────────────── */
  const sentKeys = new Map(); // idempotencyKey → result

  /* ── Retry config ──────────────────────────────────────────────── */
  const MAX_ATTEMPTS     = 3;          // 1 initial + 2 retries
  const BASE_DELAY_MS    = 2_000;      // 2 s → 4 s (exponential)

  /* ── Helpers ────────────────────────────────────────────────────── */

  /** Generate a v4-ish UUID (good enough for per-session idempotency). */
  function uuid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
  }

  /** Build a fingerprint for the current form data so we can attach
      one idempotency key per unique payload.                          */
  function payloadFingerprint(data) {
    return [data.name, data.email, data.subject, data.message].join("|");
  }

  /** Show status banner. */
  function setStatus(type, html) {
    statusEl.className = `status ${type}`;
    statusEl.innerHTML = html;
  }

  /** Delay helper. */
  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ── Main send logic ───────────────────────────────────────────── */

  async function sendWithRetries(payload) {
    const fingerprint = payloadFingerprint(payload);

    // Re-use key if user re-submits the exact same data while page is open
    let idempotencyKey = sentKeys.get(fingerprint);
    if (!idempotencyKey) {
      idempotencyKey = uuid();
      sentKeys.set(fingerprint, idempotencyKey);
    }

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      /* ── Update UI ──────────────────────────────────────────────── */
      if (attempt === 1) {
        setStatus("sending", `<span class="spinner"></span> Отправка…`);
      } else {
        setStatus(
          "retrying",
          `<span class="spinner"></span> Повторная попытка ${attempt} из ${MAX_ATTEMPTS}…`,
        );
      }

      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, idempotencyKey }),
        });

        const data = await res.json();

        /* ── Success ─────────────────────────────────────────────── */
        if (data.status === "accepted") {
          setStatus("accepted", "✅ Письмо принято почтовым сервером.");
          return true;
        }

        /* ── Retryable server error ──────────────────────────────── */
        if (data.retryable && attempt < MAX_ATTEMPTS) {
          lastError = data.message;
          const wait = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          setStatus(
            "retrying",
            `⏳ Временная ошибка. Повтор через ${wait / 1000} сек… (${attempt}/${MAX_ATTEMPTS})`,
          );
          await delay(wait);
          continue;
        }

        /* ── Permanent error ─────────────────────────────────────── */
        setStatus("error", `❌ Ошибка отправки: ${escapeHtml(data.message)}`);
        return false;

      } catch (networkErr) {
        /* ── Network failure (fetch itself failed) ────────────────── */
        lastError = networkErr.message || "Сеть недоступна";

        if (attempt < MAX_ATTEMPTS) {
          const wait = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          setStatus(
            "retrying",
            `⏳ Ошибка сети. Повтор через ${wait / 1000} сек… (${attempt}/${MAX_ATTEMPTS})`,
          );
          await delay(wait);
          continue;
        }
      }
    }

    /* ── All attempts exhausted ──────────────────────────────────── */
    setStatus(
      "unknown",
      `⚠️ Неопределённый результат: не удалось получить ответ после ${MAX_ATTEMPTS} попыток. Последняя ошибка: ${escapeHtml(lastError || "нет данных")}`,
    );
    // Remove fingerprint so user can try again with a new key
    sentKeys.delete(fingerprint);
    return false;
  }

  /* ── Form submit ────────────────────────────────────────────────── */

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Basic client-side validation
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const payload = {
      name:    form.name.value.trim(),
      email:   form.email.value.trim(),
      subject: form.subject.value.trim(),
      message: form.message.value.trim(),
    };

    submitBtn.disabled = true;
    setStatus("waiting", "⏳ Ожидание…");

    await sendWithRetries(payload);

    submitBtn.disabled = false;
  });

  /* ── Escape HTML for safe status display ────────────────────────── */
  function escapeHtml(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }
})();
