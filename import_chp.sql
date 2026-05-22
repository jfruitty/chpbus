\set ON_ERROR_STOP on
BEGIN;

-- Real CHP data has one perid that is 21 chars ("0000 เจ้าหน้าที่จัดรถ"),
-- 1 char over gateway's varchar(20). Widen only in chp.
ALTER TABLE chp.users ALTER COLUMN perid TYPE varchar(30);

DROP TABLE IF EXISTS chp._stage_members;
DROP TABLE IF EXISTS chp._stage_thisweek;
DROP TABLE IF EXISTS chp._stage_nextweek;

CREATE TABLE chp._stage_members (
  serial_no   text,
  perid       text,
  userid      text,
  displayname text,
  first_name  text,
  last_name   text,
  department  text,
  approve     text,
  location    text,
  approver    text
);

CREATE TABLE chp._stage_thisweek (
  perid      text,
  first_name text,
  last_name  text,
  route_name text,
  pickup     text,
  mon_in text, mon_out text,
  tue_in text, tue_out text,
  wed_in text, wed_out text,
  thu_in text, thu_out text,
  fri_in text, fri_out text,
  sat_in text, sat_out text,
  sun_in text, sun_out text,
  approve  text,
  approver text
);

CREATE TABLE chp._stage_nextweek (LIKE chp._stage_thisweek INCLUDING ALL);

\copy chp._stage_members  FROM 'd:/work/resonac/chpbus/Shutterbus - member.csv'   WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy chp._stage_thisweek FROM 'd:/work/resonac/chpbus/Shutterbus - thisweek.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy chp._stage_nextweek FROM 'd:/work/resonac/chpbus/Shutterbus - nextweek.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

-- Truncate any pre-existing target rows (target was just created empty, but be safe & idempotent)
TRUNCATE chp.users, chp.thisweek, chp.nextweek RESTART IDENTITY;

INSERT INTO chp.users (perid, userid, displayname, first_name, last_name, department, factory, approvalstatus, location)
SELECT
  NULLIF(perid, ''),
  NULLIF(userid, ''),
  NULLIF(displayname, ''),
  NULLIF(first_name, ''),
  NULLIF(last_name, ''),
  NULLIF(department, ''),
  NULL,
  CASE WHEN upper(approve) = 'TRUE'  THEN 'approved'
       WHEN upper(approve) = 'FALSE' THEN 'pending'
       ELSE NULLIF(approve, '') END,
  NULLIF(location, '')
FROM chp._stage_members
WHERE COALESCE(perid,'') <> '' OR COALESCE(userid,'') <> '';

INSERT INTO chp.thisweek (
  userid, route,
  monday_inbound, monday_outbound,
  tuesday_inbound, tuesday_outbound,
  wednesday_inbound, wednesday_outbound,
  thursday_inbound, thursday_outbound,
  friday_inbound, friday_outbound,
  saturday_inbound, saturday_outbound,
  sunday_inbound, sunday_outbound,
  department_approval
)
SELECT
  u.userid,
  NULLIF(s.route_name, ''),
  NULLIF(s.mon_in, ''), NULLIF(s.mon_out, ''),
  NULLIF(s.tue_in, ''), NULLIF(s.tue_out, ''),
  NULLIF(s.wed_in, ''), NULLIF(s.wed_out, ''),
  NULLIF(s.thu_in, ''), NULLIF(s.thu_out, ''),
  NULLIF(s.fri_in, ''), NULLIF(s.fri_out, ''),
  NULLIF(s.sat_in, ''), NULLIF(s.sat_out, ''),
  NULLIF(s.sun_in, ''), NULLIF(s.sun_out, ''),
  CASE WHEN upper(s.approve) = 'TRUE'  THEN 'approved'
       WHEN upper(s.approve) = 'FALSE' THEN 'pending'
       ELSE NULLIF(s.approve, '') END
FROM chp._stage_thisweek s
JOIN chp.users u ON u.perid = NULLIF(s.perid, '');

INSERT INTO chp.nextweek (
  userid, route,
  monday_inbound, monday_outbound,
  tuesday_inbound, tuesday_outbound,
  wednesday_inbound, wednesday_outbound,
  thursday_inbound, thursday_outbound,
  friday_inbound, friday_outbound,
  saturday_inbound, saturday_outbound,
  sunday_inbound, sunday_outbound,
  department_approval
)
SELECT
  u.userid,
  NULLIF(s.route_name, ''),
  NULLIF(s.mon_in, ''), NULLIF(s.mon_out, ''),
  NULLIF(s.tue_in, ''), NULLIF(s.tue_out, ''),
  NULLIF(s.wed_in, ''), NULLIF(s.wed_out, ''),
  NULLIF(s.thu_in, ''), NULLIF(s.thu_out, ''),
  NULLIF(s.fri_in, ''), NULLIF(s.fri_out, ''),
  NULLIF(s.sat_in, ''), NULLIF(s.sat_out, ''),
  NULLIF(s.sun_in, ''), NULLIF(s.sun_out, ''),
  CASE WHEN upper(s.approve) = 'TRUE'  THEN 'approved'
       WHEN upper(s.approve) = 'FALSE' THEN 'pending'
       ELSE NULLIF(s.approve, '') END
FROM chp._stage_nextweek s
JOIN chp.users u ON u.perid = NULLIF(s.perid, '');

-- Report unmatched perids (rows that would be skipped by the JOIN above)
SELECT 'thisweek_unmatched_perids' AS metric,
       COUNT(*) AS unmatched_rows,
       array_agg(DISTINCT s.perid) FILTER (WHERE u.userid IS NULL) AS sample_perids
FROM chp._stage_thisweek s
LEFT JOIN chp.users u ON u.perid = NULLIF(s.perid, '')
WHERE u.userid IS NULL;

SELECT 'nextweek_unmatched_perids' AS metric,
       COUNT(*) AS unmatched_rows,
       array_agg(DISTINCT s.perid) FILTER (WHERE u.userid IS NULL) AS sample_perids
FROM chp._stage_nextweek s
LEFT JOIN chp.users u ON u.perid = NULLIF(s.perid, '')
WHERE u.userid IS NULL;

DROP TABLE chp._stage_members;
DROP TABLE chp._stage_thisweek;
DROP TABLE chp._stage_nextweek;

COMMIT;

SELECT 'chp.users'    AS t, count(*) FROM chp.users
UNION ALL SELECT 'chp.thisweek', count(*) FROM chp.thisweek
UNION ALL SELECT 'chp.nextweek', count(*) FROM chp.nextweek
ORDER BY 1;
