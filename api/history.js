export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: 'Storage non configurato (mancano UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)' });
  }

  const KEY = 'revisioni_history';

  async function redis(...args) {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
    const data = await r.json();
    return data.result;
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis('GET', KEY);
      const history = raw ? JSON.parse(raw) : [];
      return res.status(200).json({ history });
    }

    if (req.method === 'POST') {
      const { action, entry, id } = req.body;

      const raw = await redis('GET', KEY);
      let history = raw ? JSON.parse(raw) : [];

      if (action === 'add' && entry) {
        history.unshift(entry);
        if (history.length > 200) history.splice(200);
        await redis('SET', KEY, JSON.stringify(history));
        return res.status(200).json({ ok: true, history });
      }

      if (action === 'delete' && id !== undefined) {
        history = history.filter(e => e.id !== id);
        await redis('SET', KEY, JSON.stringify(history));
        return res.status(200).json({ ok: true, history });
      }

      return res.status(400).json({ error: 'Azione non valida' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
