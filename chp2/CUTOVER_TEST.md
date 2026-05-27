# Full cutover -> chp2 : test plan + steps (branch `chp2-full-cutover`)

ทั้งระบบย้ายมาอ่าน/เขียน `chp2` ผ่าน adapter `chp2/store.js` แล้ว
ตาราง pipeline ชั่วคราว (`driver/seatdriver/bustoday/seattoday/busfromhr/seatfromhr`)
ยังเป็น chp scratch แต่ engine RMT ใหม่เป็นคนป้อน (approach A)

## สิ่งที่เปลี่ยน (อยู่บน branch นี้)
| ส่วน | เดิม | ใหม่ |
|---|---|---|
| users (member/register/approve/json) | chp.users | chp2.employee |
| booking LIFF (nextweek/thisweek อ่าน+เขียน) | chp.thisweek/nextweek (grid) | chp2.booking + booking_ride |
| dashboards / sumthisweek / hrnextweek | chp.* | chp2 (ผ่าน store) |
| /daliy จัดรถ | chpSpilloverA/B + caps | **engine RMT** (chp2 rules) → เขียน chp.driver/seatdriver รูปแบบเดิม |
| autoapprove / reset | chp.thisweek | chp2.booking |
| /weekly, /tranfernextweekforhr | rollover/snapshot | **no-op** (chp2 ใช้ week_of) |
| pipeline editors / busfromhr / downloads / changelog | chp scratch | **ไม่เปลี่ยน** (engine ป้อน) |

## ⚠️ ก่อน cutover จริง: sync chp -> chp2 รอบสุดท้าย
chp2 ถูก migrate มาครั้งเดียว แต่ main (live) ยังเขียน booking ลง chp เรื่อย ๆ
→ ก่อนสลับ ต้อง refresh chp2 จาก chp ล่าสุด **ในช่วง freeze (ศุกร์ ≥15:00 / เสาร์-อาทิตย์ ที่ booking ปิด)**:
```bash
psql "$DATABASE_URL" -f migrate/02_routes_stops_employees.sql   # employees/stops (เผื่อมีคนลงทะเบียนใหม่)
psql "$DATABASE_URL" -f migrate/04_bookings.sql                 # bookings ล่าสุด
```
(01 ไม่ต้องรันซ้ำถ้าไม่อยากล้าง chp2; แต่ 02 มี DELETE/insert employees — ตรวจก่อน หรือปรับเป็น upsert)

## วิธีเอา branch ไปทดสอบ
- **ตัวเลือก 1:** Railway → สร้าง service/environment ชี้ branch `chp2-full-cutover` (ใช้ DATABASE_URL เดิม — chp2 อยู่ DB เดียวกัน)
- **ตัวเลือก 2:** รัน local — `git checkout chp2-full-cutover && npm start` (ต้องมี .env: DATABASE_URL, CHANNEL*, LIFF_*, AUTH_SECRET) แล้วเปิดผ่าน LINE/LIFF

## เช็กลิสต์ทดสอบ (เน้น LIFF/LINE ที่ผมเทสต์เองไม่ได้)
- [ ] `/login` admin → `/member` แสดงรายชื่อ (chp2.employee), กดเปลี่ยน approval/department ได้
- [ ] register ผ่าน LINE (LIFF) → ได้รายชื่อใหม่ใน /member + แจ้งเตือน admin
- [ ] **booking LIFF**: เปิด nextweek/thisweek ผ่าน LINE → เห็นตารางเดิมของตัวเอง (chp2), เลือกเวลาแล้วบันทึก → เปิดใหม่ค่าตรง
- [ ] dashboards (/thisweekdashboard, /nextweekdashboard, /sumthisweek) แสดงถูก
- [ ] `/hrnextweek` แสดง booking สัปดาห์หน้า
- [ ] `/chp2/rules` → "ลองจัดดู" ใส่วันที่ เห็นแผน + validation
- [ ] **`/daliy`** (กดเอง) → engine จัด เขียนลง chp.driver/seatdriver → หน้า `/driver` แสดงรถ/ที่นั่ง (กฎ RMT)
- [ ] `/driversendtohr` → ขึ้น bustoday; `/sendmsgtodriver` → push คนขับ + ขึ้น busfromhr
- [ ] `/seatfromhr`, `/busfromhr`, downloads, `/changelog` แสดงถูก
- [ ] passenger เปิด detail ผ่าน LINE เห็นที่นั่งตัวเอง

## ตัดจริง (เมื่อเทสต์ผ่าน)
1. freeze (ช่วง booking ปิด)
2. sync chp→chp2 (ข้างบน)
3. `git checkout main && git merge chp2-full-cutover && git push` → Railway redeploy main
4. ยืนยันใช้งานจริง → เก็บ chp เป็น backup สักระยะ ค่อย `DROP SCHEMA chp CASCADE`

## หมายเหตุ / ค้างไว้
- **/supervisor** render ว่าง — chp2 ยังไม่มีฟิลด์ `supervisor` (ของเดิมก็พึ่ง column ที่อาจไม่มี) ถ้าจะใช้ต้องเพิ่ม employee.supervisor + เติมข้อมูล
- โค้ดเก่าที่ไม่ใช้แล้ว (chpPack/chpSpillover*/caps loader/chpTransfer*/chpDeriveRoute) ยังค้างใน index.js — เป็น dead code (ลบได้ใน cleanup pass ภายหลัง)
- pipeline ยังเป็น chp scratch (ตามที่เลือก A) — ถ้าจะ DROP chp ทั้ง schema ต้องย้าย pipeline + change_log ไป chp2 ก่อน
