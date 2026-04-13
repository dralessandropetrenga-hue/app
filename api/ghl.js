/**
 * api/ghl.js
 * Serverless function Vercel — carica conversazione da GoHighLevel
 *
 * Riceve { conversationId } nel body JSON,
 * recupera tutti i messaggi dalla GHL API e li restituisce
 * come testo formattato pronto per l'analisi.
 *
 * Docs GHL: https://highlevel.stoplight.io/docs/integrations/
 */

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

  const ghlApiKey = process.env.GOHIGHLEVEL_API_KEY;
  if (!ghlApiKey) {
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GOHIGHLEVEL_API_KEY non configurata" }));
    return;
  }

  try {
    // Leggi body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const { conversationId } = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

    if (!conversationId) {
      res.writeHead(400, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "conversationId mancante" }));
      return;
    }

    // 1. Recupera i dettagli della conversazione
    const convRes = await fetch(
      `https://services.leadconnectorhq.com/conversations/${conversationId}`,
      {
        headers: {
          Authorization: `Bearer ${ghlApiKey}`,
          Version: "2021-04-15",
          "Content-Type": "application/json",
        },
      }
    );

    if (!convRes.ok) {
      const err = await convRes.text();
      throw new Error(`GHL conversations: ${convRes.status} — ${err}`);
    }

    const convData = await convRes.json();
    const conv = convData.conversation || convData;

    // 2. Recupera i messaggi (paginazione con limit 100)
    let allMessages = [];
    let lastMessageId = null;

    // GHL restituisce max 20 messaggi per default; usiamo limit=100 e scorriamo
    while (true) {
      const params = new URLSearchParams({ limit: "100" });
      if (lastMessageId) params.append("lastMessageId", lastMessageId);

      const msgRes = await fetch(
        `https://services.leadconnectorhq.com/conversations/${conversationId}/messages?${params}`,
        {
          headers: {
            Authorization: `Bearer ${ghlApiKey}`,
            Version: "2021-04-15",
          },
        }
      );

      if (!msgRes.ok) {
        const err = await msgRes.text();
        throw new Error(`GHL messages: ${msgRes.status} — ${err}`);
      }

      const msgData = await msgRes.json();
      const messages = msgData.messages?.messages || msgData.messages || [];

      if (!messages.length) break;

      allMessages = allMessages.concat(messages);

      // Se ci sono meno messaggi del limite, siamo arrivati alla fine
      if (messages.length < 100) break;

      // Prendi l'ID dell'ultimo messaggio per la paginazione
      lastMessageId = messages[messages.length - 1].id;
    }

    // 3. Ordina per data crescente
    allMessages.sort((a, b) => {
      const dA = new Date(a.dateAdded || a.createdAt || 0);
      const dB = new Date(b.dateAdded || b.createdAt || 0);
      return dA - dB;
    });

    // 4. Formatta come testo leggibile per il sistema di analisi
    const contactName = conv.contactName || conv.fullName || "Cliente";
    const channel     = conv.type || conv.channel || "WhatsApp";

    const lines = [
      `=== CONVERSAZIONE GHL ===`,
      `Contatto: ${contactName}`,
      `Canale: ${channel}`,
      `ID: ${conversationId}`,
      `Messaggi totali: ${allMessages.length}`,
      `========================`,
      "",
    ];

    allMessages.forEach(msg => {
      // Determina il mittente
      let sender = "Sconosciuto";
      if (msg.direction === "inbound"  || msg.type === "TYPE_INCOMING_CALL") {
        sender = contactName;
      } else if (msg.direction === "outbound" || msg.type === "TYPE_OUTGOING_CALL") {
        sender = "Segretaria";
      } else if (msg.userId) {
        sender = "Segretaria";
      } else {
        sender = contactName;
      }

      // Data
      const d = new Date(msg.dateAdded || msg.createdAt || "");
      const dataStr = isNaN(d) ? "" : `[${d.toLocaleString("it-IT")}] `;

      // Testo messaggio
      const testo = msg.body || msg.message || msg.text || "";

      // Tipo speciale (chiamata, nota, ecc.)
      const tipo = msg.messageType || msg.type || "";
      const tipoLabel = tipo && tipo !== "TYPE_SMS" && tipo !== "TYPE_WHATSAPP"
        ? ` (${tipo})`
        : "";

      if (testo) {
        lines.push(`${dataStr}${sender}${tipoLabel}: ${testo}`);
      }
    });

    const text = lines.join("\n");

    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ text, messageCount: allMessages.length }));

  } catch (err) {
    console.error("Errore GHL:", err);
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Errore interno" }));
  }
}
