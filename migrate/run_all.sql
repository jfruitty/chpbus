-- รัน migration ทั้งชุดตามลำดับ (chp.* -> chp2.*)
-- ใช้: psql "$DATABASE_URL" -f migrate/run_all.sql
-- ⚠️ รันกับ DB copy ก่อนเสมอ — 01 จะ DROP SCHEMA chp2 ทิ้งแล้วสร้างใหม่
\set ON_ERROR_STOP on
\echo '== 01 schema =='
\i migrate/01_chp2_schema.sql
\echo '== 02 routes / stops / employees / merge-rules =='
\i migrate/02_routes_stops_employees.sql
\echo '== 04 bookings =='
\i migrate/04_bookings.sql
\echo '== 05 assignments =='
\i migrate/05_assignments.sql
\echo '== done =='
