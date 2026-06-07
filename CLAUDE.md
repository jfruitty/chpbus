
# CLAUDE.md

ไฟล์นี้เป็นคู่มือให้ Claude Code (claude.ai/code) ใช้ทำงานกับโค้ดใน repo นี้

> หมายเหตุ: เอกสารนี้อธิบายโค้ด **เวอร์ชันปัจจุบัน** ซึ่งเป็นเวอร์ชัน refactor ที่ใช้ schema `chp.*`
> ไฟล์สำรองของเวอร์ชันเก่า (`gateway.*`) คือ [index.gateway.bak.js](index.gateway.bak.js) — อย่าเอามาอ้างอิง

## คำสั่ง (Commands)

- `npm start` — รัน server (`node index.js`)
- `npm run dev` — รันด้วย `nodemon` (auto-reload; `nodemon` ไม่ได้อยู่ใน `devDependencies` ต้องลง global หรือใช้ `npx`)
- `npm test` — **ยังไม่มี**; script แค่ `exit 1` ไม่มี test framework
- มี lint config ([.eslintrc.json](.eslintrc.json), `eslint-config-standard`) แต่ไม่มี `lint` script — รันเองด้วย `npx eslint index.js`
- Server อ่าน port จาก `process.env.PORT` (default `3000`) ที่ [index.js:2598](index.js#L2598)

## การตั้งค่า (Configuration)

Secret ทั้งหมดอยู่ใน `.env` (gitignored, โหลดผ่าน `dotenv`):

- `DATABASE_URL` — connection string ของ PostgreSQL (pool ตั้งที่ [index.js:17-24](index.js#L17-L24), `ssl.rejectUnauthorized: false`, `max: 95`)
- `CHANNELACCESSTOKEN`, `CHANNELSECRET` — credential ของ LINE Messaging API
- `LINE_CHANNEL_ID` — ใช้ตรวจ client_id ตอน verify access token
- `LIFF_REGISTER`, `LIFF_NEXTWEEK`, `LIFF_THISWEEK`, `LIFF_DETAIL`, `LIFF_SUPAPPROVE`, `LIFF_HR` — LIFF ID แยกตามหน้า (โหลดเข้า object `liffIds` ที่ [index.js:68-75](index.js#L68-L75) — **ไม่ฮาร์ดโค้ดแล้ว**)
- `ADMIN_LINE_USERS` — LINE userId ของ admin/HR (คั่นด้วย comma) ใช้เป็นปลายทาง push แจ้งเตือน
- `ERROR_NOTIFY_USER` — userId ปลายทางแจ้งเตือนเมื่อ cron ล้มเหลว

Deploy จริงอยู่บน **Railway** (host โซน Singapore UTC+8) — cron ย้ายมาไว้ในแอปแล้ว (ดูหัวข้อ Scheduler)

[README.md](README.md) เป็น **starter content เก่าค้าง** (อ้างถึง `config.json` กับ port ที่ตั้งค่าได้ ซึ่ง fork นี้ไม่ใช้แล้ว) — ข้ามไป

## สถาปัตยกรรม (Architecture)

เป็น **monolith ไฟล์เดียว**: logic ฝั่ง server แทบทั้งหมดอยู่ใน [index.js](index.js) (~2600 บรรทัด) เป็น Express app ที่ serve หน้า LIFF mini-app (render ด้วย EJS) + LINE webhook เพื่อจัดการระบบจองรถรับส่งพนักงานรายสัปดาห์ของ Resonac (โรงงาน CHP/Gateway) ข้อมูลอยู่ใน PostgreSQL schema `chp.*`

### โครงสร้างไฟล์ในโปรเจกต์

```
chpbus/
├── index.js                  # monolith server ทั้งหมด (~2600 บรรทัด)
├── index.gateway.bak.js      # backup เวอร์ชันเก่า gateway.* (ไม่ track ใน git, local เท่านั้น) — อย่าอ้างอิง
├── package.json / package-lock.json
├── .eslintrc.json            # eslint-config-standard (ไม่มี lint script)
├── .env                      # secrets (gitignored) — ดูหัวข้อ Configuration
├── README.md                 # starter เก่าค้าง — ข้าม
├── CLAUDE.md                 # ไฟล์นี้
│
├── chp_schema.sql            # dump schema ปัจจุบัน (chp.*)
├── gateway_schema.sql        # dump schema เก่า (gateway.*) — อ้างอิงประวัติ
├── import_chp.sql            # script import/staging (chp._stage_*)
├── import_chp_fix.sql        # patch ของ import ข้างบน
├── Shutterbus - *.csv        # ข้อมูล import (member/nextweek/thisweek/util);
│                             #   "Shutterbus - sumthisweek.csv" = แหล่ง caps matrix ที่ chpPack โหลดตอน startup
│
├── views/                    # EJS templates
│   ├── (ใช้จริง) login, member, thisweekdashboard, nextweekdashboard,
│   │            sumweek (ใช้ทั้ง /sumthisweek + /sumnextweek), chp2rules,
│   │            supervisor, hrnextweek, driver, seatdriver, bustoday, seattoday,
│   │            busfromhr, seatfromhr, bushistory, seathistory, changelog,
│   │            register, nextweek, thisweek; partials/adminmenu
│   └── (legacy/ไม่ถูกใช้) index, hr, newbookingpage, driverplan, oldnextweek,
│                          oldthisweek, drivercheck   (detail.ejs ถูกอ้างแต่ไฟล์ไม่มีจริง)
│
└── public/                   # static assets (mount ที่ "/" และ "/static")
    ├── css/   styles, dashboard, modal-form, thisweekdashboard, member, driver
    └── js/    picker, sum, dashboard, member, table-tools,         # shared/helper
                driver, seatdriver, bustoday, seattoday,            # client-render หน้า list (fetch *json)
                busfromhr, seatfromhr, changelog
```

### LINE / LIFF

- LINE webhook: `POST /callback` ([index.js:2468](index.js#L2468)) ผ่าน middleware ตรวจลายเซ็น HMAC-SHA256 `validateSignatureMiddleware` ([index.js:2395](index.js#L2395)) — ใช้ค่า `channelSecret` constant อย่างถูกต้อง (บั๊ก `config` undefined ของเวอร์ชันเก่าถูกแก้แล้ว)
- LIFF mini-app ยืนยันตัวตนด้วย LINE access token ผ่าน `POST /verifyaccesstoken` ([index.js:256](index.js#L256)) ตรวจ client_id เทียบกับ `LINE_CHANNEL_ID`
- หน้า admin/HR ใช้ middleware `requireRole('admin')`
- **หน้า `/register`** (LIFF): ถ้าลงทะเบียนแล้ว (approved/standby) จะโชว์การ์ดโปรไฟล์ + **การ์ดแก้จุดขึ้นรถของตัวเอง** (dropdown จุด group ตามสาย) — ดึงรายการจาก `GET /stopsjson` แล้ว save ผ่าน `POST /update-my-location` (ยืนยันด้วย access token, อัปเดต `employee.home_stop_id` ซึ่ง `upsertBooking` ใช้ derive route ตอนจองครั้งถัดไป). ถ้ายังไม่ลงทะเบียน → ฟอร์มสมัคร (`POST /register`)

### Schema ฐานข้อมูล (`chp.*`)

ตารางแบ่งเป็น 3 กลุ่ม โดยตารางในกลุ่มเดียวกัน column เหมือนกันหมด ข้อมูลจึงไหลด้วย `INSERT INTO ... SELECT FROM` ได้

- **Booking** (grid รายสัปดาห์ของแต่ละคน): `lastweek`, `thisweek`, `nextweek` — 1 แถว = user × route หนึ่งราย มี 14 column `monday_inbound`/`monday_outbound`/.../`sunday_outbound` (ค่าเป็นเวลา `"HH:MM"` หรือ sentinel `'ไม่ใช้'`) + `department_approval`
  - `hrnextweek` — snapshot ของ `nextweek` ที่ HR ใช้ (เพิ่ม column `week_of`) สร้างทุกศุกร์ เก็บแยกตามสัปดาห์
- **Bus assignment** (pipeline system → driver → HR): `driver` → `bustoday` → `busfromhr` (column: route/day/bound/time/`bus_number` + `driver_user_id` + ชื่อ + `service_date`)
- **Seat list** (รายผู้โดยสาร): `seatdriver` → `seattoday` → `seatfromhr` (column: route/location/day/bound/time/`busnumber`/`seat` + ชื่อ)
- อื่น ๆ: `users` (พนักงานที่ลงทะเบียน), `route` (แค็ตตาล็อกเส้นทาง), `change_log` (audit trail)

**ข้อควรรู้สำคัญ (อย่าหลงตามชื่อตาราง):**
- ตาราง history 6 ตัว (`driverhistoryfrom*`, `seathistoryfrom*`) **เป็นตารางตาย** — ไม่มีโค้ดอ่านหรือเขียนเลย หน้า `/bushistory` กับ `/seathistory` จริง ๆ อ่านจาก `busfromhr`/`seatfromhr`
- ตาราง `locations` กับ `approvalstatus` **ไม่ถูกใช้** (คำว่า approvalstatus มีเฉพาะเป็น column ใน `users`)
- "ประวัติ" ที่ใช้จริงคือ: `busfromhr`/`seatfromhr` (snapshot batch ล่าสุด) + `change_log` (audit) + `hrnextweek` (snapshot booking รายสัปดาห์)
- ⚠️ โค้ดอ้าง column `users.supervisor` (ที่ `/supervisor`, `/hrnextweek`) แต่ schema dump ไม่มี column นี้ — น่าจะถูกเพิ่มนอก migration ถ้าแตะส่วนนี้ต้องเช็ก
- `service_date` (วันที่จริง) ถูกเพิ่มเข้า pipeline tables ผ่าน migration แบบ additive ([index.js:46-51](index.js#L46-L51))
- ชื่อ column ไม่สม่ำเสมอ: ฝั่ง bus ใช้ `bus_number`/`per_id` แต่ฝั่ง seat ใช้ `busnumber`/`perid`; day ฝั่ง bus เป็นอังกฤษ (monday) ฝั่ง seat เป็นไทย (จันทร์)

### Migration ตอน startup

`chpEnsureSchema()` รันทุกครั้งที่บูต เป็นแบบ additive ล้วน (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) ปลอดภัย ไม่แตะข้อมูลเดิม — สร้าง `hrnextweek`, `change_log`, `error_log` และเพิ่ม column `service_date`

### วงจรข้อมูลรายสัปดาห์ (ส่วนที่ต้องเข้าใจให้ขึ้นใจ)

1. พนักงานจองสัปดาห์หน้าผ่าน LIFF (`POST /nextweek`, [index.js:1254](index.js#L1254)) → เขียนลง `chp.nextweek` (`route` ถูก derive จาก pickup `location` ของ user ผ่าน `chpDeriveRoute`); มี cutoff ล็อก: **ศุกร์ ≥ 14:00 BKK** และเสาร์/อาทิตย์ จะจองไม่ได้ เปิดอีกครั้งจันทร์ 00:00 (`isAfterChpCutoff` คิดเป็นเวลา BKK ด้วย +7h offset แล้ว — ตรงกับ guard ฝั่ง client `isAfter2pmOnFriday()` ใน [views/nextweek.ejs](views/nextweek.ejs) ที่ใช้เวลาเครื่องผู้ใช้)
2. **Rollover รายสัปดาห์** — `GET /weekly` ([index.js:2274](index.js#L2274)): `thisweek` → `lastweek`, `nextweek` → `thisweek` แล้วล้าง `nextweek`
3. **จัดรถรายวัน** — `runDaily()` ที่ [index.js](index.js) (เปิดเป็น `GET /daliy` ด้วย): ตอนนี้ใช้ chp2 engine (`chp2Pack.planDate` + `commitToChp`) อ่านจาก `chp2.booking` (ไม่ใช่ `chp.thisweek`) แล้วเขียนผลลง `chp.driver` + `chp.seatdriver` รายวัน. **window = 14:30→14:30 BKK ไม่ใช่ทั้งวัน**: จันทร์-พฤหัส รัน 14:30 → จัด "วันนี้-after + พรุ่งนี้-before" ; ศุกร์ 14:30 → จัด "ศ-after + ส-เต็มวัน + อา-เต็มวัน + จ-before". half filter (`before` = slot < 14:30 = 07:30/08:15/10:30 ; `after` = slot ≥ 14:30 = 17:15/19:30/20:15 ; `all` = ทั้งวัน) ส่งผ่านเข้า `loadPassengers` SQL เป็น `AND br.depart_time < '14:30'::time` / `>=`. ข้าม ส./อา. (cron ไม่รัน)
4. **ส่งให้ HR รีวิว** — `POST /driversendtohr` ([index.js:2377](index.js#L2377)): เลื่อน `driver` → `bustoday`, `seatdriver` → `seattoday` แล้วล้างตาราง proposal + push แจ้งเตือน LINE
5. **HR ปิดงาน** — `POST /sendmsgtodriver` ([index.js:1122](index.js#L1122)): push manifest ให้คนขับแต่ละคัน + รายละเอียดที่นั่งให้ผู้โดยสารแต่ละคน แล้วคัด `bustoday` → `busfromhr`, `seattoday` → `seatfromhr` (ตัวที่อ่านโชว์/ดาวน์โหลดจริง)

### การจัดรถ — `chpPack(day, kind, group)`

- `day`: 1=จันทร์ … 7=อาทิตย์ | `kind`: `'before'` (รอบเช้า) / `'after'` (รอบเย็น) | `group`: `'A'` หรือ `'B'`
- มี wrapper 4 ตัว ([index.js:2231-2234](index.js#L2231-L2234)) จับคู่ before/after × A/B
- **ความจุ**: van/รถตู้ = **13** ที่นั่ง, รถบัสใหญ่เส้น `'ลาดบัวขาว รถบัส'` = **42** ที่นั่ง (ค่าฮาร์ดโค้ดอยู่ใน `chpPack`) — ส่วน "เมื่อไหร่ล้นไป route รวม" คุมด้วย **caps matrix** ที่โหลดจาก CSV `Shutterbus - sumthisweek.csv` ตอน startup (ไม่มี constant `MAX_SEATS` แล้ว)
- เมื่อ route เต็มที่ slot นั้น จะ spillover ไป route รวมตาม chain ที่ฮาร์ดโค้ด (`chpSpilloverA`/`chpSpilloverB`)
- seat = `pax % busSize`, `bus_number = ceil(pax / busSize)` (ล้นคันหนึ่งก็เปิดคันถัดไป)

### split `before` vs `after`

ไม่มี array `INVALID_TIMES` แล้ว — การแยกรอบเช้า/เย็นทำผ่าน slot index ใน `chpPack` ([index.js:2175-2176](index.js#L2175-L2176)). `chpTimeToIndex(time, bound)` ให้ index 0–5 ต่อวัน:

| index | bound | เวลา | รอบ |
|---|---|---|---|
| 0 | ขาเข้า | 07:30 | before (เช้า) |
| 1 | ขาออก | 08:15 | before |
| 2 | ขาเข้า | 10:30 | before |
| 3 | ขาออก | 17:15 | after (เย็น) |
| 4 | ขาเข้า | 19:30 | after |
| 5 | ขาออก | 20:15 | after |

`'before'` เก็บ index < 3 (เช้า), `'after'` เก็บ index ≥ 3 (เย็น) — แยก cohort เช้า/เย็นของแต่ละวันให้จัดรถแยกกัน

### Scheduler (node-cron ในแอป)

`chpStartSchedulers()` ([index.js:2586](index.js#L2586)) ตั้ง cron 3 งาน ทุกงานใช้ `{ timezone: 'Asia/Bangkok' }` (host อยู่ SG UTC+8 แต่ node-cron ตีความ expression เป็นเวลา BKK ให้เอง):

| cron | เวลา BKK | งาน |
|---|---|---|
| `0 0 * * *` | ทุกวัน 00:00 | `chpResetApprove` — เซ็ต `thisweek` ทุกแถวเป็น `'pending'` |
| `30 13 * * 5` | ศุกร์ 13:30 | `chpSnapshotNextweekForHr` — snapshot `nextweek` → `hrnextweek` (ต้องก่อน 14:30) |
| `30 14 * * 1-5` | จ.–ศ. 14:30 | `runDaily` — จัดรถ + rollover (วันศุกร์) |

ทุกงาน trigger เองได้ผ่าน endpoint: `GET /daliy`, `GET /autoresetapprove`, `GET /tranfernextweekforhr`, `GET /weekly`
helper เวลา (`bangkok*`) บวก +7h เองถูกต้อง — `isAfterChpCutoff()` ([index.js:321](index.js#L321)) ก็ใช้ +7h offset แล้วอ่าน `getUTCDay()`/`getUTCHours()` เช่นกัน (เคยเป็นบั๊กที่ใช้ `getDay()`/`getHours()` ของ server ตรง ๆ ทำให้ cutoff เพี้ยนตาม timezone ของ host — แก้แล้ว)

### View layer

**Sidebar เมนู admin (ทุกหน้า):** ทุกหน้า admin include partial เดียวกัน [views/partials/adminmenu.ejs](views/partials/adminmenu.ejs) — เมนูจัดเป็น **4 กลุ่มยุบ-ขยายได้** (สมาชิก&การจอง / จัดรถ / ผล HR&ประวัติ / ระบบ) ลิงก์ครบทุกฟังก์ชัน รวม **เงื่อนไขจัดรถ (RMT) → `/chp2/rules`** (อยู่กลุ่ม "ระบบ"). กลุ่มที่มีหน้าปัจจุบันจะเปิดไว้กลุ่มเดียว (คำนวณ server-side จาก `res.locals.currentPath` ที่ middleware [index.js:91](index.js#L91) เซ็ต = `req.path`; /chp2/rules match แบบ prefix) คลิกหัวกลุ่มเพื่อ toggle. partial มี `<style>`/`<script>` ในตัว ใช้คลาส `.adminmenu*` เฉพาะ จึงไม่ชนกับ CSS ของหน้า. ⚠️ การใส่ attribute แบบมีเงื่อนไข (`class="active"`) ต้องใช้ `<%-` (raw) ไม่ใช่ `<%=` ไม่งั้น `"` จะโดน escape เป็น `&#34;` แล้วพัง
- หน้า `/chp2/rules` (จาก [chp2/adminRouter.js](chp2/adminRouter.js)) render ผ่าน view [views/chp2rules.ejs](views/chp2rules.ejs) ซึ่งเป็น **shell เดียวกับหน้า admin อื่น** (sidebar + partial เมนู, โหลด `driver.css`) แล้วฉีด body HTML ที่ router สร้างเข้าไป (`res.render('chp2rules', mk(title, base, body))`). ฟังก์ชัน `layout()` เดิม (HTML standalone) เหลือใช้แค่ error handler
  - มี **2 รายการในเมนู sidebar** ชี้คนละหน้า: **"จัดการสายและจุด"** → `/chp2/rules/routes` (แก้สาย/จุด) และ **"เงื่อนไขจัดรถ (RMT)"** → `/chp2/rules` (= root) ซึ่งเป็น **หน้า landing ของ engine ขั้นสูง** (ไม่ redirect ไป `/routes` แล้ว — เคยเป็นบั๊กที่ทำให้ทั้งสองเมนูเด้งไปหน้าเดียวกัน). landing + ทุกหน้า engine (`/groups`/`/rules`/`/dryrun`) มี **sub-nav pill bar** ร่วม (helper `engineNav(base, active)`) ลิงก์ ภาพรวม/กลุ่มรวม/กฎจุด-ทิศ/ลองจัดดู — ไม่รวม `/routes` (เป็นคนละเมนู)
  - หน้า `/routes` (จัดการสายและจุด) มีแค่ การ์ดต่อสาย (แก้รหัส/ชื่อ, ดูจุด, ลิงก์ "จัดการจุด" → `/routes/:id/stops`, ปุ่มลบสาย) + ฟอร์มเพิ่มสายใหม่ที่กรอก **รหัส + ชื่อ + รายชื่อจุด (textarea จุดละบรรทัด → insert พร้อม seq ใน transaction)**. ลบสาย (`POST /routes/:id/delete`) ปฏิเสธถ้าจุดถูกใช้ (employee.home_stop_id/booking.pickup_stop_id) → `?err=inuse`, หรือถูกอ้างใน engine config (FK 23503) → `?err=ref`
  - หน้า **engine ขั้นสูง (`/groups` กลุ่มรวม, `/rules` กฎจุด/ทิศ, `/dryrun`+`/commit` ลองจัดดู) เข้าถึงผ่านเมนู "เงื่อนไขจัดรถ (RMT)" + sub-nav** (โค้ด/handler ครบ; `validate()`/`PG_OPTS` ยังเป็น dead code แต่คงไว้). flag ราย route (`never_merge`/`min_solo_pax`/`bus_threshold`/`bus_route_id`/`seat_capacity`/`pack_group`) ไม่มี UI แก้แล้ว — ค่าเดิมใน DB ยังอยู่และ engine ใช้ตามเดิม; สายที่สร้างใหม่ default `pack_group='A'`, `seat_capacity=13`. `POST /routes/:id` (อัปเดต flag) และ `POST /routes/:id/info` (เปลี่ยนแค่ code/name แล้ว ไม่แตะ pack_group) ยังอยู่

EJS templates อยู่ใน [views/](views/), static อยู่ใน [public/](public/) (mount ที่ `/static` ด้วย) มี 2 รูปแบบ:
- **server-rendered** (วน `rows` ใน EJS): `member`, `thisweekdashboard`, `nextweekdashboard`, `sumweek`, `supervisor`, `hrnextweek`, `busfromhr`, `seatfromhr`
  - `sumweek.ejs` ใช้ร่วมกันโดย `/sumthisweek` กับ `/sumnextweek` ([index.js](index.js) `buildSumData(which)` นับหัวคนต่อ สาย×วัน×รอบ จาก `getDashboard(which)` = `chp2.booking`); แสดงเป็น **แท็บแยกวัน** ตารางจัดกลุ่มขาเข้า/ขาออก + ยอดรวมแถว/คอลัมน์ ซ่อนสายที่ไม่มีคนจองในวันนั้น (default แท็บ = วันนี้สำหรับ this / จันทร์สำหรับ next, fallback วันแรกที่มีข้อมูล)
- **client-rendered** (`<tbody>` ว่าง, JS fetch endpoint `*json` มา build เอง): `driver`, `seatdriver`, `bustoday`, `seattoday`, `changelog` และ LIFF app (`register`, `nextweek`, `thisweek`) — contract ของ field อยู่ใน `public/js/*.js` ไม่ใช่ใน template

**Modal เพิ่ม/แก้รถ + ผู้โดยสาร (`driver`/`seatdriver`):** dropdown สายรถ**ไม่ฮาร์ดโค้ดแล้ว** — โหลดจาก `GET /routenamesjson` (chp2.route, แยก optgroup สายเดี่ยว/สายรวม + ตัวเลือก "อื่นๆ" พิมพ์เอง) ผ่าน `loadRoutePicker()` ใน [public/js/picker.js](public/js/picker.js); helper เดียวกันมี `selectRouteValue()` (prefill สายตอน edit) และ `enableModalDismiss()` (ปิดด้วยปุ่ม ✕ / คลิกฉากหลัง / Escape) สไตล์ modal อยู่ใน [public/css/modal-form.css](public/css/modal-form.css). แก้ผู้โดยสาร (`/editpaxdriver` → `chp.seatdriver`, `/editpaxtoday` → `chp.seattoday`) ใช้ helper เดียวกัน `chpEditPax()` ([index.js:1029](index.js#L1029)) ซึ่ง **กัน blank/NaN แล้ว**: `busnumber`/`seat` ที่ส่งมาว่าง → `parseInt` ได้ NaN → แปลงเป็น `null` แล้ว `COALESCE` กลับเป็นค่าเดิม, `route` ว่าง → `COALESCE(NULLIF($2,''), route)` คงค่าเดิม. ดังนั้น submit โดยไม่กรอกบางช่อง = แก้เฉพาะช่องที่กรอก (ไม่ crash ด้วย `invalid input syntax for type integer: NaN` แบบเดิมที่ยังไม่ได้กัน) — การ prefill ในฟอร์มยังควรทำเพื่อ UX แต่ไม่ใช่เงื่อนไขกัน crash อีกต่อไป

template ที่ไม่ถูกใช้/พัง (ข้ามได้): `index.ejs`, `hr.ejs`, `newbookingpage.ejs`, `driverplan.ejs`, `oldnextweek.ejs`, `oldthisweek.ejs`, `drivercheck.ejs`; และ `GET /detail` ([index.js:1442](index.js#L1442)) เรียก `res.render('detail')` ทั้งที่ไฟล์ `detail.ejs` **ไม่มีอยู่จริง** (route นี้พัง)

### Export CSV/Excel

endpoint `GET /download-csv-*` และ `/download-excel-*` ใช้ `csv-writer` / `exceljs` dump ตาราง bus/seat ให้ HR (ผ่าน `chpDownloadCsv`/`chpDownloadExcel`) — เขียนไฟล์ temp ลง disk แล้ว serve ด้วย `res.download()` และ `fs.unlink` ลบทิ้งใน callback
- ชื่อไฟล์ temp ทำให้ **ไม่ซ้ำต่อ request** ผ่าน helper `chpTmpPath()` (`{ชื่อ}-{pid}-{counter}.ext` ใน `os.tmpdir()`) — เดิมใช้ชื่อคงที่ใน root โปรเจกต์ ทำให้กดโหลดซ้อนกันแล้ว `unlink` ของ request แรกลบไฟล์ทิ้งระหว่างที่ request ที่สอง stat อยู่ → `ENOENT` (เคยเจอจริงที่ `/download-excel-seattoday`). ชื่อที่ผู้ใช้ดาวน์โหลดยังคุมด้วย arg ที่ 2 ของ `res.download` (เช่น `seattoday.xlsx`)

### การแจ้งเตือน (Notifications)

- `sendPushMessage(userIds, msg)` ([index.js:202](index.js#L202)) ยิง LINE `/v2/bot/message/multicast` ไปยัง `adminLineUsers` (จาก env `ADMIN_LINE_USERS`)
- `telegramNotify(msg)` ([index.js:181](index.js#L181)) โพสต์เข้า Telegram bot/chat ใช้แจ้ง deploy + pipeline

### Audit log

`chpLog(actor, action, rowId, detail)` เขียน `change_log` (ไม่มีวัน throw) มี middleware บันทึก POST ที่แก้ข้อมูลทุกตัวที่สำเร็จ (status < 400) อัตโนมัติ ดูผ่าน `GET /changelogjson`
- `detail` เก็บเป็น **`{ before, after }`**: `after` = body ที่ส่งมา; สำหรับ `edit`/`remove` middleware จะ `SELECT *` แถวนั้น **ก่อน** handler แก้ (ตาม map `CHP_LOG_TABLE`) มาใส่ `before` เพื่อให้หน้า log โชว์ diff old → new ได้
- การแปลงให้อ่านง่ายอยู่ **ฝั่ง client** ([public/js/changelog.js](public/js/changelog.js)): `formatDetail()` + `canonFields()` normalize ชื่อ field ทั้งฝั่ง DB (`per_id`/`busnumber`/`seat`) และฝั่ง form (`perid`/`bus_number`/`seat_number`) เป็น label ไทย, แปลงวัน/รอบเป็นไทย, insert โชว์ค่าทั้งหมด / edit โชว์เฉพาะ field ที่เปลี่ยน (`เดิม → ใหม่`) / remove สรุปแถวที่ลบ. รองรับ row เก่าที่ detail เป็น body ดิบ (ไม่มี wrapper) ด้วย

### System error log (ภายใน — ไม่โชว์ให้ user)

ตาราง `chp.error_log` (สร้างใน `chpEnsureSchema`) เก็บ error ของระบบไว้ debug — **ไม่มี endpoint/หน้าใดอ่านมาแสดง** ดูได้จาก DB ตรง ๆ เท่านั้น
- `console.error` ถูก**ห่อทับตอน startup** ([index.js](index.js) ใต้ pool): ทุก `console.error('... failed:', err)` ที่มีอยู่แล้วทั้งแอปจะถูกเขียนลง `error_log` อัตโนมัติ (ไม่ต้องแก้ handler ทีละตัว) — เก็บ `message` + `stack`
- request ที่กำลังทำงานถูกพกผ่าน **AsyncLocalStorage** (`chpReqContext`, middleware หลัง body parser) → `logSystemError` แนบ `source`(path)/`method`/`context`(body) ของ request นั้นให้ row เดียวกัน เลย debug 500 ได้โดยไม่ต้อง reproduce (เช่นเคส per_id ยาวเกิน varchar(20))
- best-effort ล้วน: `logSystemError` กลืน error ตัวเอง (ไม่เรียก `console.error` ซ้ำ) จึงไม่ recurse และไม่ทำ action พัง; `process.on('unhandledRejection')` ดักพวกที่หลุดนอก request (cron) ด้วย

## ข้อตกลง / จุดที่ต้องระวังเวลาแก้

- `pg.Pool` แชร์ที่ module scope (`max: 95`, `keepAlive: true`) — handler ที่ `pool.connect()` ต้อง `client.release()` ใน `finally` (ก็อป pattern จาก handler ที่ทำอยู่แล้ว) แต่ **อย่า** เรียก `client.release()` ถ้าใช้ `pool.query(...)` ตรง ๆ
- ค่าที่มาจาก user ใส่ผ่าน parameter `$1, $2, ...` เสมอ — ห้าม string-concat user input เข้า SQL (มีบางจุด interpolate **ชื่อตาราง** เข้า template literal แต่ทุกที่ส่ง constant ที่ฮาร์ดโค้ด ไม่ใช่ค่าจาก user — ปลอดภัย แต่ให้รู้ไว้)
- `process.env.CHANNELACCESSTOKEN` ถูก capture ครั้งเดียวตอน startup เป็น constant `accessToken` ([index.js:64](index.js#L64)) — rotate token แล้วต้อง restart server
- ปลายทาง LINE ของ admin/HR มาจาก env `ADMIN_LINE_USERS` (`adminLineUsers`) ไม่ใช่ค่าฮาร์ดโค้ดแล้ว
