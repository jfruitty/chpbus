-- ============================================================================
-- 02 — seed สาย(route) + ช่องเวลา + เงื่อนไขรวมสาย RMT, แตกจุด(stop) จาก location, ย้าย employee
-- ต้องรัน 01_chp2_schema.sql ก่อน
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ---------- 2.1 สาย (route) — แค็ตตาล็อกจาก "Shutterbus - util.csv" ----------
-- รถตู้ทั่วไป = 13 ที่นั่ง; รถบัสใหญ่ 'ลาดบัวขาว รถบัส' (CHP12-2) = 42
INSERT INTO chp2.route (code, name, pack_group, is_combined, seat_capacity) VALUES
  -- กลุ่ม A: สายเดี่ยว
  ('CHP01', 'วัดสว่าง',        'A', false, 13),
  ('CHP02', 'แคราย',           'A', false, 13),
  ('CHP03', 'คลอง14',          'A', false, 13),
  ('CHP04', 'คลอง16',          'A', false, 13),
  ('CHP05', 'หมู่บ้านริมบึง',   'A', false, 13),
  ('CHP06', 'คลองเจ้า',         'A', false, 13),
  ('CHP07', 'หนามแดง',         'A', false, 13),
  ('CHP08', 'ประเวศ',          'A', false, 13),
  ('CHP09', 'แปดริ้ว',          'A', false, 13),
  ('CHP10', 'วัดเกาะ',          'A', false, 13),
  ('CHP15', 'กรุงเทพ',          'A', false, 13),
  ('CHP16', 'บางน้ำเปรี้ยว',    'A', false, 13),
  -- กลุ่ม A: สายรวม (ปลายทาง spillover)
  -- หมายเหตุ: name ต้องตรงกับชื่อที่ packing เขียน (GROUP_A_ROUTES มีคำว่า "รวม " นำหน้า)
  -- ไม่งั้น assignment (ไฟล์ 05) join ไม่ติด — code เป็นแค่ id ภายใน
  ('CHP01+02+03+04', 'รวม วัดสว่าง + แคราย + คลอง14 + คลอง16', 'A', true, 13),
  ('CHP01+02',       'รวม วัดสว่าง + แคราย',                   'A', true, 13),
  ('CHP03+04',       'รวม คลอง14 + คลอง16',                    'A', true, 13),
  ('CHP05+06',       'รวม หมู่บ้านริมบึง + คลองเจ้า',            'A', true, 13),
  ('CHP07+08',       'รวม หนามแดง + ประเวศ',                   'A', true, 13),
  ('CHP09+10',       'รวม แปดริ้ว + วัดเกาะ',                    'A', true, 13),
  ('CHP05+15',       'รวม หมู่บ้านริมบึง + กรุงเทพ',             'A', true, 13),
  -- กลุ่ม B
  ('CHP14',  'สนามชัย',          'B', false, 13),
  ('CHP13',  'ดงน้อย',           'B', false, 13),
  ('CHP12',  'ลาดบัวขาว',        'B', false, 13),
  ('CHP11',  'แปลงยาว',          'B', false, 13),
  ('รวม13+14', 'รวม ดงน้อย + สนามชัย', 'B', true,  13),
  ('CHP12-2', 'ลาดบัวขาว รถบัส',  'B', false, 42),   -- รถบัสใหญ่ (P5: CHP12 >=26 คน)
  -- สายรวมเพิ่มตามเงื่อนไข RMT (โค้ดเดิมไม่มี) — ใช้เป็น result_route ของ merge_group
  ('CHP09+11',       'รวม แปดริ้ว + แปลงยาว',                     'B', true, 13),   -- GroupF (ข้ามโซน A/B)
  ('CHP11+12+13+14', 'รวม แปลงยาว + ลาดบัวขาว + ดงน้อย + สนามชัย', 'B', true, 13),   -- GroupG
  ('CHP12+13',       'รวม ลาดบัวขาว + ดงน้อย',                     'B', true, 13),   -- P4 else
  ('CHP11+13',       'รวม แปลงยาว + ดงน้อย',                       'B', true, 13),   -- P6 else
  ('CHP11+14',       'รวม แปลงยาว + สนามชัย',                      'B', true, 13);   -- P6 else (ทางเลือก)

-- ---------- 2.2 ช่องเวลา 6 ช่อง/วัน (แทน chpTimeToIndex) ----------
INSERT INTO chp2.time_slot (slot_index, bound, depart_time, period) VALUES
  (0, 'inbound',  '07:30', 'before'),
  (1, 'outbound', '08:15', 'before'),
  (2, 'inbound',  '10:30', 'before'),
  (3, 'outbound', '17:15', 'after'),
  (4, 'inbound',  '19:30', 'after'),
  (5, 'outbound', '20:15', 'after');

-- ============================================================================
-- 2.3 เงื่อนไขรวมสาย RMT (แทน chpSpilloverA/B) — ทุกอย่างเป็น data แก้ได้เองผ่าน admin
-- อ้างอิง "เงื่อนไขการรวมสายรถ RMT Update 07/03/2024 Rev01"
-- ============================================================================

-- ---------- 2.3a flag ราย route ----------
UPDATE chp2.route SET min_solo_pax = 7        -- P7: แต่ละสาย >=7 คน จัดคันเอง, <7 ยุบตามกลุ่ม
WHERE code IN ('CHP01','CHP02','CHP03','CHP04','CHP05','CHP06','CHP07','CHP08',
               'CHP09','CHP10','CHP11','CHP12','CHP13','CHP15','CHP16');
-- หมายเหตุ: CHP14 ไม่อยู่ในลิสต์ P7 (ชีตข้ามไป) — ใช้กฎ P2 (มีคนจุด 1 → จัดเอง) แทน จึงไม่ตั้ง min_solo_pax
-- P1: CHP16 ไม่รวมทุกกรณี (ไม่อยู่ในกลุ่มไหนเลย)
-- CHP15 (กรุงเทพ): ปกติวิ่งเดี่ยว แต่ยกเว้น = รวมกับ CHP05 (บ้านริมบึง) เฉพาะรอบ 20:15 (GroupC)
--   จึงไม่ตั้ง never_merge ให้ 15 แต่คุมด้วยการเป็นสมาชิก GroupC ที่จำกัดเวลา (only_slot_id) แทน
UPDATE chp2.route SET never_merge = true WHERE code = 'CHP16';
UPDATE chp2.route SET bus_threshold = 26,                                   -- P5
       bus_route_id = (SELECT id FROM chp2.route WHERE code = 'CHP12-2')
WHERE code = 'CHP12';

-- ---------- 2.3b กลุ่มรวมสาย (P8 GroupA-G + คู่ยุบจาก P3-6) ----------
INSERT INTO chp2.merge_group (code, name, seat_cap, priority, result_route_id)
SELECT v.code, v.name, 13, v.priority, rr.id
FROM (VALUES
  -- คู่ยุบเฉพาะ (ปลายทางของ dispatch_rule P3-6) — priority ต่ำ = พิจารณาก่อนกลุ่มใหญ่
  ('13+14', 'รวม ดงน้อย + สนามชัย',                          5,  'รวม13+14'),
  ('12+13', 'รวม ลาดบัวขาว + ดงน้อย',                        6,  'CHP12+13'),
  ('11+13', 'รวม แปลงยาว + ดงน้อย',                          7,  'CHP11+13'),
  ('11+14', 'รวม แปลงยาว + สนามชัย',                         8,  'CHP11+14'),
  -- กลุ่มทั่วไป P8
  ('A', 'GroupA 01+02+03+04',                10, 'CHP01+02+03+04'),
  ('C', 'GroupC 05+15 (เฉพาะ 20:15)',         9, 'CHP05+15'),   -- ต้องมาก่อน GroupB (แย่ง CHP05 ตอน 20:15)
  ('B', 'GroupB 05+06',                      11, 'CHP05+06'),
  ('D', 'GroupD 07+08',                      13, 'CHP07+08'),
  ('E', 'GroupE 09+10',                      14, 'CHP09+10'),
  ('F', 'GroupF 09+11',                      15, 'CHP09+11'),
  ('G', 'GroupG 11+12+13+14',                16, 'CHP11+12+13+14')
) AS v(code, name, priority, result_code)
LEFT JOIN chp2.route rr ON rr.code = v.result_code;

-- GroupC (บ้านริมบึง CHP05 + กรุงเทพ CHP15) รวมเฉพาะรอบ 20:15 ขาออก (ช่วง OT ของ CHP15) เท่านั้น
UPDATE chp2.merge_group
SET only_slot_id = (SELECT id FROM chp2.time_slot WHERE bound = 'outbound' AND depart_time = '20:15')
WHERE code = 'C';

-- กลุ่มคู่ยุบ = ปลายทางของ dispatch_rule เท่านั้น (ไม่ให้ P7 path หยิบเอง เช่น CHP11/12 ขาเข้า)
UPDATE chp2.merge_group SET dispatch_only = true WHERE code IN ('13+14','12+13','11+13','11+14');

-- ---------- 2.3c สมาชิกของแต่ละกลุ่มรวม ----------
INSERT INTO chp2.merge_group_member (group_id, route_id, member_order)
SELECT g.id, r.id, v.ord
FROM (VALUES
  ('13+14','CHP13',1),('13+14','CHP14',2),
  ('12+13','CHP12',1),('12+13','CHP13',2),
  ('11+13','CHP11',1),('11+13','CHP13',2),
  ('11+14','CHP11',1),('11+14','CHP14',2),
  ('A','CHP01',1),('A','CHP02',2),('A','CHP03',3),('A','CHP04',4),
  ('B','CHP05',1),('B','CHP06',2),
  ('C','CHP05',1),('C','CHP15',2),
  ('D','CHP07',1),('D','CHP08',2),
  ('E','CHP09',1),('E','CHP10',2),
  ('F','CHP09',1),('F','CHP11',2),
  ('G','CHP11',1),('G','CHP12',2),('G','CHP13',3),('G','CHP14',4)
) AS v(gcode, rcode, ord)
JOIN chp2.merge_group g ON g.code = v.gcode
JOIN chp2.route r       ON r.code = v.rcode;

-- ---------- 2.3d กฎเงื่อนไขจุด/ทิศ (P2-6) ----------
-- ⚠️ assumption ที่ต้องยืนยันกับ HR:
--   - P2 CHP14: ถ้าไม่มีคนจุด 1 ให้ยุบเข้ากลุ่มไหน (ใส่ GroupG ไว้ก่อน)
--   - GroupC แบบพิเศษตามเวลา (5โมงแยก / 2ทุ่ม OT) ยังไม่ใส่ — ข้อความในชีตถูกตัด
INSERT INTO chp2.dispatch_rule
  (priority, route_id, bound, solo_stop_from, solo_stop_to, else_group_id, else_group_alt_id, note)
SELECT v.priority, r.id, v.bnd::chp2.bound_t, v.sfrom, v.sto, g1.id, g2.id, v.note
FROM (VALUES
  (2, 'CHP14', NULL,        1, 1, 'G',     NULL,    'P2: มีคนจุด1 จัดเอง ไม่งั้นยุบ (else=สมมติ GroupG รอยืนยัน)'),
  (3, 'CHP13', 'inbound',   1, 5, '13+14', NULL,    'P3 ขาเข้า: จุด1-5 จัดเอง ไม่งั้น 13+14'),
  (3, 'CHP13', 'outbound',  1, 3, '13+14', NULL,    'P3 ขาออก: จุด1-3 จัดเอง ไม่งั้น 13+14'),
  (4, 'CHP12', 'outbound',  1, 7, '12+13', NULL,    'P4 ขาออก: จุด1-7 จัดเอง ไม่งั้น 12+13'),
  (6, 'CHP11', 'outbound',  1, 4, '11+13', '11+14', 'P6 ขาออก: จุด1-4 จัดเอง ไม่งั้น 11+13 หรือ 11+14')
) AS v(priority, rcode, bnd, sfrom, sto, gcode, gcode_alt, note)
JOIN chp2.route r            ON r.code = v.rcode
LEFT JOIN chp2.merge_group g1 ON g1.code = v.gcode
LEFT JOIN chp2.merge_group g2 ON g2.code = v.gcode_alt;

-- ---------- 2.4 จุดขึ้นรถ (stop) — แตกจาก chp.users.location ----------
-- รูปแบบ location: '[NN]<สาย> <ชื่อจุด>'  เช่น '[18]ลาดบัวขาว ปากทางเข้าวัดลาดบัว'
--   parts[1]=ลำดับ(seq), parts[2]=ชื่อสาย (token ไม่มีช่องว่าง), parts[3]=ชื่อจุด (มีช่องว่างได้)
INSERT INTO chp2.route_stop (route_id, seq, name)
SELECT DISTINCT r.id, NULLIF(p.parts[1], '')::int, btrim(p.parts[3])
FROM (
  SELECT regexp_match(location, '^\s*\[(\d+)\]\s*([^ ]+)\s+(.+)$') AS parts
  FROM chp.users
  WHERE COALESCE(location, '') <> ''
) p
JOIN chp2.route r ON r.name = p.parts[2] AND r.is_combined = false
WHERE p.parts IS NOT NULL
ON CONFLICT (route_id, seq, name) DO NOTHING;

-- ---------- 2.5 พนักงาน (employee) + ผูก home_stop ----------
INSERT INTO chp2.employee
  (per_id, line_user_id, display_name, first_name, last_name,
   department, factory, supervisor, approval_status, is_driver, home_stop_id)
SELECT
  NULLIF(u.perid, ''),
  NULLIF(u.userid, ''),
  NULLIF(u.displayname, ''),
  NULLIF(u.first_name, ''),
  NULLIF(u.last_name, ''),
  NULLIF(u.department, ''),
  NULLIF(u.factory, ''),
  NULLIF(u.supervisor, ''),
  CASE lower(COALESCE(u.approvalstatus, ''))
    WHEN 'approved' THEN 'approved'::chp2.appr_t
    WHEN 'reject'   THEN 'rejected'::chp2.appr_t
    WHEN 'rejected' THEN 'rejected'::chp2.appr_t
    ELSE 'pending'::chp2.appr_t
  END,
  (u.department IN ('Driver', 'Old Driver')),
  st.id
FROM chp.users u
LEFT JOIN LATERAL (
  SELECT regexp_match(u.location, '^\s*\[(\d+)\]\s*([^ ]+)\s+(.+)$') AS parts
) p ON true
LEFT JOIN chp2.route r
  ON r.name = p.parts[2] AND r.is_combined = false
LEFT JOIN chp2.route_stop st
  ON st.route_id = r.id
 AND st.seq = NULLIF(p.parts[1], '')::int
 AND st.name = btrim(p.parts[3])
WHERE COALESCE(u.perid, '') <> '' OR COALESCE(u.userid, '') <> '';

COMMIT;

-- ============================================================================
-- ตรวจสอบ (validation)
-- ============================================================================
-- จำนวนที่ย้ายมา
SELECT 'route' t, count(*) FROM chp2.route
UNION ALL SELECT 'route_stop', count(*) FROM chp2.route_stop
UNION ALL SELECT 'merge_group', count(*) FROM chp2.merge_group
UNION ALL SELECT 'merge_group_member', count(*) FROM chp2.merge_group_member
UNION ALL SELECT 'dispatch_rule', count(*) FROM chp2.dispatch_rule
UNION ALL SELECT 'employee', count(*) FROM chp2.employee
ORDER BY 1;

-- กลุ่มรวม + สมาชิก + สายปลายทาง + เวลาที่จำกัด (ดูว่าตั้งถูกไหม)
SELECT g.code, g.priority, g.seat_cap,
       string_agg(r.code, '+' ORDER BY m.member_order) AS members,
       rr.name AS result_route,
       ts.depart_time AS only_at_time
FROM chp2.merge_group g
LEFT JOIN chp2.merge_group_member m ON m.group_id = g.id
LEFT JOIN chp2.route r  ON r.id = m.route_id
LEFT JOIN chp2.route rr ON rr.id = g.result_route_id
LEFT JOIN chp2.time_slot ts ON ts.id = g.only_slot_id
GROUP BY g.code, g.priority, g.seat_cap, rr.name, ts.depart_time
ORDER BY g.priority;

-- จุดต่อสาย (ดูว่าแตกถูกไหม)
SELECT r.code, r.name, count(s.id) AS stops
FROM chp2.route r LEFT JOIN chp2.route_stop s ON s.route_id = r.id
WHERE r.is_combined = false
GROUP BY r.pack_group, r.code, r.name ORDER BY r.pack_group, r.code;

-- ⚠️ location ที่ parse/จับคู่สายไม่ได้ (ต้องไล่ดูเอง — มักเป็นช่องว่างผิดรูปแบบ หรือชื่อสายไม่ตรง catalog)
SELECT u.perid, u.first_name, u.location
FROM chp.users u
WHERE COALESCE(u.location, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM chp2.route r
    WHERE r.is_combined = false
      AND r.name = (regexp_match(u.location, '^\s*\[\d+\]\s*([^ ]+)\s'))[1]
  )
ORDER BY u.location;

-- พนักงานที่มี location แต่ผูก home_stop ไม่ได้ (น่าจะ seq/ชื่อจุดไม่ลงตัว)
SELECT u.perid, u.location
FROM chp.users u
JOIN chp2.employee e ON e.per_id = NULLIF(u.perid, '')
WHERE COALESCE(u.location, '') <> '' AND e.home_stop_id IS NULL
ORDER BY u.location;
