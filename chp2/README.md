# chp2/ — โค้ดใหม่ที่ทำงานบน schema `chp2`

แยกจาก `index.js` ที่ยัง live บน `chp` — ทดสอบ/พัฒนาได้โดยไม่กระทบของจริง
ใช้ `process.env.DATABASE_URL` ตัวเดียวกับแอปหลัก (ผ่าน `dotenv`)

## ไฟล์

| ไฟล์ | หน้าที่ |
|---|---|
| `db.js` | pg pool ชี้ `DATABASE_URL` |
| `rules.js` | โหลดเงื่อนไข RMT (route flags / merge_group / dispatch_rule / time_slot) จาก DB |
| `pack.js` | **packing engine** — จัดผู้โดยสารลงรถตามกฎ (แทน `chpSpilloverA/B` + caps matrix) |
| `runPack.js` | CLI dry-run / commit การจัดรถของวันหนึ่ง |
| `adminServer.js` | หน้า admin แก้กฎ + validation + ปุ่มลองจัดดู |
| `pack.test.js` | self-test ตรรกะ engine (ไม่แตะ DB) |

## ต้องทำก่อน (prereq)

รัน migration ใน `../migrate/` ให้ schema `chp2` + ข้อมูลพร้อมก่อน:
```bash
psql "$DATABASE_URL" -f migrate/run_all.sql   # (กับ DB copy)
```

## วิธีรัน

```bash
node chp2/pack.test.js                    # ทดสอบตรรกะ engine (10 เคส, ไม่แตะ DB)
node chp2/runPack.js 2026-05-28           # dry-run จัดรถวันนั้น พิมพ์แผน (ไม่เขียน DB)
node chp2/runPack.js 2026-05-28 --commit  # เขียนลง chp2.bus_trip + seat_assignment (stage=system)
node chp2/adminServer.js                  # หน้า admin -> http://localhost:3100/
```

## engine: ลำดับการตัดสิน (ต่อสาย ต่อ slot = ทิศ+เวลา)

อ่านกฎจากตาราง (ไม่ฮาร์ดโค้ด) เรียงตาม priority ของ RMT:

1. `route.never_merge` → วิ่งเดี่ยวเสมอ (P1: CHP15/16)
2. `dispatch_rule` (P2-6) → มีคนในช่วงจุด solo ของทิศนั้นไหม? มี=วิ่งเดี่ยว / ไม่มี=ยุบเข้า `else_group` (หรือ `else_group_alt`)
3. `route.bus_threshold` → คน ≥ เกณฑ์ → ใช้ `bus_route` (P5: CHP12 ≥26 → CHP12-2 cap 42)
4. `route.min_solo_pax` → คน ≥ เกณฑ์ → วิ่งเดี่ยว (P7, ปกติ 7)
5. มิฉะนั้น → ยุบ: ไล่ `merge_group` ตาม priority, ถ้าสมาชิกที่ยุบ (≥2 สาย) รวมกัน ≤ `seat_cap` และ `only_slot` ตรง → 1 คันรวม; เหลือยุบไม่ลง → วิ่งเดี่ยว

จัดที่นั่ง: เรียงตามลำดับจุด (`stop_seq`) แล้วไล่ 1..cap, ล้น cap = เปิดคันถัดไป

## ข้อสมมติ (assumption) ที่ฝังใน engine — ปรับได้

- **ยุบต้องมี ≥2 สาย** ถึงจะใช้คันรวม; สายเล็กเดี่ยว ๆ ที่ยุบไม่ได้ → วิ่งเดี่ยว (kind `solo-fallback`)
- `dispatch_rule` เลือก rule ที่ `priority` ต่ำสุดที่ตรง `bound`
- กฎ "ทุกอย่างเป็น data" — แก้ผ่าน adminServer หรือ SQL ได้โดยไม่ต้องแก้โค้ด engine

## แผน integration (เฟส cutover)

1. **ทดสอบ:** รัน migrate กับ DB copy → `pack.test.js` → `runPack.js <date>` ดูแผน เทียบกับที่ HR คาดหวัง → ปรับกฎผ่าน adminServer
2. **แทน `runDaily`/`chpPack` เดิม:** ใน `index.js` เปลี่ยน `GET /daliy` ให้เรียก `require('./chp2/pack').commitPlan(...)` (stage `system`) แทน `chpPack` — เมื่อพร้อมตัดไป chp2
3. **mount หน้า admin:** ย้าย route ใน `adminServer.js` เป็น `express.Router` แล้ว `app.use('/chp2-admin', requireRole('admin'), router)` ใน `index.js` (ตอนนี้แยกเป็น server ต่างหากเพื่อไม่ชน live)
4. ทยอย rewrite endpoint อื่นที่อ่าน/เขียน `chp.*` ให้ใช้ `chp2.*`

## ยังไม่ทำ / ต้องเก็บต่อ

- เงื่อนไขพิเศษบางอย่างที่ยังต้องยืนยัน (P2 CHP14 else-group, GroupC = 20:15 ใส่แล้ว) — ดู comment ใน `migrate/02_*.sql`
- driver assignment (ใครขับคันไหน) ยังไม่ทำใน engine — stage `system` เว้น `driver_id` ไว้ให้ HR เติม (เหมือนเดิม)
- หน้า admin ยังไม่มี auth (รันเดี่ยวเพื่อทดสอบ) — ต้องใส่ `requireRole('admin')` ตอน mount เข้า index.js
