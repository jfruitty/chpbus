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
//
// Rows are often rendered asynchronously by each page's own script (fetch +
// rebuild of <tbody>), so a MutationObserver re-applies the active filter/sort
// after every re-render. Filtering hides rows via a `.tt-hide` class marked
// !important so it always wins over the legacy per-column filters (which we
// just hide and leave empty — that keeps their event bindings from throwing).
(function () {
  function init() {
    var table = document.querySelector('table.approval-table');
    if (!table || !table.tBodies.length) return;
    var tbody = table.tBodies[0];
    var headers = Array.prototype.slice.call(table.querySelectorAll('thead th'));
    if (!headers.length) return;

    var style = document.createElement('style');
    style.textContent =
      '.tt-hide{display:none !important;}' +
      '.tt-search{flex:1 1 240px;min-width:160px;padding:8px 12px;border:1px solid #cbd5e1;' +
      'border-radius:8px;font-size:14px;}' +
      'table.approval-table thead th.tt-sortable{cursor:pointer;user-select:none;white-space:nowrap;}' +
      'table.approval-table thead th.tt-sortable:hover{background:rgba(0,0,0,.05);}' +
      '.tt-arrow{font-size:11px;opacity:.7;margin-left:4px;}';
    document.head.appendChild(style);

    var bar = document.querySelector('.filter-bar');
    var colInputs = bar
      ? Array.prototype.slice.call(bar.querySelectorAll('input[data-col]'))
      : [];
    var columnMode = colInputs.length > 0;

    if (columnMode) {
      // Per-column filters: keep them visible, drive apply() on input.
      colInputs.forEach(function (inp) { inp.addEventListener('input', apply); });
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
        apply();
      });
    }

    // Neutralize the legacy pagination on /member, /thisweekdashboard, /nextweekdashboard:
    // their member.js / dashboard.js hide rows past page 1 with inline display='none',
    // which leaks through .tt-hide removal (a match on page 10 would stay hidden).
    document.querySelectorAll('.pagination').forEach(function (el) { el.style.display = 'none'; });
    Array.prototype.slice.call(tbody.rows).forEach(function (r) {
      if (r.style.display === 'none') r.style.display = '';
    });

    var state = { col: -1, dir: 1, term: '' };
    var firstIsIndex = /^(ลำดับ|#|ที่)$/.test(headers[0].textContent.trim());

    headers.forEach(function (th, i) {
      if (th.textContent.trim() === '') return; // skip action columns
      th.classList.add('tt-sortable');
      th.addEventListener('click', function () {
        if (state.col === i) state.dir = -state.dir;
        else { state.col = i; state.dir = 1; }
        apply();
      });
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

      if (state.col >= 0) {
        rows.sort(function (r1, r2) {
          return compare(cellText(r1, state.col), cellText(r2, state.col)) * state.dir;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      }

      var n = 0;
      rows.forEach(function (r) {
        var show = rowMatches(r);
        r.classList.toggle('tt-hide', !show);
        if (show) {
          n++;
          if (r.style.display === 'none') r.style.display = '';
          if (firstIsIndex && r.cells[0] && !isActionCell(r.cells[0])) {
            r.cells[0].textContent = n;
          }
        }
      });

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

      if (observer) observer.observe(tbody, { childList: true });
    }

    observer = new MutationObserver(function () { apply(); });
    observer.observe(tbody, { childList: true });
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
