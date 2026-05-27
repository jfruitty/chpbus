'use strict';
// ============================================================================
// chp2/store.js — adapter layer: อ่าน/เขียน schema chp2 แต่คืน/รับ "รูปแบบเดิม (chp)"
// เพื่อให้ index.js + views + LIFF client JS ไม่ต้องแก้ shape
// ทุกฟังก์ชันรับ db (pool หรือ client ของ pg) เป็นพารามิเตอร์แรก
//
// แผน cutover: ค่อย ๆ สลับ handler ใน index.js จาก SQL ตรง chp.* มาเรียก store.* ทีละกลุ่ม
// ============================================================================

const DAY_KEY = [null, 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEK_OFFSET = { this: 0, next: 7, last: -7 };

// สร้าง location string เดิม จาก home_stop ('[NN]route stopname')
function rebuildLocation(seq, routeName, stopName) {
  if (!routeName) return '';
  const n = (seq == null) ? '' : `[${String(seq).padStart(2, '0')}]`;
  return `${n}${routeName}${stopName ? ' ' + stopName : ''}`;
}

// ---- chpVerifyUserData(userid) แบบ chp2 ----
async function getUserData(db, lineUserId) {
  const { rows } = await db.query(
    `SELECT e.per_id, e.line_user_id, e.display_name, e.first_name, e.last_name,
            e.department, e.approval_status, rs.seq, rs.name AS stop_name, r.name AS route_name
     FROM chp2.employee e
     LEFT JOIN chp2.route_stop rs ON rs.id = e.home_stop_id
     LEFT JOIN chp2.route r       ON r.id = rs.route_id
     WHERE e.line_user_id = $1`, [lineUserId]);
  if (rows.length === 0) {
    return { status: 'success', approve: 'notmatch', pernumber: 'no data', userid: 'no data',
      displayname: 'no data', name: 'no data', surname: 'no data', department: 'no data', role: 'no data' };
  }
  const r = rows[0];
  return {
    status: 'success',
    approve: r.approval_status === 'approved' ? 'approved' : 'standby',
    pernumber: r.per_id, userid: r.line_user_id, displayname: r.display_name,
    name: r.first_name, surname: r.last_name, department: r.department,
    role: rebuildLocation(r.seq, r.route_name, r.stop_name),
  };
}

// ---- chpBookingData(table, userid) แบบ chp2 : which = 'this'|'next' ----
async function getBookingGrid(db, which, lineUserId) {
  const offset = WEEK_OFFSET[which] ?? 0;
  const empty = { status: 'success', route: '', approve: '' };
  for (let d = 1; d <= 7; d++) { empty[`${DAY_KEY[d]}(in)`] = ''; empty[`${DAY_KEY[d]}(out)`] = ''; }

  const { rows } = await db.query(
    `SELECT b.id, b.dept_approval, r.name AS route
     FROM chp2.booking b
     JOIN chp2.employee e        ON e.id = b.employee_id
     LEFT JOIN chp2.route_stop rs ON rs.id = b.pickup_stop_id
     LEFT JOIN chp2.route r       ON r.id = rs.route_id
     WHERE e.line_user_id = $1
       AND b.week_of = (date_trunc('week', CURRENT_DATE)::date + $2::int)`,
    [lineUserId, offset]);
  if (rows.length === 0) return empty;

  const b = rows[0];
  const out = { ...empty, route: b.route || '',
    approve: b.dept_approval === 'approved' ? 'approved' : 'standby' };
  const rides = await db.query(
    `SELECT day_of_week, bound, to_char(depart_time,'HH24:MI') AS t
     FROM chp2.booking_ride WHERE booking_id = $1`, [b.id]);
  for (const ride of rides.rows) {
    const key = `${DAY_KEY[ride.day_of_week]}(${ride.bound === 'inbound' ? 'in' : 'out'})`;
    out[key] = ride.t;
  }
  return out;
}

module.exports = { getUserData, getBookingGrid, rebuildLocation, DAY_KEY, WEEK_OFFSET };
