/* =================================================================
   Landing Form Handlers with Retries & Idempotency (Vercel)
   ================================================================= */

(() => {
  "use strict";

  // Elements
  const formLead    = document.getElementById("leadForm");
  const formCourse  = document.getElementById("courseForm");

  const modalLeadEl   = document.getElementById("leadModal");
  const modalCourseEl = document.getElementById("courseModal");
  const modalSuccessEl = document.getElementById("successModal");
  const modalErrorEl   = document.getElementById("errorModal");

  // Log the public API health-check response in the browser console.
  // The endpoint returns service metadata only; no credentials are exposed.
  async function logApiStatus() {
    const endpoint = "/api/send";

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store"
      });

      let data;
      try {
        data = await response.clone().json();
      } catch {
        data = await response.text();
      }

      console.info("[API health check]", {
        endpoint,
        httpStatus: response.status,
        ok: response.ok,
        response: data
      });
    } catch (error) {
      console.error("[API health check] Request failed:", error);
    }
  }

  void logApiStatus();

  /* ── Idempotency map (persists as long as page is open) ────────── */
  const sentKeys = new Map(); // fingerprint → idempotencyKey

  /* ── Retry config ──────────────────────────────────────────────── */
  const MAX_ATTEMPTS  = 3;     // 1 initial + 2 retries
  const BASE_DELAY_MS = 2_000; // 2s → 4s

  /* ── Helper: UUID ──────────────────────────────────────────────── */
  function uuid() {
    return window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    const span = document.createElement("span");
    span.textContent = str || "";
    return span.innerHTML;
  }

  /**
   * Получить или создать контейнер статуса внутри формы
   */
  function getOrCreateStatusEl(form) {
    let statusEl = form.querySelector(".mailer-status");
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.className = "mailer-status hidden";
      statusEl.setAttribute("role", "status");
      statusEl.setAttribute("aria-live", "polite");

      const submitBtn = form.querySelector("button[type='submit']");
      if (submitBtn) {
        submitBtn.insertAdjacentElement("afterend", statusEl);
      } else {
        form.appendChild(statusEl);
      }
    }
    return statusEl;
  }

  function setStatus(statusEl, type, html) {
    statusEl.className = `mailer-status ${type}`;
    statusEl.innerHTML = html;
    statusEl.classList.remove("hidden");
  }

  function clearStatus(statusEl) {
    statusEl.className = "mailer-status hidden";
    statusEl.innerHTML = "";
  }

  /**
   * Отправка с ретраями и идемпотентностью
   */
  async function submitWithRetries(form, payload, modalInstance) {
    const statusEl  = getOrCreateStatusEl(form);
    const submitBtn = form.querySelector("button[type='submit']");
    const originalBtnText = submitBtn ? submitBtn.innerHTML : "";

    // 1. Клиентская идемпотентность
    const fingerprint = [
      payload.formType || "",
      payload.name || "",
      payload.phone || "",
      payload.email || "",
      payload.course || "",
      payload.height || "",
      payload.goal || ""
    ].join("|");

    let idempotencyKey = sentKeys.get(fingerprint);
    if (!idempotencyKey) {
      idempotencyKey = uuid();
      sentKeys.set(fingerprint, idempotencyKey);
    }

    // Состояние: Ожидание
    if (submitBtn) submitBtn.disabled = true;
    setStatus(statusEl, "waiting", "⏳ Ожидание…");

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Состояния: Отправка или Повторная попытка
      if (attempt === 1) {
        setStatus(statusEl, "sending", '<span class="mailer-spinner"></span> Отправка…');
      } else {
        setStatus(
          statusEl,
          "retrying",
          `<span class="mailer-spinner"></span> Повторная попытка ${attempt} из ${MAX_ATTEMPTS}…`
        );
      }

      try {
        const response = await fetch("/api/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({
            ...payload,
            idempotencyKey
          })
        });

        const data = await response.json().catch(() => ({}));

        /* ---- Состояние: Письмо принято SMTP-сервером ---- */
        if (response.ok && data.status === "accepted") {
          setStatus(statusEl, "accepted", "✅ Письмо принято почтовым сервером.");

          form.reset();
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
          }

          // Показываем successModal через небольшую задержку
          setTimeout(() => {
            if (modalInstance && typeof modalInstance.hide === "function") {
              modalInstance.hide();
            }
            if (modalSuccessEl && window.bootstrap && bootstrap.Modal) {
              const successModalInstance = bootstrap.Modal.getOrCreateInstance(modalSuccessEl);
              successModalInstance.show();
            }
            clearStatus(statusEl);
          }, 1200);

          return true;
        }

        /* ---- Временная ошибка (retryable) ---- */
        if (data.retryable && attempt < MAX_ATTEMPTS) {
          lastError = data.message || `HTTP ${response.status}`;
          const waitMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          setStatus(
            statusEl,
            "retrying",
            `<span class="mailer-spinner"></span> Повторная попытка ${attempt + 1} из ${MAX_ATTEMPTS}: временная ошибка. Ожидание ${waitMs / 1000} сек…`
          );
          await delay(waitMs);
          continue;
        }

        /* ---- Состояние: Ошибка отправки (постоянная ошибка) ---- */
        const errMsg = data.message || `Ошибка сервера (${response.status})`;
        setStatus(statusEl, "error", `❌ Ошибка отправки: ${escapeHtml(errMsg)}`);

        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalBtnText;
        }
        return false;

      } catch (networkErr) {
        /* ---- Сетевая ошибка ---- */
        lastError = networkErr.message || "Сетевая ошибка";

        if (attempt < MAX_ATTEMPTS) {
          const waitMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          setStatus(
            statusEl,
            "retrying",
            `<span class="mailer-spinner"></span> Ошибка сети. Повторная попытка ${attempt + 1} из ${MAX_ATTEMPTS} через ${waitMs / 1000} сек…`
          );
          await delay(waitMs);
          continue;
        }
      }
    }

    /* ---- Состояние: Неопределённый результат ---- */
    setStatus(
      statusEl,
      "unknown",
      `⚠️ Неопределённый результат: не удалось получить ответ от сервера после ${MAX_ATTEMPTS} попыток. Последняя ошибка: ${escapeHtml(lastError || "нет соединения")}`
    );

    // Удаляем из кэша, чтобы пользователь мог повторить с новым ключом
    sentKeys.delete(fingerprint);

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }

    return false;
  }

  /* =================================================================
     1. Форма заявки на занятие (leadForm)
     ================================================================= */
  if (formLead) {
    formLead.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (!formLead.checkValidity()) {
        formLead.reportValidity();
        return;
      }

      const formData = new FormData(formLead);
      const payload = {
        formType: "lead",
        name:     (formData.get("name") || "").toString().trim(),
        phone:    (formData.get("phone") || "").toString().trim(),
        height:   (formData.get("height") || "").toString().trim(),
        goal:     (formData.get("goal") || "").toString().trim(),
        site_url: (formData.get("site_url") || "").toString().trim(),
        subject:  "Заявка на занятие по скандинавской ходьбе"
      };

      const modalInstance = modalLeadEl && window.bootstrap && bootstrap.Modal
        ? bootstrap.Modal.getOrCreateInstance(modalLeadEl)
        : null;

      await submitWithRetries(formLead, payload, modalInstance);
    });
  }

  /* =================================================================
     2. Форма заказа курса (courseForm)
     ================================================================= */
  if (formCourse) {
    formCourse.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (!formCourse.checkValidity()) {
        formCourse.reportValidity();
        return;
      }

      const formData = new FormData(formCourse);
      const payload = {
        formType: "course",
        name:     (formData.get("name") || "").toString().trim(),
        phone:    (formData.get("phone") || "").toString().trim(),
        course:   "Авторский курс \"Ходить хорошо\"",
        price:    "2100 ₽",
        site_url: (formData.get("site_url") || "").toString().trim(),
        subject:  "Заказ авторского курса \"Ходить хорошо\" (2100 ₽)"
      };

      const modalInstance = modalCourseEl && window.bootstrap && bootstrap.Modal
        ? bootstrap.Modal.getOrCreateInstance(modalCourseEl)
        : null;

      await submitWithRetries(formCourse, payload, modalInstance);
    });
  }

})();
