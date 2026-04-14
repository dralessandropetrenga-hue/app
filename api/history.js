export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(503).json({ error: 'Supabase non configurato (mancano SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
  }

  const BUCKET = 'app-storage';
  const FILE   = 'revisioni.json';
  const authHeader = { Authorization: `Bearer ${SUPABASE_KEY}` };

  /* ── Crea il bucket se non esiste ─────────────────────── */
  async function ensureBucket() {
    await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
    });
    // ignoriamo errore "already exists"
  }

  /* ── Leggi JSON dal file ──────────────────────────────── */
  async function readHistory() {
    const r = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${FILE}`,
      { headers: authHeader }
    );
    if (!r.ok) return [];
    return r.json();
  }

  /* ── Scrivi JSON nel file (upsert) ───────────────────── */
  async function writeHistory(data) {
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${FILE}`,
      {
        method: 'POST',
        headers: {
          ...authHeader,
          'Content-Type': 'application/json',
          'x-upsert': 'true',
        },
        body: JSON.stringify(data),
      }
    );
  }

  try {
    await ensureBucket();

    /* GET — carica storico */
    if (req.method === 'GET') {
      const history = await readHistory();
      return res.status(200).json({ history });
    }

    /* POST — aggiungi o elimina voce */
    if (req.method === 'POST') {
      const { action, entry, id } = req.body;
      let history = await readHistory();

      if (action === 'add' && entry) {
        history.unshift(entry);
        if (history.length > 200) history.splice(200);
        await writeHistory(history);
        return res.status(200).json({ ok: true, history });
      }

      if (action === 'delete' && id !== undefined) {
        history = history.filter(e => e.id !== id);
        await writeHistory(history);
        return res.status(200).json({ ok: true, history });
      }

      return res.status(400).json({ error: 'Azione non valida' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
