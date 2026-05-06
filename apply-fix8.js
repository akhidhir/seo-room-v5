const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'public', 'index.html');
let html = fs.readFileSync(file, 'utf8');
let changes = 0;

// FIX 1: startComment must require text selection — no general comments
const oldGeneral = `        if (!sel || sel.length === 0) {
          // No text selected — open general comment (not linked to text)
          setPendingSelection({ index: 0, length: 0, text: '', top: 0, general: true });
          setNewCommentText('');
          return;
        }`;
const newGeneral = `        if (!sel || sel.length === 0) {
          // No text selected — flash red outline on button as hint
          const btn = document.querySelector('.comment-btn');
          if (btn) {
            btn.style.outline = '2px solid #ef4444';
            btn.style.outlineOffset = '2px';
            btn.setAttribute('title', 'Select text first, then click Add Comment');
            setTimeout(() => { btn.style.outline = ''; btn.removeAttribute('title'); }, 2000);
          }
          return;
        }`;
if (html.includes(oldGeneral)) {
  html = html.replace(oldGeneral, newGeneral);
  changes++;
  console.log('✅ Fix 1: Blocked comments without text selection');
} else {
  console.log('❌ Fix 1: Could not find general comment block');
}

// FIX 2a: Add onSave/saveStatus props to QuillEditor
const oldProps = `function QuillEditor({ value, onChange, readOnly, initialComments, onCommentsChange }) {`;
const newProps = `function QuillEditor({ value, onChange, readOnly, initialComments, onCommentsChange, onSave, saveStatus }) {`;
if (html.includes(oldProps)) {
  html = html.replace(oldProps, newProps);
  changes++;
  console.log('✅ Fix 2a: Added onSave/saveStatus props');
} else {
  console.log('❌ Fix 2a: Could not find QuillEditor props');
}

// FIX 2b: Add Save button before Find & Replace in toolbar
const oldFind = `            !readOnly && React.createElement('button', { onClick: () => setShowFind(!showFind), className: 'editor-btn', style: { padding: '6px 12px', fontSize: 12, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' } },
              React.createElement('i', { className: 'fa-solid fa-magnifying-glass', style: { marginRight: 6 } }), 'Find & Replace'
            )`;
const newFind = `            onSave && React.createElement('button', { onClick: onSave, className: 'editor-btn', style: { padding: '6px 14px', fontSize: 12, background: saveStatus === 'done' ? '#22c55e' : '#10b981', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, minWidth: 80 } },
              React.createElement('i', { className: saveStatus === true ? 'fas fa-spinner fa-spin' : 'fas fa-save', style: { marginRight: 5 } }), saveStatus === true ? 'Saving...' : saveStatus === 'done' ? 'Saved!' : 'Save'
            ),
            !readOnly && React.createElement('button', { onClick: () => setShowFind(!showFind), className: 'editor-btn', style: { padding: '6px 12px', fontSize: 12, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' } },
              React.createElement('i', { className: 'fa-solid fa-magnifying-glass', style: { marginRight: 6 } }), 'Find & Replace'
            )`;
if (html.includes(oldFind)) {
  html = html.replace(oldFind, newFind);
  changes++;
  console.log('✅ Fix 2b: Added Save button to toolbar');
} else {
  console.log('❌ Fix 2b: Could not find Find & Replace button');
}

// FIX 2c: Pass onSave to content_queue QuillEditor
const oldCQ = `React.createElement(QuillEditor, {
                      key: editorKey,
                      value: editContent,
                      onChange: isPublished ? undefined : setEditContent,
                      readOnly: isPublished,
                      initialComments: comments,
                      onCommentsChange: isPublished ? undefined : setComments
                    })`;
const newCQ = `React.createElement(QuillEditor, {
                      key: editorKey,
                      value: editContent,
                      onChange: isPublished ? undefined : setEditContent,
                      readOnly: isPublished,
                      initialComments: comments,
                      onCommentsChange: isPublished ? undefined : setComments,
                      onSave: isPublished ? undefined : handleSaveEdit,
                      saveStatus: savingMeta
                    })`;
if (html.includes(oldCQ)) {
  html = html.replace(oldCQ, newCQ);
  changes++;
  console.log('✅ Fix 2c: Passed onSave to content_queue QuillEditor');
} else {
  console.log('❌ Fix 2c: Could not find content_queue QuillEditor');
}

// FIX 2d: Pass onSave to site_pages QuillEditor
const oldSP = `React.createElement(QuillEditor, {
                    value: editContent,
                    onChange: isPublished ? undefined : setEditContent,
                    readOnly: isPublished,
                    initialComments: comments,
                    onCommentsChange: isPublished ? undefined : setComments
                  })`;
const newSP = `React.createElement(QuillEditor, {
                    value: editContent,
                    onChange: isPublished ? undefined : setEditContent,
                    readOnly: isPublished,
                    initialComments: comments,
                    onCommentsChange: isPublished ? undefined : setComments,
                    onSave: isPublished ? undefined : handleSaveEdit,
                    saveStatus: savingMeta
                  })`;
if (html.includes(oldSP)) {
  html = html.replace(oldSP, newSP);
  changes++;
  console.log('✅ Fix 2d: Passed onSave to site_pages QuillEditor');
} else {
  console.log('❌ Fix 2d: Could not find site_pages QuillEditor');
}

if (changes > 0) {
  fs.writeFileSync(file, html);
  console.log('\n✅ All ' + changes + ' patches applied!');
} else {
  console.log('\n❌ No patches applied');
}
