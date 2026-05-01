/**
 * api/morning-agent.js
 * Agente mattutino — analizza tutte le conversazioni GHL con nuovi messaggi
 * e salva il report su Supabase.
 *
 * Invocato dal cron Vercel ogni mattina alle 8 (Europa/Roma).
 * Env vars: GOHIGHLEVEL_API_KEY, GOHIGHLEVEL_LOCATION_ID,
 *           ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const GHL_BASE    = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SYSTEM_PROMPT = `Sei un coach di comunicazione per la segreteria del Dr. Petrenga, medico di medicina estetica high ticket (FaceLine, filler, botox, rinofiller).
Il tuo compito è analizzare e migliorare chat WhatsApp, DM Instagram e trascrizioni telefonate gestite da Carmen, Miriana e Asia.

Le segretarie sono:
- Miriana: gestisce social media e chat Instagram
- Carmen: gestisce chat WhatsApp, telefonate, accoglienza, prenotazioni
- Asia: gestisce segreteria, accoglienza pazienti e prenotazioni

OBIETTIVO: ottimizza in questo ordine:
1. Portare la paziente a prenotare con caparra da 50€.
2. Seguire gli step giusti, NON saltare subito al "vuoi prenotare?":
   - Capire obiettivo estetico / risultato desiderato.
   - Far emergere i pain point (cosa la infastidisce, da quanto tempo, quanto è prioritario).
   - Qualificare (trattamento adatto / sede / disponibilità / capacità di spesa high ticket).
   - Guidare con domande verso la prenotazione (data, sede, caparra).
3. Mantenere posizionamento premium: professionale, amichevole, efficiente, NON servile.

TONO: sempre in italiano con "tu". Professionale ma amichevole, sicuro, sintetico.
Sequenza: Riconosci → Normalizza → Prossima domanda.

COSE DA NON FARE (segnala se compaiono):
- "sono a tua disposizione", "per qualsiasi cosa scrivimi", "scrivimi quando vuoi".
- Tono servile o bisognoso.
- Diminutivi ("tesoro, cara, amore"), troppi emoji.
- Promesse di risultato garantito o consigli medici specifici.

Restituisci SOLO un JSON puro senza backtick:
{
  "voti": {
    "posizionamento_high_ticket": numero 1-10,
    "struttura_vendita": numero 1-10,
    "chiarezza_efficienza": numero 1-10
  },
  "sintesi": "max 2 righe sull'andamento generale",
  "errori_critici": ["errore grave 1"],
  "prossima_azione": "cosa fare adesso con questa paziente"
}`;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Vercel cron chiama con GET; accettiamo anche POST per trigger manuale
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const ghlApiKey    = process.env.GOHIGHLEVEL_API_KEY;
  const locationId   = process.env.GOHIGHLEVEL_LOCATION_ID;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  // Supabase: stesse credenziali pubbliche già usate in api/history.js
  const supabaseUrl  = 'https://xwijckmrywsvtddmhsij.supabase.co';
  const supabaseKey  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3aWpja21yeXdzdnRkZG1oc2lqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNTU0MDQsImV4cCI6MjA5MTczMTQwNH0.ofJl1zEQPudxKvfFvt3EnqEaP2gxVq2iPQLGaFV3v6A';

  if (!ghlApiKey || !locationId || !anthropicKey) {
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GOHIGHLEVEL_API_KEY, GOHIGHLEVEL_LOCATION_ID o ANTHROPIC_API_KEY mancanti" }));
    return;
  }

  try {
    const report = await runAgent({ ghlApiKey, locationId, anthropicKey, supabaseUrl, supabaseKey });
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, report }));
  } catch (err) {
    console.error("Errore agente:", err);
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Errore interno" }));
  }
}

/* ── Core agent ──────────────────────────────────────────────────────── */

async function runAgent({ ghlApiKey, locationId, anthropicKey, supabaseUrl, supabaseKey }) {
  const ghlHeaders = {
    Authorization: `Bearer ${ghlApiKey}`,
    Version: GHL_VERSION,
    "Content-Type": "application/json",
  };

  const sbHeaders = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  };

  // 1. Recupera le conversazioni attive da GHL (max 5 per batch, ordinate per ultima attività)
  const BATCH_SIZE = 5;
  const convUrl = `${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=100&sortBy=last_message_date&sort=desc`;
  const convRes = await fetch(convUrl, { headers: ghlHeaders });
  if (!convRes.ok) throw new Error(`GHL conversations: ${convRes.status}`);
  const convData = await convRes.json();
  const allConversations = convData.conversations || [];

  // Prendi solo le prime BATCH_SIZE con messaggi nuovi
  // (le più recenti per attività, così copriamo quelle più calde)
  const conversations = allConversations.slice(0, BATCH_SIZE * 4); // scansiona le prime 20, analizza max 5

  if (!conversations.length) {
    return buildReport([], new Date());
  }

  // 2. Legge il tracking esistente da Supabase
  const trackRes = await fetch(`${supabaseUrl}/rest/v1/conversation_tracking?select=*`, {
    headers: sbHeaders,
  });
  const trackingRows = trackRes.ok ? await trackRes.json() : [];
  const trackingMap  = {};
  for (const t of trackingRows) trackingMap[t.conversation_id] = t;

  // 3. Analizza le conversazioni con nuovi messaggi (max BATCH_SIZE)
  const results = [];
  let analyzed = 0;

  for (const conv of conversations) {
    if (analyzed >= BATCH_SIZE) break;
    const convId     = conv.id;
    const contactName = conv.contactName || conv.fullName || "Paziente";
    const prev       = trackingMap[convId];

    // Recupera messaggi della conversazione
    const msgRes = await fetch(
      `${GHL_BASE}/conversations/${encodeURIComponent(convId)}/messages?limit=100`,
      { headers: ghlHeaders }
    );
    if (!msgRes.ok) continue;
    const msgData = await msgRes.json();
    const messages = msgData.messages?.messages || msgData.messages || [];
    if (!messages.length) continue;

    // Ordina per data crescente
    messages.sort((a, b) =>
      new Date(a.dateAdded || a.createdAt || 0) - new Date(b.dateAdded || b.createdAt || 0)
    );

    const lastMsg = messages[messages.length - 1];

    // Salta se l'ultimo messaggio è già stato analizzato
    if (prev?.last_analyzed_message_id === lastMsg.id) continue;

    // Salta chat interne (email staff, nomi noti dello studio)
    const isInternal = contactName.includes("@") ||
      /petrenga|miriana|carmen|asia|staff|studio/i.test(contactName);
    if (isInternal) continue;

    // Testo completo conversazione
    const fullText = formatConversation(messages, contactName);

    // Salta se la conversazione è vuota o troppo corta per essere analizzata
    if (fullText.trim().length < 80) continue;

    // Determina segretaria dal canale
    const channel     = (conv.type || conv.channel || "").toLowerCase();
    const isInstagram = channel.includes("instagram") || channel === "ig_messaging";
    const segretaria  = isInstagram
      ? "Miriana (gestisce Instagram e social media)"
      : "Carmen (gestisce WhatsApp e telefonate)";

    // Analizza con Claude
    const analysis = await analyzeWithClaude(anthropicKey, fullText, segretaria, contactName);

    results.push({
      contactName,
      channel: isInstagram ? "Instagram" : "WhatsApp",
      segretaria: isInstagram ? "Miriana" : "Carmen",
      analysis,
    });

    analyzed++;

    // Aggiorna tracking su Supabase (fire-and-forget per non perdere tempo)
    fetch(`${supabaseUrl}/rest/v1/conversation_tracking`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({
        conversation_id: convId,
        contact_name: contactName,
        contact_id: conv.contactId || null,
        last_analyzed_message_id: lastMsg.id,
        last_analyzed_at: new Date().toISOString(),
        last_message_count: messages.length,
        updated_at: new Date().toISOString(),
      }),
    });
  }

  // 4. Costruisce e salva il report
  const now    = new Date();
  const report = buildReport(results, now);

  await fetch(`${supabaseUrl}/rest/v1/daily_reports`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      report_date: now.toISOString().split("T")[0],
      report_text: report,
      conversations_analyzed: results.length,
    }),
  });

  await sendTelegram(report);

  return report;
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function formatConversation(messages, contactName) {
  const lines = [];
  for (const msg of messages) {
    const testo = (msg.body || msg.message || msg.text || "").trim();
    if (!testo) continue;
    const isOutbound = msg.direction === "outbound" || !!msg.userId;
    const sender = isOutbound ? "Segretaria" : contactName;
    const d    = new Date(msg.dateAdded || msg.createdAt || "");
    const data = isNaN(d) ? "" : `[${d.toLocaleString("it-IT", { timeZone: "Europe/Rome" })}] `;
    lines.push(`${data}${sender}: ${testo}`);
  }
  return lines.join("\n");
}

async function analyzeWithClaude(apiKey, conversationText, segretaria, contactName) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Segretaria: ${segretaria}\n\nConversazione con ${contactName}:\n\n${conversationText.slice(0, 6000)}`,
      }],
    }),
  });

  const data = await res.json();
  const raw  = data.content?.[0]?.text || "{}";
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { sintesi: raw.slice(0, 200), voti: {}, errori_critici: [], prossima_azione: "" };
  }
}

function buildReport(results, now) {
  const dateStr = now.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

  if (!results.length) {
    return `📊 REPORT ANALISI — ${dateStr} ore 8:00\n\nNessuna chat nuova da analizzare oggi. Tutto aggiornato ✅`;
  }

  const miriana = results.filter(r => r.segretaria === "Miriana");
  const carmen  = results.filter(r => r.segretaria === "Carmen");

  const formatRow = (r) => {
    const v   = r.analysis.voti || {};
    const hasScores = v.posizionamento_high_ticket || v.struttura_vendita || v.chiarezza_efficienza;
    const avg = hasScores
      ? Math.round(((v.posizionamento_high_ticket || 0) + (v.struttura_vendita || 0) + (v.chiarezza_efficienza || 0)) / 3)
      : null;
    const dot     = avg === null ? "⚪" : avg >= 8 ? "🟢" : avg >= 6 ? "🟡" : "🔴";
    const score   = avg === null ? "N/A" : `${avg}/10`;
    const sintesi = r.analysis.sintesi ? `\n   ${r.analysis.sintesi}` : "";
    const errore  = r.analysis.errori_critici?.[0] ? `\n   ⚠️ ${r.analysis.errori_critici[0]}` : "";
    const azione  = r.analysis.prossima_azione ? `\n   👉 ${r.analysis.prossima_azione}` : "";
    return `${dot} ${r.contactName} — ${score}${sintesi}${errore}${azione}`;
  };

  let report = `📊 REPORT ANALISI CONVERSAZIONI\n${dateStr} · ore 8:00\nChat analizzate: ${results.length}\n`;

  if (miriana.length) {
    report += `\n👩 MIRIANA — Instagram (${miriana.length})\n`;
    report += miriana.map(formatRow).join("\n\n");
    report += "\n";
  }

  if (carmen.length) {
    report += `\n👩 CARMEN — WhatsApp (${carmen.length})\n`;
    report += carmen.map(formatRow).join("\n\n");
    report += "\n";
  }

  return report;
}

async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  // Telegram limita i messaggi a 4096 caratteri — divide se necessario
  const chunks = splitText(text, 4000);
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
  }
}

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = i + maxLen;
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i) end = nl;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
