/**
 * api/analyze.js
 * Serverless function Vercel — analisi testo via Claude (Anthropic)
 *
 * Riceve un JSON body e lo inoltra all'API Anthropic.
 */

// Header CORS comuni
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default async function handler(req, res) {
  // Gestione preflight CORS
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "ANTHROPIC_API_KEY non configurata" }));
    return;
  }

  try {
    // Leggi il body JSON
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf-8");
    const payload = JSON.parse(rawBody);

    // Inoltra a Anthropic
    const anthropicResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
      }
    );

    const responseText = await anthropicResponse.text();

    res.writeHead(anthropicResponse.status, {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    });
    res.end(responseText);
  } catch (err) {
    console.error("Errore analyze:", err);
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Errore interno" }));
  }
}
