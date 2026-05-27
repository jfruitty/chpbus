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

// ---- approval enum <-> ค่าที่ UI เดิมใช้ ----
const APPR_TO_DISPLAY = { approved: 'approved', pending: 'pending', rejected: 'reject' };
function apprToEnum(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'reject' || s === 'rejected') return 'rejected';
  return 'pending';
}

// ---- /member : rows รูปแบบ chp.users ----
async function getMembers(db) {
  const { rows } = await db.query(
    `SELECT e.line_user_id, e.per_id, e.display_name, e.first_name, e.last_name,
            e.department, e.factory, e.approval_status,
            rs.seq, rs.name AS stop_name, r.name AS route_name
     FROM chp2.employee e
     LEFT JOIN chp2.route_stop rs ON rs.id = e.home_stop_id
     LEFT JOIN chp2.route r       ON r.id = rs.route_id
     ORDER BY CASE WHEN e.approval_status='pending' THEN 0 ELSE 1 END, r.name NULLS LAST, rs.seq`);
  return rows.map(r => ({
    userid: r.line_user_id, perid: r.per_id, displayname: r.display_name,
    first_name: r.first_name, last_name: r.last_name, department: r.department,
    factory: r.factory, location: rebuildLocation(r.seq, r.route_name, r.stop_name),
    approvalstatus: APPR_TO_DISPLAY[r.approval_status] || r.approval_status,
  }));
}

async function updateApprovalStatus(db, lineUserId, status) {
  return db.query(`UPDATE chp2.employee SET approval_status=$1, updated_at=now() WHERE line_user_id=$2`,
    [apprToEnum(status), lineUserId]);
}
async function updateDepartment(db, lineUserId, department) {
  return db.query(`UPDATE chp2.employee SET department=$1, updated_at=now() WHERE line_user_id=$2`,
    [department, lineUserId]);
}
async function getDrivers(db) {
  return (await db.query(
    `SELECT line_user_id AS userid, per_id AS perid, first_name, last_name
     FROM chp2.employee WHERE department='Driver' ORDER BY first_name, last_name`)).rows;
}
async function getPassengers(db) {
  return (await db.query(
    `SELECT line_user_id AS userid, per_id AS perid, first_name, last_name
     FROM chp2.employee WHERE department NOT IN ('Driver','Old Driver') OR department IS NULL
     ORDER BY first_name, last_name`)).rows;
}
async function getDepartments(db) {
  return (await db.query(
    `SELECT DISTINCT department FROM chp2.employee
     WHERE department IS NOT NULL AND btrim(department)<>'' ORDER BY department`)).rows.map(r => r.department);
}
async function registerUser(db, f) {
  return db.query(
    `INSERT INTO chp2.employee (per_id, line_user_id, display_name, first_name, last_name, department, approval_status, is_driver)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
     ON CONFLICT (line_user_id) DO NOTHING`,
    [f.pernumber, f.userid, f.displayname, f.name, f.surname, f.department,
     f.department === 'Driver' || f.department === 'Old Driver']);
}

module.exports = {
  getUserData, getBookingGrid, rebuildLocation, DAY_KEY, WEEK_OFFSET, apprToEnum,
  getMembers, updateApprovalStatus, updateDepartment, getDrivers, getPassengers, getDepartments, registerUser,
};
