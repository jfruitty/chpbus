'use strict';
// โหลดเงื่อนไขรวมสาย (RMT) จากตาราง chp2 มาเป็น object ในหน่วยความจำ
// แทนค่าคงที่ที่เคยฮาร์ดโค้ดใน chpSpilloverA/B + caps matrix
//
// คืนค่า:
//   routeById        Map(routeId -> {id, code, name, seat_capacity,
//                                    never_merge, min_solo_pax, bus_threshold, bus_route_id})
//   slots            [{id, slot_index, bound, depart_time:'HH:MM', period}]
//   slotKey          Map('bound|HH:MM' -> slotId)
//   groupById        Map(groupId -> {id, code, seat_cap, priority, result_route_id,
//                                    only_slot_id, is_active, members:[routeId]})
//   groupsByPriority [group]  เรียงตาม priority น้อย->มาก
//   groupsByRoute    Map(routeId -> [groupId])  กลุ่มที่ route เป็นสมาชิก (เรียงตาม priority)
//   dispatchByRoute  Map(routeId -> [rule])     กฎ P2-6 ของ route (เรียงตาม priority)

async function loadRules(db) {
  const [routesRes, slotsRes, groupsRes, membersRes, drulesRes] = await Promise.all([
    db.query(`SELECT id, code, name, seat_capacity, never_merge, min_solo_pax, bus_threshold, bus_route_id
              FROM chp2.route`),
    db.query(`SELECT id, slot_index, bound, to_char(depart_time,'HH24:MI') AS depart_time, period
              FROM chp2.time_slot ORDER BY slot_index`),
    db.query(`SELECT id, code, seat_cap, priority, result_route_id, only_slot_id, dispatch_only, is_active
              FROM chp2.merge_group ORDER BY priority`),
    db.query(`SELECT group_id, route_id, member_order FROM chp2.merge_group_member ORDER BY member_order`),
    db.query(`SELECT id, priority, route_id, bound, solo_stop_from, solo_stop_to,
                     else_group_id, else_group_alt_id
              FROM chp2.dispatch_rule WHERE is_active ORDER BY priority`),
  ]);

  const routeById = new Map(routesRes.rows.map(r => [r.id, r]));

  const slots = slotsRes.rows;
  const slotKey = new Map(slots.map(s => [`${s.bound}|${s.depart_time}`, s.id]));

  const groupById = new Map(groupsRes.rows.map(g => [g.id, { ...g, members: [] }]));
  for (const m of membersRes.rows) {
    const g = groupById.get(m.group_id);
    if (g) g.members.push(m.route_id);
  }

  const groupsByPriority = [...groupById.values()].sort((a, b) => a.priority - b.priority);

  // กลุ่มที่ route สังกัด สำหรับ P7 path — ข้ามกลุ่ม dispatch_only (เข้าถึงผ่าน dispatch_rule เท่านั้น)
  const groupsByRoute = new Map();
  for (const g of groupsByPriority) {
    if (g.dispatch_only) continue;
    for (const rid of g.members) {
      if (!groupsByRoute.has(rid)) groupsByRoute.set(rid, []);
      groupsByRoute.get(rid).push(g.id);
    }
  }

  const dispatchByRoute = new Map();
  for (const dr of drulesRes.rows) {
    if (!dispatchByRoute.has(dr.route_id)) dispatchByRoute.set(dr.route_id, []);
    dispatchByRoute.get(dr.route_id).push(dr);
  }

  return { routeById, slots, slotKey, groupById, groupsByPriority, groupsByRoute, dispatchByRoute };
}

module.exports = { loadRules };
