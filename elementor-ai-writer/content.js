// Isolated content script: always-on panel with an editable Suburb box, a list of
// sections still needing copy (Fill each), "Show done" + Rewrite, Fill-all-missing,
// and click-a-row-to-highlight-on-page. Calls the dashboard AI endpoint.
(function () {
  const BASE = 'https://seo-room-v5-production.up.railway.app/api/elementor';
  const API = BASE + '/ai-fill';
  const RESOLVE = BASE + '/resolve';
  if (!/\/wp-admin\/post\.php/.test(location.pathname + location.search)) return;
  if (window.__seoRoomAIUI) return; window.__seoRoomAIUI = true;
  const POST_ID = (function () { try { return new URLSearchParams(location.search).get('post') || ''; } catch (e) { return ''; } })();

  let seq = 0; const pending = {};
  window.addEventListener('message', (ev) => {
    const d = ev.data; if (!d || d.__seoRoomAI !== 'res') return;
    if (pending[d.reqId]) { pending[d.reqId](d); delete pending[d.reqId]; }
  });
  function call(action, extra) {
    return new Promise((resolve) => {
      const reqId = ++seq; pending[reqId] = resolve;
      window.postMessage(Object.assign({ __seoRoomAI: 'req', action, reqId }, extra || {}), '*');
      setTimeout(() => { if (pending[reqId]) { pending[reqId]({ timeout: true }); delete pending[reqId]; } }, 15000);
    });
  }
  const esc = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  const keyOf = (w) => w.id + '|' + w.field;
  // A section still needs copy only if it clearly contains LEFTOVER template tokens.
  const needsCopy = (t) => {
    const s = String(t || '');
    if (/\{\{/.test(s)) return true;                       // {{placeholder}}
    if (/lorem ipsum/i.test(s)) return true;
    if (/\bthis suburb\b/i.test(s)) return true;           // mis-fill
    if (/selling point\s*\d/i.test(s)) return true;        // Selling point 1/2/3
    if (/^\s*write\s/i.test(s)) return true;               // "Write a description..."
    if (/\(short blurb|paragraph\s*\(/i.test(s)) return true;
    // ALL-CAPS template labels — case-SENSITIVE so real copy ("Call us Now", "Kingsley") is never flagged
    if (/\bSUBURB\b|\bKEYWORD\b|SERVICE KW|PHONE NUMBER|QUESTION URGING|CALL US NOW!|H1\(|H2\(/.test(s)) return true;
    return false;
  };

  // Best-effort suburb guess from the page slug (permalink) or the editor title.
  function guessSuburb(permalink) {
    let base = '';
    try { const u = new URL(permalink); if (!/[?&]page_id=/.test(u.search)) base = u.pathname.replace(/^\/|\/$/g, '').split('/').pop() || ''; } catch (e) {}
    if (!base) base = (document.title || '').replace(/^edit\s*/i, '');
    base = base.replace(/[-_]/g, ' ').replace(/["'‘’“”].*$/, '').replace(/[^a-zA-Z ]/g, ' ');
    base = base.replace(/\b(plumber|plumbing|gas|electrician|electrical|roofing|locksmith|services?|service|emergency|north|south|east|west|perth|wa|call|the|in|near|me|24|7|edit)\b/ig, ' ');
    base = base.replace(/\s+/g, ' ').trim();
    return base.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async function aiFill(permalink, suburb, widgets) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permalink, host: location.host, post_id: POST_ID, suburb, sections: widgets.map(w => ({ id: w.id, field: w.field, widgetType: w.widgetType, text: w.text })) }) }).then(x => x.json());
  }
  async function resolveSuburb(permalink) {
    try { return await fetch(RESOLVE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: location.host, post_id: POST_ID, permalink }) }).then(x => x.json()); }
    catch (e) { return {}; }
  }

  function buildPanel() {
    const wrap = document.createElement('div');
    wrap.id = 'seoRoomAIPanel';
    wrap.style.cssText = 'position:fixed;bottom:16px;right:16px;width:380px;max-height:80vh;z-index:2147483647;background:#0f1117;color:#e5e7eb;border:1px solid #2a2f3a;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:system-ui,sans-serif;display:flex;flex-direction:column;overflow:hidden';
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#161a23;border-bottom:1px solid #2a2f3a">' +
        '<span style="font-weight:700;font-size:13px">✦ AI Copywriter</span>' +
        '<span id="srStat" style="font-size:11px;color:#9aa3b2;flex:1">starting…</span>' +
        '<button id="srUp" title="Previous section" style="background:transparent;color:#9aa3b2;border:1px solid #2a2f3a;border-radius:6px;padding:5px 7px;font-size:11px;cursor:pointer">▲</button>' +
        '<button id="srDn" title="Next section" style="background:transparent;color:#9aa3b2;border:1px solid #2a2f3a;border-radius:6px;padding:5px 7px;font-size:11px;cursor:pointer">▼</button>' +
        '<button id="srRef" title="Re-scan" style="background:transparent;color:#9aa3b2;border:1px solid #2a2f3a;border-radius:6px;padding:5px 8px;font-size:12px;cursor:pointer">↻</button>' +
        '<button id="srMin" title="Hide" style="background:transparent;color:#9aa3b2;border:none;font-size:16px;cursor:pointer;line-height:1">–</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #1c212b">' +
        '<span style="font-size:11px;color:#9aa3b2">Suburb</span>' +
        '<input id="srSub" placeholder="e.g. Darch" style="flex:1;background:#0b0e14;color:#fff;border:1px solid #3b4663;border-radius:6px;padding:6px 8px;font-size:12px">' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #1c212b">' +
        '<button id="srAll" style="flex:1;background:#6366f1;color:#fff;border:none;border-radius:6px;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer">Fill all missing</button>' +
        '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#9aa3b2;cursor:pointer;white-space:nowrap"><input id="srShow" type="checkbox" style="cursor:pointer"> Show done</label>' +
      '</div>' +
      '<div id="srBody" style="overflow:auto;padding:4px 0"></div>';
    document.body.appendChild(wrap);
    return wrap;
  }

  function rowEl(w, needs) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #1c212b;cursor:pointer' + (needs ? '' : ';opacity:.6');
    const isHead = w.label === 'Heading';
    row.innerHTML =
      '<input type="checkbox" class="srInc" checked title="Include in Fill all (uncheck to exclude)" style="cursor:pointer;flex:none">' +
      '<span style="font-size:9px;font-weight:700;text-transform:uppercase;color:' + (isHead ? '#a5b4fc' : '#9aa3b2') + ';min-width:42px">' + w.label + '</span>' +
      '<span class="srSnip" style="flex:1;font-size:12px;color:#cbd2dd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(w.text).slice(0, 60) + '</span>' +
      '<button class="srFill" style="background:' + (needs ? '#26304a' : 'transparent') + ';color:#c7d2fe;border:1px solid #3b4663;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer">' + (needs ? 'Fill' : 'Rewrite') + '</button>';
    return row;
  }

  function start() {
    const panel = buildPanel();
    const body = panel.querySelector('#srBody');
    const statEl = panel.querySelector('#srStat');
    const subInput = panel.querySelector('#srSub');
    subInput.addEventListener('input', () => { subInput.dataset.auto = '0'; });
    const showChk = panel.querySelector('#srShow');
    let widgets = [], permalink = '', rows = {};

    function applyFilter() {
      const showDone = showChk.checked;
      Object.values(rows).forEach((r) => { r.row.style.display = (showDone || r.needs) ? 'flex' : 'none'; });
    }
    function countMissing() { return Object.values(rows).filter(r => r.needs).length; }

    async function scan() {
      statEl.textContent = 'scanning…';
      const r = await call('read');
      if (r && r.timeout) { statEl.textContent = 'Elementor loading — click ↻'; return; }
      widgets = (r && r.widgets || []).filter(w => w.text && w.text.trim());
      permalink = (r && r.permalink) || '';
      // Auto-detect the suburb from the real slug (via the server/reader plugin); fall back to a local guess.
      if (!subInput.value.trim()) {
        subInput.value = guessSuburb(permalink);
        resolveSuburb(permalink).then((rs) => { if (rs && rs.suburb && !subInput.value.trim()) subInput.value = rs.suburb; else if (rs && rs.suburb && subInput.dataset.auto !== '0') subInput.value = rs.suburb; });
      }
      body.innerHTML = ''; rows = {};
      if (!widgets.length) { body.innerHTML = '<div style="padding:14px;font-size:12px;color:#9aa3b2">No editable text found here. Click ↻ to re-scan.</div>'; statEl.textContent = ''; return; }
      widgets.forEach((w) => {
        const needs = needsCopy(w.text);
        const row = rowEl(w, needs);
        const inc = row.querySelector('.srInc');
        const rec = { w, row, needs, included: true, snip: row.querySelector('.srSnip'), btn: row.querySelector('.srFill') };
        rows[keyOf(w)] = rec;
        row.onclick = () => call('highlight', { id: w.id });
        inc.onclick = (e) => e.stopPropagation();
        inc.onchange = () => { rec.included = inc.checked; row.style.opacity = inc.checked ? (rec.needs ? '1' : '.6') : '.35'; };
        rec.btn.onclick = (e) => { e.stopPropagation(); fillRows([w]); };
        body.appendChild(row);
      });
      applyFilter();
      const m = countMissing();
      statEl.textContent = m ? (m + ' need copy') : 'all filled ✓';
    }

    async function fillRows(list) {
      const suburb = subInput.value.trim();
      if (!suburb) { subInput.style.borderColor = '#ef4444'; subInput.focus(); statEl.textContent = 'enter a suburb first'; return; }
      subInput.style.borderColor = '#3b4663';
      list.forEach((w) => { const r = rows[keyOf(w)]; if (r) { r.btn.textContent = '…'; r.btn.disabled = true; } });
      let resp;
      try { resp = await aiFill(permalink, suburb, list); }
      catch (e) { list.forEach((w) => { const r = rows[keyOf(w)]; if (r) { r.btn.textContent = 'Retry'; r.btn.disabled = false; } }); return; }
      if (!resp || resp.error) { list.forEach((w) => { const r = rows[keyOf(w)]; if (r) { r.btn.textContent = 'Retry'; r.btn.disabled = false; r.btn.title = (resp && resp.error) || 'error'; } }); return; }
      const out = resp.sections || [];
      for (const w of list) {
        const f = out.find(o => o.id === w.id && o.field === w.field) || out.find(o => o.id === w.id);
        const r = rows[keyOf(w)]; if (!r) continue;
        if (f && f.new_text != null) {
          const a = await call('apply', { id: w.id, field: w.field, value: f.new_text });
          if (a && a.ok) {
            w.text = f.new_text; r.snip.textContent = esc(f.new_text).slice(0, 64);
            r.needs = false; r.row.style.opacity = '.6';
            r.btn.textContent = 'Rewrite'; r.btn.style.background = 'transparent'; r.btn.disabled = false;
          } else { r.btn.textContent = 'Retry'; r.btn.disabled = false; }
        } else { r.btn.textContent = 'Retry'; r.btn.disabled = false; }
      }
      applyFilter();
      const m = countMissing();
      statEl.textContent = m ? (m + ' need copy') : 'all filled ✓';
    }

    // Page -> panel highlight: flash the matching row and scroll the panel to it.
    function highlightRow(id) {
      const rec = Object.values(rows).find(r => r.w.id === id);
      if (!rec) return;
      try { rec.row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      const prev = rec.row.style.background;
      rec.row.style.background = 'rgba(99,102,241,.28)';
      setTimeout(() => { rec.row.style.background = prev || ''; }, 1500);
      return rec;
    }
    window.addEventListener('message', (ev) => {
      const d = ev.data; if (!d || d.__seoRoomAI !== 'selected') return;
      highlightRow(d.id);
    });

    // Up/Down: step through sections in document order, highlighting on page + in panel.
    let curIdx = -1;
    function step(dir) {
      if (!widgets.length) return;
      curIdx = (curIdx + dir + widgets.length) % widgets.length;
      const w = widgets[curIdx];
      call('highlight', { id: w.id });
      highlightRow(w.id);
    }

    panel.querySelector('#srUp').onclick = () => step(-1);
    panel.querySelector('#srDn').onclick = () => step(1);
    panel.querySelector('#srAll').onclick = () => fillRows(Object.values(rows).filter(r => r.needs && r.included).map(r => r.w));
    panel.querySelector('#srRef').onclick = () => scan();
    showChk.onchange = () => applyFilter();
    const minBtn = panel.querySelector('#srMin');
    minBtn.onclick = () => { const hidden = body.style.display === 'none'; body.style.display = hidden ? 'block' : 'none'; minBtn.textContent = hidden ? '–' : '+'; };

    // Try to scan now; if Elementor isn't ready yet, retry a few times automatically.
    let tries = 0;
    const retry = setInterval(async () => {
      tries++;
      const p = await call('ping');
      if (p && p.ok) { clearInterval(retry); scan(); }
      else if (tries > 30) { clearInterval(retry); statEl.textContent = 'Elementor not detected — click ↻'; }
    }, 1000);
  }

  // Build the panel as soon as <body> exists — it always appears.
  let n = 0;
  const t = setInterval(() => { n++; if (document.body) { clearInterval(t); start(); } else if (n > 120) clearInterval(t); }, 300);
})();
