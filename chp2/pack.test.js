'use strict';
// self-test ตรรกะ engine (ไม่แตะ DB) — รัน: node chp2/pack.test.js
const assert = require('assert');
const { planSlot, assignSeats } = require('./pack');

// ---- helper สร้าง rules object แบบ mock ----
function mkRules(routes, groups, dispatch) {
  const routeById = new Map(routes.map(r => [r.id, r]));
  const groupsByPriority = groups.slice().sort((a, b) => a.priority - b.priority);
  const groupsByRoute = new Map();
  for (const g of groupsByPriority)
    for (const rid of g.members) {
      if (!groupsByRoute.has(rid)) groupsByRoute.set(rid, []);
      groupsByRoute.get(rid).push(g.id);
    }
  const dispatchByRoute = new Map();
  for (const dr of (dispatch || []))
    (dispatchByRoute.get(dr.route_id) || dispatchByRoute.set(dr.route_id, []).get(dr.route_id)).push(dr);
  return { routeById, groupsByPriority, groupsByRoute, dispatchByRoute };
}
const R = (id, code, o = {}) => ({
  id, code, name: code, seat_capacity: o.cap ?? 13,
  never_merge: o.never ?? false, min_solo_pax: o.min ?? 7,
  bus_threshold: o.bus ?? null, bus_route_id: o.busRoute ?? null,
});
const pax = (routeId, n, seq = 1) =>
  Array.from({ length: n }, (_, i) => ({ employee_id: routeId * 1000 + i, route_id: routeId, stop_seq: seq, stop_id: routeId * 1000 + i }));

const routes = [
  R(1, 'CHP01'), R(2, 'CHP02'), R(3, 'CHP03'), R(4, 'CHP04'),
  R(5, 'CHP05'), R(15, 'CHP15'),
  R(13, 'CHP13'), R(14, 'CHP14'),
  R(16, 'CHP16', { never: true }),
  R(12, 'CHP12', { bus: 26, busRoute: 120 }), R(120, 'CHP12-2', { cap: 42 }),
  R(100, 'GroupA-route'), R(113, '13+14-route'), R(105, 'GroupC-route'),
];
const groups = [
  { id: 1013, code: '13+14', seat_cap: 13, priority: 5,  result_route_id: 113, only_slot_id: null, is_active: true, members: [13, 14] },
  { id: 1001, code: 'A',     seat_cap: 13, priority: 10, result_route_id: 100, only_slot_id: null, is_active: true, members: [1, 2, 3, 4] },
  { id: 1003, code: 'C',     seat_cap: 13, priority: 12, result_route_id: 105, only_slot_id: 55,   is_active: true, members: [5, 15] },
];
const dispatch = [
  { route_id: 13, bound: 'inbound', solo_stop_from: 1, solo_stop_to: 5, else_group_id: 1013, else_group_alt_id: null },
];
const rules = mkRules(routes, groups, dispatch);
const slot = (b, sid) => ({ bound: b, depart_time: '07:30', slotId: sid });

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ✓', name); }
const find = (vs, kind) => vs.filter(v => v.kind === kind);

// A: P7 — สายใหญ่วิ่งเดี่ยว, สายเล็กยุบ GroupA
check('P7: CHP01x10 solo, CHP02x3+CHP03x2 merge GroupA', () => {
  const vs = planSlot(rules, slot('inbound', 1), [...pax(1, 10), ...pax(2, 3), ...pax(3, 2)]);
  const solo = find(vs, 'solo');
  assert.strictEqual(solo.length, 1);
  assert.strictEqual(solo[0].resultRouteId, 1);
  assert.strictEqual(solo[0].pax.length, 10);
  const m = find(vs, 'merge');
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].resultRouteId, 100);
  assert.strictEqual(m[0].pax.length, 5);
});

// B: P1 — never_merge วิ่งเดี่ยวแม้ < min
check('P1: CHP16x2 (never_merge) -> solo', () => {
  const vs = planSlot(rules, slot('inbound', 1), pax(16, 2));
  assert.strictEqual(vs.length, 1);
  assert.strictEqual(vs[0].kind, 'solo');
  assert.strictEqual(vs[0].resultRouteId, 16);
});

// C: P5 — bus_threshold
check('P5: CHP12x30 -> bus (route 120, cap 42)', () => {
  const vs = planSlot(rules, slot('inbound', 1), pax(12, 30));
  assert.strictEqual(vs.length, 1);
  assert.strictEqual(vs[0].kind, 'bus');
  assert.strictEqual(vs[0].resultRouteId, 120);
  assert.strictEqual(vs[0].capacity, 42);
});
check('P5: CHP12x10 (<26) -> solo van', () => {
  const vs = planSlot(rules, slot('inbound', 1), pax(12, 10));
  assert.strictEqual(vs[0].kind, 'solo');
  assert.strictEqual(vs[0].resultRouteId, 12);
});

// D: dispatch_rule — ไม่มีคนในช่วงจุด solo -> ยุบ 13+14
check('P3: CHP13(seq8, นอกช่วง1-5)x3 + CHP14x2 -> merge 13+14', () => {
  const vs = planSlot(rules, slot('inbound', 1), [...pax(13, 3, 8), ...pax(14, 2)]);
  const m = find(vs, 'merge');
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].resultRouteId, 113);
  assert.strictEqual(m[0].pax.length, 5);
});
// E: dispatch_rule — มีคนในช่วงจุด solo -> วิ่งเดี่ยว
check('P3: CHP13(seq2, ในช่วง1-5)x3 -> solo', () => {
  const vs = planSlot(rules, slot('inbound', 1), pax(13, 3, 2));
  const solo = find(vs, 'solo');
  assert.ok(solo.some(v => v.resultRouteId === 13));
});

// F: only_slot — GroupC ใช้เฉพาะ slot 55 (20:15)
check('GroupC inactive ที่ slot อื่น: CHP05x3+CHP15x2 -> solo-fallback ทั้งคู่', () => {
  const vs = planSlot(rules, slot('inbound', 1), [...pax(5, 3), ...pax(15, 2)]);
  assert.strictEqual(find(vs, 'merge').length, 0);
  assert.strictEqual(vs.filter(v => v.kind === 'solo-fallback').length, 2);
});
check('GroupC active ที่ slot 55: CHP05x3+CHP15x2 -> merge', () => {
  const vs = planSlot(rules, slot('outbound', 55), [...pax(5, 3), ...pax(15, 2)]);
  const m = find(vs, 'merge');
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].resultRouteId, 105);
  assert.strictEqual(m[0].pax.length, 5);
});

// G: assignSeats overflow -> หลายคัน
check('assignSeats: 15 คน cap13 -> 2 คัน (13+2)', () => {
  const buses = assignSeats({ pax: pax(1, 15), capacity: 13 });
  assert.strictEqual(buses.length, 2);
  assert.strictEqual(buses[0].seats.length, 13);
  assert.strictEqual(buses[1].seats.length, 2);
  assert.strictEqual(buses[0].seats[0].seat_no, 1);
  assert.strictEqual(buses[1].seats[0].seat_no, 1);
});

// H: merge ต้อง >=2 สาย — สายเล็กเดี่ยว ๆ ไม่ยุบ
check('merge ต้องมี >=2 สาย: CHP02x3 อย่างเดียว -> solo-fallback (ไม่ใช้คันรวม)', () => {
  const vs = planSlot(rules, slot('inbound', 1), pax(2, 3));
  assert.strictEqual(find(vs, 'merge').length, 0);
  assert.strictEqual(vs[0].kind, 'solo-fallback');
  assert.strictEqual(vs[0].resultRouteId, 2);
});

console.log(`\n✅ ผ่านทั้งหมด ${passed} เคส`);
