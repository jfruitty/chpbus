\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS chp._stage_thisweek;
DROP TABLE IF EXISTS chp._stage_nextweek;
CREATE TABLE chp._stage_thisweek (
  perid text, first_name text, last_name text, route_name text, pickup text,
  mon_in text, mon_out text, tue_in text, tue_out text,
  wed_in text, wed_out text, thu_in text, thu_out text,
  fri_in text, fri_out text, sat_in text, sat_out text,
  sun_in text, sun_out text, approve text, approver text
);
CREATE TABLE chp._stage_nextweek (LIKE chp._stage_thisweek INCLUDING ALL);

\copy chp._stage_thisweek FROM 'd:/work/resonac/chpbus/Shutterbus - thisweek.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy chp._stage_nextweek FROM 'd:/work/resonac/chpbus/Shutterbus - nextweek.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

TRUNCATE chp.thisweek, chp.nextweek RESTART IDENTITY;

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
JOIN chp.users u ON ltrim(u.perid, '0') = ltrim(NULLIF(s.perid,''), '0');

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
JOIN chp.users u ON ltrim(u.perid, '0') = ltrim(NULLIF(s.perid,''), '0');

-- Final unmatched report (rows with non-blank perid that still didn't join)
SELECT 'thisweek_still_unmatched' AS m, COUNT(*) FROM chp._stage_thisweek s
LEFT JOIN chp.users u ON ltrim(u.perid,'0') = ltrim(NULLIF(s.perid,''),'0')
WHERE u.userid IS NULL AND COALESCE(s.perid,'') <> '';

SELECT 'nextweek_still_unmatched' AS m, COUNT(*) FROM chp._stage_nextweek s
LEFT JOIN chp.users u ON ltrim(u.perid,'0') = ltrim(NULLIF(s.perid,''),'0')
WHERE u.userid IS NULL AND COALESCE(s.perid,'') <> '';

DROP TABLE chp._stage_thisweek;
DROP TABLE chp._stage_nextweek;
COMMIT;

SELECT 'chp.thisweek' AS t, count(*) FROM chp.thisweek
UNION ALL SELECT 'chp.nextweek', count(*) FROM chp.nextweek;
