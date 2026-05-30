// Shared table tools for the admin list pages (driver / seat / bus / history /
// member / dashboard). Adds:
//   1. filtering — two modes:
//       a) column-filter mode (per-column inputs, AND'd) when the page has
//          .filter-bar inputs with data-col="N" attributes. Inputs stay visible
//          and act as column-targeted filters. Used on /driver, /seatdriver.
//       b) unified-search mode (single search box across all columns) when no
//          data-col inputs exist. Replaces the legacy per-column filter inputs
//          which are hidden. Used on /member, /thisweekdashboard, etc.
//   2. click-to-sort column headers (click again to reverse).
//   3. pagination — the visible (matched + sorted) rows are split into pages of
//      `pageSize` (default 20, override via `data-page-size` on the table). The
//      pager only appears when there is more than one page. This replaces the
//      legacy per-page member.js / dashboard.js pagination (now neutralised)
//      so search, sort and paging all cooperate from one place.
//
// Pipeline per render is: filter → sort → paginate. Rows are often rendered
// asynchronously by each page's own script (fetch + rebuild of <tbody>), so a
// MutationObserver re-applies everything after each re-render. Filtering hides
// rows via a `.tt-hide` class marked !important; pagination hides off-page rows
// with inline display:none.
(function () {
  var DEFAULT_PAGE_SIZE = 20;

  function init() {
    var table = document.querySelector('table.approval-table');
    if (!table || !table.tBodies.length) return;
    var tbody = table.tBodies[0];
    var headers = Array.prototype.slice.call(table.querySelectorAll('thead th'));
    if (!headers.length) return;

    var pageSize = parseInt(table.getAttribute('data-page-size'), 10) || DEFAULT_PAGE_SIZE;

    var style = document.createElement('style');
    style.textContent =
      '.tt-hide{display:none !important;}' +
      '.tt-search{flex:1 1 240px;min-width:160px;padding:8px 12px;border:1px solid #cbd5e1;' +
      'border-radius:8px;font-size:14px;}' +
      'table.approval-table thead th.tt-sortable{cursor:pointer;user-select:none;white-space:nowrap;}' +
      'table.approval-table thead th.tt-sortable:hover{background:rgba(0,0,0,.05);}' +
      '.tt-arrow{font-size:11px;opacity:.7;margin-left:4px;}' +
      '.tt-pager{display:flex;align-items:center;justify-content:center;gap:12px;' +
      'flex-wrap:wrap;margin:14px 0 4px;}' +
      '.tt-pager button{padding:6px 14px;border:1px solid #cbd5e1;background:#fff;' +
      'border-radius:8px;font-size:13px;cursor:pointer;color:#1e293b;}' +
      '.tt-pager button:hover:not(:disabled){background:#f1f5f9;}' +
      '.tt-pager button:disabled{opacity:.45;cursor:default;}' +
      '.tt-page-label{font-size:13px;color:#475569;min-width:160px;text-align:center;}';
    document.head.appendChild(style);

    var bar = document.querySelector('.filter-bar');
    var colInputs = bar
      ? Array.prototype.slice.call(bar.querySelectorAll('input[data-col]'))
      : [];
    var columnMode = colInputs.length > 0;

    if (columnMode) {
      // Per-column filters: keep them visible, drive apply() on input.
      colInputs.forEach(function (inp) {
        inp.addEventListener('input', function () { state.page = 1; apply(); });
      });
    } else {
      // Unified-search: hide legacy per-column controls, inject one search box.
      document.querySelectorAll('.filter-bar input, .filter-bar select').forEach(function (el) {
        el.style.display = 'none';
        if (el.value) el.value = '';
      });
      var search = document.createElement('input');
      search.type = 'text';
      search.className = 'tt-search';
      search.placeholder = '🔍 ค้นหา... (ทุกคอลัมน์)';
      if (bar) bar.insertBefore(search, bar.firstChild);
      else table.parentNode.insertBefore(search, table);
      search.addEventListener('input', function () {
        state.term = search.value.trim().toLowerCase();
        state.page = 1;
        apply();
      });
    }

    // Neutralize the legacy pagination/results on /member, /thisweekdashboard,
    // /nextweekdashboard: their member.js / dashboard.js hide rows past page 1
    // with inline display='none' and bind their own (now hidden) prev/next
    // buttons. We hide that markup and reset the row display, then drive paging
    // ourselves below so it cooperates with search + sort.
    document.querySelectorAll('.pagination, .results').forEach(function (el) {
      el.style.display = 'none';
    });
    Array.prototype.slice.call(tbody.rows).forEach(function (r) {
      if (r.style.display === 'none') r.style.display = '';
    });

    var state = { col: -1, dir: 1, term: '', page: 1 };
    var firstIsIndex = /^(ลำดับ|#|ที่)$/.test(headers[0].textContent.trim());

    headers.forEach(function (th, i) {
      if (th.textContent.trim() === '') return; // skip action columns
      th.classList.add('tt-sortable');
      th.addEventListener('click', function () {
        if (state.col === i) state.dir = -state.dir;
        else { state.col = i; state.dir = 1; }
        state.page = 1;
        apply();
      });
    });

    // Pager UI — built once, lives just below the table. Hidden when ≤ 1 page.
    var pager = document.createElement('div');
    pager.className = 'tt-pager';
    var prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.textContent = '‹ ก่อนหน้า';
    var pageLabel = document.createElement('span');
    pageLabel.className = 'tt-page-label';
    var nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.textContent = 'ถัดไป ›';
    pager.appendChild(prevBtn);
    pager.appendChild(pageLabel);
    pager.appendChild(nextBtn);
    table.parentNode.insertBefore(pager, table.nextSibling);
    prevBtn.addEventListener('click', function () {
      if (state.page > 1) { state.page--; apply(); }
    });
    nextBtn.addEventListener('click', function () {
      state.page++; apply();   // apply() clamps to the last page
    });

    function isActionCell(cell) {
      return !!cell.querySelector('button,a,input,select');
    }
    function cellText(row, i) {
      var c = row.cells[i];
      return c ? c.textContent.trim() : '';
    }
    function rowText(row) {
      var parts = [];
      for (var i = 0; i < row.cells.length; i++) {
        if (isActionCell(row.cells[i])) continue;
        parts.push(row.cells[i].textContent);
      }
      return parts.join(' ').toLowerCase();
    }
    function rowMatches(row) {
      if (columnMode) {
        for (var i = 0; i < colInputs.length; i++) {
          var term = colInputs[i].value.trim().toLowerCase();
          if (!term) continue;
          var col = parseInt(colInputs[i].dataset.col, 10);
          var c = row.cells[col];
          var txt = c ? c.textContent.toLowerCase() : '';
          if (txt.indexOf(term) === -1) return false;
        }
        return true;
      }
      return !state.term || rowText(row).indexOf(state.term) !== -1;
    }
    function compare(a, b) {
      var na = parseFloat(a), nb = parseFloat(b);
      var aNum = a !== '' && !isNaN(na) && /^-?\d/.test(a);
      var bNum = b !== '' && !isNaN(nb) && /^-?\d/.test(b);
      if (aNum && bNum) return na - nb;
      return a.localeCompare(b, 'th');
    }

    var observer;
    function apply() {
      if (observer) observer.disconnect();
      var rows = Array.prototype.slice.call(tbody.rows);

      // 1) sort (reorders the DOM so pagination slices the sorted order)
      if (state.col >= 0) {
        rows.sort(function (r1, r2) {
          return compare(cellText(r1, state.col), cellText(r2, state.col)) * state.dir;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      }

      // 2) filter — collect the matched rows (in current order)
      var matched = [];
      rows.forEach(function (r) {
        var ok = rowMatches(r);
        r.classList.toggle('tt-hide', !ok);
        if (ok) matched.push(r);
      });

      // 3) paginate the matched rows
      var total = matched.length;
      var totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (state.page > totalPages) state.page = totalPages;
      if (state.page < 1) state.page = 1;
      var start = (state.page - 1) * pageSize;
      var end = start + pageSize;

      matched.forEach(function (r, idx) {
        r.style.display = (idx >= start && idx < end) ? '' : 'none';
        if (firstIsIndex && r.cells[0] && !isActionCell(r.cells[0])) {
          r.cells[0].textContent = idx + 1;   // continuous numbering across pages
        }
      });

      // sort-direction arrows
      headers.forEach(function (th, i) {
        var old = th.querySelector('.tt-arrow');
        if (old) old.remove();
        if (i === state.col) {
          var s = document.createElement('span');
          s.className = 'tt-arrow';
          s.textContent = state.dir > 0 ? '▲' : '▼';
          th.appendChild(s);
        }
      });

      // pager state
      if (totalPages > 1) {
        pager.style.display = '';
        pageLabel.textContent = 'หน้า ' + state.page + ' / ' + totalPages +
          '  (' + total + ' รายการ)';
        prevBtn.disabled = state.page <= 1;
        nextBtn.disabled = state.page >= totalPages;
      } else {
        pager.style.display = 'none';
      }

      if (observer) observer.observe(tbody, { childList: true });
    }

    observer = new MutationObserver(function () { apply(); });
    observer.observe(tbody, { childList: true });
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
