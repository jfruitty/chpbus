-- ============================================================================
-- 05 — pipeline จัดรถ -> chp2.bus_trip + chp2.seat_assignment
--   driver     / seatdriver  -> stage 'system'  (ระบบเพิ่งจัด)
--   bustoday   / seattoday   -> stage 'driver'   (ส่งให้ HR แล้ว)
--   busfromhr  / seatfromhr  -> stage 'hr'       (HR ปิดงานแล้ว)
-- ตารางพวกนี้เป็น transient (ถูกล้างเป็นรอบ ๆ) — migrate เท่าที่มีอยู่ ณ ตอนนั้น
-- ข้ามแถวที่ service_date เป็น NULL (แถวเก่าก่อนเพิ่มคอลัมน์)
-- ต้องรัน 01 + 02 ก่อน (ใช้ route.name / employee.line_user_id)
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ---------- 5.1 bus_trip (จากตาราง bus 3 stage) ----------
INSERT INTO chp2.bus_trip
  (stage, route_id, service_date, bound, depart_time, bus_number, driver_id, capacity)
SELECT
  src.stage::chp2.stage_t,
  r.id,
  src.service_date,
  CASE WHEN src.bound IN ('ขาเข้า','inbound')  THEN 'inbound'::chp2.bound_t
       WHEN src.bound IN ('ขาออก','outbound') THEN 'outbound'::chp2.bound_t END,
  btrim(src.depart_time)::time,
  src.bus_number,
  e.id,
  r.seat_capacity
FROM (
  SELECT 'system' stage, driver_user_id, route, bound, "time" depart_time, bus_number, service_date FROM chp.driver
  UNION ALL
  SELECT 'driver', driver_user_id, route, bound, "time", bus_number, service_date FROM chp.bustoday
  UNION ALL
  SELECT 'hr',     driver_user_id, route, bound, "time", bus_number, service_date FROM chp.busfromhr
) src
JOIN chp2.route r ON r.name = src.route
LEFT JOIN chp2.employee e ON e.line_user_id = NULLIF(src.driver_user_id, '')
WHERE src.service_date IS NOT NULL
  AND src.bound IN ('ขาเข้า','inbound','ขาออก','outbound')
  AND btrim(COALESCE(src.depart_time, '')) ~ '^\d{1,2}:\d{2}$'
ON CONFLICT (stage, route_id, service_date, bound, depart_time, bus_number) DO NOTHING;

-- ---------- 5.2 seat_assignment (จากตาราง seat 3 stage, join เข้ากับ bus_trip) ----------
INSERT INTO chp2.seat_assignment (trip_id, employee_id, pickup_stop_id, seat_no)
SELECT t.id, e.id, e.home_stop_id, src.seat
FROM (
  SELECT 'system' stage, userid, route, bound, "time" depart_time, busnumber, seat, service_date FROM chp.seatdriver
  UNION ALL
  SELECT 'driver', userid, route, bound, "time", busnumber, seat, service_date FROM chp.seattoday
  UNION ALL
  SELECT 'hr',     userid, route, bound, "time", busnumber, seat, service_date FROM chp.seatfromhr
) src
JOIN chp2.employee e ON e.line_user_id = src.userid
JOIN chp2.route r    ON r.name = src.route
JOIN chp2.bus_trip t
  ON t.stage        = src.stage::chp2.stage_t
 AND t.route_id     = r.id
 AND t.service_date = src.service_date
 AND t.bound = CASE WHEN src.bound IN ('ขาเข้า','inbound')  THEN 'inbound'::chp2.bound_t
                    WHEN src.bound IN ('ขาออก','outbound') THEN 'outbound'::chp2.bound_t END
 AND t.depart_time  = btrim(src.depart_time)::time
 AND t.bus_number   = src.busnumber
WHERE src.service_date IS NOT NULL
  AND src.bound IN ('ขาเข้า','inbound','ขาออก','outbound')
  AND btrim(COALESCE(src.depart_time, '')) ~ '^\d{1,2}:\d{2}$'
ON CONFLICT DO NOTHING;

COMMIT;

-- ============================================================================
-- ตรวจสอบ
-- ============================================================================
SELECT t.stage, count(DISTINCT t.id) AS trips, count(s.id) AS seats
FROM chp2.bus_trip t LEFT JOIN chp2.seat_assignment s ON s.trip_id = t.id
GROUP BY t.stage ORDER BY t.stage;

-- ที่นั่งที่ join เข้า bus_trip ไม่ได้ (เช่นไม่มีแถว bus คู่กัน หรือ route/เวลาไม่ตรง) — ไว้ไล่ดู
SELECT 'seatdriver' src, count(*) AS unmatched FROM chp.seatdriver sd
WHERE sd.service_date IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM chp2.seat_assignment s
    JOIN chp2.employee e ON e.id = s.employee_id
    WHERE e.line_user_id = sd.userid AND s.seat_no = sd.seat
  );

-- route ในตาราง pipeline ที่ map เข้า chp2.route ไม่ได้ (ชื่อสายไม่ตรง catalog)
SELECT DISTINCT src.route
FROM (
  SELECT route FROM chp.driver     UNION ALL SELECT route FROM chp.bustoday
  UNION ALL SELECT route FROM chp.busfromhr
  UNION ALL SELECT route FROM chp.seatdriver UNION ALL SELECT route FROM chp.seattoday
  UNION ALL SELECT route FROM chp.seatfromhr
) src
WHERE COALESCE(src.route,'') <> ''
  AND NOT EXISTS (SELECT 1 FROM chp2.route r WHERE r.name = src.route)
ORDER BY 1;
