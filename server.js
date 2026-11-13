import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import apiRouter, { getSendStatus, sendForm } from "./src/routes/api.js";

const app = express();
const currentFile = fileURLToPath(import.meta.url);
const publicDirectory = path.join(path.dirname(currentFile), "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use("/api", apiRouter);
app.get(["/send-lead", "/send-lead-course"], getSendStatus);
app.post(["/send-lead", "/send-lead-course"], sendForm);

app.use("/api", (_req, res) => {
  res.set("Cache-Control", "no-store").status(404).json({
    status: "error",
    message: "Маршрут API не найден."
  });
});

// On Render or a VPS this serves the complete site. Vercel ignores this
// middleware and serves public/ itself from its CDN.
app.use(express.static(publicDirectory));

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);

  const status = Number(err.status) || 500;
  console.error(`[api][${new Date().toISOString()}] Request failed:`, err);

  res.status(status).json({
    status: "error",
    message: status === 400
      ? "Не удалось разобрать тело запроса."
      : status === 413
        ? "Тело запроса слишком большое."
        : "Внутренняя ошибка сервера."
  });
});

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === currentFile;

if (isDirectExecution) {
  const port = Number(process.env.PORT) || 3000;

  app.listen(port, "0.0.0.0", () => {
    console.log(`Express application listening on port ${port}`);
  });
}

export default app;
