'use strict';

const express = require('express');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const ExcelJS = require('exceljs');
const cron = require('node-cron');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

// chp2 adapter layer (อ่าน/เขียน schema chp2 คืนรูปแบบเดิม) — ใช้ระหว่าง cutover
const chp2Store = require('./chp2/store');
const chp2Pack = require('./chp2/pack');   // packing engine ตามกฎ RMT

const app = express();

// --- Postgres pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
  max: 95,
  idleTimeoutMillis: 40000,
  keepAlive: true,
});

// --- System error log (internal only — never shown to users) ----------------
// Every error written through console.error is also persisted to chp.error_log,
// tagged with the request that was in flight (method/path/body) via
// AsyncLocalStorage. This means a 500 like the varchar(20) per_id overflow is
// captured together with the offending request body, so it can be diagnosed
// after the fact without reproducing. Best-effort: persisting must never throw,
// recurse, or interfere with the original logging.
const chpReqContext = new AsyncLocalStorage();

async function logSystemError(message, stack) {
  let ctx = null;
  try { ctx = chpReqContext.getStore() || null; } catch (e) { /* no active request */ }
  try {
    await pool.query(
      `INSERT INTO chp.error_log (source, method, message, stack, context)
       VALUES ($1, $2, $3, $4, $5)`,
      [ctx ? ctx.path : null,
        ctx ? ctx.method : null,
        message ? String(message).slice(0, 4000) : null,
        stack ? String(stack).slice(0, 8000) : null,
        ctx && ctx.body != null ? JSON.stringify(ctx.body).slice(0, 4000) : null]
    );
  } catch (e) { /* swallow — error logging must never break anything */ }
}

// Wrap console.error so existing `console.error('... failed:', err)` call sites
// across the app feed chp.error_log automatically, with zero handler changes.
// logSystemError swallows its own failures (and never calls console.error), so
// this cannot recurse.
const chpOrigConsoleError = console.error.bind(console);
console.error = (...args) => {
  chpOrigConsoleError(...args);
  try {
    const errArg = args.find(a => a instanceof Error);
    const message = args
      .map(a => (a instanceof Error ? a.message : (typeof a === 'string' ? a : '')))
      .filter(Boolean).join(' ');
    void logSystemError(message, errArg ? errArg.stack : null);  // fire-and-forget
    void telegramNotifyErrorSilent(message);                     // fire-and-forget
  } catch (e) { /* never let logging throw */ }
};

// Mirror every logged error to the owner's Telegram (TELEGRAM_CHAT_ID). Like
// logSystemError, this swallows its own failures and NEVER calls console.error,
// so it cannot recurse through the wrapper above. Attaches the in-flight
// request (method/path) when there is one, so a 500 is actionable at a glance.
async function telegramNotifyErrorSilent(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId || !message) return;
  let ctx = null;
  try { ctx = chpReqContext.getStore() || null; } catch (e) { /* no active request */ }
  const where = ctx ? `\n📍 ${ctx.method} ${ctx.path}` : '';
  const text = `🔴 CHP ระบบมี error${where}\n${String(message).slice(0, 1500)}`;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) { /* swallow — must never recurse into console.error */ }
}

// Last-resort capture for errors outside any request (cron jobs, stray async).
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason instanceof Error ? reason : new Error(String(reason)));
});

// --- Idempotent startup migration -------------------------------------------
// Additive only (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) so it's
// safe to run on every boot and never touches existing rows. Adds:
//   - chp.hrnextweek : Friday snapshot of chp.nextweek for HR (kept per week_of)
//   - service_date   : real calendar date on the bus/seat pipeline tables
async function chpEnsureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chp.hrnextweek (
      userid text,
      route text,
      department_approval text,
      monday_inbound text,    monday_outbound text,
      tuesday_inbound text,   tuesday_outbound text,
      wednesday_inbound text, wednesday_outbound text,
      thursday_inbound text,  thursday_outbound text,
      friday_inbound text,    friday_outbound text,
      saturday_inbound text,  saturday_outbound text,
      sunday_inbound text,    sunday_outbound text,
      week_of date
    );
    ALTER TABLE chp.driver     ADD COLUMN IF NOT EXISTS service_date date;
    ALTER TABLE chp.seatdriver ADD COLUMN IF NOT EXISTS service_date date;
    ALTER TABLE chp.bustoday   ADD COLUMN IF NOT EXISTS service_date date;
    ALTER TABLE chp.seattoday  ADD COLUMN IF NOT EXISTS service_date date;
    ALTER TABLE chp.busfromhr  ADD COLUMN IF NOT EXISTS service_date date;
    ALTER TABLE chp.seatfromhr ADD COLUMN IF NOT EXISTS service_date date;
    CREATE TABLE IF NOT EXISTS chp.change_log (
      id      bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      ts      timestamptz DEFAULT now(),
      actor   text,
      action  text,
      row_id  text,
      detail  jsonb
    );
    -- Internal system error log. NOT surfaced to any user-facing page; it exists
    -- purely so 500s (e.g. the varchar-overflow on a long per_id) can be
    -- diagnosed from the offending request without reproducing it.
    CREATE TABLE IF NOT EXISTS chp.error_log (
      id      bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      ts      timestamptz DEFAULT now(),
      source  text,    -- request path / job name in flight when it was logged
      method  text,    -- HTTP method (null for cron/startup)
      message text,    -- error message(s)
      stack   text,    -- stack trace of the Error, if any
      context jsonb    -- request body / extra context
    );
    -- Company holidays (admin-managed). A holiday is a calendar date with NO
    -- dispatch run of its own (like a weekend): rides still run, but they are
    -- bundled into the preceding working day's 14:30 run. See chpBuildSegments.
    CREATE TABLE IF NOT EXISTS chp.holiday (
      holiday_date date PRIMARY KEY,
      note         text,
      created_at   timestamptz DEFAULT now()
    );
  `);
}

// --- LINE / LIFF config from env ---
const accessToken = process.env.CHANNELACCESSTOKEN;
const channelSecret = process.env.CHANNELSECRET;
const lineChannelId = process.env.LINE_CHANNEL_ID;

const liffIds = {
  register:   process.env.LIFF_REGISTER   || '',
  nextweek:   process.env.LIFF_NEXTWEEK   || '',
  thisweek:   process.env.LIFF_THISWEEK   || '',
  detail:     process.env.LIFF_DETAIL     || '',
  supapprove: process.env.LIFF_SUPAPPROVE || '',
  hr:         process.env.LIFF_HR         || '',
};

const adminLineUsers = (process.env.ADMIN_LINE_USERS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// --- Express setup ---
app.set('view engine', 'ejs');
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Carry the in-flight request (method/path/body) in async-local storage so
// logSystemError can attach it to any error logged while handling the request.
app.use((req, res, next) => {
  chpReqContext.run({ method: req.method, path: req.path, body: req.body }, next);
});

// Expose the current path + user role to every EJS render so the shared admin
// sidebar partial (views/partials/adminmenu.ejs) can mark the active menu item
// and hide admin-only items from non-admin sessions, without each route having
// to pass them in.
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  try {
    const u = verifyAuth(parseCookies(req)[AUTH_COOKIE]);
    res.locals.userRole = u && u.role;
  } catch (e) { res.locals.userRole = null; }
  next();
});

// --- Change log -------------------------------------------------------------
// Append-only audit trail in chp.change_log so data changes can be traced and
// mistakes corrected. chpLog never throws (logging must not break the action).
async function chpLog(actor, action, rowId, detail) {
  try {
    await pool.query(
      'INSERT INTO chp.change_log (actor, action, row_id, detail) VALUES ($1, $2, $3, $4)',
      [actor || null, action,
       (rowId !== undefined && rowId !== null && rowId !== '') ? String(rowId) : null,
       detail != null ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    console.error('chpLog error:', e.message);
  }
}

// One middleware records every data-mutating POST on success (status < 400),
// instead of editing each handler. Path = action, actor = role. The stored
// detail is { before, after }: `after` is the submitted body, and for
// edit/remove `before` is a snapshot of the row taken *before* the handler
// mutates it — so the change-log UI can render a readable "old → new" diff.
const CHP_LOG_TABLE = {
  busdriver: 'chp.driver',     bustoday: 'chp.bustoday',
  paxdriver: 'chp.seatdriver', paxtoday: 'chp.seattoday',
};
const CHP_LOGGED_POST = /^\/(insert|edit|remove)(busdriver|bustoday|paxtoday|paxdriver)$|^\/driversendtohr$/;
app.use(async (req, res, next) => {
  if (req.method !== 'POST' || !CHP_LOGGED_POST.test(req.path)) return next();

  // For edit/remove, snapshot the current row before it is changed/deleted.
  // Best-effort: a failed snapshot must not block or break the request.
  let before = null;
  const m = req.path.match(/^\/(edit|remove)(busdriver|bustoday|paxtoday|paxdriver)$/);
  if (m && req.body && req.body.id) {
    try {
      const r = await pool.query(
        `SELECT * FROM ${CHP_LOG_TABLE[m[2]]} WHERE id = $1`, [req.body.id]);
      before = r.rows[0] || null;
    } catch (e) { /* ignore — logging must not break the action */ }
  }

  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let role = null;
      try { const u = verifyAuth(parseCookies(req)[AUTH_COOKIE]); role = u && u.role; } catch (e) {}
      chpLog(role, req.path.slice(1), req.body && req.body.id, { before, after: req.body });
    }
  });
  next();
});

// --- Cookie-signed admin/driver auth ---
const AUTH_COOKIE = 'chp_auth';
const AUTH_TTL_MS = 8 * 60 * 60 * 1000;

function authSecret() {
  return process.env.AUTH_SECRET || process.env.CHANNELSECRET || 'change-me';
}

function signAuth(role) {
  const exp = Date.now() + AUTH_TTL_MS;
  const payload = `${role}.${exp}`;
  const sig = crypto.createHmac('sha256', authSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAuth(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [role, exp, sig] = parts;
  const expected = crypto.createHmac('sha256', authSecret()).update(`${role}.${exp}`).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  return { role };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = decodeURIComponent(pair.slice(idx + 1).trim());
    out[key] = val;
  }
  return out;
}

function requireRole(...roles) {
  return (req, res, next) => {
    const cookies = parseCookies(req);
    const user = verifyAuth(cookies[AUTH_COOKIE]);
    if (!user || !roles.includes(user.role)) {
      return res.redirect('/login');
    }
    req.user = user;
    next();
  };
}

// --- chp2 (schema ใหม่) rules-admin + packing engine ---------------------------
// เพิ่มคู่ขนาน ไม่กระทบ flow chp เดิม: หน้าแก้กฎรวมสาย RMT + ลองจัดดู (dry-run) + commit
// เข้าที่ /chp2/rules (ต้องล็อกอิน admin). engine อ่าน/เขียน schema chp2 เท่านั้น
app.use('/chp2/rules', requireRole('admin'), require('./chp2/adminRouter'));

// CHP cutoff: after Friday 15:00 the packing for Sat/Sun/Mon has already
// run (see Apps Script calculatedaily Friday branch at 14:30-14:35),
// so nextweek edits should be locked until the weekly rollover.
function isAfterChpCutoff() {
  const now = new Date();
  const d = now.getDay();
  return (d === 5 && now.getHours() >= 15) || d === 0 || d === 6;
}

async function telegramNotify(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    if (!response.ok) {
      console.error(`Telegram API error: ${response.status} - ${await response.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Telegram send error:', error.message);
    return false;
  }
}

async function sendPushMessage(userIds, msg) {
  if (!accessToken) {
    console.error('CHANNELACCESSTOKEN not set; sendPushMessage skipped');
    return;
  }
  try {
    const response = await axios.post(
      'https://api.line.me/v2/bot/message/multicast',
      { to: userIds, messages: [{ type: 'text', text: msg }] },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
    );
    return response.data;
  } catch (err) {
    console.error('sendPushMessage error:', err.response ? err.response.data : err.message);
  }
}

// Send many per-recipient push messages with limited concurrency. LINE push is
// one recipient per call and each passenger's text differs (so multicast can't
// be used). sendPushMessage swallows its own errors, so this never throws.
async function chpPushBatch(items, size = 20) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(it => sendPushMessage([it.to], it.text)));
  }
}

// --- LIFF access-token verification ---
async function verifyAndFetchProfile(userAccessToken, res) {
  if (!userAccessToken) {
    return res.json({ error: 'Access token is missing' });
  }
  try {
    const verifyResponse = await axios.get(
      `https://api.line.me/oauth2/v2.1/verify?access_token=${userAccessToken}`
    );
    const { client_id, expires_in } = verifyResponse.data;

    if (lineChannelId && client_id !== lineChannelId) {
      return res.json({ error: 'Client id mismatch' });
    }
    if (expires_in <= 0) {
      return res.json({ error: 'Client id expire' });
    }

    const profileResponse = await axios.get('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    });
    return profileResponse;
  } catch (error) {
    console.error('Error during verification and profile retrieval:', error.message);
    return res.json({ error: 'Internal Server Error' });
  }
}

app.post('/verifyaccesstoken', async (req, res) => {
  const { accessToken: userAccessToken } = req.body;
  try {
    const response = await axios.get(
      `https://api.line.me/oauth2/v2.1/verify?access_token=${userAccessToken}`
    );
    const { client_id, expires_in } = response.data;

    if (lineChannelId && client_id !== lineChannelId) {
      return res.json({ valid: false });
    }
    if (expires_in <= 2000) {
      return res.json({ valid: false });
    }

    const profileResponse = await axios.get('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    });
    res.json({ valid: !!profileResponse.data.userId });
  } catch (error) {
    console.error('Error verifying access token:', error.response ? error.response.data : error.message);
    res.json({ valid: false });
  }
});

// --- chp.* pipeline transfer helpers (used by /weekly, /driversendtohr) ---

async function chpTransferThisweekToLastweek() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chp.lastweek');
    await client.query(`
      INSERT INTO chp.lastweek (
        userid, route, monday_inbound, monday_outbound,
        tuesday_inbound, tuesday_outbound, wednesday_inbound, wednesday_outbound,
        thursday_inbound, thursday_outbound, friday_inbound, friday_outbound,
        saturday_inbound, saturday_outbound, sunday_inbound, sunday_outbound,
        department_approval
      )
      SELECT
        userid, route, monday_inbound, monday_outbound,
        tuesday_inbound, tuesday_outbound, wednesday_inbound, wednesday_outbound,
        thursday_inbound, thursday_outbound, friday_inbound, friday_outbound,
        saturday_inbound, saturday_outbound, sunday_inbound, sunday_outbound,
        department_approval
      FROM chp.thisweek
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('chpTransferThisweekToLastweek error:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function chpTransferNextweekToThisweek() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chp.thisweek');
    await client.query(`
      INSERT INTO chp.thisweek (
        userid, route, monday_inbound, monday_outbound,
        tuesday_inbound, tuesday_outbound, wednesday_inbound, wednesday_outbound,
        thursday_inbound, thursday_outbound, friday_inbound, friday_outbound,
        saturday_inbound, saturday_outbound, sunday_inbound, sunday_outbound,
        department_approval
      )
      SELECT
        userid, route, monday_inbound, monday_outbound,
        tuesday_inbound, tuesday_outbound, wednesday_inbound, wednesday_outbound,
        thursday_inbound, thursday_outbound, friday_inbound, friday_outbound,
        saturday_inbound, saturday_outbound, sunday_inbound, sunday_outbound,
        department_approval
      FROM chp.nextweek
    `);
    await client.query('DELETE FROM chp.nextweek');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('chpTransferNextweekToThisweek error:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function chpTransferDriverToBustoday() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chp.bustoday');
    await client.query(`
      INSERT INTO chp.bustoday (
        driver_user_id, per_id, first_name,
        last_name, route, day, bound, time, bus_number, service_date
      )
      SELECT
        driver_user_id, per_id, first_name,
        last_name, route, day, bound, time, bus_number, service_date
      FROM chp.driver
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('chpTransferDriverToBustoday error:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function chpTransferSeatdriverToSeattoday() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chp.seattoday');
    await client.query(`
      INSERT INTO chp.seattoday (
        userid, perid, first_name,
        last_name, route, location, day,
        time, busnumber, seat, bound, service_date
      )
      SELECT
        userid, perid, first_name,
        last_name, route, location, day,
        time, busnumber, seat, bound, service_date
      FROM chp.seatdriver
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('chpTransferSeatdriverToSeattoday error:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function chpTransferBustodayToBusfromhr() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chp.busfromhr');
    await client.query(`
      INSERT INTO chp.busfromhr (
        driver_user_id, per_id, first_name,
        last_name, route, day, bound, time, bus_number, service_date
      )
      SELECT
        driver_user_id, per_id, first_name,
        last_name, route, day, bound, time, bus_number, service_date
      FROM chp.bustoday
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('chpTransferBustodayToBusfromhr error:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function chpTransferSeattodayToSeatfromhr() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chp.seatfromhr');
    await client.query(`
      INSERT INTO chp.seatfromhr (
        userid, perid, first_name,
        last_name, route, location, day,
        time, busnumber, seat, bound, service_date
      )
      SELECT
        userid, perid, first_name,
        last_name, route, location, day,
        time, busnumber, seat, bound, service_date
      FROM chp.seattoday
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('chpTransferSeattodayToSeatfromhr error:', err);
    throw err;
  } finally {
    client.release();
  }
}

// tranfernextweekforhr: snapshot chp.nextweek into chp.hrnextweek so HR keeps a
// stable copy of next week's bookings even after the Friday rollover clears
// chp.nextweek. Tagged with week_of (next Monday); only that week's snapshot is
// replaced, so prior weeks accumulate and are never overwritten/lost. Atomic.
async function chpSnapshotNextweekForHr() {
  // chp2: HR ดู next week ตรง ๆ ผ่าน /hrnextweek (getDashboard('next')) — ไม่ต้อง snapshot
}

// --- Web auth routes ---
app.get('/', (req, res) => {
  // Entry point: send everyone to /login. If already authenticated, the
  // /login handler bounces them on to their dashboard (admin → /member,
  // driver → /driver).
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  const cookies = parseCookies(req);
  const user = verifyAuth(cookies[AUTH_COOKIE]);
  if (user) {
    return res.redirect(user.role === 'admin' ? '/member' : '/driver');
  }
  res.render('login', { title: 'Login', error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  let role = null;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    role = 'admin';
  } else if (username === process.env.DRIVER_USER && password === process.env.DRIVER_PASS) {
    role = 'driver';
  }
  if (!role) {
    return res.status(401).render('login', { title: 'Login', error: 'Invalid username or password' });
  }
  res.cookie(AUTH_COOKIE, signAuth(role), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: AUTH_TTL_MS,
  });
  res.redirect(role === 'admin' ? '/member' : '/driver');
});

app.get('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.redirect('/login');
});

// --- Admin "Member" dashboard (post-login landing for admin) ---
// Ported from the old Gateway /member; reads chp.users instead of
// gateway.users (same columns). The view (member.ejs) drives approval
// and department edits via the two POST endpoints below.
app.get('/member', requireRole('admin'), async (req, res) => {
  try {
    const rows = await chp2Store.getMembers(pool);          // chp2 (รูปแบบ chp.users)
    const departments = await getChpDepartments();
    const stops = await chp2Store.getStops(pool);           // chp2 (ตัวเลือกจุดขึ้นรถ)
    res.render('member', { rows, departments, stops });
  } catch (err) {
    console.error('GET /member error:', err);
    res.status(500).send('Server Error');
  }
});

app.post('/update-approval-status', requireRole('admin'), async (req, res) => {
  const { userId, status } = req.body;
  try {
    await chp2Store.updateApprovalStatus(pool, userId, status);
    res.status(200).send('Approval status updated successfully');
  } catch (error) {
    console.error('Error updating approval status:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/update-user-department', requireRole('admin'), async (req, res) => {
  const { userId, department } = req.body;
  if (!userId || typeof department !== 'string' || department.trim() === '') {
    return res.status(400).send('Invalid userId or department');
  }
  try {
    await chp2Store.updateDepartment(pool, userId, department);
    res.status(200).send('User department updated successfully');
  } catch (error) {
    console.error('Error updating user department:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/update-user-location', requireRole('admin'), async (req, res) => {
  const { userId, stopId } = req.body;
  if (!userId) return res.status(400).send('Invalid userId');
  const sid = (stopId === '' || stopId == null) ? null : Number(stopId);
  if (sid !== null && !Number.isInteger(sid)) return res.status(400).send('Invalid stopId');
  try {
    await chp2Store.updateHomeStop(pool, userId, sid);   // chp2 (ผูก home_stop_id)
    res.status(200).send('User location updated successfully');
  } catch (error) {
    console.error('Error updating user location:', error);
    res.status(500).send('Internal Server Error');
  }
});

// --- Driver "Driver" dashboard (post-login landing for driver) ---
// Ported from the old Gateway /driver; reads/writes chp.driver (the system
// proposal table) and joins chp.seatdriver for the per-bus passenger count.
// driver.js (+ picker.js) drive the insert/edit/delete modals and the
// "ส่ง HR" button (POST /driversendtohr, already defined below).
app.get('/driver', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, per_id AS perid, first_name, last_name,
             route, day, bound, "time", bus_number AS number
      FROM chp.driver
    `);
    res.render('driver', { rows: result.rows });
  } catch (err) {
    console.error('GET /driver error:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/driverjson', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.id, b.per_id AS perid, b.first_name, b.last_name,
             b.route, b.day, b.bound, b."time", b.bus_number AS number,
             COUNT(s.id) AS pax
      FROM chp.driver b
      LEFT JOIN chp.seatdriver s
        ON  b.route      = s.route
        AND b.day        = s.day
        AND b.bound      = s.bound
        AND b."time"     = s."time"
        AND b.bus_number = s.busnumber
      GROUP BY b.id, b.per_id, b.first_name, b.last_name,
               b.route, b.day, b.bound, b."time", b.bus_number
    `);
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('GET /driverjson error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/driverusersjson', requireRole('admin', 'driver'), async (req, res) => {
  try {
    res.json({ rows: await chp2Store.getDrivers(pool) });
  } catch (err) {
    console.error('GET /driverusersjson error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// chp.driver insert/edit share a column shape; keep these helpers thin.
// `table` is a hard-coded constant at every call site — never user input.
function chpInsertBusAssignment(table, body) {
  const sql = `
    INSERT INTO ${table} (
      driver_user_id, per_id, first_name, last_name, route, day, bound, "time", bus_number
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `;
  return pool.query(sql, [
    body.driver_user_id || null,
    body.perid          || null,
    body.first_name     || null,
    body.last_name      || null,
    body.route,
    body.day,
    body.bound,
    body.time,
    body.bus_number,
  ]);
}

// COALESCE preserves stored values when the edit modal leaves the driver
// dropdown on its placeholder (picker sends nulls for un-touched fields).
function chpEditBusAssignment(table, body) {
  const sql = `
    UPDATE ${table}
    SET first_name     = COALESCE($1, first_name),
        last_name      = COALESCE($2, last_name),
        per_id         = COALESCE($3, per_id),
        route          = COALESCE($4, route),
        driver_user_id = COALESCE($5, driver_user_id)
    WHERE id = $6
  `;
  return pool.query(sql, [
    body.first_name     || null,
    body.last_name      || null,
    body.perid          || null,
    body.route          || null,
    body.driver_user_id || null,
    body.id,
  ]);
}

app.post('/insertbusdriver', requireRole('admin', 'driver'), async (req, res) => {
  try {
    await chpInsertBusAssignment('chp.driver', req.body);
    return res.status(200).json({ message: 'Bus insert successfully' });
  } catch (error) {
    console.error('insertbusdriver failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/editbusdriver', requireRole('admin', 'driver'), async (req, res) => {
  if (!req.body.id) return res.status(400).json({ error: 'No id provided' });
  try {
    const result = await chpEditBusAssignment('chp.driver', req.body);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Bus not found' });
    return res.status(200).json({ message: 'Bus edited successfully' });
  } catch (error) {
    console.error('editbusdriver failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/removebusdriver', requireRole('admin', 'driver'), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'No id provided' });
  try {
    const result = await pool.query('DELETE FROM chp.driver WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Bus not found' });
    return res.status(200).json({ message: 'Bus removed successfully' });
  } catch (error) {
    console.error('Error removing bus:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Passenger picker source for seatdriver.js (everyone who is not a driver).
app.get('/passengerusersjson', requireRole('admin', 'driver'), async (req, res) => {
  try {
    res.json({ rows: await chp2Store.getPassengers(pool) });
  } catch (err) {
    console.error('GET /passengerusersjson error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ===========================================================================
// HR/admin & driver management dashboards (ported from Gateway -> chp.*)
// ===========================================================================

// --- Booking dashboards (admin) ---

// Distinct, non-empty department names from chp.users, sorted.
// Drives the department filter dropdown on the booking dashboards
// (replaces the old hardcoded list).
async function getChpDepartments() {
  return chp2Store.getDepartments(pool);   // chp2
}

app.get('/thisweekdashboard', requireRole('admin'), async (req, res) => {
  try {
    const rows = await chp2Store.getDashboard(pool, 'this');   // chp2
    const departments = await getChpDepartments();
    res.render('thisweekdashboard', { rows, departments });
  } catch (err) {
    console.error('GET /thisweekdashboard error:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/nextweekdashboard', requireRole('admin'), async (req, res) => {
  try {
    const rows = await chp2Store.getDashboard(pool, 'next');   // chp2
    const departments = await getChpDepartments();
    res.render('nextweekdashboard', { rows, departments });
  } catch (err) {
    console.error('GET /nextweekdashboard error:', err);
    res.status(500).send('Server Error');
  }
});

app.post('/update-approval-department-thisweek', requireRole('admin'), async (req, res) => {
  const { userId, status } = req.body;
  try {
    await chp2Store.updateThisweekApproval(pool, userId, status);
    res.status(200).send('Approval status updated successfully');
  } catch (error) {
    console.error('Error updating thisweek approval:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Build the passenger-count matrix for the weekly summary page.
// which = 'this' | 'next'. Reads chp2.booking via getDashboard and tallies
// head-count per route × day × bound × time. Returns { rows, count } where
// count[routeName][day] = { inbound: {HH:MM: n}, outbound: {HH:MM: n} }.
async function buildSumData(which) {
  const rows = await chp2Store.getRouteNames(pool);            // chp2 (ชื่อสาย)
  const dash = await chp2Store.getDashboard(pool, which);      // chp2.booking ของสัปดาห์นั้น
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const count = {};
  dash.forEach((item) => {
    const route = item.route;
    if (!route) return;                                        // ข้ามคนที่ยังไม่มีสาย/จุด
    if (!count[route]) count[route] = {};
    days.forEach((day) => {
      if (!count[route][day]) count[route][day] = { inbound: {}, outbound: {} };
      const inT = item[`${day}_inbound`];
      const outT = item[`${day}_outbound`];
      if (inT && inT !== 'ไม่ใช้') count[route][day].inbound[inT] = (count[route][day].inbound[inT] || 0) + 1;
      if (outT && outT !== 'ไม่ใช้') count[route][day].outbound[outT] = (count[route][day].outbound[outT] || 0) + 1;
    });
  });
  return { rows, count };
}

app.get('/sumthisweek', requireRole('admin'), async (req, res) => {
  try {
    const { rows, count } = await buildSumData('this');
    res.render('sumweek', { rows, count, which: 'this', title: 'สรุปการจอง — สัปดาห์นี้' });
  } catch (err) {
    console.error('GET /sumthisweek error:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/sumnextweek', requireRole('admin'), async (req, res) => {
  try {
    const { rows, count } = await buildSumData('next');
    res.render('sumweek', { rows, count, which: 'next', title: 'สรุปการจอง — สัปดาห์หน้า' });
  } catch (err) {
    console.error('GET /sumnextweek error:', err);
    res.status(500).send('Server Error');
  }
});

// Route catalogue for the driver/seatdriver insert+edit modals (chp2.route).
// Returns { routes: [{ code, name, pack_group }] } so the client can group
// single vs combined ("รวม…") routes in <optgroup>s. Replaces the stale
// hard-coded <option> lists that used the old chp route names.
app.get('/routenamesjson', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT code, name, pack_group FROM chp2.route ORDER BY pack_group, code'
    );
    res.json({ routes: result.rows });
  } catch (err) {
    console.error('GET /routenamesjson error:', err);
    res.status(500).send('Server Error');
  }
});

// --- Bus management: bustoday (HR) reuses the chp.driver insert/edit helpers ---
app.get('/bustoday', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, per_id AS perid, first_name, last_name,
             route, day, bound, "time", bus_number AS number
      FROM chp.bustoday
    `);
    res.render('bustoday', { rows: result.rows });
  } catch (err) {
    console.error('GET /bustoday error:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/bustodayjson', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.id, b.per_id AS perid, b.first_name, b.last_name,
             b.route, b.day, b.bound, b."time", b.bus_number AS number,
             COUNT(s.id) AS pax
      FROM chp.bustoday b
      LEFT JOIN chp.seattoday s
        ON  b.route = s.route AND b.day = s.day AND b.bound = s.bound
        AND b."time" = s."time" AND b.bus_number = s.busnumber
      GROUP BY b.id, b.per_id, b.first_name, b.last_name,
               b.route, b.day, b.bound, b."time", b.bus_number
    `);
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('GET /bustodayjson error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/insertbustoday', requireRole('admin'), async (req, res) => {
  try {
    await chpInsertBusAssignment('chp.bustoday', req.body);
    return res.status(200).json({ message: 'Bus insert successfully' });
  } catch (error) {
    console.error('insertbustoday failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/editbustoday', requireRole('admin'), async (req, res) => {
  if (!req.body.id) return res.status(400).json({ error: 'No id provided' });
  try {
    const result = await chpEditBusAssignment('chp.bustoday', req.body);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Bus not found' });
    return res.status(200).json({ message: 'Bus edited successfully' });
  } catch (error) {
    console.error('editbustoday failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/removebustoday', requireRole('admin'), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'No id provided' });
  try {
    const result = await pool.query('DELETE FROM chp.bustoday WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Bus not found' });
    return res.status(200).json({ message: 'Bus removed successfully' });
  } catch (error) {
    console.error('Error removing bus:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- Seat (passenger) management: shared helpers for seattoday & seatdriver ---
// Insert looks up the employee by perid (chp.users) to fill name/location.
async function chpInsertPax(table, body) {
  const { perid, route, day, bound, time, bus_number, seat_number } = body;
  const u = await pool.query(
    `SELECT e.line_user_id AS userid, e.first_name, e.last_name,
            rs.seq, rs.name AS stop_name, r.name AS route_name
     FROM chp2.employee e
     LEFT JOIN chp2.route_stop rs ON rs.id = e.home_stop_id
     LEFT JOIN chp2.route r       ON r.id = rs.route_id
     WHERE e.per_id = $1`, [perid]);
  const row = u.rows[0] || {};
  const homeLoc = row.route_name ? chp2Store.rebuildLocation(row.seq, row.route_name, row.stop_name) : null;
  return pool.query(
    `INSERT INTO ${table}
       (userid, perid, first_name, last_name, route, location, day, bound, "time", busnumber, seat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [row.userid || null, perid, row.first_name || null, row.last_name || null,
      route, homeLoc, day, bound, time,
      parseInt(bus_number, 10), parseInt(seat_number, 10)]
  );
}

function chpEditPax(table, body) {
  return pool.query(
    `UPDATE ${table} SET route = $2, busnumber = $3, seat = $4 WHERE id = $1`,
    [body.id, body.route, parseInt(body.bus_number, 10), parseInt(body.seat_number, 10)]
  );
}

app.get('/seattoday', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, userid, perid, first_name, last_name, route, location,
             day, bound, "time", busnumber, seat
      FROM chp.seattoday
    `);
    res.render('seattoday', { rows: result.rows });
  } catch (err) {
    console.error('GET /seattoday error:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/seattodayjson', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, userid, perid, first_name, last_name, route, location,
             day, bound, "time", busnumber, seat
      FROM chp.seattoday
    `);
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('GET /seattodayjson error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/insertpaxtoday', requireRole('admin'), async (req, res) => {
  try {
    await chpInsertPax('chp.seattoday', req.body);
    return res.status(200).json({ message: 'Pax insert successfully' });
  } catch (error) {
    console.error('insertpaxtoday failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/editpaxtoday', requireRole('admin'), async (req, res) => {
  try {
    const result = await chpEditPax('chp.seattoday', req.body);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Pax not found or no changes made' });
    return res.status(200).json({ message: 'Pax edited successfully' });
  } catch (error) {
    console.error('editpaxtoday failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/removepaxtoday', requireRole('admin'), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'No id provided' });
  try {
    const result = await pool.query('DELETE FROM chp.seattoday WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Pax id not found' });
    return res.status(200).json({ message: 'Pax removed successfully' });
  } catch (error) {
    console.error('Error removing Pax:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- Driver-side seat list (seatdriver) ---
app.get('/seatdriver', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, userid, perid, first_name, last_name, route, location,
             day, bound, "time", busnumber, seat
      FROM chp.seatdriver
      ORDER BY route,
               CASE day WHEN 'จันทร์' THEN 1 WHEN 'อังคาร' THEN 2 WHEN 'พุธ' THEN 3
                        WHEN 'พฤหัส' THEN 4 WHEN 'ศุกร์' THEN 5 WHEN 'เสาร์' THEN 6
                        WHEN 'อาทิตย์' THEN 7 ELSE 8 END,
               "time", bound, busnumber, seat
`);
    res.render('seatdriver', { rows: result.rows });
  } catch (err) {
    console.error('GET /seatdriver error:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/seatdriverjson', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, userid, perid, first_name, last_name, route, location,
             day, bound, "time", busnumber, seat
      FROM chp.seatdriver
      ORDER BY route,
               CASE day WHEN 'จันทร์' THEN 1 WHEN 'อังคาร' THEN 2 WHEN 'พุธ' THEN 3
                        WHEN 'พฤหัส' THEN 4 WHEN 'ศุกร์' THEN 5 WHEN 'เสาร์' THEN 6
                        WHEN 'อาทิตย์' THEN 7 ELSE 8 END,
               "time", bound, busnumber, seat
`);
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('GET /seatdriverjson error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/insertpaxdriver', requireRole('admin', 'driver'), async (req, res) => {
  try {
    await chpInsertPax('chp.seatdriver', req.body);
    return res.status(200).json({ message: 'Pax insert successfully' });
  } catch (error) {
    console.error('insertpaxdriver failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/editpaxdriver', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await chpEditPax('chp.seatdriver', req.body);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Pax not found or no changes made' });
    return res.status(200).json({ message: 'Pax edited successfully' });
  } catch (error) {
    console.error('editpaxdriver failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/removepaxdriver', requireRole('admin', 'driver'), async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'No id provided' });
  try {
    const result = await pool.query('DELETE FROM chp.seatdriver WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Pax id not found' });
    return res.status(200).json({ message: 'Pax removed successfully' });
  } catch (error) {
    console.error('Error removing Pax:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- HR-finalized views (read-only) + history ---
app.get('/busfromhr', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, per_id AS perid, first_name, last_name,
             route, day, bound, "time", bus_number AS number
      FROM chp.busfromhr
    `);
    res.render('busfromhr', { rows: result.rows });
  } catch (err) {
    console.error('GET /busfromhr error:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/seatfromhr', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, userid, perid, first_name, last_name, route, location,
             day, bound, "time", busnumber, seat
      FROM chp.seatfromhr
    `);
    res.render('seatfromhr', { rows: result.rows });
  } catch (err) {
    console.error('GET /seatfromhr error:', err);
    res.status(500).send('Server Error');
  }
});

// History pages mirror Gateway behaviour: they display the HR-finalized
// chp.busfromhr / chp.seatfromhr tables (and reuse busfromhr.js / seatfromhr.js).
app.get('/bushistory', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, per_id AS perid, first_name, last_name,
             route, day, bound, "time", bus_number AS number
      FROM chp.busfromhr
    `);
    res.render('bushistory', { rows: result.rows });
  } catch (err) {
    console.error('GET /bushistory error:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/seathistory', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, userid, perid, first_name, last_name, route, location,
             day, bound, "time", busnumber, seat
      FROM chp.seatfromhr
    `);
    res.render('seathistory', { rows: result.rows });
  } catch (err) {
    console.error('GET /seathistory error:', err);
    res.status(500).send('Server Error');
  }
});

// --- HR finalize: notify each driver with their pax manifest, copy
// bustoday/seattoday into busfromhr/seatfromhr, then clear the working tables.
app.post('/sendmsgtodriver', requireRole('admin'), async (req, res) => {
  try {
    const bustoday = (await pool.query('SELECT * FROM chp.bustoday')).rows;
    const seattoday = (await pool.query('SELECT * FROM chp.seattoday')).rows;

    // Guard against a double-press: after a successful send, bustoday/seattoday
    // are cleared. Pressing "send" again would otherwise DELETE busfromhr/
    // seatfromhr and re-insert nothing (the transfer is replace-all), wiping the
    // just-sent snapshot. If both are empty there is nothing to send — bail out
    // without touching the from-hr tables.
    if (bustoday.length === 0 && seattoday.length === 0) {
      return res.status(409).json({ error: 'ไม่มีข้อมูลให้ส่ง (อาจส่งไปแล้ว) — ตารางรถ/ที่นั่งวันนี้ว่างอยู่' });
    }

    const dayTH = { monday: 'จันทร์', tuesday: 'อังคาร', wednesday: 'พุธ', thursday: 'พฤหัสบดี', friday: 'ศุกร์', saturday: 'เสาร์', sunday: 'อาทิตย์' };
    const boundTH = { inbound: 'ขาเข้าโรงงาน', outbound: 'ขาออกโรงงาน' };

    for (const bus of bustoday) {
      if (!bus.driver_user_id) continue;
      const pointCounts = {};
      const paxDetails = {};
      for (const s of seattoday) {
        if (bus.route === s.route && bus.day === s.day && bus.time === s.time
            && bus.bus_number === s.busnumber && bus.bound === s.bound) {
          const point = s.location;
          pointCounts[point] = (pointCounts[point] || 0) + 1;
          if (!paxDetails[point]) paxDetails[point] = [];
          paxDetails[point].push(`${s.first_name} ${s.perid},${s.seat}`);
        }
      }
      let text = 'จุดรับ\n\n';
      let total = 0;
      for (const point in pointCounts) {
        text += `จุด ${point} จำนวน ${pointCounts[point]} คน\n`;
        paxDetails[point].forEach((p) => { text += `${p}\n`; });
        text += '\n';
        total += pointCounts[point];
      }
      text += `\nรวมทั้งสิ้น ${total} คน `;
      await sendPushMessage([bus.driver_user_id],
        `คุณ ${bus.first_name} ${bus.last_name} \nทะเบียน ${bus.per_id} \nสาย ${bus.route} (คันที่ ${bus.bus_number}) \nวัน ${dayTH[bus.day]} ${boundTH[bus.bound]} เวลา ${bus.time} \n\n${text}`);
    }

    // Notify each passenger of their bus/seat (mirrors the old sendlinetopax()).
    const paxItems = seattoday.filter(s => s.userid).map(s => {
      const d = dayTH[s.day] || s.day;
      const b = { 'ขาเข้า': 'ขาเข้าโรงงาน', 'ขาออก': 'ขาออกโรงงาน', inbound: 'ขาเข้าโรงงาน', outbound: 'ขาออกโรงงาน' }[s.bound] || s.bound;
      return { to: s.userid, text:
        `รายละเอียดรถของ\nคุณ ${s.first_name} ${s.last_name}\nรหัส ${s.perid}\nประจำวันนี้คือ สาย ${s.route}\n(คันที่ ${s.busnumber} ที่นั่งหมายเลข ${s.seat})\nวัน ${d} ${b} เวลา ${s.time} ครับ` };
    });
    await chpPushBatch(paxItems);

    await chpTransferBustodayToBusfromhr();
    await chpTransferSeattodayToSeatfromhr();
    await pool.query('DELETE FROM chp.bustoday');
    await pool.query('DELETE FROM chp.seattoday');

    const busMsgCnt = bustoday.filter(b => b.driver_user_id).length;
    const paxMsgCnt = paxItems.length;
    await telegramNotify(`✅ HR ส่งข้อความแจ้งคนขับ/ผู้โดยสารแล้ว\nคนขับ ${busMsgCnt} คัน / ผู้โดยสาร ${paxMsgCnt} คน\nบันทึกเข้า busfromhr/seatfromhr เรียบร้อย`).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /sendmsgtodriver error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- CHP route derivation from a user's pickup point ---
// Mirrors fillsheetwhenuserbooknextweek() in the Apps Script: the user's
// stored "point" (e.g. "[09]ดงน้อย โลตัส เกาะขนุน") drives the route name
// written on each booking row. Multi-stop routes collapse to "X จุด N-M";
// [22]/[23]ลาดบัวขาว also normalize the pickup point itself.
function chpDeriveRoute(point) {
  if (!point) return { route: null, point: null };
  const firstChunk = point.split(/\s+/, 1)[0];

  const SANAMCHAI = ['[01]สนามชัย', '[02]สนามชัย', '[03]สนามชัย'];
  const DONGNOI = ['[01]ดงน้อย', '[02]ดงน้อย', '[03]ดงน้อย', '[04]ดงน้อย', '[05]ดงน้อย'];
  const LADBUAKHAW = Array.from({ length: 14 }, (_, i) =>
    `[${String(i + 1).padStart(2, '0')}]ลาดบัวขาว`);
  const PLAENGYAO = Array.from({ length: 6 }, (_, i) =>
    `[${String(i + 1).padStart(2, '0')}]แปลงยาว`);

  if (SANAMCHAI.includes(firstChunk))  return { route: 'สนามชัย จุด 1-3',   point };
  if (DONGNOI.includes(firstChunk))    return { route: 'ดงน้อย จุด 1-5',    point };
  if (LADBUAKHAW.includes(firstChunk)) return { route: 'ลาดบัวขาว จุด 1-14', point };
  if (PLAENGYAO.includes(firstChunk))  return { route: 'แปลงยาว จุด 1-6',   point };
  if (firstChunk === '[22]ลาดบัวขาว') return { route: 'ลาดบัวขาว จุด 1-14', point: '[0022]ลาดบัวขาว ศูนย์Honda' };
  if (firstChunk === '[23]ลาดบัวขาว') return { route: 'ลาดบัวขาว จุด 1-14', point: '[0023]ลาดบัวขาว แยกตั๊กม้อ' };
  return { route: firstChunk.length >= 4 ? firstChunk.substring(4) : firstChunk, point };
}

// --- Phase 1: LIFF user pages + JSON data endpoints ---

app.get('/register', (req, res) => {
  res.render('register', { title: 'Register Form', liffid: liffIds.register });
});

app.post('/register', async (req, res) => {
  // CHP register form sends "name"/"surname" (Apps Script field names).
  const {
    userAccessToken,
    displayname,
    pernumber,
    name,
    surname,
    department,
  } = req.body;

  if (!userAccessToken || !pernumber || !name || !surname || !department) {
    return res.render('register', { title: 'Register Form', liffid: liffIds.register });
  }

  const profileResponse = await verifyAndFetchProfile(userAccessToken, res);
  if (!profileResponse || !profileResponse.data || !profileResponse.data.userId) return;

  const userid = profileResponse.data.userId;

  const client = await pool.connect();
  try {
    await chp2Store.registerUser(client, { pernumber, userid, displayname, name, surname, department });
    await sendPushMessage(adminLineUsers,
      `คุณ ${name} ${surname} เลขประจำตัว ${pernumber} แผนก ${department} ลงทะเบียนครับ`);
  } catch (err) {
    console.error('POST /register error:', err);
    await telegramNotify(`CHP /register error: ${err.message}`);
  } finally {
    client.release();
  }

  res.render('register', { title: 'Register Form', liffid: liffIds.register });
});

// Pickup-point catalogue for LIFF pages (the /register self-service editor).
// Same single-route stop list the admin /member page uses; not sensitive.
app.get('/stopsjson', async (req, res) => {
  try {
    res.json({ stops: await chp2Store.getStops(pool) });
  } catch (err) {
    console.error('GET /stopsjson error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Let a registered user change their OWN pickup point from /register.
// Authenticated by LINE access token (like the booking endpoints), so the
// userId is taken from the verified profile — never trusted from the body.
// Updates employee.home_stop_id, which upsertBooking reads when deriving the
// route on the next booking.
app.post('/update-my-location', async (req, res) => {
  const { userAccessToken, stopId } = req.body;
  const profileResponse = await verifyAndFetchProfile(userAccessToken, res);
  if (!profileResponse || !profileResponse.data || !profileResponse.data.userId) return;
  const userId = profileResponse.data.userId;

  const sid = (stopId === '' || stopId == null) ? null : Number(stopId);
  if (sid !== null && !Number.isInteger(sid)) {
    return res.status(400).json({ error: 'Invalid stopId' });
  }
  try {
    const result = await chp2Store.updateHomeStop(pool, userId, sid);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /update-my-location error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Booking next week ---

app.get('/nextweek', (req, res) => {
  res.render('nextweek', { title: 'Booking Next Week', liffid: liffIds.nextweek });
});

app.post('/nextweek', async (req, res) => {
  const userAccessToken = req.body.userAccessToken;
  const fields = {
    monin:   req.body['monday(in)']    || 'ไม่ใช้',
    monout:  req.body['monday(out)']   || 'ไม่ใช้',
    tuesin:  req.body['tuesday(in)']   || 'ไม่ใช้',
    tuesout: req.body['tuesday(out)']  || 'ไม่ใช้',
    wedin:   req.body['wednesday(in)'] || 'ไม่ใช้',
    wedout:  req.body['wednesday(out)']|| 'ไม่ใช้',
    thuin:   req.body['thursday(in)']  || 'ไม่ใช้',
    thout:   req.body['thursday(out)'] || 'ไม่ใช้',
    friin:   req.body['friday(in)']    || 'ไม่ใช้',
    friout:  req.body['friday(out)']   || 'ไม่ใช้',
    satin:   req.body['saturday(in)']  || 'ไม่ใช้',
    satout:  req.body['saturday(out)'] || 'ไม่ใช้',
    sunin:   req.body['sunday(in)']    || 'ไม่ใช้',
    sunout:  req.body['sunday(out)']   || 'ไม่ใช้',
  };

  const profileResponse = await verifyAndFetchProfile(userAccessToken, res);
  if (!profileResponse || !profileResponse.data || !profileResponse.data.userId) return;
  const userid = profileResponse.data.userId;

  if (isAfterChpCutoff()) {
    return res.render('nextweek', { title: 'Booking Next Week', liffid: liffIds.nextweek });
  }

  const client = await pool.connect();
  try {
    await chp2Store.upsertBooking(client, 'next', userid, fields);   // chp2 (route มาจาก home_stop)
  } catch (err) {
    console.error('POST /nextweek error:', err);
    await telegramNotify(`CHP /nextweek error: ${err.message}`);
  } finally {
    client.release();
  }

  res.render('nextweek', { title: 'Booking Next Week', liffid: liffIds.nextweek });
});

// --- Booking this week (CHP allows mid-week edits) ---

app.get('/thisweek', (req, res) => {
  res.render('thisweek', { title: 'Edit This Week', liffid: liffIds.thisweek });
});

app.post('/thisweek', async (req, res) => {
  const userAccessToken = req.body.userAccessToken;
  const fields = {
    monin:   req.body['monday(in)']    || 'ไม่ใช้',
    monout:  req.body['monday(out)']   || 'ไม่ใช้',
    tuesin:  req.body['tuesday(in)']   || 'ไม่ใช้',
    tuesout: req.body['tuesday(out)']  || 'ไม่ใช้',
    wedin:   req.body['wednesday(in)'] || 'ไม่ใช้',
    wedout:  req.body['wednesday(out)']|| 'ไม่ใช้',
    thuin:   req.body['thursday(in)']  || 'ไม่ใช้',
    thout:   req.body['thursday(out)'] || 'ไม่ใช้',
    friin:   req.body['friday(in)']    || 'ไม่ใช้',
    friout:  req.body['friday(out)']   || 'ไม่ใช้',
    satin:   req.body['saturday(in)']  || 'ไม่ใช้',
    satout:  req.body['saturday(out)'] || 'ไม่ใช้',
    sunin:   req.body['sunday(in)']    || 'ไม่ใช้',
    sunout:  req.body['sunday(out)']   || 'ไม่ใช้',
  };

  const profileResponse = await verifyAndFetchProfile(userAccessToken, res);
  if (!profileResponse || !profileResponse.data || !profileResponse.data.userId) return;
  const userid = profileResponse.data.userId;

  const client = await pool.connect();
  try {
    await chp2Store.upsertBooking(client, 'this', userid, fields);   // chp2 (route มาจาก home_stop)
  } catch (err) {
    console.error('POST /thisweek error:', err);
    await telegramNotify(`CHP /thisweek error: ${err.message}`);
  } finally {
    client.release();
  }

  res.render('thisweek', { title: 'Edit This Week', liffid: liffIds.thisweek });
});

// --- LIFF page that shows the user's seat assignments for this week ---
app.get('/detail', (req, res) => {
  res.render('detail', { title: 'My Seat Details', liffid: liffIds.detail });
});

// --- LIFF JSON helpers ---

// --- Internal helpers that mirror the Apps Script doGet shapes ---
// Used to assemble the combined response below.

async function chpVerifyUserData(client, userid) {
  return chp2Store.getUserData(client, userid);   // chp2 (รูปแบบเดิม)
}

async function chpBookingData(client, table, userid) {
  // table = 'chp.nextweek' | 'chp.thisweek' -> which
  return chp2Store.getBookingGrid(client, table.includes('next') ? 'next' : 'this', userid);
}

async function chpDetailThisweekData(client, userid) {
  const status = await chp2Store.getBookingApprove(client, 'this', userid);  // chp2

  // ที่นั่งยังอ่านจาก chp.seattoday (scratch ที่ engine ป้อน — approach A)
  const seatResult = await client.query(
    `SELECT route, day, bound, time, busnumber, seat
     FROM chp.seattoday
     WHERE userid = $1
     ORDER BY day, time`,
    [userid]
  );

  return {
    status,
    thisweekdata: seatResult.rows.map(r => ({
      route: r.route,
      daybound: `${r.day} ${r.bound}`,
      time: r.time,
      bus: r.busnumber,
      seat: r.seat,
    })),
  };
}

// Combined endpoint matching the existing CHP frontend (chp.js) shape:
//   GET /getuserdata?accesstoken=...&page=register|nextweek|thisweek
// Returns { userData, booknextweekData?, bookthisweekData?, detailData? }.
app.get('/getuserdata', async (req, res) => {
  const client = await pool.connect();
  try {
    const accessToken = req.query.accesstoken;
    const page = req.query.page;

    const profileResponse = await verifyAndFetchProfile(accessToken, res);
    if (!profileResponse || !profileResponse.data || !profileResponse.data.userId) return;

    const userid = profileResponse.data.userId;
    const response = { userData: await chpVerifyUserData(client, userid) };

    if (page === 'nextweek') {
      response.booknextweekData = await chpBookingData(client, 'chp.nextweek', userid);
    } else if (page === 'thisweek') {
      response.bookthisweekData = await chpBookingData(client, 'chp.thisweek', userid);
      response.detailData = await chpDetailThisweekData(client, userid);
    }

    res.json(response);
  } catch (err) {
    console.error('GET /getuserdata error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/getuserdatathisweek', async (req, res) => {
  const accessToken = req.query.accesstoken;
  const profileResponse = await verifyAndFetchProfile(accessToken, res);
  if (!profileResponse || !profileResponse.data || !profileResponse.data.userId) return;
  const userid = profileResponse.data.userId;

  const client = await pool.connect();
  try {
    const r = await chp2Store.getUserWeekData(client, 'this', userid);   // chp2
    res.json({ status: r.status, bookthisweekdata: r.data });
  } catch (err) {
    console.error('GET /getuserdatathisweek error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/getuserdatanextweek', async (req, res) => {
  const accessToken = req.query.accesstoken;
  const profileResponse = await verifyAndFetchProfile(accessToken, res);
  if (!profileResponse || !profileResponse.data || !profileResponse.data.userId) return;
  const userid = profileResponse.data.userId;

  const client = await pool.connect();
  try {
    const r = await chp2Store.getUserWeekData(client, 'next', userid);   // chp2
    res.json({ status: r.status, booknextweekdata: r.data });
  } catch (err) {
    console.error('GET /getuserdatanextweek error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// CHP detailthisweek: returns the user's per-passenger seat assignments
// for the current week (from chp.seattoday after HR finalisation, falling
// back to chp.seatdriver for the in-progress proposal).
app.get('/getdetailthisweek', async (req, res) => {
  const accessToken = req.query.accesstoken;
  const profileResponse = await verifyAndFetchProfile(accessToken, res);
  if (!profileResponse || !profileResponse.data || !profileResponse.data.userId) return;
  const userid = profileResponse.data.userId;

  const client = await pool.connect();
  try {
    const approval = await chp2Store.getBookingApprove(client, 'this', userid);  // chp2

    const seatResult = await client.query(
      `SELECT route, day, bound, time, busnumber AS bus, seat
       FROM chp.seattoday
       WHERE userid = $1
       ORDER BY day, time`,
      [userid]
    );

    res.json({
      status: 'success',
      detailThisWeekData: {
        status: approval || 'pending',
        thisweekdata: seatResult.rows.map(r => ({
          route: r.route,
          daybound: `${r.day} ${r.bound}`,
          time: r.time,
          bus: r.bus,
          seat: r.seat,
        })),
      },
    });
  } catch (err) {
    console.error('GET /getdetailthisweek error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});
// --- Phase 2: Supervisor / HR pages and approval workflow ---

// Shape each chp.{thisweek|nextweek} JOIN chp.users row into the 21-column
// array form supervisor.ejs / hrnextweek.ejs expect:
//   [perid, first_name, last_name, route, location,
//    monday_in, monday_out, ..., sunday_out,
//    approve(bool), supervisor]
function chpBookingToRow(r) {
  return [
    r.perid || '',
    r.first_name || '',
    r.last_name || '',
    r.route || '',
    r.location || '',
    r.monday_inbound    || '', r.monday_outbound    || '',
    r.tuesday_inbound   || '', r.tuesday_outbound   || '',
    r.wednesday_inbound || '', r.wednesday_outbound || '',
    r.thursday_inbound  || '', r.thursday_outbound  || '',
    r.friday_inbound    || '', r.friday_outbound    || '',
    r.saturday_inbound  || '', r.saturday_outbound  || '',
    r.sunday_inbound    || '', r.sunday_outbound    || '',
    r.department_approval === 'approved',
    r.supervisor || '',
  ];
}

const BOOKING_COLUMNS_SQL = `
  u.perid, u.first_name, u.last_name,
  t.route, u.location,
  t.monday_inbound, t.monday_outbound,
  t.tuesday_inbound, t.tuesday_outbound,
  t.wednesday_inbound, t.wednesday_outbound,
  t.thursday_inbound, t.thursday_outbound,
  t.friday_inbound, t.friday_outbound,
  t.saturday_inbound, t.saturday_outbound,
  t.sunday_inbound, t.sunday_outbound,
  t.department_approval, u.supervisor
`;

// Supervisor approval page — shows their team's THIS week bookings.
app.get('/supervisor', async (req, res) => {
  const name = req.query.name || '';
  try {
    // chp2: ทีมของหัวหน้าคนนี้ ที่มี booking สัปดาห์นี้ (กรองด้วย employee.supervisor)
    const rows = (await chp2Store.getDashboard(pool, 'this')).filter(r => r.supervisor === name);
    res.render('supervisor', { title: 'Supervisor Approval', data: { data: rows.map(chpBookingToRow) }, name });
  } catch (err) {
    console.error('GET /supervisor error:', err);
    res.status(500).send('Server Error');
  }
});

// HR sees ALL next-week bookings (for visibility before Friday rollover).
app.get('/hrnextweek', async (req, res) => {
  try {
    // chp2: HR ดู next week ตรง ๆ (ไม่ต้อง snapshot). getDashboard คืน field ครบสำหรับ chpBookingToRow
    const rows = await chp2Store.getDashboard(pool, 'next');
    res.render('hrnextweek', { title: 'hrnextweek', data: { data: rows.map(chpBookingToRow) } });
  } catch (err) {
    console.error('GET /hrnextweek error:', err);
    res.status(500).send('Server Error');
  }
});

// POST /approve — supervisor (or HR) marks THIS week bookings as approved.
// Matches Apps Script behavior: only flips rows that have a non-empty
// pickup point (users without a location can't be packed onto a bus).
app.post('/approve', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const client = await pool.connect();
  try {
    const result = await chp2Store.approveByPerids(client, ids);   // chp2
    res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    console.error('POST /approve error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// --- Bus list JSON endpoints (used by hr.ejs and drivercheck.ejs) ---

// CHP appscript getBusnextweek() returned 5 columns from "drivernextweek":
//   D-H = route, day+bound, time, bus_number, (something)
// In the unified-DB model the equivalent of "next week's bus" is whatever's
// currently in chp.busfromhr (HR-finalized). Match the shape with 5 columns.
async function chpBusListRows(table) {
  const result = await pool.query(
    `SELECT route, day, bound, time, bus_number FROM ${table}
     ORDER BY day, bound, time, bus_number`
  );
  // The original drivernextweek had 5 columns starting from column D:
  //   [route, day+bound, time, bus_number, blank]
  return result.rows.map(r => [
    r.route || '',
    `${r.day || ''} ${r.bound || ''}`.trim(),
    r.time || '',
    r.bus_number || '',
    '',
  ]);
}

app.get('/busnextweek', async (req, res) => {
  try {
    const busnextweek = await chpBusListRows('chp.busfromhr');
    // CHP's response also carried a "status" cell from G7. We don't have
    // an equivalent flag — return empty string so the frontend treats it
    // as not-yet-approved.
    res.json({ status: '', busnextweek });
  } catch (err) {
    console.error('GET /busnextweek error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// drivercheck.ejs hits /drivercheck and reads .busnextweek from the response.
// Use the same shape; pull from chp.bustoday (today's pending bus list)
// so drivers see what they need to drive today.
app.get('/drivercheck', async (req, res) => {
  try {
    const busnextweek = await chpBusListRows('chp.bustoday');
    res.json({ status: '', busnextweek });
  } catch (err) {
    console.error('GET /drivercheck error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// --- Phase 3: pipeline endpoints (scheduled by external cron) ---

async function chpAutoApprove() {
  // chp2: อนุมัติ booking ของสัปดาห์นี้เป็นต้นไป (เผื่อ Friday จัดของจันทร์สัปดาห์หน้า)
  await pool.query(
    "UPDATE chp2.booking SET dept_approval='approved', updated_at=now() WHERE week_of >= date_trunc('week',CURRENT_DATE)::date");
}

// autoresetapprove: set every thisweek booking back to pending (un-approve all).
async function chpResetApprove() {
  await pool.query(
    "UPDATE chp2.booking SET dept_approval='pending', updated_at=now() WHERE week_of = date_trunc('week',CURRENT_DATE)::date");
}

async function chpClearDriverState() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chp.driver');
    await client.query('DELETE FROM chp.seatdriver');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// The dispatcher fills in drivers on chp.driver — the same table the packer
// clears. Returns true if any bus already has a driver assigned, so the
// auto-pack can skip and avoid wiping work that hasn't been sent to HR yet.
async function chpDriverHasAssignments() {
  const r = await pool.query(
    "SELECT 1 FROM chp.driver WHERE COALESCE(driver_user_id, '') <> '' LIMIT 1"
  );
  return r.rowCount > 0;
}

// --- Phase 4: bus packing ---
//
// Each daily run picks up approved bookings from chp.thisweek (joined with
// chp.users for the pickup point), drops them into a seat-count matrix the
// same shape as the Apps Script `util` / `sumthisweek` sheets, and writes
// per-passenger placements to chp.seatdriver plus per-bus rows to chp.driver.
//
// Day numbering: 1=Mon ... 7=Sun (matches Apps Script's route1to10* callers).
// "before" packs morning runs (07:30 / 08:15 / 10:30); "after" packs evening
// (17:15 / 19:30 / 20:15). The four Apps Script functions become two args
// (group + kind) into one shared chpPack().

const DAY_NAMES_TH = [null, 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์', 'อาทิตย์'];

// Group A route names — these must line up with sumthisweek rows 17-35.
const GROUP_A_ROUTES = [
  'วัดสว่าง', 'แคราย', 'คลอง14', 'คลอง16', 'หมู่บ้านริมบึง', 'คลองเจ้า',
  'หนามแดง', 'ประเวศ', 'แปดริ้ว', 'วัดเกาะ', 'กรุงเทพ', 'บางน้ำเปรี้ยว',
  'รวม วัดสว่าง + แคราย + คลอง14 + คลอง16', 'รวม วัดสว่าง + แคราย', 'รวม คลอง14 + คลอง16', 'รวม หมู่บ้านริมบึง + คลองเจ้า', 'รวม หนามแดง + ประเวศ', 'รวม แปดริ้ว + วัดเกาะ', 'รวม หมู่บ้านริมบึง + กรุงเทพ',
];

// Group B route names — these must line up with sumthisweek rows 51-56.
const GROUP_B_ROUTES = [
  'สนามชัย', 'ดงน้อย', 'ลาดบัวขาว', 'แปลงยาว', 'รวม ดงน้อย + สนามชัย', 'ลาดบัวขาว รถบัส',
];

// Load cap matrices (route × time-slot) from the sumthisweek CSV at startup.
// rowCount × 42 numbers; columns: (day-1)*6 + slot for slot 0..5 where
//   0:07:30(in) 1:08:15(out) 2:10:30(in) 3:17:15(out) 4:19:30(in) 5:20:15(out)
function chpLoadCapsMatrix(filepath, startRow, rowCount) {
  const raw = fs.readFileSync(path.join(__dirname, filepath), 'utf8');
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < rowCount; i++) {
    const cols = (lines[startRow - 1 + i] || '').split(',');
    const values = cols.slice(2).map(s => parseInt(s, 10) || 0);
    while (values.length < 42) values.push(0);
    out.push(values.slice(0, 42));
  }
  return out;
}

let chpCapsGroupA = null;
let chpCapsGroupB = null;
try {
  chpCapsGroupA = chpLoadCapsMatrix('Shutterbus - sumthisweek.csv', 17, 19);
  chpCapsGroupB = chpLoadCapsMatrix('Shutterbus - sumthisweek.csv', 51, 6);
} catch (err) {
  console.warn('Could not load CHP caps matrices — bus packing will refuse to run:', err.message);
}

function chpZerosMatrix(rows, cols) {
  return Array.from({ length: rows }, () => new Array(cols).fill(0));
}

// "ลาดบัวขาว จุด 1-14" was stored on the booking row at booking time; collapse
// back to the canonical pack-target name before looking up rindex.
function chpCanonicalizeRoute(route) {
  if (route === 'ลาดบัวขาว จุด 1-14') return 'ลาดบัวขาว';
  if (route === 'แปลงยาว จุด 1-6')   return 'แปลงยาว';
  if (route === 'สนามชัย จุด 1-3')    return 'สนามชัย';
  if (route === 'ดงน้อย จุด 1-5')     return 'ดงน้อย';
  return route;
}

function chpTimeToIndex(time, bound) {
  if (bound === 'ขาเข้า' && time === '07:30') return 0;
  if (bound === 'ขาออก' && time === '08:15') return 1;
  if (bound === 'ขาเข้า' && time === '10:30') return 2;
  if (bound === 'ขาออก' && time === '17:15') return 3;
  if (bound === 'ขาเข้า' && time === '19:30') return 4;
  return 5;
}

// Group A spillover when the base route is at cap.
// Matches the chain in Apps Script route1to10berfore1400 / after1400.
function chpSpilloverA(routeName, ref, matrix, caps) {
  let rindex, route;
  if (routeName === 'วัดสว่าง' || routeName === 'แคราย') {
    rindex = 12; route = GROUP_A_ROUTES[12];
    if (matrix[rindex][ref] == caps[rindex][ref]) {
      rindex = 13; route = GROUP_A_ROUTES[13];
    }
  } else if (routeName === 'คลอง14' || routeName === 'คลอง16') {
    rindex = 12; route = GROUP_A_ROUTES[12];
    if (matrix[rindex][ref] == caps[rindex][ref]) {
      rindex = 14; route = GROUP_A_ROUTES[14];
    }
  } else if (routeName === 'หมู่บ้านริมบึง') {
    rindex = 18; route = GROUP_A_ROUTES[18];
    if (matrix[rindex][ref] == caps[rindex][ref]) {
      rindex = 15; route = GROUP_A_ROUTES[15];
    }
  } else if (routeName === 'คลองเจ้า') {
    rindex = 15; route = GROUP_A_ROUTES[15];
  } else if (routeName === 'หนามแดง' || routeName === 'ประเวศ') {
    rindex = 16; route = GROUP_A_ROUTES[16];
  } else if (routeName === 'แปดริ้ว' || routeName === 'วัดเกาะ') {
    rindex = 17; route = GROUP_A_ROUTES[17];
  } else {
    return null;
  }
  return { rindex, route };
}

// Group B spillover (route11to14*).
function chpSpilloverB(routeName, ref, matrix, caps) {
  let rindex, route;
  if (routeName === 'สนามชัย') {
    rindex = 1; route = GROUP_B_ROUTES[1];
    if (matrix[rindex][ref] == caps[rindex][ref]) {
      rindex = 4; route = GROUP_B_ROUTES[4];
    }
  } else if (routeName === 'ดงน้อย') {
    rindex = 0; route = GROUP_B_ROUTES[0];
    if (matrix[rindex][ref] == caps[rindex][ref]) {
      rindex = 4; route = GROUP_B_ROUTES[4];
    }
  } else if (routeName === 'ลาดบัวขาว') {
    rindex = 5; route = GROUP_B_ROUTES[5];
    if (matrix[rindex][ref] == caps[rindex][ref]) {
      rindex = 3; route = GROUP_B_ROUTES[3];
    }
  } else if (routeName === 'แปลงยาว') {
    rindex = 2; route = GROUP_B_ROUTES[2];
    if (matrix[rindex][ref] == caps[rindex][ref]) {
      rindex = 5; route = GROUP_B_ROUTES[5];
    }
  } else {
    return null;
  }
  return { rindex, route };
}

const DAY_COLUMNS = [
  null, // 0 = unused (day numbering is 1-indexed)
  ['monday_inbound',    'monday_outbound'],
  ['tuesday_inbound',   'tuesday_outbound'],
  ['wednesday_inbound', 'wednesday_outbound'],
  ['thursday_inbound',  'thursday_outbound'],
  ['friday_inbound',    'friday_outbound'],
  ['saturday_inbound',  'saturday_outbound'],
  ['sunday_inbound',    'sunday_outbound'],
];

// Core packer used by all four Apps Script entry points.
//   day:   1=Mon ... 7=Sun
//   kind:  'before' (morning) | 'after' (evening)
//   group: 'A' (CHP01-10/15/16 + combined) | 'B' (CHP11-14 + รถบัส)
async function chpPack(day, kind, group) {
  if (day < 1 || day > 7) return;
  const today = DAY_NAMES_TH[day];
  const serviceDate = bangkokServiceDate(day); // actual calendar date for this day-number

  const caps = group === 'A' ? chpCapsGroupA : chpCapsGroupB;
  const routes = group === 'A' ? GROUP_A_ROUTES : GROUP_B_ROUTES;
  const spillover = group === 'A' ? chpSpilloverA : chpSpilloverB;
  if (!caps) {
    console.warn(`chpPack(${day},${kind},${group}) skipped — caps matrix not loaded`);
    return;
  }
  const matrix = chpZerosMatrix(routes.length, 42);

  const client = await pool.connect();
  try {
    const rs = await client.query(
      `SELECT u.userid, u.perid, u.first_name, u.last_name, u.location,
              t.route,
              t.monday_inbound, t.monday_outbound,
              t.tuesday_inbound, t.tuesday_outbound,
              t.wednesday_inbound, t.wednesday_outbound,
              t.thursday_inbound, t.thursday_outbound,
              t.friday_inbound, t.friday_outbound,
              t.saturday_inbound, t.saturday_outbound,
              t.sunday_inbound, t.sunday_outbound
       FROM chp.thisweek t
       JOIN chp.users u ON u.userid = t.userid
       WHERE t.department_approval = 'approved'
         AND COALESCE(u.location, '') <> ''
       ORDER BY u.location, u.first_name`
    );

    const [colIn, colOut] = DAY_COLUMNS[day];

    await client.query('BEGIN');

    rowLoop:
    for (const row of rs.rows) {
      const route0 = chpCanonicalizeRoute(row.route);
      const isGroupB = ['สนามชัย', 'ดงน้อย', 'ลาดบัวขาว', 'แปลงยาว'].includes(route0);
      if (group === 'A' && isGroupB) continue;
      if (group === 'B' && !isGroupB) continue;

      for (const bound of ['ขาเข้า', 'ขาออก']) {
        const time = bound === 'ขาเข้า' ? row[colIn] : row[colOut];
        const index = chpTimeToIndex(time, bound);

        if (kind === 'before' && index >= 3) continue;
        if (kind === 'after'  && index < 3)  continue;
        if (!time || time === 'ไม่ใช้') continue;

        const ref = (day - 1) * 6 + index;

        let route = route0;
        let rindex = routes.indexOf(route);
        if (rindex < 0) continue;

        let pax = matrix[rindex][ref];
        if (pax == caps[rindex][ref]) {
          const sp = spillover(route, ref, matrix, caps);
          if (sp) { rindex = sp.rindex; route = sp.route; pax = matrix[rindex][ref]; }
        } else if (pax > caps[rindex][ref]) {
          console.error(`pack error ${route} ${kind} ${today} ref=${ref}`);
          await client.query('ROLLBACK');
          const u = (process.env.ERROR_NOTIFY_USER || '').trim();
          if (u) await sendPushMessage([u], `จัดรถไม่สำเร็จ ${route} ${kind}1400 ${today}`);
          return;
        }

        pax = pax + 1;
        const busSize = route === 'ลาดบัวขาว รถบัส' ? 42 : 13;
        let seat = pax % busSize;
        if (seat === 0) seat = busSize;
        const busnumber = Math.ceil(pax / busSize);

        await client.query(
          `INSERT INTO chp.seatdriver (userid, perid, first_name, last_name, route, location, day, bound, time, busnumber, seat, service_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [row.userid, row.perid, row.first_name, row.last_name,
           route, row.location, today, bound, time, busnumber, seat, serviceDate]
        );

        matrix[rindex][ref] = pax;

        if (seat === 1) {
          await client.query(
            `INSERT INTO chp.driver (route, day, bound, time, bus_number, service_date) VALUES ($1,$2,$3,$4,$5,$6)`,
            [route, today, bound, time, busnumber, serviceDate]
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`chpPack(${day},${kind},${group}) failed:`, err);
    throw err;
  } finally {
    client.release();
  }
}

async function chpPackRoute1to10Before1400(day) { return chpPack(day, 'before', 'A'); }
async function chpPackRoute1to10After1400(day)  { return chpPack(day, 'after',  'A'); }
async function chpPackRoute11to14Before1400(day) { return chpPack(day, 'before', 'B'); }
async function chpPackRoute11to14After1400(day)  { return chpPack(day, 'after',  'B'); }

// Convert UTC server time to Bangkok day-of-week (0=Sun..6=Sat).
// Works regardless of server timezone (e.g. the SG host) because it offsets
// the absolute UTC timestamp by +7h, not the local clock.
function bangkokDayOfWeek(d = new Date()) {
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.getUTCDay();
}

// 'YYYY-MM-DD' for the Bangkok date `addDays` from today.
function bangkokDateISO(addDays = 0, d = new Date()) {
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000 + addDays * 24 * 60 * 60 * 1000);
  const y = bkk.getUTCFullYear();
  const m = String(bkk.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bkk.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Actual calendar date (Bangkok) for a pack day-number (1=Mon..7=Sun),
// resolved as the next occurrence on/after today — matches how /daliy packs
// today + the following days (incl. Fri packing Sat/Sun then next Mon).
function bangkokServiceDate(dayNum) {
  const dow = bangkokDayOfWeek();          // 0=Sun..6=Sat
  const dowMon = dow === 0 ? 7 : dow;      // 1=Mon..7=Sun
  const offset = (dayNum - dowMon + 7) % 7;
  return bangkokDateISO(offset);
}

// Monday (Bangkok) of next week — the week chp.nextweek bookings are for.
function bangkokNextMondayISO() {
  const dow = bangkokDayOfWeek();
  const dowMon = dow === 0 ? 7 : dow;
  const daysUntilNextMonday = ((1 - dowMon + 7) % 7) || 7; // strictly the upcoming Monday
  return bangkokDateISO(daysUntilNextMonday);
}

// GET /weekly — rollover thisweek→lastweek, nextweek→thisweek, clear nextweek.
// Apps Script invokes this inline from calculatedaily on Friday; expose it
// separately for manual triggering or a dedicated Friday cron.
app.get('/weekly', async (req, res) => {
  // chp2: booking ใช้ week_of -> "สัปดาห์นี้/หน้า" เลื่อนอัตโนมัติตามวันที่ ไม่ต้อง rollover
  res.json({ ok: true, note: 'chp2: no rollover needed (week_of based)' });
});

// Set of 'YYYY-MM-DD' holiday dates (admin-managed via /holiday). Best-effort:
// on any error treat as "no holidays" so packing still runs as before.
async function chpGetHolidaySet() {
  try {
    const { rows } = await pool.query(
      `SELECT to_char(holiday_date,'YYYY-MM-DD') d FROM chp.holiday`);
    return new Set(rows.map(r => r.d));
  } catch (err) {
    console.error('chpGetHolidaySet failed:', err);
    return new Set();
  }
}

// Build the pack segments for today's 14:30 run, honouring holidays.
// A "run day" = a weekday (Mon–Fri) that is NOT a holiday; only run days get
// their own 14:30 run. Rule: pack today-after, then walk forward day by day —
// the first run day we hit gets its -before and we stop; every weekend/holiday
// day before it has no run of its own, so we bundle it as a full day ('all')
// (rides still operate on holidays, they're just dispatched in advance).
// With no holidays this reproduces the old behaviour exactly:
//   Mon–Thu -> [today-after, tomorrow-before]
//   Fri     -> [Fri-after, Sat-all, Sun-all, Mon-before]
function chpBuildSegments(holidays) {
  const segs = [{ d: 0, half: 'after' }];
  for (let d = 1; d <= 14; d++) { // 14 = safety cap (e.g. long holiday runs)
    const iso = bangkokDateISO(d);
    const dow = bangkokDayOfWeek(new Date(Date.now() + d * 24 * 60 * 60 * 1000)); // 0=Sun..6=Sat
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = holidays.has(iso);
    if (!isWeekend && !isHoliday) { segs.push({ d, half: 'before' }); break; }
    segs.push({ d, half: 'all' }); // weekend or holiday: bundle the whole day
  }
  return segs;
}

// calculatedaily — main daily packing run (cron at 14:30 Asia/Bangkok Mon–Fri,
// also exposed as GET /daliy for manual triggering). Packs a rolling 14:30→14:30
// window via chpBuildSegments, which bundles weekends + admin-set holidays into
// the preceding working day's run. Skips weekends and holidays (no run of own).
async function runDaily() {
  const dayOfWeek = bangkokDayOfWeek(); // 0=Sun..6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return { ok: true, skipped: 'weekend' };
  }

  const holidays = await chpGetHolidaySet();
  const todayIso = bangkokDateISO(0);
  if (holidays.has(todayIso)) {
    // Holiday: no run today — the preceding working day already bundled today.
    await chpLog('system', 'daliy-skipped-holiday', null, { date: todayIso });
    return { ok: true, skipped: 'holiday', date: todayIso };
  }

  // Guard: don't wipe the dispatcher's in-progress bus list. If chp.driver
  // already has assigned drivers (not yet sent to HR), skip and notify.
  if (await chpDriverHasAssignments()) {
    await chpLog('system', 'daliy-skipped-driver-busy', null, { day: dayOfWeek });
    await sendPushMessage(adminLineUsers,
      '⚠️ ข้ามจัดรถอัตโนมัติ: ยังมีรถที่คนจัดรถกรอกคนขับค้างอยู่ใน chp.driver (ยังไม่ได้ส่ง HR) — กรุณาส่ง HR ก่อน แล้วค่อยรัน /daliy ใหม่');
    await telegramNotify('⚠️ CHP ข้ามจัดรถอัตโนมัติ: ยังมีรถค้างใน chp.driver (ยังไม่ได้ส่ง HR) — กรุณาส่ง HR ก่อน แล้วรันใหม่').catch(() => {});
    return { ok: true, skipped: 'driver-has-assignments' };
  }
  await chpLog('system', 'daliy-pack', null, { day: dayOfWeek });

  await chpAutoApprove();
  await chpClearDriverState();

  // chp2 engine: จัดเป็นช่วง 14:30→14:30 (BKK) ไม่ใช่ทั้งวัน — segments คำนวณจาก
  // chpBuildSegments (รวบเสาร์/อาทิตย์ + วันหยุดที่ admin ตั้งไว้เข้ารอบวันก่อนหน้า)
  //   half: 'before' = slot ก่อน 14:30 (07:30/08:15/10:30)
  //         'after'  = slot ตั้งแต่ 14:30 (17:15/19:30/20:15)
  //         'all'    = ทั้งวัน (เสาร์/อาทิตย์/วันหยุด ที่ถูกรวบ)
  const segs = chpBuildSegments(holidays);
  const dates = [];
  for (const seg of segs) {
    const d = bangkokDateISO(seg.d);
    dates.push(`${d}(${seg.half})`);
    const { plan } = await chp2Pack.planDate(pool, d, { half: seg.half });
    await chp2Pack.commitToChp(pool, d, plan);
  }

  await sendPushMessage(adminLineUsers, `CHP daliy pack เสร็จ (วัน ${dayOfWeek}: ${dates.join(', ')})`);
  await telegramNotify(`🚐 จัดรถอัตโนมัติเสร็จแล้ว (วัน ${dayOfWeek})\nช่วงที่จัด: ${dates.join(', ')}`).catch(() => {});
  return { ok: true, day: dayOfWeek, dates };
}

app.get('/daliy', async (req, res) => {
  try {
    res.json(await runDaily());
  } catch (err) {
    console.error('GET /daliy error:', err);
    const u = (process.env.ERROR_NOTIFY_USER || '').trim();
    if (u) await sendPushMessage([u], `วันนี้ทำงานไม่สำเร็จครับ: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Manual triggers for the other two scheduled jobs (handy for testing).
app.get('/autoresetapprove', async (req, res) => {
  try {
    await chpResetApprove();
    res.json({ ok: true });
  } catch (err) {
    console.error('GET /autoresetapprove error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/tranfernextweekforhr', async (req, res) => {
  // chp2: HR ดู next week ได้ตรง ๆ ผ่าน /hrnextweek (getDashboard('next')) — ไม่ต้อง snapshot
  res.json({ ok: true, note: 'chp2: HR reads next week directly; snapshot not needed' });
});

// POST /driversendtohr — driver dispatches today's plan to HR. Mirrors the
// Apps Script approve() function: promote chp.driver → chp.bustoday and
// chp.seatdriver → chp.seattoday, then ping the admin LINE recipients.
app.post('/driversendtohr', async (req, res) => {
  try {
    await chpTransferDriverToBustoday();
    await chpTransferSeatdriverToSeattoday();
    await pool.query('DELETE FROM chp.driver');
    await pool.query('DELETE FROM chp.seatdriver');
    await sendPushMessage(adminLineUsers, 'จัดรถ CHP ส่งข้อมูลให้ HR');
    const busCnt = (await pool.query('SELECT count(*) FROM chp.bustoday')).rows[0].count;
    const seatCnt = (await pool.query('SELECT count(*) FROM chp.seattoday')).rows[0].count;
    await telegramNotify(`📤 คนจัดรถส่งข้อมูลให้ HR แล้ว\nรถ ${busCnt} คัน / ผู้โดยสาร ${seatCnt} คน`).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /driversendtohr error:', err);
    res.status(500).json({ error: err.message });
  }
});
// --- TODO: Phase 4 (bus packing — calculatebus equivalents) ---
// --- Phase 5: LINE webhook ---

// HMAC SHA256 over the raw body using CHANNELSECRET; LINE sends the
// expected digest in X-Line-Signature.
function validateSignatureMiddleware(req, res, next) {
  const signature = req.get('X-Line-Signature');
  if (!signature) return res.status(400).send('Signature missing');
  if (!channelSecret) return res.status(500).send('Server missing CHANNELSECRET');

  const body = JSON.stringify(req.body);
  const hash = crypto.createHmac('sha256', channelSecret).update(body).digest('base64');
  if (hash !== signature) return res.status(401).send('Invalid signature');
  next();
}

async function chpReplyMenu(replyToken) {
  if (!accessToken) return;
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      {
        replyToken,
        messages: [{
          type: 'flex',
          altText: 'CHP menu',
          contents: {
            type: 'bubble',
            body: {
              type: 'box', layout: 'vertical',
              contents: [{ type: 'text', text: 'กรุณาเลือกเมนู', weight: 'bold', size: 'xl' }],
            },
            footer: {
              type: 'box', layout: 'vertical', spacing: 'sm', flex: 0,
              contents: [{
                type: 'button',
                action: { type: 'uri', label: 'Check in', uri: 'https://liff.line.me/2002711129-MPLvkR4W' },
              }],
            },
          },
        }],
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    console.error('chpReplyMenu error:', err.response ? err.response.data : err.message);
  }
}

async function chpReplyLocation(replyToken) {
  if (!accessToken) return;
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      {
        replyToken,
        messages: [{
          type: 'location', title: 'CHP Resonac',
          address: 'Chachoengsao, Thailand',
          // TODO: update to real CHP plant coordinates
          latitude: 13.6904, longitude: 101.0779,
        }],
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
    );
  } catch (err) {
    console.error('chpReplyLocation error:', err.response ? err.response.data : err.message);
  }
}

async function chpHandleEvent(event) {
  if (event.type !== 'message') return;
  const msg = event.message;
  if (msg.type !== 'text') return;
  if (msg.text === '/checkin') return chpReplyMenu(event.replyToken);
  if (msg.text === 'location') return chpReplyLocation(event.replyToken);
}

app.post('/callback', validateSignatureMiddleware, async (req, res) => {
  const events = req.body.events;
  if (!Array.isArray(events)) return res.status(400).end();
  try {
    await Promise.all(events.map(chpHandleEvent));
    res.end();
  } catch (err) {
    console.error('/callback error:', err);
    res.status(500).end();
  }
});
// --- Phase 6: CSV/Excel exports for HR ---
//
// Each endpoint writes a temporary file to the project root, serves it via
// res.download(), then unlinks it. Caller passes a fully-qualified table
// name (e.g. "chp.busfromhr") and the desired download filename.

async function chpDownloadExcel(tableName, filename, res) {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM ${tableName}`);
    if (result.rows.length === 0) return res.status(404).send('No data available');

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(filename.replace(/\.xlsx$/, ''));
    worksheet.columns = Object.keys(result.rows[0]).map(key => ({ header: key, key }));
    result.rows.forEach(row => worksheet.addRow(row));

    const filePath = path.join(__dirname, filename);
    await workbook.xlsx.writeFile(filePath);
    res.download(filePath, filename, (err) => {
      if (err) console.error('chpDownloadExcel send error:', err);
      fs.unlink(filePath, () => {});
    });
  } catch (err) {
    console.error(`chpDownloadExcel(${tableName}) error:`, err);
    res.status(500).send('Internal Server Error');
  } finally {
    client.release();
  }
}

async function chpDownloadCsv(tableName, filename, res) {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM ${tableName}`);
    if (result.rows.length === 0) return res.status(404).send('No data available');

    const filePath = path.join(__dirname, filename);
    const csvWriter = createCsvWriter({
      path: filePath,
      header: Object.keys(result.rows[0]).map(k => ({ id: k, title: k })),
    });
    await csvWriter.writeRecords(result.rows);
    res.download(filePath, filename, (err) => {
      if (err) console.error('chpDownloadCsv send error:', err);
      fs.unlink(filePath, () => {});
    });
  } catch (err) {
    console.error(`chpDownloadCsv(${tableName}) error:`, err);
    res.status(500).send('Internal Server Error');
  } finally {
    client.release();
  }
}

// Driver-side current proposals
app.get('/download-excel-driver',     (req, res) => chpDownloadExcel('chp.driver',     'driver.xlsx',     res));
app.get('/download-excel-seatdriver', (req, res) => chpDownloadExcel('chp.seatdriver', 'seatdriver.xlsx', res));
app.get('/download-csv-driver',       (req, res) => chpDownloadCsv  ('chp.driver',     'driver.txt',      res));
app.get('/download-csv-seatdriver',   (req, res) => chpDownloadCsv  ('chp.seatdriver', 'seatdriver.txt',  res));

// HR-pending (sent by driver via /driversendtohr)
app.get('/download-excel-bustoday',   (req, res) => chpDownloadExcel('chp.bustoday',   'bustoday.xlsx',   res));
app.get('/download-excel-seattoday',  (req, res) => chpDownloadExcel('chp.seattoday',  'seattoday.xlsx',  res));
app.get('/download-csv-bustoday',     (req, res) => chpDownloadCsv  ('chp.bustoday',   'bustoday.txt',    res));
app.get('/download-csv-seattoday',    (req, res) => chpDownloadCsv  ('chp.seattoday',  'seattoday.txt',   res));

// HR-finalized
app.get('/download-excel-busfromhr',  (req, res) => chpDownloadExcel('chp.busfromhr',  'busfromhr.xlsx',  res));
app.get('/download-excel-seatfromhr', (req, res) => chpDownloadExcel('chp.seatfromhr', 'seatfromhr.xlsx', res));
app.get('/download-csv-busfromhr',    (req, res) => chpDownloadCsv  ('chp.busfromhr',  'busfromhr.txt',   res));
app.get('/download-csv-seatfromhr',   (req, res) => chpDownloadCsv  ('chp.seatfromhr', 'seatfromhr.txt',  res));

// --- Change log viewer ------------------------------------------------------
app.get('/changelog', requireRole('admin', 'driver'), (req, res) => res.render('changelog'));
app.get('/changelogjson', requireRole('admin', 'driver'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id,
             to_char(ts AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') AS ts,
             actor, action, row_id, detail
      FROM chp.change_log
      ORDER BY id DESC
      LIMIT 1000
    `);
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('GET /changelogjson error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- Holidays (admin) -------------------------------------------------------
// Admin marks calendar dates as holidays. A holiday has no dispatch run of its
// own; runDaily bundles it into the preceding working day's run (see
// chpBuildSegments). Plain form POSTs (urlencoded) + redirect — no client JS.
const HOLIDAY_DOW_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
app.get('/holiday', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT to_char(holiday_date,'YYYY-MM-DD') AS date,
             EXTRACT(DOW FROM holiday_date)::int AS dow,
             note, (holiday_date < CURRENT_DATE) AS past
      FROM chp.holiday ORDER BY holiday_date`);
    const holidays = rows.map(r => ({
      date: r.date, note: r.note || '', past: r.past,
      dow_th: HOLIDAY_DOW_TH[r.dow],
    }));
    res.render('holiday', { holidays, today: bangkokDateISO(0), err: req.query.err || '' });
  } catch (err) {
    console.error('GET /holiday error:', err);
    res.status(500).send('Server Error');
  }
});

app.post('/holiday/add', requireRole('admin'), async (req, res) => {
  const date = (req.body.date || '').trim();
  const note = (req.body.note || '').trim() || null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect('/holiday?err=baddate');
  try {
    await pool.query(
      `INSERT INTO chp.holiday (holiday_date, note) VALUES ($1, $2)
       ON CONFLICT (holiday_date) DO UPDATE SET note = EXCLUDED.note`, [date, note]);
    await chpLog('admin', 'holiday-add', date, { date, note });
    res.redirect('/holiday');
  } catch (err) {
    console.error('POST /holiday/add error:', err);
    res.redirect('/holiday?err=save');
  }
});

app.post('/holiday/remove', requireRole('admin'), async (req, res) => {
  const date = (req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect('/holiday?err=baddate');
  try {
    await pool.query('DELETE FROM chp.holiday WHERE holiday_date = $1', [date]);
    await chpLog('admin', 'holiday-remove', date, { date });
    res.redirect('/holiday');
  } catch (err) {
    console.error('POST /holiday/remove error:', err);
    res.redirect('/holiday?err=save');
  }
});

// --- Schedulers (node-cron) -------------------------------------------------
// The host runs in Singapore (UTC+8) but every job must fire at Bangkok
// (UTC+7) wall-clock time, so each schedule passes { timezone: 'Asia/Bangkok' }
// — node-cron interprets the expression in that zone, no manual offset.
function chpRunJob(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`[cron] ${name} done`))
    .catch(async (err) => {
      console.error(`[cron] ${name} failed:`, err);
      const u = (process.env.ERROR_NOTIFY_USER || '').trim();
      if (u) await sendPushMessage([u], `CHP cron ${name} ล้มเหลว: ${err.message}`).catch(() => {});
    });
}

function chpStartSchedulers() {
  const tz = { timezone: 'Asia/Bangkok' };
  // autoresetapprove — ทุกวัน 00:00
  cron.schedule('0 0 * * *',     () => chpRunJob('autoresetapprove', chpResetApprove), tz);
  // tranfernextweekforhr — ศุกร์ 13:30 (ต้องก่อน rollover ของ calculatedaily 14:30)
  cron.schedule('30 13 * * 5',   () => chpRunJob('tranfernextweekforhr', chpSnapshotNextweekForHr), tz);
  // calculatedaily — จันทร์–ศุกร์ 14:30
  cron.schedule('30 14 * * 1-5', () => chpRunJob('calculatedaily', runDaily), tz);

  console.log('[cron] schedulers started (Asia/Bangkok)');
}

const PORT = Number(process.env.PORT) || 3000;

(async () => {
  try {
    await chpEnsureSchema();
    console.log('[startup] chp schema ensured');
  } catch (err) {
    console.error('[startup] chpEnsureSchema failed:', err);
  }
  chpStartSchedulers();
  app.listen(PORT, () => {
    console.log(`CHP shuttle-bus server listening on :${PORT}`);
    telegramNotify('CHP Bus deploy successful 🚀').catch(() => {});
  });
})();
