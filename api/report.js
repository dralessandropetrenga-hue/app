/**
 * api/report.js
 * Recupera l'ultimo report giornaliero da Supabase.
 * GET /api/report         → ultimo report
 * GET /api/report?run=1   → esegue l'agente adesso e restituisce il report
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY mancanti" }));
    return;
  }

  // Se ?run=1 viene chiesto di eseguire l'agente ora
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.searchParams.get("run") === "1") {
    const base = `https://${req.headers.host}`;
    const agentRes = await fetch(`${base}/api/morning-agent`, { method: "GET" });
    const agentData = await agentRes.json();
    res.writeHead(agentRes.status, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(agentData));
    return;
  }

  try {
    const sbRes = await fetch(
      `${supabaseUrl}/rest/v1/daily_reports?select=*&order=created_at.desc&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!sbRes.ok) throw new Error(`Supabase error: ${sbRes.status}`);
    const rows = await sbRes.json();

    if (!rows.length) {
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ report: null, message: "Nessun report ancora generato. Usa ?run=1 per eseguire l'agente ora." }));
      return;
    }

    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({
      report: rows[0].report_text,
      date: rows[0].report_date,
      conversations_analyzed: rows[0].conversations_analyzed,
      created_at: rows[0].created_at,
    }));
  } catch (err) {
    console.error("Errore report:", err);
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}
