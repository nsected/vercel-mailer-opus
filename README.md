# 📨 Vercel Mailer — отправка заявок через Gmail SMTP

Минимальный рабочий пример: HTML-форма → Vercel Serverless Function (Fluid Compute) → Gmail SMTP (Nodemailer).

## Архитектура

```
┌──────────────┐   POST /api/send   ┌──────────────────────┐   SMTP   ┌───────────┐
│  Browser     │ ─────────────────▸ │  Vercel Function     │ ───────▸ │  Gmail    │
│  (HTML+JS)   │ ◂───── JSON ────── │  (Node.js + Fluid)   │          │  SMTP     │
└──────────────┘                    └──────────────────────┘          └───────────┘
```

**Ключевые решения:**

| Компонент | Выбор | Почему |
|---|---|---|
| Hosting | Vercel | Бесплатный tier, авто-деплой, Functions из коробки |
| Compute | Fluid Compute | Тарификация по CPU-time, переиспользование warm-инстансов |
| Email | Nodemailer + Gmail SMTP | Не нужны сторонние API, App Password |
| Idempotency | Клиент (UUID) + сервер (in-memory cache) | Дублирование при retry невозможно, пока инстанс жив |

---

## 1. Переменные окружения

| Переменная | Описание | Пример |
|---|---|---|
| `SMTP_HOST` | SMTP-сервер | `smtp.gmail.com` |
| `SMTP_PORT` | Порт | `465` |
| `SMTP_SECURE` | TLS | `true` |
| `SMTP_USER` | Email аккаунта Gmail | `you@gmail.com` |
| `SMTP_PASS` | [Пароль приложения Google](#2-настройка-gmail-smtp) | `abcd efgh ijkl mnop` |
| `RECIPIENT_EMAIL` | Куда приходят заявки | `admin@example.com` |

> **Файл `.env.example`** — шаблон без реальных паролей. Скопируйте в `.env` и заполните.

---

## 2. Настройка Gmail SMTP

### 2.1 Включите двухфакторную аутентификацию

1. [myaccount.google.com/security](https://myaccount.google.com/security)
2. Раздел **«Вход в аккаунт Google»** → **Двухэтапная аутентификация** → Включить.

### 2.2 Создайте пароль приложения

1. [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. **Приложение** → `Почта`, **Устройство** → `Другое` → введите `VercelMailer`.
3. Нажмите **Создать**.
4. Скопируйте 16-символьный код (формат `abcd efgh ijkl mnop`).
5. Вставьте его в `SMTP_PASS` (с пробелами или без — оба варианта работают).

---

## 3. Локальный запуск

```bash
# 1. Клонируйте и установите зависимости
git clone <repo-url>
cd vercel-mailer-opus
npm install

# 2. Создайте .env
cp .env.example .env
# Заполните SMTP_USER, SMTP_PASS, RECIPIENT_EMAIL

# 3. Запустите Vercel Dev
npx vercel dev
# → http://localhost:3000
```

> **Vercel Dev** читает `.env` автоматически и эмулирует Serverless Functions локально.

Откройте `http://localhost:3000`, заполните форму и отправьте тестовую заявку.

---

## 4. Развёртывание на Vercel

### 4.1 Первый деплой

```bash
npx vercel          # Preview-деплой, следуйте интерактивным вопросам
npx vercel --prod   # Production-деплой
```

Или подключите GitHub-репозиторий в [vercel.com/new](https://vercel.com/new) — деплой при каждом push.

### 4.2 Переменные окружения в Vercel

```bash
# Через CLI
npx vercel env add SMTP_HOST       # введите smtp.gmail.com
npx vercel env add SMTP_PORT       # введите 465
npx vercel env add SMTP_SECURE     # введите true
npx vercel env add SMTP_USER       # ваш Gmail
npx vercel env add SMTP_PASS       # пароль приложения (sensitive)
npx vercel env add RECIPIENT_EMAIL # email получателя
```

Или в Dashboard: **Project → Settings → Environment Variables**.

> После добавления переменных — сделайте **Redeploy** для их применения.

---

## 5. Fluid Compute

### Что это

Fluid Compute меняет модель тарификации:
- **CPU time** — вы платите только за активное выполнение кода (не за ожидание I/O).
- **Provisioned memory** — более низкий тариф за RAM на всё время запроса.
- Warm-инстансы **переиспользуются** — in-memory кеш идемпотентности живёт дольше.

### Как включено

В `vercel.json`:
```json
{
  "fluid": true
}
```

### Проверка работы

1. **Dashboard** → Project → **Logs** → посмотрите строки функций `api/send`.
2. **Dashboard** → Project → **Settings → Functions** — убедитесь, что Fluid Compute включён.
3. **Dashboard** → Project → **Usage** → раздел «Function Execution» — вы увидите разделение на CPU Time и Duration.

> При Fluid Compute нельзя задавать `memory` в `vercel.json` — управление памятью происходит через Dashboard → Settings → Functions → Function CPU.

---

## 6. Логика работы

### Клиент (script.js)

1. При отправке формы генерируется **idempotency key** (UUID v4).
2. Если пользователь отправляет те же данные повторно — используется тот же ключ.
3. При **временной ошибке** или **ошибке сети** — до 3 попыток с экспоненциальным backoff (2 с → 4 с).
4. Состояния, отображаемые пользователю:

| Состояние | Что происходит |
|---|---|
| ⏳ Ожидание | Запрос подготовлен |
| 🔄 Отправка | Запрос ушёл на сервер |
| 🔁 Повторная попытка | Временная ошибка, ждём и пробуем снова |
| ✅ Принято | SMTP-сервер подтвердил приём |
| ❌ Ошибка | Постоянная ошибка (неверный адрес, конфигурация и т.д.) |
| ⚠️ Неопределённый результат | Все попытки исчерпаны, статус неизвестен |

### Сервер (api/send.js)

1. Принимает POST с `idempotencyKey`.
2. Проверяет in-memory кеш — если уже обработано, возвращает сохранённый результат.
3. Отправляет письмо через Nodemailer.
4. Классифицирует ошибки:
   - **Временные** (SMTP 4xx, ECONNRESET, ETIMEDOUT) → 503, `retryable: true`.
   - **Постоянные** (SMTP 5xx, авторизация) → 502, `retryable: false`.

---

## 7. Проверка логов

### Локально

Логи выводятся в терминал при `vercel dev`. Ищите строки `[send] SMTP error:`.

### На Vercel

1. **Dashboard** → Project → **Logs**.
2. Фильтр: **Functions** → `api/send`.
3. Или через CLI:
   ```bash
   npx vercel logs <deployment-url>
   ```

---

## 8. Структура проекта

```
vercel-mailer-opus/
├── api/
│   └── send.js          # Serverless Function: приём заявки, отправка через SMTP
├── public/
│   ├── index.html        # Форма заявки
│   ├── style.css         # Стили
│   └── script.js         # Клиентская логика: retry, idempotency, статусы
├── vercel.json           # Конфигурация Vercel (Fluid Compute, rewrites)
├── package.json          # Зависимости (nodemailer)
├── .env.example          # Шаблон переменных окружения
├── .gitignore            # Игнорируемые файлы
└── README.md             # Эта документация
```

---

## 9. Ограничения и заметки

- **Gmail SMTP** подходит для тестирования и небольших объёмов (до ~500 писем/сутки). Для production рекомендуется Resend, SendGrid или AWS SES.
- **Idempotency-кеш на сервере** — in-memory, сбрасывается при холодном старте. С Fluid Compute инстансы живут дольше, но кеш не персистентен. Клиентская сторона компенсирует это, сохраняя ключи пока открыта вкладка.
- **`from`** — Gmail перезаписывает поле «от кого» на адрес аккаунта. Email отправителя из формы ставится в `Reply-To`.
