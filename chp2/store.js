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
  // มี booking แล้ว -> วันที่ไม่ได้จอง = 'ไม่ใช้' (ตรงกับที่ระบบเดิมเก็บ/LIFF คาด)
  for (let d = 1; d <= 7; d++) { out[`${DAY_KEY[d]}(in)`] = 'ไม่ใช้'; out[`${DAY_KEY[d]}(out)`] = 'ไม่ใช้'; }
  const rides = await db.query(
    `SELECT day_of_week, bound, to_char(depart_time,'HH24:MI') AS t
     FROM chp2.booking_ride WHERE booking_id = $1`, [b.id]);
  for (const ride of rides.rows) {
    const key = `${DAY_KEY[ride.day_of_week]}(${ride.bound === 'inbound' ? 'in' : 'out'})`;
    out[key] = ride.t;
  }
  return out;
}

// ---- dashboards: rows รูปแบบ query เดิม (snake-case grid cols) ----
async function getDashboard(db, which) {
  const offset = WEEK_OFFSET[which] ?? 0;
  const { rows: bookings } = await db.query(
    `SELECT b.id, e.line_user_id AS userid, e.per_id AS perid, e.first_name, e.last_name,
            e.department, b.dept_approval, rs.seq, rs.name AS stop_name, r.name AS route_name
     FROM chp2.booking b
     JOIN chp2.employee e ON e.id = b.employee_id
     LEFT JOIN chp2.route_stop rs ON rs.id = b.pickup_stop_id
     LEFT JOIN chp2.route r       ON r.id = rs.route_id
     WHERE b.week_of = date_trunc('week',CURRENT_DATE)::date + $1::int
     ORDER BY r.name NULLS LAST`, [offset]);
  if (bookings.length === 0) return [];
  const { rows: rides } = await db.query(
    `SELECT booking_id, day_of_week, bound, to_char(depart_time,'HH24:MI') AS t
     FROM chp2.booking_ride WHERE booking_id = ANY($1::int[])`, [bookings.map(b => b.id)]);
  const byB = new Map();
  for (const r of rides) (byB.get(r.booking_id) || byB.set(r.booking_id, []).get(r.booking_id)).push(r);
  return bookings.map(b => {
    const row = {
      userid: b.userid, perid: b.perid, first_name: b.first_name, last_name: b.last_name,
      location: rebuildLocation(b.seq, b.route_name, b.stop_name), department: b.department,
      route: b.route_name || '',
      department_approval: APPR_TO_DISPLAY[b.dept_approval] || b.dept_approval,
    };
    for (let d = 1; d <= 7; d++) { row[`${DAY_KEY[d]}_inbound`] = 'ไม่ใช้'; row[`${DAY_KEY[d]}_outbound`] = 'ไม่ใช้'; }
    for (const ride of (byB.get(b.id) || [])) row[`${DAY_KEY[ride.day_of_week]}_${ride.bound}`] = ride.t;
    return row;
  });
}

// ชื่อสายทั้งหมด (แทน SELECT * FROM chp.route) — ใช้ใน sumthisweek
async function getRouteNames(db) {
  return (await db.query(`SELECT name FROM chp2.route ORDER BY pack_group, code`)).rows;
}

// /update-approval-department-thisweek
async function updateThisweekApproval(db, lineUserId, status) {
  return db.query(
    `UPDATE chp2.booking b SET dept_approval=$1, updated_at=now()
     FROM chp2.employee e
     WHERE b.employee_id=e.id AND e.line_user_id=$2
       AND b.week_of = date_trunc('week',CURRENT_DATE)::date`,
    [apprToEnum(status), lineUserId]);
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

// ฟิลด์ฟอร์ม booking (เหมือน index.js) -> (day_of_week, bound)
const FIELD_MAP = [
  ['monin', 1, 'inbound'], ['monout', 1, 'outbound'],
  ['tuesin', 2, 'inbound'], ['tuesout', 2, 'outbound'],
  ['wedin', 3, 'inbound'], ['wedout', 3, 'outbound'],
  ['thuin', 4, 'inbound'], ['thout', 4, 'outbound'],
  ['friin', 5, 'inbound'], ['friout', 5, 'outbound'],
  ['satin', 6, 'inbound'], ['satout', 6, 'outbound'],
  ['sunin', 7, 'inbound'], ['sunout', 7, 'outbound'],
];
const validTime = (t) => t && String(t).trim() !== '' && String(t).trim() !== 'ไม่ใช้'
  && /^\d{1,2}:\d{2}$/.test(String(t).trim());

// ---- POST /nextweek,/thisweek : upsert booking + แทนที่ booking_ride ----
// which='this'|'next'. route มาจาก home_stop (pickup_stop) ไม่ต้อง derive
// db ต้องเป็น client (มี transaction). คืน false ถ้าไม่พบ employee
async function upsertBooking(db, which, lineUserId, fields) {
  const offset = WEEK_OFFSET[which] ?? 0;
  const emp = await db.query('SELECT id, home_stop_id FROM chp2.employee WHERE line_user_id=$1', [lineUserId]);
  if (emp.rows.length === 0) return false;
  const { id: employeeId, home_stop_id } = emp.rows[0];
  await db.query('BEGIN');
  try {
    const b = await db.query(
      `INSERT INTO chp2.booking (employee_id, week_of, pickup_stop_id, dept_approval)
       VALUES ($1, date_trunc('week',CURRENT_DATE)::date + $2::int, $3, 'pending')
       ON CONFLICT (employee_id, week_of)
       DO UPDATE SET pickup_stop_id=EXCLUDED.pickup_stop_id, dept_approval='pending', updated_at=now()
       RETURNING id`, [employeeId, offset, home_stop_id]);
    const bookingId = b.rows[0].id;
    await db.query('DELETE FROM chp2.booking_ride WHERE booking_id=$1', [bookingId]);
    for (const [key, dow, bound] of FIELD_MAP) {
      if (validTime(fields[key])) {
        await db.query(
          `INSERT INTO chp2.booking_ride (booking_id, day_of_week, bound, depart_time) VALUES ($1,$2,$3,$4)`,
          [bookingId, dow, bound, String(fields[key]).trim()]);
      }
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  return true;
}

// ---- /getuserdatathisweek,/getuserdatanextweek : { status, data:{status,location,14keys} } ----
async function getUserWeekData(db, which, lineUserId) {
  const u = await db.query(
    `SELECT e.approval_status, rs.seq, rs.name AS stop_name, r.name AS route_name
     FROM chp2.employee e
     LEFT JOIN chp2.route_stop rs ON rs.id = e.home_stop_id
     LEFT JOIN chp2.route r       ON r.id = rs.route_id
     WHERE e.line_user_id = $1`, [lineUserId]);
  if (u.rows.length === 0) return { status: 'newuser', data: null };
  const row = u.rows[0];
  const grid = await getBookingGrid(db, which, lineUserId);
  const data = { status: 'success', location: rebuildLocation(row.seq, row.route_name, row.stop_name) || 'N/A' };
  for (let d = 1; d <= 7; d++) {
    data[`${DAY_KEY[d]}(in)`] = grid[`${DAY_KEY[d]}(in)`] || 'ไม่ใช้';
    data[`${DAY_KEY[d]}(out)`] = grid[`${DAY_KEY[d]}(out)`] || 'ไม่ใช้';
  }
  return { status: APPR_TO_DISPLAY[row.approval_status] || row.approval_status, data };
}

// ---- POST /approve : อนุมัติ booking สัปดาห์นี้ ตาม perid (เฉพาะที่มี home_stop) ----
async function approveByPerids(db, ids) {
  return db.query(
    `UPDATE chp2.booking b SET dept_approval='approved', updated_at=now()
     FROM chp2.employee e
     WHERE b.employee_id = e.id AND e.per_id = ANY($1::text[])
       AND e.home_stop_id IS NOT NULL
       AND b.week_of = date_trunc('week',CURRENT_DATE)::date`, [ids]);
}

// ---- approval status ของ booking (ใช้ใน detail) : 'approved'|'standby' ----
async function getBookingApprove(db, which, lineUserId) {
  const offset = WEEK_OFFSET[which] ?? 0;
  const { rows } = await db.query(
    `SELECT b.dept_approval FROM chp2.booking b JOIN chp2.employee e ON e.id=b.employee_id
     WHERE e.line_user_id=$1 AND b.week_of = date_trunc('week',CURRENT_DATE)::date + $2::int`,
    [lineUserId, offset]);
  if (rows.length === 0) return 'standby';
  return rows[0].dept_approval === 'approved' ? 'approved' : 'standby';
}

module.exports = {
  getUserData, getBookingGrid, rebuildLocation, DAY_KEY, WEEK_OFFSET, apprToEnum,
  getMembers, updateApprovalStatus, updateDepartment, getDrivers, getPassengers, getDepartments, registerUser,
  upsertBooking, getDashboard, getRouteNames, updateThisweekApproval,
  getUserWeekData, approveByPerids, getBookingApprove,
};
