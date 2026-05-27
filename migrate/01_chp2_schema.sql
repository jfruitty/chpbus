-- ============================================================================
-- CHP shuttle-bus — schema ใหม่ (chp2) ที่ normalize แล้ว
-- ----------------------------------------------------------------------------
-- ออกแบบใหม่จาก chp.* เดิม โดยแก้ปัญหาหลัก:
--   - lifecycle (lastweek/thisweek/nextweek) -> คอลัมน์ booking.week_of เดียว
--   - pipeline (driver/bustoday/busfromhr, seat*) -> คอลัมน์ bus_trip.stage เดียว
--   - grid 14 คอลัมน์/วัน -> ตารางแนวยาว booking_ride
--   - สาย(route) กับ จุด(stop) แยกตาราง: 1 route มีหลาย stop (ตามเลข [NN] ใน location)
--   - เงื่อนไขรวมสาย RMT (chpSpilloverA/B) -> merge_group + merge_group_member + dispatch_rule + flag บน route
--   - ผูก FK จริง แทน text ซ้ำทุกตาราง
-- (caps matrix เดิมถูกตัดทิ้ง — กฎ RMT ใช้ค่าคงที่ 7/13/26 แทน per-slot cap)
--
-- รันคู่ขนานกับ chp.* เดิม (ไม่แตะของจริง) จนกว่าจะ cutover
-- re-runnable: ลบ schema chp2 ทิ้งแล้วสร้างใหม่
-- ============================================================================

\set ON_ERROR_STOP on
BEGIN;

DROP SCHEMA IF EXISTS chp2 CASCADE;
CREATE SCHEMA chp2;

-- ---------- enum ----------
CREATE TYPE chp2.bound_t  AS ENUM ('inbound', 'outbound');           -- ขาเข้า / ขาออก
CREATE TYPE chp2.stage_t  AS ENUM ('system', 'driver', 'hr');        -- ระบบจัด -> ส่ง HR -> HR ปิด
CREATE TYPE chp2.appr_t   AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE chp2.period_t AS ENUM ('before', 'after');               -- รอบเช้า / รอบเย็น

-- ============================================================================
-- MASTER / LOOKUP
-- ============================================================================

-- สาย (route) — หน่วยที่ packing/ความจุผูกอยู่
CREATE TABLE chp2.route (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code          text NOT NULL UNIQUE,        -- 'CHP01', 'CHP12-2', 'CHP01+02+03+04', ...
    name          text NOT NULL,               -- 'วัดสว่าง', 'ลาดบัวขาว รถบัส', ...
    pack_group    char(1) NOT NULL CHECK (pack_group IN ('A', 'B')),  -- legacy โซนจัดรถ (กำลังจะเลิกพึ่ง — ใช้ merge_group แทน)
    is_combined   boolean NOT NULL DEFAULT false,  -- true = สายรวม (ใช้เป็น result ของ merge_group)
    seat_capacity int NOT NULL DEFAULT 13,      -- ความจุรถจริง: รถตู้=13, รถบัสใหญ่=42
    -- เงื่อนไขจัดรถ (RMT) — แก้ได้เองผ่านหน้า admin -----------------------------
    never_merge   boolean NOT NULL DEFAULT false,  -- P1: CHP15/16 ไม่รวมทุกกรณี
    min_solo_pax  int,                              -- P7: ผู้โดยสาร >= ค่านี้ -> จัดคันเอง (ปกติ 7)
    bus_threshold int,                              -- P5: ผู้โดยสาร >= ค่านี้ -> ใช้รถบัส (CHP12=26)
    bus_route_id  int REFERENCES chp2.route(id),    -- สายรถบัสที่ใช้แทนเมื่อถึง bus_threshold (CHP12 -> CHP12-2)
    is_active     boolean NOT NULL DEFAULT true
);

-- จุดขึ้นรถ (stop) — แต่ละจุดอยู่บน "สาย" เดียว มีลำดับ (seq = เลข [NN] ใน location เดิม)
CREATE TABLE chp2.route_stop (
    id        int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id  int NOT NULL REFERENCES chp2.route(id),
    seq       int,                              -- ลำดับวิ่งรับ (จาก [NN]); NULL ได้ถ้าข้อมูลเก่าไม่มี
    name      text NOT NULL,                    -- ชื่อจุด เช่น 'ปากทางเข้าวัดลาดบัว'
    is_active boolean NOT NULL DEFAULT true,
    UNIQUE (route_id, seq, name)
);
CREATE INDEX route_stop_route_idx ON chp2.route_stop (route_id, seq);

-- ช่องเวลา 6 ช่อง/วัน (แทน chpTimeToIndex ที่ฮาร์ดโค้ด)
CREATE TABLE chp2.time_slot (
    id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slot_index  int NOT NULL UNIQUE CHECK (slot_index BETWEEN 0 AND 5),
    bound       chp2.bound_t NOT NULL,
    depart_time time NOT NULL,
    period      chp2.period_t NOT NULL,         -- before(เช้า, index<3) / after(เย็น, index>=3)
    UNIQUE (bound, depart_time)
);

-- ---------- เงื่อนไขรวมสาย (RMT) — แก้ได้เองผ่าน admin, แทน chpSpilloverA/B ----------
-- กลุ่มรวมสาย (P8 GroupA-G + คู่ยุบจาก P3-6) : รวมหลายสายเป็น 1 คัน
CREATE TABLE chp2.merge_group (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            text NOT NULL UNIQUE,            -- 'A'..'G', '13+14', '12+13', ...
    name            text,
    seat_cap        int NOT NULL DEFAULT 13,         -- 1 คันรวมไม่เกินเท่านี้
    priority        int NOT NULL,                    -- ลำดับลองยุบ (น้อย = ลองก่อน)
    result_route_id int REFERENCES chp2.route(id),   -- สาย(รวม)ที่ bus ถูก assign ไปเมื่อยุบกลุ่มนี้
    only_slot_id    int REFERENCES chp2.time_slot(id), -- NULL = ทุกช่องเวลา; เช่น GroupC รวมเฉพาะ 20:15
    dispatch_only   boolean NOT NULL DEFAULT false,  -- true = ใช้เป็นปลายทาง dispatch_rule เท่านั้น (ไม่เข้า P7 path)
    is_active       boolean NOT NULL DEFAULT true
);

-- สมาชิกของแต่ละกลุ่มรวม
CREATE TABLE chp2.merge_group_member (
    group_id     int NOT NULL REFERENCES chp2.merge_group(id) ON DELETE CASCADE,
    route_id     int NOT NULL REFERENCES chp2.route(id),
    member_order int,
    PRIMARY KEY (group_id, route_id)
);

-- กฎเงื่อนไขจุด/ทิศทาง (P2-6) เรียงตาม priority
-- ความหมาย: ถ้าสาย route_id (ทิศ bound) "มีผู้โดยสารในช่วงจุด solo_stop_from..solo_stop_to"
--           -> จัดรถของตัวเอง ; ไม่งั้นยุบเข้า else_group (หรือ else_group_alt ถ้ากลุ่มแรกไม่ลงตัว)
CREATE TABLE chp2.dispatch_rule (
    id                int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    priority          int NOT NULL,
    route_id          int NOT NULL REFERENCES chp2.route(id),
    bound             chp2.bound_t,                          -- NULL = ทั้งสองทิศ
    solo_stop_from    int,
    solo_stop_to      int,
    else_group_id     int REFERENCES chp2.merge_group(id),
    else_group_alt_id int REFERENCES chp2.merge_group(id),   -- ทางเลือก 2 (P6: 11+13 หรือ 11+14)
    note              text,
    is_active         boolean NOT NULL DEFAULT true
);

-- ============================================================================
-- คน
-- ============================================================================
CREATE TABLE chp2.employee (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    per_id          text,                        -- รหัสพนักงาน — อาจซ้ำได้ (พนง.1 คนมี LINE หลาย account เช่น perid 1170)
    line_user_id    text UNIQUE,                 -- LINE userId = identity จริงที่ booking อ้างถึง
    display_name    text,
    first_name      text,
    last_name       text,
    department      text,
    factory         text,
    home_stop_id    int REFERENCES chp2.route_stop(id),   -- จุดขึ้นรถประจำ (สายมาจากจุดนี้)
    approval_status chp2.appr_t NOT NULL DEFAULT 'pending',
    is_driver       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_home_stop_idx ON chp2.employee (home_stop_id);
CREATE INDEX employee_per_id_idx    ON chp2.employee (per_id);

-- ============================================================================
-- การจอง (แทน lastweek/thisweek/nextweek/hrnextweek)
-- ============================================================================
-- 1 แถว = พนักงาน 1 คน x 1 สัปดาห์ (week_of = วันจันทร์ของสัปดาห์นั้น)
-- "lastweek/thisweek/nextweek" กลายเป็นแค่ค่า week_of ต่างกัน
CREATE TABLE chp2.booking (
    id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id    int NOT NULL REFERENCES chp2.employee(id),
    week_of        date NOT NULL,
    pickup_stop_id int REFERENCES chp2.route_stop(id),    -- snapshot จุด/สาย ณ ตอนจอง
    dept_approval  chp2.appr_t NOT NULL DEFAULT 'pending',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, week_of)
);
CREATE INDEX booking_week_idx ON chp2.booking (week_of);

-- 1 แถว = 1 เที่ยวที่ขอ (แทน 14 คอลัมน์ *_inbound/*_outbound)
CREATE TABLE chp2.booking_ride (
    id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id   int NOT NULL REFERENCES chp2.booking(id) ON DELETE CASCADE,
    day_of_week  int NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
    bound        chp2.bound_t NOT NULL,
    depart_time  time NOT NULL,                  -- เวลาที่ผู้ใช้เลือก (map เข้า time_slot ตอน pack)
    UNIQUE (booking_id, day_of_week, bound)
);
CREATE INDEX booking_ride_dow_idx ON chp2.booking_ride (day_of_week, bound, depart_time);

-- ============================================================================
-- ผลการจัดรถ (แทน driver/bustoday/busfromhr + seatdriver/seattoday/seatfromhr
--             + history 6 ตาราง ที่เป็นตารางตาย)
-- ============================================================================
-- 1 แถว = 1 คันรถ ใน stage หนึ่ง (system/driver/hr)
CREATE TABLE chp2.bus_trip (
    id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stage        chp2.stage_t NOT NULL,
    route_id     int NOT NULL REFERENCES chp2.route(id),
    service_date date NOT NULL,                  -- วันที่จริง
    bound        chp2.bound_t NOT NULL,
    depart_time  time NOT NULL,
    bus_number   int NOT NULL,
    driver_id    int REFERENCES chp2.employee(id),
    capacity     int NOT NULL,                   -- snapshot จาก route.seat_capacity ตอนจัด
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (stage, route_id, service_date, bound, depart_time, bus_number)
);
CREATE INDEX bus_trip_date_stage_idx ON chp2.bus_trip (service_date, stage);

-- 1 แถว = ผู้โดยสาร 1 คน บนคันรถนั้น
CREATE TABLE chp2.seat_assignment (
    id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id        int NOT NULL REFERENCES chp2.bus_trip(id) ON DELETE CASCADE,
    employee_id    int NOT NULL REFERENCES chp2.employee(id),
    pickup_stop_id int REFERENCES chp2.route_stop(id),
    seat_no        int,
    UNIQUE (trip_id, seat_no),
    UNIQUE (trip_id, employee_id)
);
CREATE INDEX seat_assignment_emp_idx ON chp2.seat_assignment (employee_id);

-- ============================================================================
-- audit (คงรูปแบบ chp.change_log เดิม)
-- ============================================================================
CREATE TABLE chp2.change_log (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts     timestamptz NOT NULL DEFAULT now(),
    actor  text,
    action text,
    row_id text,
    detail jsonb
);

COMMIT;

-- สรุปตารางที่สร้าง
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'chp2' ORDER BY table_name;
