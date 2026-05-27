/*
 * picker.js — shared dropdown population for the bus / passenger pickers.
 *
 * Used by three pages:
 *   - /driver       (driver.js)     — admin assigning drivers to bus runs
 *   - /bustoday     (bustoday.js)   — HR reviewing the same bus runs
 *   - /seatdriver   (seatdriver.js) — passenger picker for "เพิ่มผู้โดยสาร"
 *
 * Load this file BEFORE the page-specific script in the EJS view, e.g.:
 *
 *     <script src="/js/picker.js"></script>
 *     <script src="/js/driver.js"></script>
 *
 * There are two pickers because the two server endpoints behind them
 * expect different payloads:
 *
 *   Driver picker (loadDriverPicker / readPickerSelection):
 *     /insertbusdriver and /insertbustoday want first_name, last_name,
 *     driver_user_id (LINE userId), and per_id all sent explicitly so
 *     the server doesn't have to guess by splitting a display name.
 *     We stash these on the <option> as data-* attrs at populate time
 *     and read them back at submit time.
 *
 *   Passenger picker (loadPassengerPicker):
 *     /insertpaxdriver still does its own perid → user lookup on the
 *     server, so the option only needs to carry perid (in `value`).
 */

/**
 * Populate one or more <select> dropdowns with rows fetched from `url`.
 * The placeholder option (the first <option> in the markup) is preserved.
 *
 * Each rendered option carries:
 *   value             = "first_name last_name"
 *   textContent       = "first_name last_name (perid)"
 *   data-userid       = perid             (employee number)
 *   data-line-userid  = users.userid      (LINE userId, for push messaging)
 *   data-first-name   = users.first_name  (DB value, not parsed from display)
 *   data-last-name    = users.last_name
 *
 * Submit handlers should use `readPickerSelection(selectId)` to extract
 * these — that helper coerces empty strings to null so the server's
 * COALESCE clauses keep existing values when the placeholder is left
 * selected.
 *
 * @param {string} url           Endpoint that returns { rows: [...] }.
 * @param {string[]} selectIds   DOM ids of <select> elements to populate.
 *                               Multiple ids are supported because the
 *                               same row list usually feeds both the
 *                               insert and the edit modal.
 */
async function loadDriverPicker(url, selectIds) {
  try {
    const response = await fetch(url);
    const data = await response.json();
    const rows = data.rows || [];

    selectIds.forEach((id) => {
      const select = document.getElementById(id);
      if (!select) return;

      // Strip everything except the placeholder (the first option).
      // We keep index 0 so the user can still revert to "no selection".
      while (select.options.length > 1) select.remove(1);

      rows.forEach((u) => {
        const opt = document.createElement('option');
        const fullname = `${u.first_name || ''} ${u.last_name || ''}`.trim();
        opt.value = fullname;
        opt.textContent = u.perid ? `${fullname} (${u.perid})` : fullname;
        opt.setAttribute('data-userid', u.perid || '');
        opt.setAttribute('data-line-userid', u.userid || '');
        opt.setAttribute('data-first-name', u.first_name || '');
        opt.setAttribute('data-last-name', u.last_name || '');
        select.appendChild(opt);
      });
    });
  } catch (error) {
    console.error('loadDriverPicker failed for', url, error);
  }
}

/**
 * Read the four data-* attrs off the currently-selected <option> of a
 * driver picker, returning an object suitable for spreading into a
 * POST body.
 *
 * Empty strings (the placeholder option) are normalised to null so the
 * server's `COALESCE($n, existing)` clauses preserve whatever the row
 * already had instead of clobbering it.
 *
 * @param {string} selectId   DOM id of the <select> element.
 * @returns {{
 *   perid: string|null,
 *   driver_user_id: string|null,
 *   first_name: string|null,
 *   last_name: string|null
 * }}
 */
function readPickerSelection(selectId) {
  const select = document.getElementById(selectId);
  const opt = select && select.options[select.selectedIndex];
  const get = (attr) => {
    if (!opt) return null;
    const v = opt.getAttribute(attr);
    return v ? v : null;
  };
  return {
    perid: get('data-userid'),
    driver_user_id: get('data-line-userid'),
    first_name: get('data-first-name'),
    last_name: get('data-last-name'),
  };
}

/**
 * Populate a single <select> with passenger rows from `url`. Differs
 * from `loadDriverPicker` in two ways:
 *   - we set option.value = perid (so `formData.get('perid')` returns
 *     the perid directly — no readPickerSelection call needed),
 *   - we don't stash data-* attrs, because /insertpaxdriver re-looks
 *     up the user by perid on the server anyway.
 *
 * @param {string} url        Endpoint that returns { rows: [...] }.
 * @param {string} selectId   DOM id of the <select> element.
 */
async function loadPassengerPicker(url, selectId) {
  try {
    const response = await fetch(url);
    const data = await response.json();
    const rows = data.rows || [];

    const select = document.getElementById(selectId);
    if (!select) return;
    while (select.options.length > 1) select.remove(1);

    rows.forEach((u) => {
      const opt = document.createElement('option');
      const fullname = `${u.first_name || ''} ${u.last_name || ''}`.trim();
      opt.value = u.perid || '';
      opt.textContent = u.perid ? `${fullname} (${u.perid})` : fullname;
      select.appendChild(opt);
    });
  } catch (error) {
    console.error('loadPassengerPicker failed for', url, error);
  }
}

/* ---------------------------------------------------------------------------
 * Route picker (/routenamesjson) — shared by /driver and /seatdriver.
 *
 * Replaces the hard-coded <option> lists (old chp route names) with the live
 * chp2.route catalogue. Single routes and combined ("รวม…") routes are split
 * into two <optgroup>s, and a trailing "อื่นๆ" option is kept so HR can still
 * type a one-off route by hand (the page JS shows the free-text row when it
 * is selected).
 * ------------------------------------------------------------------------- */

const ROUTE_OTHER = 'อื่นๆ';

async function loadRoutePicker(url, selectIds) {
  try {
    const response = await fetch(url);
    const data = await response.json();
    const routes = data.routes || [];
    const isCombined = (r) => /^\s*รวม/.test(r.name) || (r.code || '').includes('+');
    const singles = routes.filter((r) => !isCombined(r));
    const combos = routes.filter(isCombined);

    selectIds.forEach((sid) => {
      const select = document.getElementById(sid);
      if (!select) return;
      select.innerHTML = '';

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'เลือกสายรถ';
      select.appendChild(placeholder);

      const addGroup = (label, list) => {
        if (!list.length) return;
        const og = document.createElement('optgroup');
        og.label = label;
        list.forEach((r) => {
          const opt = document.createElement('option');
          opt.value = r.name;
          opt.textContent = r.name;
          og.appendChild(opt);
        });
        select.appendChild(og);
      };
      addGroup('สายเดี่ยว', singles);
      addGroup('สายรวม', combos);

      const other = document.createElement('option');
      other.value = ROUTE_OTHER;
      other.textContent = 'อื่นๆ (พิมพ์เอง)';
      select.appendChild(other);
    });
  } catch (error) {
    console.error('loadRoutePicker failed for', url, error);
  }
}

/**
 * Pre-select a route in an edit modal. If `value` matches one of the
 * dropdown options it is selected and the free-text row is hidden; otherwise
 * the dropdown falls back to "อื่นๆ", the free-text row is shown and the
 * input is filled with the original value.
 *
 * @param {string} selectId    route <select> id (e.g. 'editroute')
 * @param {string} otherInputId free-text <input> id (e.g. 'editotherroute')
 * @param {string} otherRowId   wrapper row id to toggle (e.g. 'edit-other-route-row')
 * @param {string} value        the row's current route name
 */
function selectRouteValue(selectId, otherInputId, otherRowId, value) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const v = value || '';
  const match = Array.from(select.options).some((o) => o.value === v && o.value !== '');
  const otherRow = document.getElementById(otherRowId);
  const otherInput = document.getElementById(otherInputId);

  if (match) {
    select.value = v;
    if (otherRow) otherRow.style.display = 'none';
    if (otherInput) otherInput.value = '';
  } else if (v) {
    select.value = ROUTE_OTHER;
    if (otherRow) otherRow.style.display = 'flex';
    if (otherInput) otherInput.value = v;
  } else {
    select.value = '';
    if (otherRow) otherRow.style.display = 'none';
  }
}

/**
 * Wire up generic "dismiss" behaviour for the .modal dialogs on a page:
 *   - clicking any element carrying [data-close-modal] closes its modal,
 *   - clicking the dark backdrop (the .modal itself) closes it,
 *   - pressing Escape closes whichever modal is open.
 * Safe to call once per page; it only attaches document-level listeners.
 */
function enableModalDismiss() {
  document.addEventListener('click', (e) => {
    const closer = e.target.closest && e.target.closest('[data-close-modal]');
    if (closer) {
      const m = closer.closest('.modal');
      if (m) m.style.display = 'none';
      return;
    }
    if (e.target.classList && e.target.classList.contains('modal')) {
      e.target.style.display = 'none';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal').forEach((m) => {
      if (m.style.display === 'block') m.style.display = 'none';
    });
  });
}
