# 📨 Vercel Mailer & Landing — сайт и отправка заявок через Gmail SMTP

Полноценный лендинг «Ходить хорошо» со статической раздачей через Vercel, формами на Bootstrap и раздельной архитектурой обработки заявок на Serverless Functions (**Vercel Fluid Compute**).

---

## Архитектура Backend API

Логика бэкенда разделена на фасад и два изолированных модуля в `api/lib/`:

```
┌──────────────────────────────────────────────┐
│     Веб-форма лендинга                       │
└──────────────────────┬───────────────────────┘
                       │ POST /api/send
                       ▼
┌──────────────────────────────────────────────┐
│             api/send.js (Фасад)              │ ── Принимает HTTP-запрос (Web Standard / Node.js)
└──────────────────────┬───────────────────────┘ ── Логирует входящий вызов и делегирует
                       │
                       ▼
┌──────────────────────────────────────────────┐
│          api/lib/formHandler.js              │ ── 1. Разбор JSON и URL-encoded данных
│          (Обработчик веб-форм)               │ ── 2. Проверка honeypot `site_url` (защита от ботов)
└──────────────────────┬───────────────────────┘ ── 3. Валидация обязательных полей
                       │                         ── 4. Формирование темы и HTML/текста письма
                       │ sendEmail(...)
                       ▼
┌──────────────────────────────────────────────┐
│          api/lib/smtpMailer.js               │ ── 1. Ленивый пул Nodemailer (Gmail SMTP 465)
│          (Почтовый SMTP-сервис)              │ ── 2. Кэш идемпотентности (Fluid warm instance)
└──────────────────────┬───────────────────────┘ ── 3. Отправка и классификация ошибок (temporary / permanent)
                       │ TLS / SMTP (порт 465)
                       ▼
                 Gmail SMTP Сервер
                (smtp.gmail.com:465)
```

1. **`api/send.js`** — публичный фасад (Serverless Function эндпоинт Vercel):
   - Принимает запросы по адресу `/api/send`.
   - Поддерживает как стандартный Web Standard Fetch API (`POST(request)`), так и классический Node.js `handler(req, res)`.
   - Логирует каждый входящий запрос с отметкой времени.

2. **`api/lib/formHandler.js`** — приём и валидация форм:
   - Извлекает поля формы (поддерживает `application/json` и `application/x-www-form-urlencoded`).
   - Проверяет поле-ловушку `site_url` (honeypot): спам-боты тихо отсекаются с кодом 200 без отправки писем.
   - Валидирует поля (имя обязательно, телефон или email обязателен).
   - Собирает тему и красивое HTML/plain-text письмо с кликабельными ссылками на звонок и переход в WhatsApp.
   - Передает подготовленные данные в `smtpMailer.js`.

3. **`api/lib/smtpMailer.js`** — почтовый транспорт:
   - Ленивая инициализация транспортера Nodemailer с безопасным переиспользованием в warm-инстансах Vercel Fluid Compute.
   - In-memory кэш идемпотентности `idempotencyKey` на 10 минут (предотвращает повторную отправку одинаковых писем).
   - Классификация ошибок: временные сетевые проблемы и SMTP 4xx возвращают `retryable: true` для повторных попыток клиентом, а ошибки авторизации 5xx — как постоянные.
   - Полное сквозное логирование всех этапов отправки в консоль сервера.

---

## Настройка переменных окружения

В файле `.env` (создается по шаблону `.env.example`):

```ini
# ── SMTP (Gmail) ─────────────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@gmail.com
SMTP_PASS=abcd efgh ijkl mnop

# ── Получатель заявок ────────────────────────────────────
RECIPIENT_EMAIL=recipient@example.com

# ── Отладка в консоли Vercel (по умолчанию включена) ─────
DEBUG=true
```

---

## Локальный запуск

```bash
# 1. Установка зависимостей
npm install

# 2. Запуск локального сервера Vercel
npx vercel dev
```

Приложение доступно по адресу [http://localhost:3000](http://localhost:3000). При любой отправке формы в терминале сразу отображаются подробные логи:
```
[send facade] Incoming POST /api/send
[formHandler] Processing form payload: { name: "...", phone: "..." }
[formHandler] Forwarding to smtpMailer (idempotencyKey: ...)…
[smtpMailer] Connecting to SMTP and sending mail to: ...
[smtpMailer] ✅ SMTP accepted! messageId=...
```
