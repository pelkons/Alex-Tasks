'use strict';
// Semantic search layer: multilingual-e5-small (ONNX, CPU) embeddings stored with sqlite-vec in the same database,
// built in the background from the keyword index, and merged with the keyword results by reciprocal rank fusion.
const path = require('path');
const { normDate } = require('./store');

const MODEL = process.env.MESIMOT_EMBED_MODEL || 'Xenova/multilingual-e5-small';
const DIM = 384;
const PART_WORDS = 200;
const RRF_K = 60;
const QSCALE = 640; // unit vectors: components never exceed ~0.19, so x * 640 fills int8 without clipping; the int8 L2 distance divided by 640 is the float L2 distance
const quant = (v) => Buffer.from(Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * QSCALE)))).buffer);

function createSemantic(db, { embedder, models = path.join(__dirname, '..', 'models') } = {}) {
  let vecOk = false;
  try { if (process.env.MESIMOT_SEMANTIC !== '0') { require('sqlite-vec').load(db); vecOk = true; } } catch { vecOk = false; }
  if (vecOk) {
    db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, part INTEGER NOT NULL, src_rowid INTEGER,
      project_id INTEGER, ts TEXT, person TEXT, title TEXT, snippet TEXT, UNIQUE (kind, ref_id, part));
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding float[${DIM}]);`);
    // vectors of ARCHIVE mail (lib/archive.js) carry archive = 1: the live indexer's housekeeping never touches them and search can include or exclude them
    require('./db').alterAdd(db, 'embeddings', 'archive', 'INTEGER NOT NULL DEFAULT 0');
    // ARCHIVE vectors live in their own table, quantized to int8 (1 byte per dimension instead of 4): a scan of 120,000 float vectors took 0.75 s on this server (and slowed every live search and every context gathering),
    // the int8 table answers in 0.05 s with ~95% of the float top-10 (measured on this server's own vectors), and the live table stays small and fast.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_archive USING vec0(embedding int8[${DIM}]);`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_emb_archive ON embeddings(archive) WHERE archive = 1');
  }

  // ---- model (lazy, one copy per process)
  let pipe = null, loading = null, loadError = null;
  const stats = { items_done: 0, ms_total: 0, started: null };
  async function load() {
    if (embedder) return embedder;
    if (pipe) return pipe;
    if (loadError) throw loadError;
    if (!loading) {
      loading = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = models;
        const ext = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
        pipe = async (texts) => (await ext(texts, { pooling: 'mean', normalize: true })).tolist();
        return pipe;
      })().catch((e) => { loadError = e; loading = null; throw e; });
    }
    return loading;
  }
  const embed = async (texts) => (await load())(texts);
  const buf = (v) => Buffer.from(new Float32Array(v).buffer);

  const words = (t) => String(t || '').split(/\s+/).filter(Boolean);
  function partsOf(title, body) {
    const w = words(body);
    const out = [];
    for (let i = 0; i < Math.max(w.length, 1); i += PART_WORDS) out.push(((i === 0 && title ? title + '\n' : '') + w.slice(i, i + PART_WORDS).join(' ')).trim());
    return out.filter(Boolean);
  }

  // ---- background indexing from search_index (which the triggers keep current)
  const pendingSql = `FROM search_index s LEFT JOIN embeddings e ON e.kind = s.kind AND e.ref_id = s.ref_id AND e.part = 0
    WHERE (e.id IS NULL OR e.src_rowid <> s.rowid)
      AND length(trim(COALESCE(s.title, '') || COALESCE(s.body, ''), ' ' || char(9) || char(10) || char(13))) > 0`; // rows with no text have nothing to embed: never retried
  const pendingCount = () => db.prepare(`SELECT COUNT(*) n ${pendingSql}`).get().n;

  async function indexBatch(limit = 8) {
    if (!vecOk) return 0;
    const rows = db.prepare(`SELECT s.rowid AS rid, s.kind, s.ref_id, s.title, s.body, s.project_id, s.ts, s.person ${pendingSql} LIMIT ?`).all(limit);
    if (!rows.length) return 0;
    const t0 = Date.now();
    const jobs = [];
    for (const r of rows) partsOf(r.title, r.body).forEach((text, part) => jobs.push({ r, part, text }));
    if (!stats.started) stats.started = Date.now();
    const vecs = jobs.length ? await embed(jobs.map((j) => 'passage: ' + j.text)) : [];
    // the "rows that no longer exist" scan is done OUTSIDE the write transaction (it used to take 5+ seconds inside it and made every other writer fail with "database is locked"), against an in-memory set,
    // and not on every batch
    let goneIds = [];
    if (Date.now() - (stats.goneAt || 0) > 5 * 60000) {
      stats.goneAt = Date.now();
      const live = new Set(db.prepare('SELECT kind, ref_id FROM search_index').all().map((x) => `${x.kind}|${x.ref_id}`));
      goneIds = db.prepare('SELECT id, kind, ref_id FROM embeddings WHERE part = 0 AND archive = 0').all().filter((e) => !live.has(`${e.kind}|${e.ref_id}`)).map((e) => e.id);
    }
    db.transaction(() => {
      for (const r of rows) {
        const old = db.prepare('SELECT id FROM embeddings WHERE kind=? AND ref_id=?').all(r.kind, r.ref_id);
        for (const o of old) db.prepare('DELETE FROM vec_items WHERE rowid=?').run(BigInt(o.id));
        db.prepare('DELETE FROM embeddings WHERE kind=? AND ref_id=?').run(r.kind, r.ref_id);
      }
      jobs.forEach((j, i) => {
        const id = db.prepare(`INSERT INTO embeddings (kind, ref_id, part, src_rowid, project_id, ts, person, title, snippet) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(j.r.kind, j.r.ref_id, j.part, j.r.rid, j.r.project_id, j.r.ts, j.r.person, j.r.title, words(j.r.body).slice(0, 40).join(' ')).lastInsertRowid;
        db.prepare('INSERT INTO vec_items (rowid, embedding) VALUES (?, ?)').run(BigInt(id), buf(vecs[i]));
      });
      // vectors of rows that no longer exist in the keyword index (found above, outside the transaction)
      for (const gid of goneIds) {
        const g = db.prepare('SELECT kind, ref_id FROM embeddings WHERE id=?').get(gid); if (!g) continue;
        for (const e of db.prepare('SELECT id FROM embeddings WHERE kind=? AND ref_id=?').all(g.kind, g.ref_id)) db.prepare('DELETE FROM vec_items WHERE rowid=?').run(BigInt(e.id));
        db.prepare('DELETE FROM embeddings WHERE kind=? AND ref_id=?').run(g.kind, g.ref_id);
      }
    })();
    stats.items_done += rows.length; stats.ms_total += Date.now() - t0;
    return rows.length;
  }

  // ARCHIVE vectors: the archive worker (lib/archive.js) hands over finished jobs [{kind, ref_id, part, title, text, project_id, ts, person}] and its own bookkeeping callback runs in the SAME short transaction,
  // so a crash can never leave a mail marked as embedded without its vectors. The text of a job is what is embedded (already cut to a few hundred words).
  async function embedJobs(jobs) {
    if (!vecOk || !jobs.length) return [];
    const vecs = await embed(jobs.map((j) => 'passage: ' + j.text));
    return jobs.map((j, i) => ({ ...j, vec: vecs[i] }));
  }
  function storeJobs(done, after = null) {
    db.transaction(() => {
      const delE = db.prepare('DELETE FROM embeddings WHERE kind=? AND ref_id=?'), delV = db.prepare('DELETE FROM vec_archive WHERE rowid=?'), selE = db.prepare('SELECT id FROM embeddings WHERE kind=? AND ref_id=? AND archive=1');
      const seen = new Set();
      for (const j of done) { const k = j.kind + '|' + j.ref_id; if (seen.has(k)) continue; seen.add(k); for (const o of selE.all(j.kind, j.ref_id)) delV.run(BigInt(o.id)); delE.run(j.kind, j.ref_id); }
      const ins = db.prepare('INSERT INTO embeddings (kind, ref_id, part, src_rowid, project_id, ts, person, title, snippet, archive) VALUES (?,?,?,?,?,?,?,?,?,1)'), insV = db.prepare('INSERT INTO vec_archive (rowid, embedding) VALUES (?, vec_int8(?))');
      for (const j of done) { const id = ins.run(j.kind, j.ref_id, j.part, null, j.project_id ?? null, j.ts ?? null, j.person ?? null, j.title ?? null, words(j.text).slice(0, 40).join(' ')).lastInsertRowid; insV.run(BigInt(id), quant(j.vec)); }
      if (after) after();
    })();
  }

  let timer = null;
  function startIndexer(intervalMs = 3000) {
    if (!vecOk || process.env.MESIMOT_SEMANTIC === '0' || timer) return;
    let busy = false;
    timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { while (await indexBatch(8)) { /* keep going until the queue is empty */ } } catch (e) { console.error('semantic indexing failed:', e.message); }
      busy = false;
    }, intervalMs);
    timer.unref?.();
  }
  const stop = () => { if (timer) clearInterval(timer); timer = null; };

  function status() {
    return {
      available: vecOk, model: MODEL, loaded: !!pipe || !!embedder, load_error: loadError ? String(loadError.message) : null,
      indexed_items: vecOk ? db.prepare('SELECT COUNT(*) n FROM embeddings WHERE part = 0 AND archive = 0').get().n : 0,
      vectors: vecOk ? db.prepare('SELECT COUNT(*) n FROM embeddings WHERE archive = 0').get().n : 0,
      archive_vectors: vecOk ? db.prepare('SELECT COUNT(*) n FROM embeddings WHERE archive = 1').get().n : 0,
      pending: vecOk ? pendingCount() : 0,
      items_per_second: stats.ms_total ? +(stats.items_done / (stats.ms_total / 1000)).toFixed(2) : null,
      rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    };
  }

  // ---- query
  async function semantic(f, k = 80) {
    if (!vecOk) return [];
    const [qv] = await embed(['query: ' + f.q]);
    // live vectors (float) and, unless excluded, archive vectors (int8, own table): merged by distance
    const arch = f.archive === 'exclude' || f.archive === 'only' ? f.archive : null;
    let near = [];
    if (arch !== 'only') near = db.prepare('SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = ? ORDER BY distance').all(buf(qv), k);
    if (arch !== 'exclude') {
      try { near = near.concat(db.prepare('SELECT rowid, distance FROM vec_archive WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance').all(quant(qv), arch === 'only' ? 200 : k).map((r) => ({ rowid: r.rowid, distance: r.distance / QSCALE }))); } catch { /* no archive table */ }
      near.sort((a, b) => a.distance - b.distance); near = near.slice(0, Math.max(k, 100));
    }
    if (!near.length) return [];
    const by = new Map(db.prepare(`SELECT * FROM embeddings WHERE id IN (${near.map(() => '?').join(',')})`).all(...near.map((n) => n.rowid)).map((e) => [e.id, e]));
    const kinds = f.kind ? String(f.kind).split(',').map((x) => x.trim()) : null;
    const from = f.from ? normDate(f.from) : null, to = f.to ? normDate(f.to) : null;
    const seen = new Set(), out = [];
    for (const n of near) {
      const e = by.get(Number(n.rowid));
      if (!e) continue;
      const key = `${e.kind}:${e.ref_id}`;
      if (seen.has(key)) continue; // best part of each item only
      if (arch === 'exclude' && e.archive) continue;
      if (arch === 'only' && !e.archive) continue;
      if (kinds && !kinds.includes(e.kind)) continue;
      if (f.projectId && e.project_id !== f.projectId) continue;
      if (f.person && !String(e.person || '').toLowerCase().includes(String(f.person).trim().toLowerCase())) continue;
      const d = String(e.ts || '').slice(0, 10);
      if (from && d < from) continue;
      if (to && d > to) continue;
      seen.add(key);
      out.push({ ...e, distance: n.distance });
    }
    return out;
  }

  // reciprocal rank fusion of ranked lists of results (each result has .key)
  function fuse(lists, limit) {
    const score = new Map(), first = new Map(), via = new Map();
    lists.forEach(({ name, items }) => items.forEach((it, i) => {
      score.set(it.key, (score.get(it.key) || 0) + 1 / (RRF_K + i + 1));
      if (!first.has(it.key) || name === 'keyword') first.set(it.key, it);
      via.set(it.key, new Set([...(via.get(it.key) || []), name]));
    }));
    return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, sc]) => ({ ...first.get(key), score: +sc.toFixed(5), via: [...via.get(key)].join('+') }));
  }

  return { indexBatch, embedJobs, storeJobs, startIndexer, stop, status, semantic, fuse, load, pendingCount, available: () => vecOk };
}

module.exports = { createSemantic, DIM };
