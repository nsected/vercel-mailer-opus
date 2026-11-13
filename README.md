# Лендинг и Express API для заявок

Проект запускается с одним Express-приложением на Vercel, Netlify, Render или собственном VPS.

| Платформа | Запуск | Кто раздаёт `public/` |
| --- | --- | --- |
| Vercel | Vercel импортирует `server.js` как Function с Fluid Compute | Vercel CDN |
| Netlify | `netlify/functions/api.mjs` вызывает Express через `serverless-http` | Netlify CDN + Function |
| Render / VPS | `npm start` запускает `node server.js` | Express |

`server.js` содержит API и `express.static(public)`. На Vercel файлы из `public/` раздаёт CDN платформы. На Netlify статика публикуется из `public/`, а существующее Express-приложение вызывается через Netlify Function и `serverless-http`. При прямом запуске Node.js Express раздаёт весь сайт и слушает `PORT` на `0.0.0.0`.

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
netlify.toml             Публикация public/, Function и rewrite-маршруты Netlify
netlify/functions/api.mjs Адаптер существующего Express app для Netlify Functions
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

`.env` исключён из Git. На Vercel, Netlify и Render задайте те же переменные в настройках сервиса. На VPS передайте их через systemd, Docker, PM2 или переменные окружения процесса.

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

## Деплой на Netlify

Ветка `Netlify-адаптер` содержит отдельную конфигурацию Netlify. Исходный `server.js`, маршруты API и Vercel-конфигурация сохранены. Netlify Function вызывает то же Express-приложение через `serverless-http`, поэтому логика проверки формы и отправки Gmail-писем не дублируется.

1. Импортируйте репозиторий `nsected/vercel-mailer-opus` в Netlify и выберите ветку `Netlify-адаптер`.
2. Оставьте Base directory пустым (корень репозитория). Параметры сборки уже заданы в `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
3. В настройках Netlify добавьте переменные окружения `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` и `RECIPIENT_EMAIL`. Для production выберите область Production; для тестовых deploy preview при необходимости добавьте Preview.
4. После добавления или изменения переменных запустите новый deploy.

Netlify публикует HTML/CSS/JS и медиа из `public/` через CDN, а запросы к `/api/*`, `/send-lead` и `/send-lead-course` переписываются на Function. Внутри Function Express обрабатывает те же маршруты, что и на Vercel/Render.

Проверка после деплоя: откройте `https://<имя-сайта>.netlify.app/api/send`. Ожидается JSON со статусом API. Отправку формы проверяйте тестовой заявкой после настройки SMTP-переменных.

Важно: Netlify Functions — бессерверная среда с ограничениями по времени выполнения и памяти. Она подходит для текущей короткой операции отправки письма; функция не должна использоваться как постоянно работающий HTTP-сервер или для WebSocket-соединений.

## Деплой на Render или VPS

На Render создайте Node Web Service со значениями:

```text
Build Command: npm ci
Start Command: npm start
```

Render передаст порт в `PORT`; на VPS по умолчанию используется порт `3000`, либо укажите свой `PORT`. Express в обоих случаях раздаёт и API, и всё содержимое `public/`.
