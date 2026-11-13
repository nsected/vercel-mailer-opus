# Лендинг и Express API для заявок

Проект запускается с одним Express-приложением на Vercel, Render или собственном VPS.

| Платформа | Запуск | Кто раздаёт `public/` |
| --- | --- | --- |
| Vercel | Vercel импортирует `server.js` как Function с Fluid Compute | Vercel CDN |
| Render / VPS | `npm start` запускает `node server.js` | Express |

`server.js` всегда содержит API и `express.static(public)`. При развёртывании на Vercel middleware для статики игнорируется платформой, поэтому Vercel сам раздаёт файлы из `public/`. При прямом запуске Node.js тот же middleware раздаёт весь сайт, а Express слушает `PORT` на `0.0.0.0`.

## Структура

```text
public/                  HTML, CSS, JavaScript, изображения и видео лендинга
server.js                Express app и старт HTTP-сервера вне Vercel
src/routes/api.js        HTTP-маршруты API
src/services/formHandler.js
                         Проверка формы и подготовка письма
src/services/smtpMailer.js
                         Отправка через Gmail SMTP и защита от повторов
vercel.json              Настройки Vercel Function и совместимые URL форм
```

## API

- `GET /api/send` — проверка доступности API.
- `POST /api/send` — приём заявки в JSON или `application/x-www-form-urlencoded`.
- `GET` и `POST` на `/send-lead` и `/send-lead-course` — совместимые короткие URL.

Обработчик проверяет honeypot `site_url`, требует имя и телефон либо email, затем отправляет письмо через Gmail SMTP. Тело запроса ограничено 100 КБ.

## Переменные окружения

Скопируйте `.env.example` в `.env` и укажите значения для локальной разработки:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
RECIPIENT_EMAIL=recipient@example.com
```

`.env` исключён из Git. На Vercel и Render задайте те же переменные в настройках сервиса. На VPS передайте их через systemd, Docker, PM2 или переменные окружения процесса.

## Локальная разработка

```bash
npm install
npm run dev
```

Сервер доступен на `http://localhost:3000`; изменения в серверном коде перезапускают процесс. Для запуска без watch-режима с локальным `.env` используйте `npm run start:local`.

## Деплой на Vercel

Vercel автоматически использует экспорт Express app из `server.js`, раздаёт `public/` через CDN и запускает API на Fluid Compute. Задайте SMTP-переменные в настройках проекта и выполните:

```bash
npm run deploy
```

Для `vercel dev` в Vercel Dashboard не задавайте Development Command, который вызывает `vercel dev`: это создаёт рекурсивный запуск.

## Деплой на Render или VPS

На Render создайте Node Web Service со значениями:

```text
Build Command: npm ci
Start Command: npm start
```

Render передаст порт в `PORT`; на VPS по умолчанию используется порт `3000`, либо укажите свой `PORT`. Express в обоих случаях раздаёт и API, и всё содержимое `public/`.
