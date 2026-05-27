-- ============================================================================
-- 04 — booking grid -> chp2.booking + chp2.booking_ride
--   chp.thisweek  -> week_of = วันจันทร์ของสัปดาห์นี้
--   chp.nextweek  -> week_of = วันจันทร์สัปดาห์หน้า
--   chp.lastweek  -> week_of = วันจันทร์สัปดาห์ที่แล้ว  (เก็บเป็นประวัติ; ลบ block นี้ได้ถ้าไม่ต้องการ)
-- 14 คอลัมน์ *_inbound/*_outbound -> แถวใน booking_ride (เฉพาะที่มีเวลาจริง)
-- pickup_stop_id = employee.home_stop_id (route เดิมถูก derive จาก location อยู่แล้ว)
-- ต้องรัน 01 + 02 ก่อน
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ---------- 4.1 booking (header) ----------
INSERT INTO chp2.booking (employee_id, week_of, pickup_stop_id, dept_approval)
SELECT e.id, src.week_of, e.home_stop_id,
  CASE lower(COALESCE(src.department_approval, ''))
    WHEN 'approved' THEN 'approved'::chp2.appr_t
    WHEN 'reject'   THEN 'rejected'::chp2.appr_t
    WHEN 'rejected' THEN 'rejected'::chp2.appr_t
    ELSE 'pending'::chp2.appr_t
  END
FROM (
  SELECT userid, department_approval,
         date_trunc('week', CURRENT_DATE)::date       AS week_of FROM chp.thisweek
  UNION ALL
  SELECT userid, department_approval,
         date_trunc('week', CURRENT_DATE)::date + 7    FROM chp.nextweek
  UNION ALL
  SELECT userid, department_approval,
         date_trunc('week', CURRENT_DATE)::date - 7    FROM chp.lastweek
) src
JOIN chp2.employee e ON e.line_user_id = src.userid
ON CONFLICT (employee_id, week_of) DO NOTHING;

-- ---------- 4.2 booking_ride (unpivot 14 คอลัมน์) ----------
INSERT INTO chp2.booking_ride (booking_id, day_of_week, bound, depart_time)
SELECT b.id, v.dow, v.bnd::chp2.bound_t, btrim(v.t)::time
FROM (
  SELECT userid, date_trunc('week', CURRENT_DATE)::date AS week_of,
         monday_inbound, monday_outbound, tuesday_inbound, tuesday_outbound,
         wednesday_inbound, wednesday_outbound, thursday_inbound, thursday_outbound,
         friday_inbound, friday_outbound, saturday_inbound, saturday_outbound,
         sunday_inbound, sunday_outbound
  FROM chp.thisweek
  UNION ALL
  SELECT userid, date_trunc('week', CURRENT_DATE)::date + 7,
         monday_inbound, monday_outbound, tuesday_inbound, tuesday_outbound,
         wednesday_inbound, wednesday_outbound, thursday_inbound, thursday_outbound,
         friday_inbound, friday_outbound, saturday_inbound, saturday_outbound,
         sunday_inbound, sunday_outbound
  FROM chp.nextweek
  UNION ALL
  SELECT userid, date_trunc('week', CURRENT_DATE)::date - 7,
         monday_inbound, monday_outbound, tuesday_inbound, tuesday_outbound,
         wednesday_inbound, wednesday_outbound, thursday_inbound, thursday_outbound,
         friday_inbound, friday_outbound, saturday_inbound, saturday_outbound,
         sunday_inbound, sunday_outbound
  FROM chp.lastweek
) src
JOIN chp2.employee e ON e.line_user_id = src.userid
JOIN chp2.booking b ON b.employee_id = e.id AND b.week_of = src.week_of
CROSS JOIN LATERAL (VALUES
  (1, 'inbound',  src.monday_inbound),     (1, 'outbound', src.monday_outbound),
  (2, 'inbound',  src.tuesday_inbound),    (2, 'outbound', src.tuesday_outbound),
  (3, 'inbound',  src.wednesday_inbound),  (3, 'outbound', src.wednesday_outbound),
  (4, 'inbound',  src.thursday_inbound),   (4, 'outbound', src.thursday_outbound),
  (5, 'inbound',  src.friday_inbound),     (5, 'outbound', src.friday_outbound),
  (6, 'inbound',  src.saturday_inbound),   (6, 'outbound', src.saturday_outbound),
  (7, 'inbound',  src.sunday_inbound),     (7, 'outbound', src.sunday_outbound)
) AS v(dow, bnd, t)
WHERE v.t IS NOT NULL
  AND btrim(v.t) <> ''
  AND btrim(v.t) <> 'ไม่ใช้'
  AND btrim(v.t) ~ '^\d{1,2}:\d{2}$'         -- กันค่าเพี้ยน cast เป็น time ไม่ได้
ON CONFLICT (booking_id, day_of_week, bound) DO NOTHING;

COMMIT;

-- ============================================================================
-- ตรวจสอบ
-- ============================================================================
SELECT b.week_of, count(DISTINCT b.id) AS bookings, count(r.id) AS rides
FROM chp2.booking b LEFT JOIN chp2.booking_ride r ON r.booking_id = b.id
GROUP BY b.week_of ORDER BY b.week_of;

-- เทียบจำนวน booking ของสัปดาห์นี้ กับจำนวนแถว chp.thisweek ที่ join employee ได้
SELECT
  (SELECT count(*) FROM chp.thisweek tw JOIN chp2.employee e ON e.line_user_id = tw.userid) AS src_thisweek_matched,
  (SELECT count(*) FROM chp2.booking WHERE week_of = date_trunc('week', CURRENT_DATE)::date) AS dst_thisweek_bookings;

-- ค่าเวลาที่ถูกข้าม (ไม่ตรง pattern HH:MM และไม่ใช่ 'ไม่ใช้'/ว่าง) — ไว้ไล่ดู
SELECT DISTINCT btrim(t) AS skipped_time FROM (
  SELECT monday_inbound t FROM chp.thisweek UNION ALL SELECT monday_outbound FROM chp.thisweek
  UNION ALL SELECT tuesday_inbound FROM chp.thisweek UNION ALL SELECT tuesday_outbound FROM chp.thisweek
  UNION ALL SELECT wednesday_inbound FROM chp.thisweek UNION ALL SELECT wednesday_outbound FROM chp.thisweek
  UNION ALL SELECT thursday_inbound FROM chp.thisweek UNION ALL SELECT thursday_outbound FROM chp.thisweek
  UNION ALL SELECT friday_inbound FROM chp.thisweek UNION ALL SELECT friday_outbound FROM chp.thisweek
  UNION ALL SELECT saturday_inbound FROM chp.thisweek UNION ALL SELECT saturday_outbound FROM chp.thisweek
  UNION ALL SELECT sunday_inbound FROM chp.thisweek UNION ALL SELECT sunday_outbound FROM chp.thisweek
) q
WHERE btrim(COALESCE(t,'')) <> '' AND btrim(t) <> 'ไม่ใช้' AND btrim(t) !~ '^\d{1,2}:\d{2}$';
