'use strict';
// CLI: ลองจัดรถของวันหนึ่ง (อ่านกฎ+การจองจาก chp2)
//   node chp2/runPack.js 2026-05-28            # dry-run พิมพ์แผน ไม่เขียน DB
//   node chp2/runPack.js 2026-05-28 --commit   # เขียนลง chp2.bus_trip + seat_assignment (stage system)
const { pool } = require('./db');
const { planDate, commitPlan } = require('./pack');

function fmt(n, w) { return String(n).padStart(w); }

(async () => {
  const dateArg = process.argv[2];
  const commit = process.argv.includes('--commit');
  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error('usage: node chp2/runPack.js YYYY-MM-DD [--commit]');
    process.exit(1);
  }

  try {
    const { weekOf, dow, plan } = await planDate(pool, dateArg);
    console.log(`\n=== จัดรถ ${dateArg} (week_of=${weekOf}, day-of-week=${dow}) ===`);
    if (plan.length === 0) {
      console.log('  (ไม่มีผู้โดยสารที่อนุมัติแล้วในวันนี้ — อาจยังไม่ได้ import booking)');
    }

    // group แสดงตาม slot
    const bySlot = new Map();
    for (const bus of plan) {
      const k = `${bus.bound} ${bus.depart_time}`;
      if (!bySlot.has(k)) bySlot.set(k, []);
      bySlot.get(k).push(bus);
    }
    let totalSeats = 0;
    for (const [slot, buses] of bySlot) {
      console.log(`\n  [${slot}]`);
      for (const b of buses) {
        totalSeats += b.seats.length;
        const tag = b.kind === 'merge' ? 'รวม' : b.kind === 'bus' ? 'บัส' : b.kind === 'solo-fallback' ? 'เดี่ยว*' : 'เดี่ยว';
        console.log(`    - ${b.route_code} คันที่ ${b.bus_number} [${tag}] : ${fmt(b.seats.length, 2)}/${b.capacity} ที่นั่ง`);
      }
    }
    console.log(`\n  รวม ${plan.length} คัน, ${totalSeats} ที่นั่ง`);

    if (commit) {
      await commitPlan(pool, dateArg, plan, 'system');
      console.log('\n  ✅ เขียนลง chp2.bus_trip + seat_assignment (stage=system) แล้ว');
    } else {
      console.log('\n  (dry-run — ยังไม่เขียน DB; ใส่ --commit ถ้าต้องการเขียน)');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
