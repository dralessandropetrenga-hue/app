/**
 * api/ghl.js
 * Serverless function Vercel — integrazione GoHighLevel
 *
 * Azioni disponibili (campo "action" nel body JSON):
 *   searchContacts  → cerca contatti per nome o telefono
 *   getConversation → recupera la conversazione di un contatto
 *   getMessages     → carica tutti i messaggi di una conversazione
 *
 * Env vars richieste:
 *   GOHIGHLEVEL_API_KEY      — chiave API GHL
 *   GOHIGHLEVEL_LOCATION_ID  — ID della location (sede)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GHL_BASE    = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

export default async function handler(req, res) {
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

  const apiKey     = process.env.GOHIGHLEVEL_API_KEY;
  const locationId = process.env.GOHIGHLEVEL_LOCATION_ID;

  if (!apiKey || !locationId) {
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "GOHIGHLEVEL_API_KEY o GOHIGHLEVEL_LOCATION_ID non configurati nelle variabili d'ambiente Vercel",
    }));
    return;
  }

  const ghlHeaders = {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_VERSION,
    "Content-Type": "application/json",
  };

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    const { action } = body;

    // ── 1. CERCA CONTATTI PER NOME / TELEFONO ──────────────────────────────
    if (action === "searchContacts") {
      const { query } = body;
      if (!query) throw new Error("query mancante");

      const url = `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}&limit=10`;
      const r   = await fetch(url, { headers: ghlHeaders });

      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`GHL search: ${r.status} — ${txt}`);
      }

      const data     = await r.json();
      const contacts = data.contacts || [];

      // Normalizza l'output
      const result = contacts.map(c => ({
        id:    c.id,
        name:  c.contactName || `${c.firstName || ""} ${c.lastName || ""}`.trim() || "Senza nome",
        phone: c.phone || "",
        email: c.email || "",
        tags:  c.tags || [],
      }));

      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ contacts: result }));
      return;
    }

    // ── 2. RECUPERA CONVERSAZIONE DI UN CONTATTO ───────────────────────────
    if (action === "getConversation") {
      const { contactId } = body;
      if (!contactId) throw new Error("contactId mancante");

      const url = `${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=5`;
      const r   = await fetch(url, { headers: ghlHeaders });

      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`GHL conversations: ${r.status} — ${txt}`);
      }

      const data          = await r.json();
      const conversations = data.conversations || [];

      // Restituisce la prima (più recente) oppure tutte
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ conversations }));
      return;
    }

    // ── 3. CARICA MESSAGGI DI UNA CONVERSAZIONE ────────────────────────────
    if (action === "getMessages") {
      const { conversationId, contactName = "Paziente" } = body;
      if (!conversationId) throw new Error("conversationId mancante");

      // Paginazione: GHL restituisce max 100 messaggi per chiamata
      let allMessages   = [];
      let lastMessageId = null;

      while (true) {
        const params = new URLSearchParams({ limit: "100" });
        if (lastMessageId) params.append("lastMessageId", lastMessageId);

        const r = await fetch(
          `${GHL_BASE}/conversations/${encodeURIComponent(conversationId)}/messages?${params}`,
          { headers: ghlHeaders }
        );

        if (!r.ok) {
          const txt = await r.text();
          throw new Error(`GHL messages: ${r.status} — ${txt}`);
        }

        const data     = await r.json();
        const messages = data.messages?.messages || data.messages || [];
        if (!messages.length) break;

        allMessages = allMessages.concat(messages);
        if (messages.length < 100) break;
        lastMessageId = messages[messages.length - 1].id;
      }

      // Ordina per data crescente
      allMessages.sort((a, b) =>
        new Date(a.dateAdded || a.createdAt || 0) - new Date(b.dateAdded || b.createdAt || 0)
      );

      // Formatta come testo conversazione leggibile
      const text = formatConversation(allMessages, contactName);

      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ text, messageCount: allMessages.length }));
      return;
    }

    throw new Error(`Azione non riconosciuta: ${action}`);

  } catch (err) {
    console.error("Errore GHL:", err);
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Errore interno GHL" }));
  }
}

/**
 * Converte l'array di messaggi GHL in testo conversazione formattato.
 */
function formatConversation(messages, contactName) {
  if (!messages.length) return "(nessun messaggio trovato)";

  const lines = [];

  messages.forEach(msg => {
    const testo = (msg.body || msg.message || msg.text || "").trim();
    if (!testo) return;

    // Mittente
    const isOutbound =
      msg.direction === "outbound" ||
      msg.type === "TYPE_ACTIVITY_EMAIL" ||
      msg.userId;
    const sender = isOutbound ? "Segretaria" : contactName;

    // Data
    const d      = new Date(msg.dateAdded || msg.createdAt || "");
    const data   = isNaN(d)
      ? ""
      : `[${d.toLocaleString("it-IT", { timeZone: "Europe/Rome" })}] `;

    lines.push(`${data}${sender}: ${testo}`);
  });

  return lines.join("\n");
}
