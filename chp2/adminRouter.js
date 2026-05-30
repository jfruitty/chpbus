'use strict';
// express.Router หน้า admin แก้เงื่อนไขรวมสาย RMT (chp2)
// URL ทุกอันอิง req.baseUrl -> mount ที่ path ไหนก็ได้ (standalone '/' หรือ '/chp2/rules' ใน index.js)
// ใช้ express.urlencoded ของ app แม่ (index.js มีอยู่แล้ว / adminServer.js ใส่ให้)
const express = require('express');
const { pool } = require('./db');
const { planDate, commitPlan } = require('./pack');

const router = express.Router();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// today / tomorrow in BKK as YYYY-MM-DD — used as the default date in the dry-run picker
function bkkYmd(offsetDays = 0) {
  const t = Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
const HALF_OPTS = [['', 'ทั้งวัน'], ['before', 'ก่อน 14:30 (07:30/08:15/10:30)'], ['after', 'หลัง 14:30 (17:15/19:30/20:15)']];
function halfSelect(name, sel) {
  return `<select name="${name}">${HALF_OPTS.map(([v, l]) => `<option value="${v}"${v === (sel || '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function dryrunForm(base, defaultDate, half) {
  return `<form action="${esc(base)}/dryrun" method="get">วันที่ <input type="date" name="date" value="${esc(defaultDate)}" required>
    รอบ ${halfSelect('half', half)}
    <button>ลองจัดดู</button></form>`;
}
function layout(title, base, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — CHP rules</title>
<style>
 body{font-family:system-ui,'Segoe UI',sans-serif;margin:0;background:#f4f6f8;color:#1a2027}
 header{background:#0f4c81;color:#fff;padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
 header a{color:#fff;text-decoration:none;opacity:.9} header a:hover{opacity:1;text-decoration:underline}
 h1{font-size:18px;margin:0 16px 0 0}
 main{padding:16px;max-width:1100px;margin:0 auto}
 table{border-collapse:collapse;width:100%;background:#fff;margin:8px 0 20px}
 th,td{border:1px solid #dde3e8;padding:6px 8px;font-size:14px;text-align:left;vertical-align:middle}
 th{background:#eef2f5}
 input[type=number],input[type=text],select{padding:4px;border:1px solid #ccc;border-radius:4px}
 input[type=number]{width:70px}
 button{padding:5px 10px;border:0;border-radius:4px;background:#0f4c81;color:#fff;cursor:pointer}
 button.sec{background:#6b7b8a} button.danger{background:#b3261e}
 .card{background:#fff;border:1px solid #dde3e8;border-radius:8px;padding:12px 16px;margin-bottom:16px}
 .err{color:#b3261e} .warn{color:#9a6700} .ok{color:#1a7f37}
 .muted{color:#6b7b8a;font-size:13px} form.inline{display:inline}
 code{background:#eef2f5;padding:1px 4px;border-radius:3px}
</style></head><body>
<header><h1>CHP เงื่อนไขรวมสาย</h1>
 <a href="${base}/">หน้าหลัก</a><a href="${base}/routes">flag ราย route</a><a href="${base}/groups">กลุ่มรวม</a><a href="${base}/rules">กฎจุด/ทิศ</a><a href="${base}/dryrun">ลองจัดดู</a>
 <a href="/member" style="margin-left:auto">← กลับ Admin</a>
</header><main>${body}</main></body></html>`;
}
function mk(title, base, body) { return { title, base, bodyHtml: body }; }
const BOUND_LABEL = { inbound: 'ขาเข้า (ออกจากบ้าน)', outbound: 'ขาออก (ออกจากโรงงาน)' };
const boundOpts = (sel) => ['', 'inbound', 'outbound']
  .map(b => `<option value="${b}"${b === (sel ?? '') ? ' selected' : ''}>${b === '' ? '(ทั้งสองทิศ)' : BOUND_LABEL[b]}</option>`).join('');
const routeOpts = (routes, sel, blank) =>
  (blank ? `<option value="">(ไม่มี)</option>` : '') +
  routes.map(r => `<option value="${r.id}"${r.id === sel ? ' selected' : ''}>${esc(r.code)} — ${esc(r.name)}</option>`).join('');
const groupOpts = (groups, sel, blank) =>
  (blank ? `<option value="">(ไม่มี)</option>` : '') +
  groups.map(g => `<option value="${g.id}"${g.id === sel ? ' selected' : ''}>${esc(g.code)}</option>`).join('');
const slotOpts = (slots, sel) =>
  `<option value="">(ทุกเวลา)</option>` +
  slots.map(s => `<option value="${s.id}"${s.id === sel ? ' selected' : ''}>${esc(s.bound)} ${esc(s.depart_time)}</option>`).join('');

async function validate(db) {
  const issues = [];
  const add = (level, msg) => issues.push({ level, msg });
  const q = (sql) => db.query(sql).then(r => r.rows);
  for (const r of await q(`SELECT r.code FROM chp2.route r JOIN chp2.merge_group_member m ON m.route_id=r.id WHERE r.never_merge`))
    add('error', `สาย ${r.code} ตั้ง never_merge แต่ยังเป็นสมาชิกกลุ่มรวม`);
  for (const g of await q(`SELECT code FROM chp2.merge_group WHERE seat_cap <= 0`))
    add('error', `กลุ่ม ${g.code} มี seat_cap <= 0`);
  for (const g of await q(`SELECT code FROM chp2.merge_group WHERE result_route_id IS NULL`))
    add('warn', `กลุ่ม ${g.code} ยังไม่ได้ตั้ง result_route`);
  for (const g of await q(`SELECT g.code FROM chp2.merge_group g LEFT JOIN chp2.merge_group_member m ON m.group_id=g.id WHERE m.group_id IS NULL`))
    add('warn', `กลุ่ม ${g.code} ยังไม่มีสมาชิก`);
  for (const d of await q(`SELECT r.code FROM chp2.dispatch_rule d JOIN chp2.route r ON r.id=d.route_id WHERE d.solo_stop_from > d.solo_stop_to`))
    add('error', `กฎจุดของสาย ${d.code} มี ช่วงจุดเริ่ม > สิ้นสุด`);
  for (const r of await q(`SELECT code FROM chp2.route WHERE NOT never_merge AND min_solo_pax IS NULL
                            AND id NOT IN (SELECT route_id FROM chp2.merge_group_member)
                            AND id NOT IN (SELECT route_id FROM chp2.dispatch_rule)
                            AND id NOT IN (SELECT bus_route_id FROM chp2.route WHERE bus_route_id IS NOT NULL)
                            AND is_combined=false`))
    add('warn', `สาย ${r.code} ไม่มีทั้ง min_solo_pax / กลุ่มรวม / กฎจุด — engine จะ fallback วิ่งเดี่ยวเสมอ`);
  return issues;
}

// ---------- home ----------
// Simplified tool: the landing page is just the route/stop manager.
// (The advanced engine pages — groups / rules / dryrun — are kept below and are
//  still reachable by URL, but are no longer linked in the navigation.)
router.get('/', (req, res) => res.redirect(req.baseUrl + '/routes'));

// ---------- route flags (card layout, level-2 redesign) ----------
const PG_OPTS = (sel) => ['A', 'B'].map(g => `<option value="${g}"${g === sel ? ' selected' : ''}>${g}</option>`).join('');
function routeCard(r, base) {
  const stopList = r.stop_names
    ? esc(r.stop_names)
    : '<span class="muted">(ยังไม่มีจุด — กด "จัดการจุด" เพื่อเพิ่ม)</span>';

  // One compact card per route: edit code/name, see its stops, manage stops,
  // delete the route. No engine flags here (kept on the hidden /routes/:id form).
  return `<div class="rcard">
    <div class="rcard-head">
      <span class="code">${esc(r.code)}</span><span class="name">${esc(r.name)}</span>
      <div class="rcard-meta"><span class="chip">${r.stops} จุด</span></div>
    </div>
    <div class="field" style="margin:2px 0 8px">
      <span class="muted">จุดรับ-ส่ง (ตามลำดับ):</span> ${stopList}
    </div>
    <form class="rcard-form" action="${base}/routes/${r.id}/info" method="post">
      <div class="field">
        <label for="rc${r.id}">รหัส:</label>
        <input type="text" id="rc${r.id}" name="code" value="${esc(r.code)}" required style="width:120px">
        <label for="rn${r.id}">ชื่อสาย:</label>
        <input type="text" id="rn${r.id}" name="name" value="${esc(r.name)}" required>
      </div>
      <div class="rcard-actions">
        <button>บันทึกชื่อ</button>
        <a href="${base}/routes/${r.id}/stops" class="chip"
           style="background:#eaf2ff;color:#1d4ed8;text-decoration:none">📍 จัดการจุด</a>
      </div>
    </form></div>`;
}

function newRouteCard(base) {
  return `<div class="rcard">
    <div class="rcard-head"><span class="code">+</span><span class="name">เพิ่มสายใหม่</span></div>
    <form class="rcard-form" action="${base}/routes" method="post">
      <fieldset><legend>สายใหม่</legend>
        <div class="field"><label for="ncode">รหัส:</label>
          <input type="text" id="ncode" name="code" required placeholder="เช่น CHP17"></div>
        <div class="field"><label for="nname">ชื่อสาย:</label>
          <input type="text" id="nname" name="name" required placeholder="เช่น บางคล้า"></div>
        <div class="field" style="align-items:flex-start">
          <label for="nstops">จุดรับ-ส่ง:</label>
          <textarea id="nstops" name="stops" rows="5"
            placeholder="พิมพ์จุดละบรรทัด เรียงตามลำดับที่รถแวะ (จุดแรก = ขึ้นก่อน)&#10;เช่น&#10;ตลาดบางคล้า&#10;วัดโพธิ์&#10;หน้าโรงเรียน"
            style="width:280px;padding:6px;border:1px solid #ccc;border-radius:4px;font-family:inherit"></textarea>
          <span class="hint">หนึ่งจุดต่อหนึ่งบรรทัด — เว้นว่างไว้ก่อนก็ได้ ค่อยเพิ่มทีหลังในหน้า "จัดการจุด"</span>
        </div>
      </fieldset>
      <div class="rcard-actions"><button>สร้างสาย</button></div>
    </form></div>`;
}

const ROUTE_ERR = {
  inuse: '⚠️ ลบสายไม่ได้ — มีพนักงานหรือการจองใช้จุดของสายนี้อยู่ ต้องย้ายคนออกจากจุดก่อน',
  ref: '⚠️ ลบสายไม่ได้ — สายนี้ถูกอ้างอิงในกลุ่มรวม/กฎจัดรถ (ตั้งค่าขั้นสูง)',
};
router.get('/routes', async (req, res, next) => {
  try {
    const base = req.baseUrl;
    // Only manually-managed routes; combined (engine-generated) routes are hidden.
    const routes = (await pool.query(`
      SELECT r.id, r.code, r.name,
             (SELECT count(*) FROM chp2.route_stop WHERE route_id = r.id) AS stops,
             (SELECT string_agg(name, ' › ' ORDER BY seq NULLS LAST, id)
                FROM chp2.route_stop WHERE route_id = r.id) AS stop_names
      FROM chp2.route r
      WHERE NOT r.is_combined
      ORDER BY r.code`)).rows;

    const errMsg = ROUTE_ERR[req.query.err];
    let body = errMsg ? `<div class="card err">${esc(errMsg)}</div>` : '';
    body += `<p class="muted">เพิ่ม/ลบสาย และกำหนดว่าจุดรับ-ส่งไหนเป็นของสายไหน. ตอนเพิ่มสายใหม่พิมพ์รายชื่อจุดได้เลย (จุดละบรรทัด)</p>`;
    body += routes.map(r => routeCard(r, base)).join('') || '<p class="warn">(ยังไม่มีสาย)</p>';
    body += `<div class="pg-head">เพิ่มสายใหม่</div>` + newRouteCard(base);

    res.render('chp2rules', mk('จัดการสายและจุด', base, body));
  } catch (e) { next(e); }
});
// POST /routes — create a route (always is_combined=false) plus its stops.
// Engine fields (pack_group / seat_capacity) get sensible defaults; tune them
// later via the hidden advanced form if ever needed.
router.post('/routes', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body;
    if (!b.code || !b.name) { res.redirect(req.baseUrl + '/routes'); return; }
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO chp2.route (code, name, pack_group, seat_capacity, is_combined)
       VALUES ($1, $2, 'A', 13, false) RETURNING id`,
      [b.code.trim(), b.name.trim()]);
    const routeId = ins.rows[0].id;
    const stops = String(b.stops || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < stops.length; i++) {
      await client.query(
        `INSERT INTO chp2.route_stop (route_id, seq, name) VALUES ($1, $2, $3)`,
        [routeId, i + 1, stops[i]]);
    }
    await client.query('COMMIT');
    res.redirect(req.baseUrl + '/routes');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});
// POST /routes/:id — update flags (existing handler)
router.post('/routes/:id', async (req, res, next) => {
  try {
    const b = req.body, num = (v) => (v === '' || v == null) ? null : Number(v);
    await pool.query(
      `UPDATE chp2.route SET never_merge=$1, min_solo_pax=$2, bus_threshold=$3, bus_route_id=$4, seat_capacity=COALESCE($5,seat_capacity) WHERE id=$6`,
      [b.never_merge === 'on', num(b.min_solo_pax), num(b.bus_threshold), num(b.bus_route_id), num(b.seat_capacity), req.params.id]);
    res.redirect(req.baseUrl + '/routes');
  } catch (e) { next(e); }
});
// POST /routes/:id/info — rename a route (code/name only; pack_group and other
// engine flags are left untouched). Skips combined routes.
router.post('/routes/:id/info', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.code || !b.name) return res.redirect(req.baseUrl + '/routes');
    await pool.query(
      `UPDATE chp2.route SET code=$1, name=$2 WHERE id=$3 AND NOT is_combined`,
      [b.code.trim(), b.name.trim(), req.params.id]);
    res.redirect(req.baseUrl + '/routes');
  } catch (e) { next(e); }
});
// POST /routes/:id/delete — remove a (non-combined) route and all its stops.
// Refused if any of its stops is still referenced by an employee/booking, or if
// the route itself is referenced by engine config (merge group / dispatch rule).
router.post('/routes/:id/delete', async (req, res, next) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    const inUse = (await client.query(
      `SELECT count(*)::int AS n FROM chp2.route_stop s
       WHERE s.route_id=$1 AND (
         EXISTS (SELECT 1 FROM chp2.employee e WHERE e.home_stop_id = s.id) OR
         EXISTS (SELECT 1 FROM chp2.booking  b WHERE b.pickup_stop_id = s.id))`, [id])).rows[0].n;
    if (inUse > 0) { res.redirect(req.baseUrl + '/routes?err=inuse'); return; }

    await client.query('BEGIN');
    await client.query(`DELETE FROM chp2.route_stop WHERE route_id=$1`, [id]);
    await client.query(`DELETE FROM chp2.route WHERE id=$1 AND NOT is_combined`, [id]);
    await client.query('COMMIT');
    res.redirect(req.baseUrl + '/routes');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23503') return res.redirect(req.baseUrl + '/routes?err=ref'); // FK = referenced by engine config
    next(e);
  } finally {
    client.release();
  }
});

// ---------- route stops (per-route sub-page) ----------
router.get('/routes/:id/stops', async (req, res, next) => {
  try {
    const base = req.baseUrl, id = Number(req.params.id);
    const route = (await pool.query(`SELECT id, code, name, is_combined FROM chp2.route WHERE id=$1`, [id])).rows[0];
    if (!route) return res.status(404).send('route not found');
    const stops = (await pool.query(`
      SELECT s.id, s.seq, s.name,
        (SELECT count(*) FROM chp2.employee e WHERE e.home_stop_id = s.id) AS employees,
        (SELECT count(*) FROM chp2.booking b WHERE b.pickup_stop_id = s.id) AS bookings
      FROM chp2.route_stop s WHERE s.route_id=$1 ORDER BY s.seq NULLS LAST, s.id`, [id])).rows;
    const nextSeq = (stops.reduce((m, s) => Math.max(m, s.seq || 0), 0) || 0) + 1;
    const rows = stops.map(s => {
      const usedChip = Number(s.employees) > 0 || Number(s.bookings) > 0
        ? `<span class="chip">${s.employees} พนักงาน · ${s.bookings} จอง</span>` : '';
      const inUse = Number(s.employees) > 0 || Number(s.bookings) > 0;
      const delBtn = inUse
        ? `<button type="submit" class="danger" disabled title="ลบไม่ได้ — มีพนักงาน/การจองใช้จุดนี้อยู่">ลบไม่ได้</button>`
        : `<button type="submit" class="danger" formaction="${base}/routes/${id}/stops/${s.id}/delete" onclick="return confirm('ลบจุด ${esc(s.name).replace(/'/g, "\\'")}?')">ลบ</button>`;
      return `<div class="rcard" style="padding:10px 14px">
        <form class="rcard-form" action="${base}/routes/${id}/stops/${s.id}" method="post" style="gap:6px">
          <div class="rcard-head" style="margin:0">
            <span class="code">[${String(s.seq ?? '?').padStart(2, '0')}]</span>
            <span class="name">${esc(s.name)}</span>
            <div class="rcard-meta">${usedChip}</div>
          </div>
          <div class="field">
            <label>ลำดับ:</label><input type="number" name="seq" value="${s.seq ?? ''}" min="1" style="width:60px">
            <label>ชื่อจุด:</label><input type="text" name="name" value="${esc(s.name)}" required>
            <button>บันทึก</button>
            ${delBtn}
          </div>
        </form></div>`;
    }).join('') || '<p class="warn">(ยังไม่มีจุดในสายนี้)</p>';

    const body = `
      <p class="muted"><a href="${base}/routes">← กลับหน้า routes</a></p>
      <div class="rcard">
        <div class="rcard-head">
          <span class="code">${esc(route.code)}</span><span class="name">${esc(route.name)}</span>
          <div class="rcard-meta"><span class="chip">${stops.length} จุด</span></div>
        </div>
        <p class="muted" style="margin:6px 0 0">ลำดับจุด = ลำดับที่รถมาแวะ (จุด 1 = ไกลสุด/ขึ้นก่อน). จุดที่มีพนักงาน/การจองใช้อยู่จะลบไม่ได้ — ต้องย้ายคนออกจากจุดนั้นก่อน</p>
      </div>
      ${rows}
      <div class="rcard">
        <div class="rcard-head"><span class="code">+</span><span class="name">เพิ่มจุดใหม่</span></div>
        <form class="rcard-form" action="${base}/routes/${id}/stops" method="post">
          <fieldset><legend>จุดใหม่</legend>
            <div class="field"><label for="nsseq">ลำดับ:</label>
              <input type="number" id="nsseq" name="seq" value="${nextSeq}" min="1"></div>
            <div class="field"><label for="nsname">ชื่อจุด:</label>
              <input type="text" id="nsname" name="name" required placeholder="เช่น บ้านคุณ..."></div>
          </fieldset>
          <div class="rcard-actions"><button>เพิ่มจุด</button></div>
        </form>
      </div>`;
    res.render('chp2rules', mk(`จุดของ ${route.code}`, base, body));
  } catch (e) { next(e); }
});
router.post('/routes/:id/stops', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name) return res.redirect(`${req.baseUrl}/routes/${req.params.id}/stops`);
    await pool.query(
      `INSERT INTO chp2.route_stop (route_id, seq, name) VALUES ($1, $2, $3)`,
      [req.params.id, b.seq === '' ? null : Number(b.seq), b.name.trim()]);
    res.redirect(`${req.baseUrl}/routes/${req.params.id}/stops`);
  } catch (e) { next(e); }
});
router.post('/routes/:id/stops/:stopId', async (req, res, next) => {
  try {
    const b = req.body;
    await pool.query(
      `UPDATE chp2.route_stop SET seq=$1, name=$2 WHERE id=$3 AND route_id=$4`,
      [b.seq === '' ? null : Number(b.seq), b.name.trim(),
       req.params.stopId, req.params.id]);
    res.redirect(`${req.baseUrl}/routes/${req.params.id}/stops`);
  } catch (e) { next(e); }
});
router.post('/routes/:id/stops/:stopId/delete', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM chp2.route_stop WHERE id=$1 AND route_id=$2`,
      [req.params.stopId, req.params.id]);
    res.redirect(`${req.baseUrl}/routes/${req.params.id}/stops`);
  } catch (e) {
    // FK violation = stop is in use; redirect with a flag the user can read
    if (e.code === '23503') return res.redirect(`${req.baseUrl}/routes/${req.params.id}/stops`);
    next(e);
  }
});

// ---------- merge groups (polished labels + member chips) ----------
router.get('/groups', async (req, res, next) => {
  try {
    const base = req.baseUrl;
    const routes = (await pool.query(`SELECT id, code, name FROM chp2.route ORDER BY code`)).rows;
    const slots = (await pool.query(`SELECT id, bound, to_char(depart_time,'HH24:MI') depart_time FROM chp2.time_slot ORDER BY slot_index`)).rows;
    const groups = (await pool.query(`SELECT * FROM chp2.merge_group ORDER BY priority`)).rows;
    const members = (await pool.query(`SELECT m.group_id, m.route_id, r.code FROM chp2.merge_group_member m JOIN chp2.route r ON r.id=m.route_id ORDER BY m.member_order`)).rows;
    const memByG = new Map();
    for (const m of members) (memByG.get(m.group_id) || memByG.set(m.group_id, []).get(m.group_id)).push(m);
    const cards = groups.map(g => {
      const mem = memByG.get(g.id) || [];
      const memHtml = mem.length
        ? mem.map(m => `<span class="mchip">${esc(m.code)}
            <form action="${base}/groups/${g.id}/members/${m.route_id}/delete" method="post"><button title="ลบสายนี้ออกจากกลุ่ม">×</button></form>
          </span>`).join('')
        : '<span class="mchip-empty">(ยังไม่มีสมาชิก)</span>';
      const chips = [];
      if (!g.is_active) chips.push(`<span class="chip warn">ปิดใช้งาน</span>`);
      if (g.dispatch_only) chips.push(`<span class="chip">dispatch-only</span>`);
      if (g.only_slot_id) {
        const sl = slots.find(s => s.id === g.only_slot_id);
        if (sl) chips.push(`<span class="chip">เฉพาะ ${esc(BOUND_LABEL[sl.bound] || sl.bound)} ${esc(sl.depart_time)}</span>`);
      }
      return `<div class="rcard">
        <div class="rcard-head">
          <span class="code">${esc(g.code)}</span><span class="name">${esc(g.name || '')}</span>
          <div class="rcard-meta">${chips.join('')}</div>
        </div>
        <div class="field" style="margin:4px 0 10px">สมาชิก: ${memHtml}
          <form action="${base}/groups/${g.id}/members" method="post" style="margin-left:6px">
            <select name="route_id">${routeOpts(routes, null, false)}</select>
            <button class="sec">+ เพิ่มสาย</button>
          </form>
        </div>
        <form class="rcard-form" action="${base}/groups/${g.id}" method="post">
          <fieldset><legend>การตั้งค่า</legend>
            <div class="field"><label for="gn${g.id}">ชื่อกลุ่ม:</label>
              <input type="text" id="gn${g.id}" name="name" value="${esc(g.name || '')}" placeholder="เช่น รวม CHP01+02+03+04"></div>
            <div class="field"><label for="gc${g.id}">ที่นั่งต่อคัน:</label>
              <input type="number" id="gc${g.id}" name="seat_cap" value="${g.seat_cap}" min="1">
              <span class="hint">(รถตู้รวม 13)</span></div>
            <div class="field"><label for="gp${g.id}">ลำดับความสำคัญ (priority):</label>
              <input type="number" id="gp${g.id}" name="priority" value="${g.priority}">
              <span class="hint">เลขน้อย = ลองรวมกลุ่มนี้ก่อน</span></div>
            <div class="field"><label for="gr${g.id}">สายผลลัพธ์ (ชื่อรถรวม):</label>
              <select id="gr${g.id}" name="result_route_id">${routeOpts(routes, g.result_route_id, true)}</select></div>
            <div class="field"><label for="go${g.id}">เปิดใช้เฉพาะรอบ:</label>
              <select id="go${g.id}" name="only_slot_id">${slotOpts(slots, g.only_slot_id)}</select>
              <span class="hint">(ปล่อย "ทุกเวลา" ถ้าใช้ได้ทุกรอบ)</span></div>
            <div class="field">
              <input type="checkbox" id="gd${g.id}" name="dispatch_only" ${g.dispatch_only ? 'checked' : ''}>
              <label for="gd${g.id}">dispatch-only — เฉพาะตอนจัดรถ (ไม่นับเป็นกลุ่มสำหรับกฎจุด)</label></div>
            <div class="field">
              <input type="checkbox" id="ga${g.id}" name="is_active" ${g.is_active ? 'checked' : ''}>
              <label for="ga${g.id}">เปิดใช้งานกลุ่มนี้</label></div>
          </fieldset>
          <div class="rcard-actions">
            <button>บันทึก</button>
            <button type="submit" class="danger" formaction="${base}/groups/${g.id}/delete"
              onclick="return confirm('ลบกลุ่ม ${esc(g.code)} ?')">ลบกลุ่ม</button>
          </div>
        </form></div>`;
    }).join('');
    res.render('chp2rules', mk('กลุ่มรวม', base, `
      <p class="muted">แต่ละกลุ่ม = หนึ่งคันรถตู้รวมหลายสายเข้าด้วยกัน. เลือกสมาชิกที่จะรวมเข้ามา และสายผลลัพธ์ (รถที่ผู้โดยสารจะเห็น). สร้างกลุ่มใหม่ที่การ์ดท้ายสุด</p>
      ${cards}
      <div class="rcard">
        <div class="rcard-head"><span class="code">+</span><span class="name">สร้างกลุ่มใหม่</span></div>
        <form class="rcard-form" action="${base}/groups" method="post">
          <fieldset><legend>กลุ่มใหม่</legend>
            <div class="field"><label for="ngc">รหัสกลุ่ม (สั้น):</label>
              <input type="text" id="ngc" name="code" required placeholder="เช่น H, 11+12"></div>
            <div class="field"><label for="ngn">ชื่อกลุ่ม:</label>
              <input type="text" id="ngn" name="name" placeholder="เช่น รวม CHP11+CHP12"></div>
            <div class="field"><label for="ngcap">ที่นั่งต่อคัน:</label>
              <input type="number" id="ngcap" name="seat_cap" value="13" min="1"></div>
            <div class="field"><label for="ngp">priority:</label>
              <input type="number" id="ngp" name="priority" value="20"></div>
            <div class="field"><label for="ngr">สายผลลัพธ์:</label>
              <select id="ngr" name="result_route_id">${routeOpts(routes, null, true)}</select></div>
          </fieldset>
          <div class="rcard-actions"><button>สร้าง</button></div>
        </form></div>`));
  } catch (e) { next(e); }
});
router.post('/groups', async (req, res, next) => {
  try {
    const b = req.body, num = (v) => v === '' ? null : Number(v);
    await pool.query(`INSERT INTO chp2.merge_group (code,name,seat_cap,priority,result_route_id) VALUES ($1,$2,$3,$4,$5)`,
      [b.code, b.name || null, Number(b.seat_cap) || 13, Number(b.priority) || 20, num(b.result_route_id)]);
    res.redirect(req.baseUrl + '/groups');
  } catch (e) { next(e); }
});
router.post('/groups/:id', async (req, res, next) => {
  try {
    const b = req.body, num = (v) => v === '' ? null : Number(v);
    await pool.query(`UPDATE chp2.merge_group SET name=$1, seat_cap=$2, priority=$3, result_route_id=$4, only_slot_id=$5, dispatch_only=$6, is_active=$7 WHERE id=$8`,
      [b.name || null, Number(b.seat_cap), Number(b.priority), num(b.result_route_id), num(b.only_slot_id), b.dispatch_only === 'on', b.is_active === 'on', req.params.id]);
    res.redirect(req.baseUrl + '/groups');
  } catch (e) { next(e); }
});
router.post('/groups/:id/delete', async (req, res, next) => {
  try { await pool.query(`DELETE FROM chp2.merge_group WHERE id=$1`, [req.params.id]); res.redirect(req.baseUrl + '/groups'); }
  catch (e) { next(e); }
});
router.post('/groups/:id/members', async (req, res, next) => {
  try {
    await pool.query(`INSERT INTO chp2.merge_group_member (group_id,route_id,member_order)
       VALUES ($1,$2,(SELECT COALESCE(MAX(member_order),0)+1 FROM chp2.merge_group_member WHERE group_id=$1))
       ON CONFLICT DO NOTHING`, [req.params.id, req.body.route_id]);
    res.redirect(req.baseUrl + '/groups');
  } catch (e) { next(e); }
});
router.post('/groups/:id/members/:routeId/delete', async (req, res, next) => {
  try { await pool.query(`DELETE FROM chp2.merge_group_member WHERE group_id=$1 AND route_id=$2`, [req.params.id, req.params.routeId]); res.redirect(req.baseUrl + '/groups'); }
  catch (e) { next(e); }
});

// ---------- dispatch rules (polished labels) ----------
router.get('/rules', async (req, res, next) => {
  try {
    const base = req.baseUrl;
    const routes = (await pool.query(`SELECT id, code, name FROM chp2.route WHERE NOT is_combined ORDER BY code`)).rows;
    const groups = (await pool.query(`SELECT id, code FROM chp2.merge_group ORDER BY priority`)).rows;
    const rules = (await pool.query(`SELECT d.*, r.code AS route_code, r.name AS route_name
      FROM chp2.dispatch_rule d JOIN chp2.route r ON r.id=d.route_id ORDER BY d.priority`)).rows;
    const cards = rules.map(d => `<div class="rcard">
      <div class="rcard-head">
        <span class="code">${esc(d.route_code)}</span><span class="name">${esc(d.route_name || '')}</span>
        <div class="rcard-meta">
          <span class="chip">priority ${d.priority}</span>
          <span class="chip">${esc(d.bound ? BOUND_LABEL[d.bound] : 'ทั้งสองทิศ')}</span>
          ${d.solo_stop_from != null ? `<span class="chip ok">solo ถ้ามีคน stop ${d.solo_stop_from}${d.solo_stop_to != null && d.solo_stop_to !== d.solo_stop_from ? `–${d.solo_stop_to}` : ''}</span>` : ''}
        </div>
      </div>
      <form class="rcard-form" action="${base}/rules/${d.id}" method="post">
        <fieldset><legend>เงื่อนไข</legend>
          <div class="field"><label for="rp${d.id}">priority:</label>
            <input type="number" id="rp${d.id}" name="priority" value="${d.priority}">
            <span class="hint">เลขน้อย = ลองกฎนี้ก่อน</span></div>
          <div class="field"><label for="rr${d.id}">สาย:</label>
            <select id="rr${d.id}" name="route_id">${routeOpts(routes, d.route_id, false)}</select></div>
          <div class="field"><label for="rb${d.id}">ใช้กับทิศ:</label>
            <select id="rb${d.id}" name="bound">${boundOpts(d.bound)}</select></div>
          <div class="field"><label>ช่วงจุดต้นทาง (มีคน stop ในช่วงนี้ → วิ่งเดี่ยว):</label>
            จุด <input type="number" name="solo_stop_from" value="${d.solo_stop_from ?? ''}" min="1">
            – <input type="number" name="solo_stop_to" value="${d.solo_stop_to ?? ''}" min="1"></div>
        </fieldset>
        <fieldset><legend>ถ้าไม่เข้าเงื่อนไข → ยุบเข้ากลุ่ม</legend>
          <div class="field"><label for="re${d.id}">กลุ่มหลัก:</label>
            <select id="re${d.id}" name="else_group_id">${groupOpts(groups, d.else_group_id, true)}</select></div>
          <div class="field"><label for="ra${d.id}">หรือกลุ่มสำรอง:</label>
            <select id="ra${d.id}" name="else_group_alt_id">${groupOpts(groups, d.else_group_alt_id, true)}</select>
            <span class="hint">(ถ้ากลุ่มหลักเต็มแล้ว ใช้กลุ่มนี้แทน)</span></div>
        </fieldset>
        <div class="rcard-actions">
          <button>บันทึก</button>
          <button type="submit" class="danger" formaction="${base}/rules/${d.id}/delete"
            onclick="return confirm('ลบกฎนี้?')">ลบ</button>
        </div>
      </form></div>`).join('');
    res.render('chp2rules', mk('กฎจุด/ทิศ', base, `
      <p class="muted">แต่ละกฎเชื่อมกับสายหนึ่งสาย: ถ้ามีผู้โดยสารอยู่ในช่วงจุดต้นทางที่ระบุ → สายนั้นวิ่งเดี่ยวออกรถตู้สายตัวเอง ถ้าไม่มี → ยุบรวมตามกลุ่มที่เลือก (เลือกกลุ่มสำรองไว้ได้ เผื่อกลุ่มหลักเต็ม)</p>
      ${cards}
      <div class="rcard">
        <div class="rcard-head"><span class="code">+</span><span class="name">เพิ่มกฎใหม่</span></div>
        <form class="rcard-form" action="${base}/rules" method="post">
          <fieldset><legend>เงื่อนไข</legend>
            <div class="field"><label for="np">priority:</label>
              <input type="number" id="np" name="priority" value="9"></div>
            <div class="field"><label for="nr">สาย:</label>
              <select id="nr" name="route_id">${routeOpts(routes, null, false)}</select></div>
            <div class="field"><label for="nb">ใช้กับทิศ:</label>
              <select id="nb" name="bound">${boundOpts('')}</select></div>
            <div class="field"><label>ช่วงจุดต้นทาง (มีคนช่วงนี้ → วิ่งเดี่ยว):</label>
              จุด <input type="number" name="solo_stop_from" value="1" min="1">
              – <input type="number" name="solo_stop_to" value="1" min="1"></div>
          </fieldset>
          <fieldset><legend>ถ้าไม่เข้าเงื่อนไข → ยุบเข้ากลุ่ม</legend>
            <div class="field"><label for="neg">กลุ่ม:</label>
              <select id="neg" name="else_group_id">${groupOpts(groups, null, true)}</select></div>
          </fieldset>
          <div class="rcard-actions"><button>เพิ่ม</button></div>
        </form></div>`));
  } catch (e) { next(e); }
});
const ruleParams = (b) => {
  const num = (v) => v === '' || v == null ? null : Number(v);
  return [Number(b.priority) || 0, Number(b.route_id), b.bound || null, num(b.solo_stop_from), num(b.solo_stop_to), num(b.else_group_id), num(b.else_group_alt_id)];
};
router.post('/rules', async (req, res, next) => {
  try {
    await pool.query(`INSERT INTO chp2.dispatch_rule (priority,route_id,bound,solo_stop_from,solo_stop_to,else_group_id,else_group_alt_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, ruleParams(req.body));
    res.redirect(req.baseUrl + '/rules');
  } catch (e) { next(e); }
});
router.post('/rules/:id', async (req, res, next) => {
  try {
    const p = ruleParams(req.body); p.push(req.params.id);
    await pool.query(`UPDATE chp2.dispatch_rule SET priority=$1,route_id=$2,bound=$3,solo_stop_from=$4,solo_stop_to=$5,else_group_id=$6,else_group_alt_id=$7 WHERE id=$8`, p);
    res.redirect(req.baseUrl + '/rules');
  } catch (e) { next(e); }
});
router.post('/rules/:id/delete', async (req, res, next) => {
  try { await pool.query(`DELETE FROM chp2.dispatch_rule WHERE id=$1`, [req.params.id]); res.redirect(req.baseUrl + '/rules'); }
  catch (e) { next(e); }
});

// ---------- dry-run + commit ----------
// นับ booking ใน chp2.booking ของสัปดาห์ + วันนั้น เพื่อบอก user ตอนที่ plan ว่าง
// with_ride = นับเฉพาะที่มี booking_ride วันนั้น (ทุก approval status)
async function weekDiagnostics(db, weekOf, dow) {
  const r = await db.query(`SELECT b.dept_approval,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chp2.booking_ride br WHERE br.booking_id=b.id AND br.day_of_week=$2)) AS with_ride,
       count(*) AS total
     FROM chp2.booking b WHERE b.week_of=$1 GROUP BY b.dept_approval`, [weekOf, dow]);
  const out = { approved: 0, pending: 0, rejected: 0, withRide: 0 };
  for (const x of r.rows) {
    if (x.dept_approval in out) out[x.dept_approval] = Number(x.total);
    out.withRide += Number(x.with_ride);
  }
  return out;
}
const BOUND_TH = { inbound: 'ขาเข้า', outbound: 'ขาออก' };
function renderPlan(base, date, weekOf, dow, plan, committed, diag, half) {
  const bySlot = new Map();
  for (const b of plan) {
    const k = `${BOUND_TH[b.bound] || b.bound} ${b.depart_time}`;
    (bySlot.get(k) || bySlot.set(k, []).get(k)).push(b);
  }
  const tag = (k) => k === 'merge' ? '🔗 รวม' : k === 'bus' ? '🚌 บัส' : k === 'solo-fallback' ? 'เดี่ยว*' : 'เดี่ยว';
  let body = committed ? `<div class="card ok">✅ บันทึกแผนวันที่ ${esc(date)} ลง chp2 (stage system) แล้ว</div>` : '';
  const halfLabel = half === 'before' ? 'ก่อน 14:30' : half === 'after' ? 'หลัง 14:30' : 'ทั้งวัน';
  body += `<div class="card">${dryrunForm(base, date, half)}
    <p class="muted" style="margin:8px 0 0">week_of=<code>${esc(weekOf)}</code>, day-of-week=${dow}, รอบ=<b>${esc(halfLabel)}</b>
    ${diag ? ` — booking สัปดาห์นี้: <b class="ok">${diag.approved}</b> approved · <span class="warn">${diag.pending}</span> pending · ${diag.rejected} rejected (มี ride วันนี้รวม: ${diag.withRide})` : ''}
    <br><span class="muted">ℹ️ Dry-run นับทุกการจองที่มี ride วันนี้ (ไม่สนใจสถานะ approve) — commit ก็จะเขียนตามนี้</span></p></div>`;
  body += `<div class="card">จัดวันที่ <b>${esc(date)}</b> (${esc(halfLabel)}) — <b>${plan.length}</b> คัน
    ${plan.length ? `<form method="post" action="${base}/commit" style="margin-top:8px">
       <input type="hidden" name="date" value="${esc(date)}"><input type="hidden" name="half" value="${esc(half || '')}"><button>💾 บันทึกแผนนี้ลง chp2 (stage system)</button></form>` : ''}</div>`;
  if (!plan.length) {
    body += `<p class="warn">ไม่มีคนตั้ง ride วันที่ ${dow} ของ week_of ${esc(weekOf)}`;
    if (diag && diag.approved + diag.pending + diag.rejected === 0)
      body += ` — สัปดาห์นี้ยังไม่มีจองเลย ลองเลือกวันที่ของสัปดาห์อื่น`;
    body += `</p>`;
  }
  for (const [slot, buses] of bySlot) {
    body += `<h3>${esc(slot)}</h3>`;
    for (const b of buses) {
      const routeLabel = `<code>${esc(b.route_code)}</code> ${esc(b.route_name)}`;
      body += `<details open class="bus-block" style="background:#fff;border:1px solid #dde3e8;border-radius:6px;padding:8px 12px;margin:0 0 8px">
        <summary style="cursor:pointer;list-style:revert"><b>${routeLabel}</b> — ${tag(b.kind)} · คันที่ ${b.bus_number} · <b>${b.seats.length}</b>/${b.capacity} ที่</summary>
        <table style="margin:8px 0 0"><tr><th style="width:60px">ที่นั่ง</th><th>จุดขึ้น</th><th style="width:110px">รหัสพนักงาน</th><th>ชื่อ-นามสกุล</th></tr>`;
      for (const s of b.seats) {
        const p = s.pax;
        const stopSeq = p.stop_seq != null ? `[${String(p.stop_seq).padStart(2, '0')}] ` : '';
        const homeRouteTag = p.home_route_name && p.home_route_name !== b.route_name
          ? ` <span class="muted">(${esc(p.home_route_name)})</span>` : '';
        body += `<tr><td>${s.seat_no}</td><td>${stopSeq}${esc(p.stop_name || '')}${homeRouteTag}</td><td>${esc(p.per_id || '')}</td><td>${esc(p.first_name || '')} ${esc(p.last_name || '')}</td></tr>`;
      }
      body += `</table></details>`;
    }
  }
  return body;
}
function parseHalf(v) { return v === 'before' || v === 'after' ? v : 'all'; }
router.get('/dryrun', async (req, res, next) => {
  try {
    const base = req.baseUrl, date = String(req.query.date || '');
    const half = parseHalf(req.query.half);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.render('chp2rules', mk('ลองจัดดู', base, `<div class="card">${dryrunForm(base, bkkYmd(1), half)}</div>`));
    const { weekOf, dow, plan } = await planDate(pool, date, { allApprovals: true, half });
    const diag = await weekDiagnostics(pool, weekOf, dow);
    res.render('chp2rules', mk('ลองจัดดู', base, renderPlan(base, date, weekOf, dow, plan, req.query.committed === '1', diag, half)));
  } catch (e) { next(e); }
});
router.post('/commit', async (req, res, next) => {
  try {
    const date = String(req.body.date || '');
    const half = parseHalf(req.body.half);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect(req.baseUrl + '/dryrun');
    const { plan } = await planDate(pool, date, { allApprovals: true, half });
    await commitPlan(pool, date, plan, 'system');
    const qs = `date=${date}&committed=1${half !== 'all' ? `&half=${half}` : ''}`;
    res.redirect(`${req.baseUrl}/dryrun?${qs}`);
  } catch (e) { next(e); }
});

router.use((err, req, res, next) => { console.error('[chp2 admin]', err); res.status(500).send(layout('error', req.baseUrl, `<pre class="err">${esc(err.message)}</pre>`)); });

module.exports = router;
