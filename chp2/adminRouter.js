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

// ---------- route flags (card layout, level-2 redesign) ----------
function routeCard(r, allRoutes) {
  // chip row: stops · merge groups it joins · # dispatch rules
  const chips = [];
  chips.push(`<span class="chip">${r.stops} จุด</span>`);
  if (r.in_groups) chips.push(`<span class="chip">กลุ่มรวม: ${esc(r.in_groups)}</span>`);
  if (Number(r.rules) > 0) chips.push(`<span class="chip">กฎจุด ${r.rules} ข้อ</span>`);
  if (r.never_merge) chips.push(`<span class="chip warn">วิ่งเดี่ยวเสมอ</span>`);
  if (r.bus_threshold != null) chips.push(`<span class="chip bus">บัสเมื่อ ≥${r.bus_threshold}</span>`);

  const head = `<div class="rcard-head">
    <span class="code">${esc(r.code)}</span><span class="name">${esc(r.name)}</span>
    <div class="rcard-meta">${chips.join('')}</div>
  </div>`;

  if (r.is_combined) {
    return `<div class="rcard">${head}
      <div class="readonly">สายรวม — สร้างโดย engine ตอน merge group ทำงาน ไม่ต้องตั้งเงื่อนไข</div></div>`;
  }

  // Editable card for sub-routes.
  return `<div class="rcard">${head}
    <form class="rcard-form" action="${esc(routeCard.base)}/routes/${r.id}" method="post">
      <fieldset><legend>⚙️ เมื่อไหร่ "วิ่งเดี่ยว" (ออกรถตู้สายของตัวเอง)</legend>
        <div class="field">
          <input type="checkbox" id="nm${r.id}" name="never_merge" ${r.never_merge ? 'checked' : ''}>
          <label for="nm${r.id}">วิ่งเดี่ยวเสมอ ไม่ยุบรวมเลย</label>
          <span class="hint">(ติ๊กเฉพาะสายห้ามรวม เช่น CHP16)</span>
        </div>
        <div class="field">
          <label for="ms${r.id}">เริ่มวิ่งเดี่ยวเมื่อมีคนตั้งแต่</label>
          <input type="number" id="ms${r.id}" name="min_solo_pax" value="${r.min_solo_pax ?? ''}" placeholder="—" min="1">
          <label for="ms${r.id}">คน</label>
          <span class="hint">น้อยกว่านี้ → ยุบเข้ากลุ่มรวมตามที่ตั้งไว้ (ปล่อยว่าง = ไม่ใช้กฎนี้)</span>
        </div>
      </fieldset>

      <fieldset><legend>🚌 เปลี่ยนเป็นรถบัสใหญ่ (แทนรถตู้)</legend>
        <div class="field">
          <label for="bt${r.id}">ใช้รถบัสใหญ่เมื่อมีคนตั้งแต่</label>
          <input type="number" id="bt${r.id}" name="bus_threshold" value="${r.bus_threshold ?? ''}" placeholder="—" min="1">
          <label for="bt${r.id}">คน</label>
          <span class="hint">ปล่อยว่าง = ไม่เปลี่ยนเป็นรถบัสเลย</span>
        </div>
        <div class="field">
          <label for="br${r.id}">เลือกรถบัสที่จะใช้:</label>
          <select id="br${r.id}" name="bus_route_id">${routeOpts(allRoutes, r.bus_route_id, true)}</select>
          <span class="hint">(เลือกเฉพาะถ้าตั้ง threshold ข้างบน)</span>
        </div>
      </fieldset>

      <fieldset><legend>🪑 ความจุ</legend>
        <div class="field">
          <label for="sc${r.id}">ที่นั่งต่อคันรถตู้:</label>
          <input type="number" id="sc${r.id}" name="seat_capacity" value="${r.seat_capacity}" min="1">
          <span class="hint">(รถตู้ปกติ 13, รถบัสใหญ่ปกติ 42 — แก้ที่การ์ดของสายบัสนั้น)</span>
        </div>
      </fieldset>

      <div class="rcard-actions"><button>บันทึก</button></div>
    </form></div>`;
}

router.get('/routes', async (req, res, next) => {
  try {
    const base = req.baseUrl;
    routeCard.base = base;
    const routes = (await pool.query(`
      SELECT r.id, r.code, r.name, r.pack_group, r.is_combined, r.never_merge,
             r.min_solo_pax, r.bus_threshold, r.bus_route_id, r.seat_capacity,
             (SELECT count(*) FROM chp2.route_stop WHERE route_id = r.id) AS stops,
             (SELECT count(*) FROM chp2.dispatch_rule WHERE route_id = r.id) AS rules,
             (SELECT string_agg(g.code, ', ' ORDER BY g.code)
                FROM chp2.merge_group_member m JOIN chp2.merge_group g ON g.id=m.group_id
                WHERE m.route_id = r.id) AS in_groups
      FROM chp2.route r
      ORDER BY r.is_combined, r.pack_group NULLS LAST, r.code`)).rows;

    // split by section: pack_group A, B, then combined
    const A = routes.filter(r => !r.is_combined && r.pack_group === 'A');
    const B = routes.filter(r => !r.is_combined && r.pack_group === 'B');
    const other = routes.filter(r => !r.is_combined && r.pack_group !== 'A' && r.pack_group !== 'B');
    const combined = routes.filter(r => r.is_combined);

    let body = `<p class="muted">แต่ละสายมีกลุ่มเงื่อนไข 3 ชุด: เมื่อไหร่วิ่งเดี่ยว · เมื่อไหร่ใช้รถบัสใหญ่ · ที่นั่งต่อคัน. สายรวม (CHPxx+yy) สร้างโดย engine — ตั้งจาก /กลุ่มรวม ไม่ใช่ที่นี่</p>`;
    if (A.length) body += `<div class="pg-head">กลุ่ม A — ${A.length} สาย</div>` + A.map(r => routeCard(r, routes)).join('');
    if (B.length) body += `<div class="pg-head">กลุ่ม B — ${B.length} สาย</div>` + B.map(r => routeCard(r, routes)).join('');
    if (other.length) body += `<div class="pg-head">ไม่มี pack_group</div>` + other.map(r => routeCard(r, routes)).join('');
    if (combined.length) body += `<div class="pg-head">สายรวม (อ่านอย่างเดียว) — ${combined.length} สาย</div>` + combined.map(r => routeCard(r, routes)).join('');

    res.render('chp2rules', mk('flag ราย route', base, body));
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
