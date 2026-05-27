'use strict';
// standalone launcher สำหรับทดสอบหน้า admin นอก index.js
//   node chp2/adminServer.js  -> http://localhost:3100/
// (ตอน cutover จริง index.js mount adminRouter ที่ /chp2/rules เอง — ดู chp2/README.md)
const express = require('express');
const path = require('path');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true }));
// adminRouter now renders the chp2rules.ejs shell, which includes the shared
// admin menu partial; that partial reads res.locals.currentPath for active state.
app.use((req, res, next) => { res.locals.currentPath = req.path; next(); });
app.use('/', require('./adminRouter'));

const PORT = Number(process.env.CHP2_ADMIN_PORT) || 3100;
app.listen(PORT, () => console.log(`chp2 rules-admin (standalone): http://localhost:${PORT}/`));
