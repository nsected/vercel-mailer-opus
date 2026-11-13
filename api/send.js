/**
 * /api/send facade
 * Forwards incoming HTTP requests to api/lib/formHandler.js
 */
import { handleFormRequest } from "./lib/formHandler.js";

// Web Standard Fetch API (Vercel Functions)
export async function POST(request) {
  console.log(`[send facade][${new Date().toISOString()}] Incoming POST /api/send`);
  return handleFormRequest(request);
}

export async function GET() {
  return Response.json({
    name: "Vercel Mailer API",
    status: "ok",
    usage: "Send POST requests with form fields to /api/send"
  }, { status: 200 });
}

// Node.js classic (req, res) fallback
export default async function handler(req, res) {
  console.log(`[send facade][${new Date().toISOString()}] Incoming ${req.method} /api/send (Node.js style)`);
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", message: "Vercel Mailer API. Use POST." });
  }
  return handleFormRequest(req, res);
}
