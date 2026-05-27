'use strict';
// pool สำหรับโค้ดใหม่ที่ทำงานบน schema chp2 (แยกจาก index.js ที่ยัง live บน chp)
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  keepAlive: true,
});

module.exports = { pool };
