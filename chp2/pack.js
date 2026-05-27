'use strict';
// ============================================================================
// Packing engine (chp2) — จัดผู้โดยสารลงรถตามกฎ RMT ที่เก็บในตาราง
// แทน chpSpilloverA/B + caps matrix ที่ฮาร์ดโค้ดเดิม
//
// ลำดับการตัดสิน (ต่อสาย ต่อ slot = bound+เวลา):
//   P1  never_merge            -> วิ่งเดี่ยว เสมอ
//   P2-6 dispatch_rule          -> มีคนในช่วงจุด solo? วิ่งเดี่ยว : ยุบเข้า else_group
//   P5  bus_threshold           -> คน >= เกณฑ์ -> ใช้รถบัส (วิ่งเดี่ยว, cap ใหญ่)
//   P7  min_solo_pax            -> คน >= เกณฑ์ -> วิ่งเดี่ยว : ยุบตามกลุ่มที่สังกัด
//   merge: ไล่กลุ่มตาม priority ถ้าสมาชิกที่ยุบ (>=2 สาย) รวมกัน <= seat_cap -> 1 คันรวม
//          เหลือที่ยุบไม่ลง -> วิ่งเดี่ยว (fallback)
//
// ⚠️ assumption (ปรับได้ผ่าน data/แก้ที่นี่):
//   - "merge ต้องมี >=2 สาย" ถึงจะใช้คันรวม; สายเดียวที่ยุบไม่ได้ -> วิ่งเดี่ยว
//   - dispatch_rule เลือก rule ที่ priority ต่ำสุดที่ตรง bound
//   - เลขที่นั่ง: เรียงตามลำดับจุด (stop_seq) แล้วไล่ 1..cap, ล้น cap = เปิดคันถัดไป
// ============================================================================
const { loadRules } = require('./rules');

const BOUNDS = ['inbound', 'outbound'];

// ---- date helpers (ใช้ UTC ล้วนกับ date string YYYY-MM-DD) ----
function isoDow(d) { const x = d.getUTCDay(); return x === 0 ? 7 : x; }      // 1=Mon..7=Sun
function ymd(d) { return d.toISOString().slice(0, 10); }
function mondayOf(d) {
  const m = new Date(d);
  m.setUTCDate(m.getUTCDate() - (isoDow(d) - 1));
  return m;
}

async function loadPassengers(db, serviceDateStr) {
  const d = new Date(serviceDateStr + 'T00:00:00Z');
  const weekOf = ymd(mondayOf(d));
  const dow = isoDow(d);
  const { rows } = await db.query(`
    SELECT e.id AS employee_id, e.first_name, e.last_name,
           rs.route_id, rs.seq AS stop_seq, rs.id AS stop_id,
           br.bound, to_char(br.depart_time,'HH24:MI') AS depart_time
    FROM chp2.booking b
    JOIN chp2.booking_ride br ON br.booking_id = b.id
    JOIN chp2.employee e      ON e.id = b.employee_id
    JOIN chp2.route_stop rs   ON rs.id = b.pickup_stop_id
    WHERE b.week_of = $1 AND b.dept_approval = 'approved' AND br.day_of_week = $2
  `, [weekOf, dow]);
  return { rows, weekOf, dow };
}

// จัด 1 slot -> รายการ "คันรถ" {resultRouteId, capacity, pax:[...], kind, groupId?}
function planSlot(rules, slot, passengers) {
  const byRoute = new Map();
  for (const p of passengers) {
    if (!byRoute.has(p.route_id)) byRoute.set(p.route_id, []);
    byRoute.get(p.route_id).push(p);
  }

  const solo = [];
  const mergeCandidates = []; // {routeId, pax, eligibleGroupIds:[...]}

  for (const [routeId, pax] of byRoute) {
    const route = rules.routeById.get(routeId);
    if (!route) continue;
    const n = pax.length;

    if (route.never_merge) {                                   // P1
      solo.push({ resultRouteId: routeId, capacity: route.seat_capacity, pax, kind: 'solo' });
      continue;
    }

    const drs = (rules.dispatchByRoute.get(routeId) || [])     // P2-6
      .filter(dr => dr.bound == null || dr.bound === slot.bound);
    if (drs.length) {
      const dr = drs[0];
      const hasSoloPax = pax.some(p =>
        p.stop_seq != null && p.stop_seq >= dr.solo_stop_from && p.stop_seq <= dr.solo_stop_to);
      if (hasSoloPax) {
        solo.push({ resultRouteId: routeId, capacity: route.seat_capacity, pax, kind: 'solo' });
      } else {
        const eligible = [dr.else_group_id, dr.else_group_alt_id].filter(Boolean);
        mergeCandidates.push({ routeId, pax, eligibleGroupIds: eligible });
      }
      continue;
    }

    if (route.bus_threshold != null && n >= route.bus_threshold && route.bus_route_id) {  // P5
      const busRoute = rules.routeById.get(route.bus_route_id);
      solo.push({ resultRouteId: route.bus_route_id, capacity: busRoute ? busRoute.seat_capacity : n, pax, kind: 'bus' });
      continue;
    }

    if (route.min_solo_pax != null && n >= route.min_solo_pax) {  // P7 (>=)
      solo.push({ resultRouteId: routeId, capacity: route.seat_capacity, pax, kind: 'solo' });
      continue;
    }

    const eligible = (rules.groupsByRoute.get(routeId) || []).slice();  // P7 (<) -> merge
    if (eligible.length === 0) {
      solo.push({ resultRouteId: routeId, capacity: route.seat_capacity, pax, kind: 'solo' });
    } else {
      mergeCandidates.push({ routeId, pax, eligibleGroupIds: eligible });
    }
  }

  // resolve merges: ไล่กลุ่มตาม priority, ยุบสมาชิกที่ลงตัว
  const merged = [];
  const pending = new Map(mergeCandidates.map(c => [c.routeId, c]));
  for (const g of rules.groupsByPriority) {
    if (!g.is_active) continue;
    if (g.only_slot_id != null && g.only_slot_id !== slot.slotId) continue;  // GroupC = 20:15
    const take = [];
    let total = 0;
    for (const rid of g.members) {
      const c = pending.get(rid);
      if (c && c.eligibleGroupIds.includes(g.id)) { take.push(c); total += c.pax.length; }
    }
    if (take.length >= 2 && total <= g.seat_cap) {           // ต้อง >=2 สายถึงจะใช้คันรวม
      merged.push({
        resultRouteId: g.result_route_id,
        capacity: g.seat_cap,
        pax: take.flatMap(c => c.pax),
        kind: 'merge',
        groupId: g.id,
      });
      for (const c of take) pending.delete(c.routeId);
    }
  }
  // เหลือยุบไม่ลง -> วิ่งเดี่ยว
  for (const c of pending.values()) {
    const route = rules.routeById.get(c.routeId);
    solo.push({ resultRouteId: c.routeId, capacity: route.seat_capacity, pax: c.pax, kind: 'solo-fallback' });
  }

  return [...solo, ...merged];
}

// แตกคันรถ -> รถจริง (รองรับล้นเป็นหลายคัน) + เลขที่นั่ง
function assignSeats(vehicle) {
  const pax = vehicle.pax.slice().sort((a, b) =>
    ((a.stop_seq ?? 9999) - (b.stop_seq ?? 9999)) || (a.employee_id - b.employee_id));
  const cap = vehicle.capacity || 13;
  const buses = [];
  pax.forEach((p, i) => {
    const busNumber = Math.floor(i / cap) + 1;
    const seatNo = (i % cap) + 1;
    (buses[busNumber - 1] ||= { bus_number: busNumber, seats: [] }).seats.push({ pax: p, seat_no: seatNo });
  });
  return buses;
}

// วางแผนทั้งวัน (ไม่เขียน DB) -> โครงสร้างไว้พิมพ์/เขียนต่อ
async function planDate(db, serviceDate) {
  const rules = await loadRules(db);
  const { rows, weekOf, dow } = await loadPassengers(db, serviceDate);

  // group ผู้โดยสารตาม slot (bound|เวลา)
  const slots = new Map();
  for (const p of rows) {
    const key = `${p.bound}|${p.depart_time}`;
    if (!slots.has(key)) {
      slots.set(key, {
        bound: p.bound, depart_time: p.depart_time,
        slotId: rules.slotKey.get(key) ?? null, pax: [],
      });
    }
    slots.get(key).pax.push(p);
  }

  const plan = [];
  for (const slot of slots.values()) {
    const vehicles = planSlot(rules, slot, slot.pax);
    for (const v of vehicles) {
      const route = rules.routeById.get(v.resultRouteId);
      for (const bus of assignSeats(v)) {
        plan.push({
          service_date: serviceDate, bound: slot.bound, depart_time: slot.depart_time,
          route_id: v.resultRouteId, route_code: route ? route.code : '?',
          kind: v.kind, bus_number: bus.bus_number, capacity: v.capacity,
          seats: bus.seats,
        });
      }
    }
  }
  return { weekOf, dow, plan };
}

// เขียนแผนลง chp2 (stage 'system') — ล้างของเดิมวันนั้น stage นั้นก่อน
async function commitPlan(db, serviceDate, plan, stage = 'system') {
  await db.query('BEGIN');
  try {
    await db.query(
      `DELETE FROM chp2.seat_assignment s USING chp2.bus_trip t
       WHERE s.trip_id = t.id AND t.stage = $1 AND t.service_date = $2`, [stage, serviceDate]);
    await db.query(`DELETE FROM chp2.bus_trip WHERE stage = $1 AND service_date = $2`, [stage, serviceDate]);

    for (const bus of plan) {
      const { rows } = await db.query(
        `INSERT INTO chp2.bus_trip (stage, route_id, service_date, bound, depart_time, bus_number, capacity)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [stage, bus.route_id, serviceDate, bus.bound, bus.depart_time, bus.bus_number, bus.capacity]);
      const tripId = rows[0].id;
      for (const s of bus.seats) {
        await db.query(
          `INSERT INTO chp2.seat_assignment (trip_id, employee_id, pickup_stop_id, seat_no)
           VALUES ($1,$2,$3,$4)`,
          [tripId, s.pax.employee_id, s.pax.stop_id, s.seat_no]);
      }
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

module.exports = { planDate, commitPlan, planSlot, assignSeats, isoDow, mondayOf };
