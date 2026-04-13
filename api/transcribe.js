/**
 * api/transcribe.js
 * Serverless function Vercel — trascrizione audio via Groq Whisper
 *
 * Riceve un file audio via FormData, lo inoltra a Groq
 * usando whisper-large-v3 con language: it.
 */

// Disabilita il bodyParser di Vercel per gestire manualmente multipart/form-data
export const config = {
  api: {
    bodyParser: false,
  },
};

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

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GROQ_API_KEY non configurata" }));
    return;
  }

  try {
    // Colleziona i chunk del body raw
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);

    // Ottieni il Content-Type originale (include il boundary per multipart)
    const contentType = req.headers["content-type"];

    // Inoltra la richiesta raw a Groq aggiungendo il campo model e language
    // Dobbiamo ricostruire il FormData con il campo model
    // Poiché il body è già multipart, usiamo fetch con i dati raw ma aggiungiamo
    // i campi necessari parsando e ricostruendo il multipart.
    //
    // Approccio più semplice e affidabile: parse del boundary e ricostruzione.
    const boundary = extractBoundary(contentType);
    if (!boundary) {
      throw new Error("Impossibile estrarre il boundary dal Content-Type");
    }

    // Ricostruisci il FormData aggiungendo model e language
    const newBody = appendFormDataFields(rawBody, boundary, {
      model: "whisper-large-v3",
      language: "it",
    });

    const newContentType = `multipart/form-data; boundary=${boundary}`;

    // Chiamata a Groq
    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          "Content-Type": newContentType,
        },
        body: newBody,
      }
    );

    const responseText = await groqResponse.text();

    res.writeHead(groqResponse.status, {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    });
    res.end(responseText);
  } catch (err) {
    console.error("Errore transcribe:", err);
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Errore interno" }));
  }
}

/**
 * Estrae il boundary dal Content-Type header multipart/form-data.
 * @param {string} contentType
 * @returns {string|null}
 */
function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=([^\s;]+)/i);
  return match ? match[1] : null;
}

/**
 * Aggiunge campi di testo a un body multipart/form-data esistente.
 * Inserisce i nuovi campi prima del boundary di chiusura finale.
 *
 * @param {Buffer} body - Body multipart originale
 * @param {string} boundary - Boundary string
 * @param {Object} fields - Campi da aggiungere { name: value }
 * @returns {Buffer}
 */
function appendFormDataFields(body, boundary, fields) {
  const enc = new TextEncoder();
  const closingBoundary = Buffer.from(`--${boundary}--`);

  // Trova la posizione del boundary di chiusura
  const closingIdx = body.lastIndexOf(closingBoundary);
  if (closingIdx === -1) {
    // Se non trovato, appendi prima della fine
    const parts = [body];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        )
      );
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(parts);
  }

  // Costruisci i nuovi campi
  const fieldBuffers = [];
  for (const [name, value] of Object.entries(fields)) {
    fieldBuffers.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }

  return Buffer.concat([
    body.slice(0, closingIdx),
    ...fieldBuffers,
    closingBoundary,
    Buffer.from("\r\n"),
  ]);
}
