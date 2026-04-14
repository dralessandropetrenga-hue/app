const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function sbHeaders(extra = {}) {
  return {
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type':  'application/json',
    ...extra,
  };
}

async function getAll() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/revisioni?select=*&order=id.desc&limit=200`,
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${await res.text()}`);
  return res.json();
}

function toEntry(r) {
  return {
    id:          Number(r.id),
    person:      r.person,
    date:        r.date,
    patientName: r.patient_name,
    avgScore:    r.avg_score,
    sintesi:     r.sintesi,
    tipo:        r.tipo,
    segretaria:  r.result?.segretaria || '',
    result:      r.result,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('history: SUPABASE_URL o SUPABASE_ANON_KEY mancanti');
    return res.status(503).json({ error: 'Supabase non configurato' });
  }

  try {
    /* GET — carica storico */
    if (req.method === 'GET') {
      const rows = await getAll();
      return res.status(200).json({ history: rows.map(toEntry) });
    }

    /* POST — aggiungi o elimina */
    if (req.method === 'POST') {
      const { action, entry, id } = req.body;

      if (action === 'add' && entry) {
        // Inserisci (ignora duplicati)
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/revisioni`, {
          method:  'POST',
          headers: sbHeaders({ 'Prefer': 'resolution=ignore-duplicates,return=minimal' }),
          body:    JSON.stringify({
            id:           entry.id,
            person:       entry.person,
            date:         entry.date,
            patient_name: entry.patientName,
            avg_score:    entry.avgScore,
            sintesi:      entry.sintesi,
            tipo:         entry.tipo,
            result:       entry.result,
          }),
        });
        if (!ins.ok) throw new Error(`Insert ${ins.status}: ${await ins.text()}`);

        // Mantieni max 200: elimina i più vecchi
        const allRes = await fetch(
          `${SUPABASE_URL}/rest/v1/revisioni?select=id&order=id.desc&limit=1000`,
          { headers: sbHeaders() }
        );
        if (allRes.ok) {
          const all = await allRes.json();
          if (all.length > 200) {
            const toDelete = all.slice(200).map(r => r.id);
            await fetch(
              `${SUPABASE_URL}/rest/v1/revisioni?id=in.(${toDelete.join(',')})`,
              { method: 'DELETE', headers: sbHeaders() }
            );
          }
        }

        const rows = await getAll();
        return res.status(200).json({ ok: true, history: rows.map(toEntry) });
      }

      if (action === 'delete' && id !== undefined) {
        const del = await fetch(
          `${SUPABASE_URL}/rest/v1/revisioni?id=eq.${id}`,
          { method: 'DELETE', headers: sbHeaders() }
        );
        if (!del.ok) throw new Error(`Delete ${del.status}: ${await del.text()}`);
        const rows = await getAll();
        return res.status(200).json({ ok: true, history: rows.map(toEntry) });
      }

      return res.status(400).json({ error: 'Azione non valida' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('history error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
