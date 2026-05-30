// Renders chp.change_log rows. Search/sort is handled by table-tools.js.
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function actionLabel(a) {
  const map = {
    insertbusdriver: 'เพิ่มรถ (จัดรถ)', editbusdriver: 'แก้รถ (จัดรถ)', removebusdriver: 'ลบรถ (จัดรถ)',
    insertbustoday: 'เพิ่มรถ (HR)', editbustoday: 'แก้รถ (HR)', removebustoday: 'ลบรถ (HR)',
    insertpaxdriver: 'เพิ่มผู้โดยสาร (จัดรถ)', editpaxdriver: 'แก้ผู้โดยสาร (จัดรถ)', removepaxdriver: 'ลบผู้โดยสาร (จัดรถ)',
    insertpaxtoday: 'เพิ่มผู้โดยสาร (HR)', editpaxtoday: 'แก้ผู้โดยสาร (HR)', removepaxtoday: 'ลบผู้โดยสาร (HR)',
    driversendtohr: 'ส่งให้ HR', 'daliy-pack': 'ระบบจัดรถอัตโนมัติ', 'daliy-skipped-driver-busy': 'ข้ามจัดรถ (มีงานค้าง)'
  };
  return map[a] || a;
}

// --- Detail formatting ------------------------------------------------------
// The stored detail is { before, after } (older rows are just the raw `after`
// body). We normalise both the DB-row column names (per_id/busnumber/seat) and
// the form-body names (perid/bus_number/seat_number) into one labelled shape so
// inserts read as "field: value" and edits read as "field: old → new".

const DAY_TH = {
  monday: 'จันทร์', tuesday: 'อังคาร', wednesday: 'พุธ', thursday: 'พฤหัสบดี',
  friday: 'ศุกร์', saturday: 'เสาร์', sunday: 'อาทิตย์'
};
const BOUND_TH = { inbound: 'ขาเข้า', outbound: 'ขาออก' };

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== 'NaN';
const pick = (...vals) => vals.find(has);

// Return [ [label, value], ... ] for the meaningful, populated fields of a
// record (either a DB row or a submitted form body). `action` decides whether
// the person is a driver or a passenger.
function canonFields(action, r) {
  if (!r || typeof r !== 'object') return [];
  const isPax = /pax/.test(action);
  const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
  const perid = pick(r.perid, r.per_id);
  const busno = pick(r.bus_number, r.busnumber);
  const seat = pick(r.seat, r.seat_number);
  const day = DAY_TH[r.day] || r.day;
  const bound = BOUND_TH[r.bound] || r.bound;

  const fields = [
    ['สายรถ', r.route],
    ['วัน', day],
    ['รอบ', bound],
    ['เวลา', r.time],
    [isPax ? 'ผู้โดยสาร' : 'คนขับ', name],
    [isPax ? 'รหัสพนักงาน' : 'ทะเบียน/รหัส', perid],
    ['คันที่', busno],
    ['ที่นั่ง', seat],
    ['จุดขึ้น', r.location],
  ];
  return fields.filter(([, v]) => has(v));
}

function formatDetail(action, detail) {
  if (detail == null) return '';
  let obj = detail;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch (e) { return detail; }
  }
  if (!obj || typeof obj !== 'object') return String(detail);

  // New rows wrap as { before, after }; legacy rows are the raw body (= after).
  const wrapped = ('after' in obj) || ('before' in obj);
  const after = wrapped ? obj.after : obj;
  const before = wrapped ? obj.before : null;

  const op = /^remove/.test(action) ? 'remove'
    : /^edit/.test(action) ? 'edit'
      : /^insert/.test(action) ? 'insert' : 'other';

  const join = (pairs) => pairs.map(([k, v]) => `${k}: ${v}`).join('  •  ');

  if (op === 'remove') {
    const f = canonFields(action, before || after);
    if (f.length) return 'ลบรายการ — ' + join(f);
    return after && after.id ? `ลบ (รหัสแถว ${after.id})` : 'ลบรายการ';
  }

  if (op === 'insert') {
    return join(canonFields(action, after));
  }

  if (op === 'edit') {
    const beforeMap = Object.fromEntries(canonFields(action, before));
    const afterPairs = canonFields(action, after);   // only fields the user set
    const changes = afterPairs
      .filter(([k, v]) => String(beforeMap[k] != null ? beforeMap[k] : '') !== String(v))
      .map(([k, v]) => (has(beforeMap[k]) ? `${k}: ${beforeMap[k]} → ${v}` : `${k}: ${v}`));
    if (changes.length) return 'แก้ไข — ' + changes.join('  •  ');
    // Nothing detected as different (e.g. all fields left on placeholder) —
    // fall back to showing the resulting values.
    return afterPairs.length ? 'แก้ไข — ' + join(afterPairs) : 'แก้ไข';
  }

  // other (e.g. driversendtohr) — body usually empty; action label says enough.
  return join(canonFields(action, after));
}

async function fetchLog() {
  try {
    const res = await fetch('/changelogjson');
    const data = await res.json();
    return data.rows || [];
  } catch (e) {
    console.error('Error fetching change log:', e);
    return [];
  }
}

async function buildLogTable() {
  const rows = await fetchLog();
  const tbody = document.getElementById('changelogBody');
  tbody.innerHTML = '';
  rows.forEach((row, i) => {
    const detail = formatDetail(row.action || '', row.detail);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(row.ts || '')}</td>
      <td>${escapeHtml(row.actor || '')}</td>
      <td>${escapeHtml(actionLabel(row.action || ''))}</td>
      <td>${escapeHtml(row.row_id || '')}</td>
      <td class="detail-cell">${escapeHtml(detail)}</td>`;
    tbody.appendChild(tr);
  });
}

document.addEventListener('DOMContentLoaded', buildLogTable);
