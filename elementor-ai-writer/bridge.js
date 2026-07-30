// MAIN-world bridge — injected by Chrome (CSP-safe). Talks to Elementor ($e.run).
(function () {
  if (window.__seoRoomAIBridge) return; window.__seoRoomAIBridge = true;
  const getDoc = () => { try { return window.elementor && elementor.documents && elementor.documents.getCurrent(); } catch (e) { return null; } };
  // widgetType -> editable text fields (multiple fields => multiple rows)
  const fieldsFor = {
    'heading': ['title'],
    'text-editor': ['editor'],
    'text': ['editor'],
    'button': ['text'],
    'icon-box': ['title_text', 'description_text'],
    'image-box': ['title_text', 'description_text'],
    'call-to-action': ['title', 'description'],
    'testimonial': ['testimonial_content'],
    'blockquote': ['blockquote_content'],
    'icon-list': [],
    'price-list': []
  };
  const labelFor = (wt, field) => {
    if (field === 'editor' || field === 'description_text' || field === 'description' || /content/.test(field)) return 'Text';
    if (field === 'text') return 'Button';
    return 'Heading';
  };
  function readWidgets() {
    const out = []; const doc = getDoc(); if (!doc || !doc.container) return out;
    const walk = (c) => {
      let kids = [];
      try { if (c.children && typeof c.children.forEach === 'function') kids = c.children; else if (c.children && c.children.length != null) kids = Array.from(c.children); } catch (e) {}
      kids.forEach((ch) => {
        try {
          const m = ch.model, elType = m && m.get('elType'), wt = m && m.get('widgetType');
          if (elType === 'widget' && wt === 'icon-list') {
            let texts = [];
            try {
              const coll = ch.settings && ch.settings.get('icon_list');
              if (coll && typeof coll.map === 'function') texts = coll.map((mo) => mo.get('text'));
              else if (Array.isArray(coll)) texts = coll.map((it) => it.text);
            } catch (e) {}
            texts = texts.filter((x) => x && String(x).trim());
            if (texts.length) out.push({ id: ch.id, widgetType: wt, field: 'icon_list', label: 'List', text: texts.join('\n') });
          } else if (elType === 'widget' && fieldsFor[wt]) {
            fieldsFor[wt].forEach((field) => {
              const text = (ch.settings && ch.settings.get(field)) || '';
              if (text && String(text).trim()) out.push({ id: ch.id, widgetType: wt, field, label: labelFor(wt, field), text: String(text) });
            });
          }
        } catch (e) {}
        walk(ch);
      });
    };
    walk(doc.container); return out;
  }
  function applyOne(id, field, value) {
    try {
      const c = elementor.getContainer(id); if (!c) return false;
      if (field === 'icon_list') {
        const lines = String(value).split('\n').map((s) => s.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean);
        const coll = c.settings.get('icon_list');
        if (coll && typeof coll.each === 'function') {
          let i = 0; coll.each((mo) => { if (lines[i] != null) mo.set('text', lines[i]); i++; });
          try { c.render && c.render(); } catch (e) {}
          try { if (elementor.saver && elementor.saver.setFlagEditorChange) elementor.saver.setFlagEditorChange(true); } catch (e) {}
          return true;
        } else if (Array.isArray(coll)) {
          const next = coll.map((it, i) => (lines[i] != null ? Object.assign({}, it, { text: lines[i] }) : it));
          $e.run('document/elements/settings', { container: c, settings: { icon_list: next }, options: { external: true } });
          return true;
        }
        return false;
      }
      $e.run('document/elements/settings', { container: c, settings: { [field]: value }, options: { external: true } });
      return true;
    } catch (e) { return false; }
  }
  function flash(id) {
    try { const c = elementor.getContainer(id); if (c && c.view && c.view.$el) { const $el = c.view.$el; const prev = $el.css('outline'); $el.css('outline', '2px solid #16a34a'); setTimeout(() => $el.css('outline', prev || ''), 900); } } catch (e) {}
  }
  function highlight(id) {
    try {
      const c = elementor.getContainer(id); if (!c) return;
      try { $e.run('document/elements/select', { container: c }); } catch (e) {}
      if (c.view && c.view.$el && c.view.$el[0]) {
        try { c.view.$el[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
        const $el = c.view.$el;
        $el.css({ 'outline': '3px solid #6366f1', 'outline-offset': '2px', 'transition': 'outline .15s' });
        setTimeout(() => { try { $el.css({ 'outline': '', 'outline-offset': '' }); } catch (e) {} }, 1800);
      }
    } catch (e) {}
  }
  const permalink = () => { try { return (elementor.config && elementor.config.document && elementor.config.document.urls && elementor.config.document.urls.permalink) || ''; } catch (e) { return ''; } };
  window.addEventListener('message', (ev) => {
    const d = ev.data; if (!d || d.__seoRoomAI !== 'req') return;
    if (d.action === 'ping') window.postMessage({ __seoRoomAI: 'res', reqId: d.reqId, ok: !!getDoc() }, '*');
    else if (d.action === 'read') window.postMessage({ __seoRoomAI: 'res', reqId: d.reqId, widgets: readWidgets(), permalink: permalink() }, '*');
    else if (d.action === 'apply') { const ok = applyOne(d.id, d.field, d.value); if (ok) flash(d.id); window.postMessage({ __seoRoomAI: 'res', reqId: d.reqId, ok }, '*'); }
    else if (d.action === 'highlight') { highlight(d.id); window.postMessage({ __seoRoomAI: 'res', reqId: d.reqId, ok: true }, '*'); }
    else if (d.action === 'flash') { flash(d.id); window.postMessage({ __seoRoomAI: 'res', reqId: d.reqId, ok: true }, '*'); }
    else if (d.action === 'save') { try { $e.run('document/save/update'); } catch (e) {} window.postMessage({ __seoRoomAI: 'res', reqId: d.reqId, ok: true }, '*'); }
  });

  // Page -> panel: when a widget is clicked in the Elementor preview, tell the panel which one.
  function hookPreviewClicks() {
    try {
      const iframe = document.getElementById('elementor-preview-iframe');
      const doc = iframe && iframe.contentDocument;
      if (!doc || !doc.body) { setTimeout(hookPreviewClicks, 1200); return; }
      if (doc.__seoRoomHooked) return; doc.__seoRoomHooked = true;
      doc.addEventListener('click', (e) => {
        let el = e.target;
        while (el && el !== doc.body) {
          if (el.dataset && el.dataset.id && el.classList && el.classList.contains('elementor-element')) {
            window.postMessage({ __seoRoomAI: 'selected', id: el.dataset.id }, '*');
            break;
          }
          el = el.parentElement;
        }
      }, true);
    } catch (e) { setTimeout(hookPreviewClicks, 1500); }
  }
  hookPreviewClicks();
})();

