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
function dryrunForm(base, defaultDate) {
  return `<form action="${esc(base)}/dryrun" method="get">วันที่ <input type="date" name="date" value="${esc(defaultDate)}" required>
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
const boundOpts = (sel) => ['', 'inbound', 'outbound']
  .map(b => `<option value="${b}"${b === (sel ?? '') ? ' selected' : ''}>${b === '' ? '(ทั้งสองทิศ)' : b}</option>`).join('');
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
router.get('/', async (req, res, next) => {
  try {
    const base = req.baseUrl;
    const issues = await validate(pool);
    const counts = (await pool.query(`SELECT
       (SELECT count(*) FROM chp2.route) routes,
       (SELECT count(*) FROM chp2.merge_group) groups,
       (SELECT count(*) FROM chp2.dispatch_rule) rules`)).rows[0];
    const issuesHtml = issues.length
      ? `<ul>${issues.map(i => `<li class="${i.level === 'error' ? 'err' : 'warn'}">[${i.level}] ${esc(i.msg)}</li>`).join('')}</ul>`
      : `<p class="ok">✓ ไม่พบปัญหา</p>`;
    res.render('chp2rules', mk('หน้าหลัก', base, `
      <div class="card"><b>สรุป:</b> ${counts.routes} สาย · ${counts.groups} กลุ่มรวม · ${counts.rules} กฎจุด/ทิศ</div>
      <div class="card"><h3 style="margin-top:0">ตรวจความถูกต้อง (validation)</h3>${issuesHtml}</div>
      <div class="card"><h3 style="margin-top:0">ลองจัดดูก่อนใช้จริง</h3>
        ${dryrunForm(base, bkkYmd(1))}
        <p class="muted">อ่านการจองจาก chp2.booking ของวันนั้น แล้วลองจัดตามกฎปัจจุบัน (ไม่เขียน DB)</p></div>`));
  } catch (e) { next(e); }
});

// ---------- route flags ----------
router.get('/routes', async (req, res, next) => {
  try {
    const base = req.baseUrl;
    const routes = (await pool.query(`SELECT * FROM chp2.route ORDER BY pack_group, code`)).rows;
    const rows = routes.map(r => `<tr>
      <td><code>${esc(r.code)}</code></td><td>${esc(r.name)}</td>
      <td>${r.is_combined ? '<span class="muted">สายรวม</span>' : `
       <form class="inline" action="${base}/routes/${r.id}" method="post">
        <label><input type="checkbox" name="never_merge" ${r.never_merge ? 'checked' : ''}> never</label>
        min <input type="number" name="min_solo_pax" value="${r.min_solo_pax ?? ''}">
        bus≥ <input type="number" name="bus_threshold" value="${r.bus_threshold ?? ''}">
        busRoute <select name="bus_route_id">${routeOpts(routes, r.bus_route_id, true)}</select>
        cap <input type="number" name="seat_capacity" value="${r.seat_capacity}">
        <button>บันทึก</button></form>`}</td></tr>`).join('');
    res.render('chp2rules', mk('flag ราย route', base, `<p class="muted">P1=never_merge · P5=bus_threshold(+busRoute) · P7=min_solo_pax · capacity=ที่นั่งต่อคัน</p>
      <table><tr><th>code</th><th>สาย</th><th>เงื่อนไข</th></tr>${rows}</table>`));
  } catch (e) { next(e); }
});
router.post('/routes/:id', async (req, res, next) => {
  try {
    const b = req.body, num = (v) => (v === '' || v == null) ? null : Number(v);
    await pool.query(
      `UPDATE chp2.route SET never_merge=$1, min_solo_pax=$2, bus_threshold=$3, bus_route_id=$4, seat_capacity=COALESCE($5,seat_capacity) WHERE id=$6`,
      [b.never_merge === 'on', num(b.min_solo_pax), num(b.bus_threshold), num(b.bus_route_id), num(b.seat_capacity), req.params.id]);
    res.redirect(req.baseUrl + '/routes');
  } catch (e) { next(e); }
});

// ---------- merge groups ----------
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
      const memHtml = mem.map(m => `${esc(m.code)} <form class="inline" action="${base}/groups/${g.id}/members/${m.route_id}/delete" method="post"><button class="danger" title="ลบ">×</button></form>`).join(' , ') || '<span class="muted">(ยังไม่มี)</span>';
      return `<div class="card"><b>${esc(g.code)}</b> ${g.is_active ? '' : '<span class="muted">(ปิดใช้)</span>'} ${g.dispatch_only ? '<span class="muted">[dispatch-only]</span>' : ''}
        <form class="inline" action="${base}/groups/${g.id}" method="post">
          ชื่อ <input type="text" name="name" value="${esc(g.name)}" style="width:230px">
          cap <input type="number" name="seat_cap" value="${g.seat_cap}">
          priority <input type="number" name="priority" value="${g.priority}">
          result <select name="result_route_id">${routeOpts(routes, g.result_route_id, true)}</select>
          เฉพาะเวลา <select name="only_slot_id">${slotOpts(slots, g.only_slot_id)}</select>
          <label><input type="checkbox" name="dispatch_only" ${g.dispatch_only ? 'checked' : ''}> dispatch-only</label>
          <label><input type="checkbox" name="is_active" ${g.is_active ? 'checked' : ''}> ใช้งาน</label>
          <button>บันทึก</button>
        </form>
        <form class="inline" action="${base}/groups/${g.id}/delete" method="post"><button class="danger">ลบกลุ่ม</button></form>
        <div style="margin-top:6px">สมาชิก: ${memHtml}
          <form class="inline" action="${base}/groups/${g.id}/members" method="post">
            <select name="route_id">${routeOpts(routes, null, false)}</select><button class="sec">+ เพิ่มสาย</button></form>
        </div></div>`;
    }).join('');
    res.render('chp2rules', mk('กลุ่มรวม', base, `${cards}
      <div class="card"><h3 style="margin-top:0">+ สร้างกลุ่มใหม่</h3>
       <form action="${base}/groups" method="post">
        code <input type="text" name="code" required>
        ชื่อ <input type="text" name="name" style="width:230px">
        cap <input type="number" name="seat_cap" value="13">
        priority <input type="number" name="priority" value="20">
        result <select name="result_route_id">${routeOpts(routes, null, true)}</select>
        <button>สร้าง</button></form></div>`));
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

// ---------- dispatch rules ----------
router.get('/rules', async (req, res, next) => {
  try {
    const base = req.baseUrl;
    const routes = (await pool.query(`SELECT id, code, name FROM chp2.route ORDER BY code`)).rows;
    const groups = (await pool.query(`SELECT id, code FROM chp2.merge_group ORDER BY priority`)).rows;
    const rules = (await pool.query(`SELECT d.*, r.code AS route_code FROM chp2.dispatch_rule d JOIN chp2.route r ON r.id=d.route_id ORDER BY d.priority`)).rows;
    const rows = rules.map(d => `<tr><form action="${base}/rules/${d.id}" method="post">
      <td>pri <input type="number" name="priority" value="${d.priority}"></td>
      <td><select name="route_id">${routeOpts(routes, d.route_id, false)}</select></td>
      <td><select name="bound">${boundOpts(d.bound)}</select></td>
      <td>จุด <input type="number" name="solo_stop_from" value="${d.solo_stop_from ?? ''}">-<input type="number" name="solo_stop_to" value="${d.solo_stop_to ?? ''}"></td>
      <td><select name="else_group_id">${groupOpts(groups, d.else_group_id, true)}</select></td>
      <td><select name="else_group_alt_id">${groupOpts(groups, d.else_group_alt_id, true)}</select></td>
      <td><button>บันทึก</button></form>
        <form class="inline" action="${base}/rules/${d.id}/delete" method="post"><button class="danger">ลบ</button></form></td></tr>`).join('');
    res.render('chp2rules', mk('กฎจุด/ทิศ', base, `<p class="muted">ถ้ามีคนในช่วงจุด [from..to] (ทิศที่ระบุ) → จัดเอง ; ไม่งั้นยุบเข้า else group (หรือ alt)</p>
      <table><tr><th>priority</th><th>สาย</th><th>ทิศ</th><th>ช่วงจุด solo</th><th>ยุบเข้า</th><th>หรือ</th><th></th></tr>${rows}</table>
      <div class="card"><h3 style="margin-top:0">+ เพิ่มกฎ</h3><form action="${base}/rules" method="post">
        pri <input type="number" name="priority" value="9">
        สาย <select name="route_id">${routeOpts(routes, null, false)}</select>
        ทิศ <select name="bound">${boundOpts('')}</select>
        จุด <input type="number" name="solo_stop_from" value="1">-<input type="number" name="solo_stop_to" value="1">
        ยุบเข้า <select name="else_group_id">${groupOpts(groups, null, true)}</select>
        <button>เพิ่ม</button></form></div>`));
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
async function weekDiagnostics(db, weekOf, dow) {
  const r = await db.query(`SELECT b.dept_approval,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chp2.booking_ride br WHERE br.booking_id=b.id AND br.day_of_week=$2)) AS with_ride,
       count(*) AS total
     FROM chp2.booking b WHERE b.week_of=$1 GROUP BY b.dept_approval`, [weekOf, dow]);
  const out = { approved: 0, pending: 0, rejected: 0, approvedWithRide: 0 };
  for (const x of r.rows) {
    out[x.dept_approval] = Number(x.total);
    if (x.dept_approval === 'approved') out.approvedWithRide = Number(x.with_ride);
  }
  return out;
}
function renderPlan(base, date, weekOf, dow, plan, committed, diag) {
  const bySlot = new Map();
  for (const b of plan) { const k = `${b.bound} ${b.depart_time}`; (bySlot.get(k) || bySlot.set(k, []).get(k)).push(b); }
  const tag = (k) => k === 'merge' ? '🔗 รวม' : k === 'bus' ? '🚌 บัส' : k === 'solo-fallback' ? 'เดี่ยว*' : 'เดี่ยว';
  let body = committed ? `<div class="card ok">✅ บันทึกแผนวันที่ ${esc(date)} ลง chp2 (stage system) แล้ว</div>` : '';
  body += `<div class="card">${dryrunForm(base, date)}
    <p class="muted" style="margin:8px 0 0">week_of=<code>${esc(weekOf)}</code>, day-of-week=${dow}
    ${diag ? ` — booking สัปดาห์นี้: <b class="ok">${diag.approved}</b> approved · <span class="warn">${diag.pending}</span> pending · ${diag.rejected} rejected (มี ride วันนี้: ${diag.approvedWithRide})` : ''}</p></div>`;
  body += `<div class="card">จัดวันที่ <b>${esc(date)}</b> — <b>${plan.length}</b> คัน
    ${plan.length ? `<form method="post" action="${base}/commit" style="margin-top:8px">
       <input type="hidden" name="date" value="${esc(date)}"><button>💾 บันทึกแผนนี้ลง chp2 (stage system)</button></form>` : ''}</div>`;
  if (!plan.length) {
    body += `<p class="warn">ไม่มีผู้โดยสารอนุมัติแล้ว (+มี ride วันนี้) ใน week_of ${esc(weekOf)}`;
    if (diag && diag.pending > 0 && diag.approved === 0)
      body += ` — มี ${diag.pending} จองรอ approve อยู่ ลอง approve ที่ <a href="/thisweekdashboard">/thisweekdashboard</a> หรือ <a href="/hrnextweek">/hrnextweek</a> ก่อน`;
    else if (diag && diag.approved > 0 && diag.approvedWithRide === 0)
      body += ` — มี approved ${diag.approved} แต่ไม่มีคนตั้ง ride วันที่ ${dow} ของสัปดาห์`;
    else if (diag && diag.approved + diag.pending + diag.rejected === 0)
      body += ` — สัปดาห์นี้ยังไม่มีจองเลย ลองเลือกวันที่ของสัปดาห์อื่น`;
    body += `</p>`;
  }
  for (const [slot, buses] of bySlot) {
    body += `<h3>${esc(slot)}</h3><table><tr><th>สาย</th><th>ชนิด</th><th>คันที่</th><th>ที่นั่ง</th></tr>` +
      buses.map(b => `<tr><td><code>${esc(b.route_code)}</code></td><td>${tag(b.kind)}</td><td>${b.bus_number}</td><td>${b.seats.length}/${b.capacity}</td></tr>`).join('') + `</table>`;
  }
  return body;
}
router.get('/dryrun', async (req, res, next) => {
  try {
    const base = req.baseUrl, date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.render('chp2rules', mk('ลองจัดดู', base, `<div class="card">${dryrunForm(base, bkkYmd(1))}</div>`));
    const { weekOf, dow, plan } = await planDate(pool, date);
    const diag = await weekDiagnostics(pool, weekOf, dow);
    res.render('chp2rules', mk('ลองจัดดู', base, renderPlan(base, date, weekOf, dow, plan, req.query.committed === '1', diag)));
  } catch (e) { next(e); }
});
router.post('/commit', async (req, res, next) => {
  try {
    const date = String(req.body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect(req.baseUrl + '/dryrun');
    const { plan } = await planDate(pool, date);
    await commitPlan(pool, date, plan, 'system');
    res.redirect(`${req.baseUrl}/dryrun?date=${date}&committed=1`);
  } catch (e) { next(e); }
});

router.use((err, req, res, next) => { console.error('[chp2 admin]', err); res.status(500).send(layout('error', req.baseUrl, `<pre class="err">${esc(err.message)}</pre>`)); });

module.exports = router;
