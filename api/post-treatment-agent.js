/**
 * api/post-treatment-agent.js
 * Analizza le conversazioni GHL degli ultimi 7 giorni,
 * identifica i post-trattamenti e misura la soddisfazione delle pazienti.
 *
 * Cron Vercel: ogni giorno alle 8:05 (5 minuti dopo il morning agent).
 * Env vars: GOHIGHLEVEL_API_KEY, GOHIGHLEVEL_LOCATION_ID, ANTHROPIC_API_KEY
 */

const GHL_BASE    = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const SUPABASE_URL = 'https://xwijckmrywsvtddmhsij.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3aWpja21yeXdzdnRkZG1oc2lqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNTU0MDQsImV4cCI6MjA5MTczMTQwNH0.ofJl1zEQPudxKvfFvt3EnqEaP2gxVq2iPQLGaFV3v6A';

// Quante conversazioni scansionare e quante analizzare per run
const SCAN_LIMIT    = 50;
const ANALYZE_LIMIT = 10;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Prompt 1 — classifica se la chat contiene post-trattamento
const CLASSIFY_PROMPT = `Sei un assistente medico estetico. Analizza questa conversazione WhatsApp/Instagram.

Rispondi SOLO con un JSON puro senza backtick:
{
  "is_post_treatment": true o false,
  "treatment_mentioned": "nome trattamento o null",
  "days_since_treatment": numero stimato o null
}

is_post_treatment = true SE la conversazione contiene:
- Follow-up dopo un trattamento (filler, botox, rinofiller, FaceLine, laser, peeling, ecc.)
- La paziente descrive come si sente dopo il trattamento
- Domande su gonfiore, lividi, risultati, recupero post-procedurale
- La segretaria chiede come è andato il trattamento

is_post_treatment = false in tutti gli altri casi (richiesta preventivo, prima prenotazione, info generiche).`;

// Prompt 2 — analisi soddisfazione post-trattamento
const SATISFACTION_PROMPT = `Sei un analista di customer satisfaction per una clinica di medicina estetica high ticket (Dr. Petrenga — FaceLine, filler, botox, rinofiller).

Analizza questa conversazione post-trattamento e rispondi SOLO con un JSON puro senza backtick:
{
  "satisfaction": "soddisfatta" | "insoddisfatta" | "neutrale",
  "score": numero 1-10,
  "sentiment_signals": ["segnale 1", "segnale 2"],
  "complaints": ["lamentela specifica 1"],
  "compliments": ["complimento specifico 1"],
  "risk_level": "alto" | "medio" | "basso",
  "action_needed": "azione consigliata o null",
  "sintesi": "max 2 righe"
}

Criteri:
- soddisfatta: esprime soddisfazione, risultati positivi, vuole tornare
- insoddisfatta: lamenta dolore eccessivo, risultati deludenti, si pente, minaccia recensione negativa
- neutrale: risponde in modo neutro, non esprime chiaramente soddisfazione o insoddisfazione
- risk_level alto: paziente potrebbe fare recensione negativa o chiedere rimborso`;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const ghlApiKey    = process.env.GOHIGHLEVEL_API_KEY;
  const locationId   = process.env.GOHIGHLEVEL_LOCATION_ID;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!ghlApiKey || !locationId || !anthropicKey) {
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Variabili d'ambiente GHL o Anthropic mancanti" }));
    return;
  }

  try {
    const report = await runPostTreatmentAgent({ ghlApiKey, locationId, anthropicKey });
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, report }));
  } catch (err) {
    console.error("Errore post-treatment agent:", err);
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Errore interno" }));
  }
}

/* ── Core agent ──────────────────────────────────────────────────────── */

async function runPostTreatmentAgent({ ghlApiKey, locationId, anthropicKey }) {
  const ghlHeaders = {
    Authorization: `Bearer ${ghlApiKey}`,
    Version: GHL_VERSION,
    "Content-Type": "application/json",
  };

  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  };

  // 1. Recupera conversazioni recenti da GHL
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const convUrl = `${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=${SCAN_LIMIT}&startAfterDate=${encodeURIComponent(since7d)}`;
  const convRes = await fetch(convUrl, { headers: ghlHeaders });
  if (!convRes.ok) {
    // Fallback senza filtro data se non supportato
    const fallbackRes = await fetch(
      `${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=${SCAN_LIMIT}`,
      { headers: ghlHeaders }
    );
    if (!fallbackRes.ok) throw new Error(`GHL conversations: ${fallbackRes.status}`);
    var convData = await fallbackRes.json();
  } else {
    var convData = await convRes.json();
  }

  const conversations = convData.conversations || [];
  if (!conversations.length) return buildReport([], 0, new Date());

  // 2. Legge tracking esistente
  const trackRes = await fetch(
    `${SUPABASE_URL}/rest/v1/post_treatment_tracking?select=*`,
    { headers: sbHeaders }
  );
  const trackingRows = trackRes.ok ? await trackRes.json() : [];
  const trackingMap  = {};
  for (const t of trackingRows) trackingMap[t.conversation_id] = t;

  // 3. Filtra e analizza
  const results       = [];
  let   analyzed      = 0;
  let   totalScanned  = 0;

  for (const conv of conversations) {
    if (analyzed >= ANALYZE_LIMIT) break;
    totalScanned++;

    const convId      = conv.id;
    const contactName = conv.contactName || conv.fullName || "Paziente";

    // Recupera messaggi ultimi 7 giorni
    const msgRes = await fetch(
      `${GHL_BASE}/conversations/${encodeURIComponent(convId)}/messages?limit=50`,
      { headers: ghlHeaders }
    );
    if (!msgRes.ok) continue;
    const msgData  = await msgRes.json();
    const messages = msgData.messages?.messages || msgData.messages || [];
    if (!messages.length) continue;

    // Filtra messaggi ultimi 7 giorni
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentMessages = messages.filter(m => {
      const d = new Date(m.dateAdded || m.createdAt || 0).getTime();
      return d >= cutoff;
    });
    if (!recentMessages.length) continue;

    recentMessages.sort((a, b) =>
      new Date(a.dateAdded || a.createdAt || 0) - new Date(b.dateAdded || b.createdAt || 0)
    );

    const lastMsg = recentMessages[recentMessages.length - 1];

    // Salta se già analizzato
    const prev = trackingMap[convId];
    if (prev?.last_analyzed_message_id === lastMsg.id) continue;

    const convText = formatConversation(recentMessages, contactName);

    // Pass 1: classifica se è post-trattamento
    const classification = await classifyWithClaude(anthropicKey, convText);
    if (!classification.is_post_treatment) {
      // Salva comunque che abbiamo visto questa conv (non post-trattamento)
      await upsertTracking(sbHeaders, {
        conversation_id: convId,
        contact_name: contactName,
        contact_id: conv.contactId || null,
        last_analyzed_message_id: lastMsg.id,
        last_analyzed_at: new Date().toISOString(),
        satisfaction_label: "non_post_trattamento",
      });
      continue;
    }

    analyzed++;

    // Pass 2: analisi soddisfazione
    const satisfaction = await analyzeSatisfaction(anthropicKey, convText, contactName, classification);

    const channel = (conv.type || conv.channel || "").toLowerCase();
    results.push({
      contactName,
      channel: channel.includes("instagram") ? "Instagram" : "WhatsApp",
      treatment: classification.treatment_mentioned || "trattamento",
      daysSince: classification.days_since_treatment,
      satisfaction,
    });

    await upsertTracking(sbHeaders, {
      conversation_id: convId,
      contact_name: contactName,
      contact_id: conv.contactId || null,
      last_analyzed_message_id: lastMsg.id,
      last_analyzed_at: new Date().toISOString(),
      satisfaction_label: satisfaction.satisfaction || "neutrale",
    });
  }

  // 4. Costruisce e salva il report
  const now    = new Date();
  const report = buildReport(results, totalScanned, now);

  const satisfied   = results.filter(r => r.satisfaction.satisfaction === "soddisfatta").length;
  const unsatisfied = results.filter(r => r.satisfaction.satisfaction === "insoddisfatta").length;
  const neutral     = results.filter(r => r.satisfaction.satisfaction === "neutrale").length;

  await fetch(`${SUPABASE_URL}/rest/v1/post_treatment_reports`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      report_date: now.toISOString().split("T")[0],
      report_text: report,
      conversations_analyzed: totalScanned,
      post_treatment_found: results.length,
      satisfied_count: satisfied,
      unsatisfied_count: unsatisfied,
      neutral_count: neutral,
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

async function callClaude(apiKey, systemPrompt, userContent, maxTokens = 256) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const data = await res.json();
  const raw  = data.content?.[0]?.text || "{}";
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return {};
  }
}

async function classifyWithClaude(apiKey, convText) {
  return callClaude(
    apiKey,
    CLASSIFY_PROMPT,
    `Conversazione:\n\n${convText.slice(0, 3000)}`,
    128
  );
}

async function analyzeSatisfaction(apiKey, convText, contactName, classification) {
  const context = classification.treatment_mentioned
    ? `Trattamento: ${classification.treatment_mentioned}${classification.days_since_treatment ? `, circa ${classification.days_since_treatment} giorni fa` : ""}\n\n`
    : "";
  return callClaude(
    apiKey,
    SATISFACTION_PROMPT,
    `${context}Conversazione con ${contactName}:\n\n${convText.slice(0, 4000)}`,
    384
  );
}

async function upsertTracking(sbHeaders, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/post_treatment_tracking`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
}

function buildReport(results, totalScanned, now) {
  const dateStr = now.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

  if (!results.length) {
    return `💆 REPORT POST-TRATTAMENTI — ${dateStr}\n\nNessuna conversazione post-trattamento trovata negli ultimi 7 giorni (${totalScanned} chat scansionate).`;
  }

  const satisfied   = results.filter(r => r.satisfaction.satisfaction === "soddisfatta");
  const unsatisfied = results.filter(r => r.satisfaction.satisfaction === "insoddisfatta");
  const neutral     = results.filter(r => r.satisfaction.satisfaction === "neutrale");
  const total       = results.length;

  const pct = (n) => Math.round((n / total) * 100);

  const formatRow = (r) => {
    const s   = r.satisfaction;
    const dot = s.satisfaction === "soddisfatta" ? "🟢" : s.satisfaction === "insoddisfatta" ? "🔴" : "🟡";
    const risk = s.risk_level === "alto" ? " ⚠️ RISCHIO ALTO" : "";
    const treatment = r.treatment !== "trattamento" ? ` (${r.treatment})` : "";
    const days = r.daysSince ? ` — ${r.daysSince}gg fa` : "";
    const score = s.score ? ` ${s.score}/10` : "";
    let row = `${dot} ${r.contactName}${treatment}${days}${score}${risk}`;
    if (s.sintesi)         row += `\n   ${s.sintesi}`;
    if (s.complaints?.[0]) row += `\n   😟 ${s.complaints[0]}`;
    if (s.action_needed)   row += `\n   👉 ${s.action_needed}`;
    return row;
  };

  let report = `💆 REPORT POST-TRATTAMENTI\n${dateStr} · ore 8:05\n`;
  report += `Chat scansionate: ${totalScanned} · Post-trattamenti trovati: ${total}\n\n`;
  report += `📊 SODDISFAZIONE GENERALE\n`;
  report += `🟢 Soddisfatte: ${satisfied.length} (${pct(satisfied.length)}%)\n`;
  report += `🟡 Neutrali:    ${neutral.length} (${pct(neutral.length)}%)\n`;
  report += `🔴 Insoddisfatte: ${unsatisfied.length} (${pct(unsatisfied.length)}%)\n`;

  if (unsatisfied.length) {
    report += `\n🚨 DA GESTIRE SUBITO — Insoddisfatte (${unsatisfied.length})\n`;
    report += unsatisfied.map(formatRow).join("\n\n");
    report += "\n";
  }

  if (neutral.length) {
    report += `\n🟡 NEUTRALI — Follow-up consigliato (${neutral.length})\n`;
    report += neutral.map(formatRow).join("\n\n");
    report += "\n";
  }

  if (satisfied.length) {
    report += `\n🟢 SODDISFATTE (${satisfied.length})\n`;
    report += satisfied.map(formatRow).join("\n\n");
    report += "\n";
  }

  return report;
}

async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

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
