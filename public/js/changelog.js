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
    let detail = '';
    if (row.detail != null) {
      detail = typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail);
    }
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
