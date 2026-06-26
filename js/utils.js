'use strict';

const PIP = {
  online:    '> WASTELAND NETWORK: CONNECTED',
  offline:   '> WARNING: NO SIGNAL DETECTED',
  sent:      '> TRANSMISSION SUCCESSFUL',
  queued:    '> ERROR: OFFLINE — TRANSMISSION QUEUED',
  pending:   '> PENDING: AWAITING NETWORK RESTORATION',
  added:     '> NEW DWELLER REGISTERED IN DATABASE',
  cryptoErr: '> CRITICAL: ENCRYPTION FAILURE',
  sigErr:    '> WARNING: CORRUPTED TRANSMISSION DETECTED',
  idNew:     '> NEW VAULT DWELLER PROFILE CREATED',
  idLoaded:  '> VAULT DWELLER IDENTITY VERIFIED',
  grpNew:    '> NEW SECURE CHANNEL ESTABLISHED',
  grpLeft:   '> CHANNEL ACCESS REVOKED',
};

function esc(str) {
  return String(str||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function showModal(title, bodyLines, buttons, borderColor = 'green') {
  const existing = document.querySelector('.modal-bg');
  if (existing) existing.remove();

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal" style="${borderColor==='red'?'border-color:var(--pip-red)':''}">
      <div class="modal-title glow">${esc(title)}</div>
      <div style="font-size:12px;line-height:1.7;color:var(--pip-green)">${bodyLines.join('<br>')}</div>
      <div class="modal-actions"></div>
    </div>`;

  const actions = bg.querySelector('.modal-actions');
  buttons.forEach(btn => {
    const b = document.createElement('button');
    b.className = 'pip-btn' + (btn.cls ? ' ' + btn.cls : '');
    b.textContent = btn.label;
    b.addEventListener('click', () => { if (btn.action) btn.action(); bg.remove(); });
    actions.appendChild(b);
  });

  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
}
