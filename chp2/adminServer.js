'use strict';
// standalone launcher สำหรับทดสอบหน้า admin นอก index.js
//   node chp2/adminServer.js  -> http://localhost:3100/
// (ตอน cutover จริง index.js mount adminRouter ที่ /chp2/rules เอง — ดู chp2/README.md)
const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use('/', require('./adminRouter'));

const PORT = Number(process.env.CHP2_ADMIN_PORT) || 3100;
app.listen(PORT, () => console.log(`chp2 rules-admin (standalone): http://localhost:${PORT}/`));
