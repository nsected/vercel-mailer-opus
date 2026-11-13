# 📨 Vercel Mailer & Landing — сайт и отправка заявок через Gmail SMTP

Полноценный лендинг «Ходить хорошо» со статической раздачей через Vercel и Serverless Functions (Fluid Compute) для отправки заявок через Gmail SMTP (Nodemailer).

## Архитектура

```
┌─────────────────────────┐   POST /api/send   ┌──────────────────────┐   SMTP   ┌───────────┐
│  Browser / Landing      │ ─────────────────▸ │  Vercel Function     │ ───────▸ │  Gmail    │
│  (HTML+CSS+JS статика)  │ ◂───── JSON ────── │  (Node.js + Fluid)   │          │  SMTP     │
└─────────────────────────┘                    └──────────────────────┘          └───────────┘
```

**Ключевые решения:**

| Компонент | Выбор | Почему |
|---|---|---|
| Hosting | Vercel | Автоматическая раздача статики (`public/`), быстрый CDN, Functions из коробки |
| Compute | Fluid Compute | Тарификация по CPU-time, долгие warm-инстансы, быстрое выполнение |
| Email | Nodemailer + Gmail SMTP | Прямая отправка без сторонних платных сервисов (Resend/SendGrid) |
| Idempotency | Клиент (UUID) + сервер (in-memory cache) | Предотвращение дублей при повторных кликах и сетевых ретраях |
| Antispam | Honeypot (`site_url`) | Боты заполняют скрытое поле и получают фиктивный успех без спама |

---

## 1. Формы лендинга

1. **Заказ курса «Ходить хорошо»** (модальное окно `#courseModal`):
   - Имя (`name`)
   - Телефон (`phone`)
   - Скрытое поле от спама (`site_url`)
   - Товар: Авторский курс «Ходить хорошо» (2100 ₽)

2. **Заявка на занятие** (модальное окно `#leadModal`):
   - Имя (`name`)
   - Телефон (`phone`)
   - Рост (`height`)
   - Цель занятий (`goal` — radio: «Освоить технику», «Оздоровление», «Коррекция веса», «Доктор прописал»)
   - Скрытое поле от спама (`site_url`)

---

## 2. Статусы отправки и повторные попытки

В интерфейсе пользователя отображаются все 6 состояний:

| Состояние | Вид в интерфейсе | Описание |
|---|---|---|
| **Ожидание** | `⏳ Ожидание…` | Форма валидирована, подготавливается запрос |
| **Отправка** | `<spinner> Отправка…` | Запрос передан на сервер Vercel |
| **Повторная попытка** | `<spinner> Повторная попытка N из 3…` | При временных сетевых или SMTP ошибках (4xx) с нарастающим интервалом (2с, 4с) |
| **Принято почтовым сервером** | `✅ Письмо принято почтовым сервером.` | Успешный ответ SMTP, форма очищается и открывается окно `#successModal` |
| **Ошибка отправки** | `❌ Ошибка отправки: ...` | Постоянная ошибка (неверный адрес, авторизация SMTP) |
| **Неопределённый результат** | `⚠️ Неопределённый результат: ...` | Все 3 попытки исчерпаны без подтверждения от сервера |

---

## 3. Переменные окружения

Создайте `.env` в корне проекта (на основе `.env.example`):

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

## 4. Настройка Gmail SMTP и пароля приложения

1. Включите **двухэтапную аутентификацию** в аккаунте Google: [myaccount.google.com/security](https://myaccount.google.com/security).
2. Перейдите в раздел **Пароли приложений**: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Создайте новый пароль (название: `VercelMailer`).
4. Скопируйте 16-значный пароль в переменную `SMTP_PASS`.

---

## 5. Локальный запуск

```bash
# Установка зависимостей
npm install

# Запуск локального сервера Vercel Dev
npx vercel dev
```

Откройте [http://localhost:3000](http://localhost:3000) в браузере.

---

## 6. Развёртывание на Vercel

```bash
# 1. Авторизация
npx vercel login

# 2. Добавление секретов в Vercel
npx vercel env add SMTP_HOST
npx vercel env add SMTP_PORT
npx vercel env add SMTP_SECURE
npx vercel env add SMTP_USER
npx vercel env add SMTP_PASS
npx vercel env add RECIPIENT_EMAIL

# 3. Деплой в Production
npx vercel --prod
```

---

## 7. Fluid Compute

Включение Fluid Compute контролируется файлом `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "fluid": true,
  "functions": {
    "api/**": {
      "maxDuration": 30
    }
  }
}
```

Проверка использования Fluid Compute:
- В Vercel Dashboard перейдите в **Project Settings → Functions → Fluid Compute**.
- В разделе **Usage** видно разделение на активный CPU Time и общее время выполнения.
