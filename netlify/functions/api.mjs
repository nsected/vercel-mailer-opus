import serverless from "serverless-http";
import app from "../../server.js";

// Reuse the existing Express application and its routes.
// Netlify invokes this handler as a Function; no app.listen() is needed.
export const handler = serverless(app);
