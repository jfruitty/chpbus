# Migration: `chp.*` → `chp2.*` (schema ที่ normalize แล้ว)

ชุดสคริปต์นี้สร้าง schema ใหม่ `chp2` **คู่ขนาน** กับ `chp` เดิม แล้วย้ายข้อมูลเข้า
ไม่แตะ `chp.*` ของจริงเลย จนกว่าจะ cutover

## สรุปการเปลี่ยนโครงสร้าง

| เดิม (`chp.*`) | ใหม่ (`chp2.*`) |
|---|---|
| `lastweek` / `thisweek` / `nextweek` / `hrnextweek` | `booking` (+`booking_ride`) คั่นด้วย `week_of` |
| 14 คอลัมน์ `*_inbound/_outbound` | แถวใน `booking_ride` |
| `driver`/`bustoday`/`busfromhr` | `bus_trip` (คอลัมน์ `stage`) |
| `seatdriver`/`seattoday`/`seatfromhr` | `seat_assignment` |
| `*history*` ×6 (ตารางตาย) | ตัดทิ้ง (ใช้ `change_log` + `stage`) |
| `users` | `employee` (FK → `route_stop`) |
| `route` (ชื่อ string ซ้ำทุกที่) | `route` (สาย) + `route_stop` (จุด, มี `seq`) |
| caps matrix per-slot (CSV) | **ตัดทิ้ง** — กฎ RMT ใช้ค่าคงที่ 7/13/26 แทน |
| เงื่อนไขรวมสาย RMT ฮาร์ดโค้ดใน JS (`chpSpilloverA/B`) | `merge_group` + `merge_group_member` + `dispatch_rule` + flag บน `route` (**แก้เองได้ผ่าน admin**) |
| `chpTimeToIndex` ฮาร์ดโค้ด | `time_slot` (6 ช่อง) |

**สาย (route) กับ จุด (stop) แยกตาราง** — 1 สายมีหลายจุด เพราะความจุ/การจัดรถผูกที่ระดับ "สาย"
ส่วนเลขจุด (`seq`) ใช้เรียงลำดับวิ่งรับ + ทำ manifest

## ลำดับรัน (สำคัญ — มี dependency)

```
01_chp2_schema.sql            # สร้าง schema + ตาราง (DROP chp2 ทิ้งแล้วสร้างใหม่)
02_routes_stops_employees.sql # seed สาย/ช่องเวลา/เงื่อนไขรวมสาย(RMT), แตกจุดจาก location, ย้าย employee
04_bookings.sql               # thisweek/nextweek/lastweek → booking + booking_ride
05_assignments.sql            # pipeline 6 ตาราง → bus_trip + seat_assignment
```

(03_caps.sql ถูกตัดทิ้ง — เลข 03 ว่างไว้ ไม่ได้ใช้)
02 ต้องมาก่อน 04/05 (ทุกไฟล์อ้าง `route` / `route_stop` / `employee` ที่ 02 สร้าง)

## วิธีรัน

⚠️ **รันกับ DB copy ก่อนเสมอ** อย่ารันกับ prod (kodama) ตรง ๆ จนกว่าจะ validate ผ่าน

```bash
# ทีละไฟล์ (เห็นผล validation ท้ายไฟล์)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrate/01_chp2_schema.sql
psql "$DATABASE_URL" -f migrate/02_routes_stops_employees.sql
psql "$DATABASE_URL" -f migrate/04_bookings.sql
psql "$DATABASE_URL" -f migrate/05_assignments.sql

# หรือรวดเดียว
psql "$DATABASE_URL" -f migrate/run_all.sql
```

## จุดที่ต้องไล่ดูหลังรัน (แต่ละไฟล์มี validation ท้ายไฟล์)

- **02**: query โชว์ `location` ที่ parse/จับคู่สายไม่ได้ + พนักงานที่ผูก `home_stop` ไม่ได้
  → เป็น edge case ของรูปแบบ `[NN]สาย จุด` (เว้นวรรคผิด/ชื่อสายไม่ตรง catalog) ต้องตามเก็บ;
  และดูตาราง merge_group/สมาชิก/เวลาที่จำกัด (GroupC = 20:15)
- **04**: เทียบ `src_thisweek_matched` กับ `dst_thisweek_bookings` (ควรเท่ากัน); ดูค่าเวลาที่ถูกข้าม
- **05**: ที่นั่ง/สายที่ map ไม่ติด (ปกติ pipeline ว่างก็ได้ 0 แถว — ไม่ผิด)

## แผน cutover

สคริปต์ชุดนี้ย้าย **ข้อมูล** เท่านั้น ตัวแอป live (`index.js`) ยัง query `chp.*` อยู่
โค้ดใหม่ที่ทำงานบน `chp2` ถูกแยกไว้ในโฟลเดอร์ `chp2/` (ดู `chp2/README.md`) — ยังไม่ยุ่งกับ live

1. **เตรียมข้อมูล (เสร็จแล้ว):** schema + ย้ายข้อมูลเข้า `chp2` บน DB copy → validate
2. **packing engine + หน้า admin (กำลังทำ → `chp2/`):** engine อ่านกฎจาก
   `merge_group`/`dispatch_rule`/flag (priority P1-8) แทน `chpSpilloverA/B`; หน้า admin แก้กฎ
   (route settings / merge groups / dispatch rules) + **validation** (15/16 ห้ามอยู่ในกลุ่ม, cap>0)
   + **ปุ่ม dry-run** ลองจัดก่อน apply
3. **เขียน data-access อื่นใหม่:** rewrite endpoint ที่เหลือใน `index.js` ให้ใช้ `chp2`
4. **ตัดจริง:** freeze การเขียน → รัน migrate บน prod → deploy แอปใหม่ → สลับมาใช้ `chp2`
5. เก็บ `chp.*` ไว้เป็น backup สักระยะ แล้วค่อย `DROP SCHEMA chp CASCADE`

> ปล. การ migrate นี้ idempotent ระดับ "รันใหม่ได้" — ไฟล์ 01 ลบ `chp2` ทิ้งแล้วสร้างใหม่
> ดังนั้นรัน 01→05 ซ้ำได้เรื่อย ๆ ระหว่างทดสอบ
