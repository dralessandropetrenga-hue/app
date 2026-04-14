import pkg from 'pg';
const { Pool } = pkg;

// Usa POSTGRES_URL_NON_POOLING (dal connettore Supabase su Vercel)
// oppure POSTGRES_URL come fallback
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const INIT = `
  CREATE TABLE IF NOT EXISTS revisioni (
    id         BIGINT PRIMARY KEY,
    person     TEXT,
    date       TEXT,
    patient_name TEXT,
    avg_score  INTEGER,
    sintesi    TEXT,
    tipo       TEXT,
    result     JSONB
  );
`;

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = await pool.connect();
  try {
    // Crea la tabella se non esiste (prima chiamata)
    await db.query(INIT);

    /* GET — carica storico */
    if (req.method === 'GET') {
      const { rows } = await db.query(
        'SELECT * FROM revisioni ORDER BY id DESC LIMIT 200'
      );
      return res.status(200).json({ history: rows.map(toEntry) });
    }

    /* POST — aggiungi o elimina */
    if (req.method === 'POST') {
      const { action, entry, id } = req.body;

      if (action === 'add' && entry) {
        // Mantieni max 200 voci: elimina le più vecchie
        await db.query(`
          DELETE FROM revisioni
          WHERE id IN (
            SELECT id FROM revisioni ORDER BY id DESC OFFSET 199
          )
        `);
        await db.query(
          `INSERT INTO revisioni (id, person, date, patient_name, avg_score, sintesi, tipo, result)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [entry.id, entry.person, entry.date, entry.patientName,
           entry.avgScore, entry.sintesi, entry.tipo, JSON.stringify(entry.result)]
        );
        const { rows } = await db.query('SELECT * FROM revisioni ORDER BY id DESC LIMIT 200');
        return res.status(200).json({ ok: true, history: rows.map(toEntry) });
      }

      if (action === 'delete' && id !== undefined) {
        await db.query('DELETE FROM revisioni WHERE id = $1', [id]);
        const { rows } = await db.query('SELECT * FROM revisioni ORDER BY id DESC LIMIT 200');
        return res.status(200).json({ ok: true, history: rows.map(toEntry) });
      }

      return res.status(400).json({ error: 'Azione non valida' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('history error:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    db.release();
  }
}
