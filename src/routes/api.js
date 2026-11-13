import { Router } from "express";
import { processFormData } from "../services/formHandler.js";

const router = Router();

export function getSendStatus(_req, res) {
  res.set("Cache-Control", "no-store").status(200).json({
    name: "Express Mailer API",
    status: "ok",
    usage: "Send POST requests with form fields to /api/send"
  });
}

export async function sendForm(req, res, next) {
  console.log(`[api][${new Date().toISOString()}] Incoming POST ${req.originalUrl}`);

  try {
    const { httpStatus, data } = await processFormData(req.body ?? {});
    return res.set("Cache-Control", "no-store").status(httpStatus).json(data);
  } catch (err) {
    return next(err);
  }
}

router.get("/send", getSendStatus);
router.post("/send", sendForm);

export default router;
