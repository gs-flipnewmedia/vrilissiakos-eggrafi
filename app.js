'use strict';

/* ---------- Ρυθμίσεις ---------- */
const DB_NAME = 'vrilissiakos-registrations';
const STORE = 'submissions';
const DEFAULT_PIN = '1234';
const SUCCESS_RESET_SECONDS = 30;
const SYNC_INTERVAL_MS = 60 * 1000;
const SETTINGS_KEY = 'appSettings';

const $ = (sel, root = document) => root.querySelector(sel);
const form = $('#regForm');

const settings = Object.assign(
  { formMode: 'single', scriptUrl: '', secret: '', deleteAfterSync: true },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })()
);
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ιδιωτική περιήγηση */ }
}

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const dbAdd = rec => tx('readwrite', s => s.add(rec));
const dbPut = rec => tx('readwrite', s => s.put(rec));
const dbAll = () => tx('readonly', s => s.getAll());
const dbDelete = id => tx('readwrite', s => s.delete(id));
const dbClear = () => tx('readwrite', s => s.clear());

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function getRecords() {
  const all = await dbAll();
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/* ---------- Ημερομηνία γέννησης (ημερολόγιο) ---------- */
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmy = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '';

// Μορφοποίηση καθώς πληκτρολογεί: «14032015» → «14/03/2015», «1/3/2015» → «01/03/2015»
function maskDate(raw) {
  const parts = raw.split(/\D+/);
  let digits = parts.length > 1
    ? parts.map((p, i) => (i < 2 && i < parts.length - 1 && p.length === 1 ? '0' + p : p)).join('')
    : raw;
  digits = digits.replace(/\D/g, '').slice(0, 8);
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += '/' + digits.slice(2, 4);
  if (digits.length > 4) out += '/' + digits.slice(4);
  return out;
}

// «ηη/μμ/εεεε» → «εεεε-μμ-ηη», ή '' αν η ημερομηνία δεν υπάρχει
function parseDmy(text) {
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  const date = new Date(+y, +mo - 1, +d);
  return date.getFullYear() === +y && date.getMonth() === +mo - 1 && date.getDate() === +d ? `${y}-${mo}-${d}` : '';
}

function setupBirthDate() {
  const native = $('#birthDate'), text = $('#birthDateText');
  const today = new Date();
  native.max = isoDay(today);
  native.min = isoDay(new Date(today.getFullYear() - 40, 0, 1));

  text.addEventListener('input', () => {
    const masked = maskDate(text.value);
    if (masked !== text.value) text.value = masked;
    native.value = parseDmy(masked);
    clearError('birthDate');
  });
  native.addEventListener('change', () => {
    text.value = dmy(native.value);
    clearError('birthDate');
  });
  // Σε browsers υπολογιστή το ημερολόγιο ανοίγει μόνο με showPicker()
  native.addEventListener('click', () => { try { native.showPicker?.(); } catch { /* ήδη ανοιχτό */ } });
}

/* ---------- Υπογραφή ---------- */
const sig = (() => {
  const canvas = $('#sigCanvas');
  const box = canvas.parentElement;
  const ctx = canvas.getContext('2d');
  const MAX_EXPORT_WIDTH = 900; // αρκετό για εκτύπωση, μικρό για αποστολή
  let strokes = [], current = null;

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return; // κρυμμένο βήμα
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function drawStroke(c, s, w) {
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#0b1640';
    c.lineWidth = Math.max(2.6, w / 260);
    c.beginPath();
    s.forEach((p, i) => {
      const x = p.x * w, y = p.y * w; // κανονικοποιημένο στο πλάτος, για σωστό redraw σε αλλαγή προσανατολισμού
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    });
    if (s.length === 1) c.lineTo(s[0].x * w + .1, s[0].y * w);
    c.stroke();
  }

  function redraw() {
    const w = canvas.getBoundingClientRect().width;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes.forEach(s => drawStroke(ctx, s, w));
    box.classList.toggle('has-ink', strokes.length > 0);
  }

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.width };
  }

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* συνεχίζουμε χωρίς capture */ }
    current = [point(e)];
    strokes.push(current);
    redraw();
    clearError('signature');
  });
  canvas.addEventListener('pointermove', e => {
    if (!current) return;
    const evs = e.getCoalescedEvents?.() || [];
    (evs.length ? evs : [e]).forEach(ev => current.push(point(ev)));
    redraw();
  });
  const end = () => { current = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  $('#sigClear').addEventListener('click', () => { strokes = []; redraw(); });
  new ResizeObserver(resize).observe(canvas);

  return {
    isEmpty: () => strokes.reduce((n, s) => n + s.length, 0) < 6,
    clear: () => { strokes = []; redraw(); },
    // Επανασχεδίαση σε λευκό φόντο, με σταθερό μέγιστο πλάτος, ανεξάρτητα από την οθόνη
    toDataURL() {
      const r = canvas.getBoundingClientRect();
      const w = Math.min(MAX_EXPORT_WIDTH, Math.round(r.width * 2));
      const h = Math.round(w * r.height / r.width);
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const o = out.getContext('2d');
      o.fillStyle = '#fff';
      o.fillRect(0, 0, w, h);
      strokes.forEach(s => drawStroke(o, s, w));
      return out.toDataURL('image/png');
    }
  };
})();

/* ---------- Έλεγχος πεδίων ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?\d{8,15}$/;
const normalizePhone = v => v.replace(/[\s\-().]/g, '');

const FIELD_IDS = ['lastName', 'firstName', 'fatherName', 'motherName', 'birthDate', 'street', 'area',
  'postalCode', 'school', 'email', 'email2', 'phoneFather', 'phoneMother', 'phoneAthlete', 'landline',
  'photoConsent', 'dataConsent', 'guardianName', 'signature', 'parentPhone'];

// Το στοιχείο που "κρατάει" κάθε σφάλμα (για χρωματισμό και εύρεση βήματος)
const holderOf = name => document.getElementById(name === 'parentPhone' ? 'parentPhoneHint' : name);

function setError(name, msg) {
  if (name === 'parentPhone') {
    $('#parentPhoneHint').classList.add('is-invalid');
    ['phoneFather', 'phoneMother'].forEach(n => holderOf(n).closest('.field').classList.add('is-invalid'));
    return;
  }
  const holder = holderOf(name);
  const target = holder?.closest('.field, .consent') || holder;
  const err = document.getElementById(name + '-error');
  if (err) err.textContent = msg;
  target?.classList.add('is-invalid');
  if (holder && holder.matches('input, select')) holder.setAttribute('aria-invalid', 'true');
}

function clearError(name) {
  if (name === 'parentPhone') {
    $('#parentPhoneHint').classList.remove('is-invalid');
    ['phoneFather', 'phoneMother'].forEach(n => {
      if (!document.getElementById(n + '-error').textContent) holderOf(n).closest('.field').classList.remove('is-invalid');
    });
    return;
  }
  const holder = holderOf(name);
  const target = holder?.closest('.field, .consent') || holder;
  const err = document.getElementById(name + '-error');
  if (err) err.textContent = '';
  target?.classList.remove('is-invalid');
  holder?.removeAttribute('aria-invalid');
}

function collect() {
  const f = new FormData(form);
  const v = k => (f.get(k) || '').toString().trim();
  return {
    lastName: v('lastName'),
    firstName: v('firstName'),
    fatherName: v('fatherName'),
    motherName: v('motherName'),
    birthDate: v('birthDate'),
    street: v('street'),
    area: v('area'),
    postalCode: v('postalCode').replace(/\s/g, ''),
    school: v('school'),
    email: v('email').toLowerCase(),
    email2: v('email2').toLowerCase(),
    phoneFather: normalizePhone(v('phoneFather')),
    phoneMother: normalizePhone(v('phoneMother')),
    phoneAthlete: normalizePhone(v('phoneAthlete')),
    landline: normalizePhone(v('landline')),
    photoConsent: v('photoConsent'),
    dataConsent: v('dataConsent'),
    guardianName: v('guardianName')
  };
}

const NO_DATA_CONSENT = 'Χωρίς συναίνεση στην επεξεργασία δεδομένων δεν μπορεί να ολοκληρωθεί η εγγραφή.';

function validate() {
  const errors = {};
  const raw = name => form.elements[name]?.value?.trim() || '';
  const required = {
    lastName: 'Συμπληρώστε το επώνυμο.',
    firstName: 'Συμπληρώστε το όνομα.',
    fatherName: 'Συμπληρώστε το όνομα πατέρα.',
    motherName: 'Συμπληρώστε το όνομα μητέρας.',
    street: 'Συμπληρώστε τη διεύθυνση.',
    area: 'Συμπληρώστε την περιοχή.',
    email: 'Συμπληρώστε e-mail.',
    guardianName: 'Συμπληρώστε το ονοματεπώνυμο γονέα / κηδεμόνα.'
  };
  for (const [k, msg] of Object.entries(required)) if (!raw(k)) errors[k] = msg;

  const bd = $('#birthDate'), bdText = $('#birthDateText').value.trim();
  if (!bd.value) errors.birthDate = bdText ? 'Μη έγκυρη ημερομηνία. Γράψτε ηη/μμ/εεεε, π.χ. 14/03/2015.' : 'Συμπληρώστε την ημερομηνία γέννησης.';
  else if (bd.value > bd.max) errors.birthDate = 'Η ημερομηνία δεν μπορεί να είναι μελλοντική.';
  else if (bd.value < bd.min) errors.birthDate = 'Ελέγξτε το έτος γέννησης.';

  if (raw('postalCode') && !/^\d{5}$/.test(raw('postalCode').replace(/\s/g, ''))) errors.postalCode = 'Ο Τ.Κ. έχει 5 ψηφία.';
  if (raw('email') && !EMAIL_RE.test(raw('email'))) errors.email = 'Μη έγκυρο e-mail.';
  if (raw('email2') && !EMAIL_RE.test(raw('email2'))) errors.email2 = 'Μη έγκυρο e-mail.';

  form.querySelectorAll('[data-phone]').forEach(el => {
    const v = normalizePhone(el.value.trim());
    if (v && !PHONE_RE.test(v)) errors[el.name] = 'Μόνο αριθμοί (8–15 ψηφία).';
  });
  if (!raw('phoneFather') && !raw('phoneMother')) errors.parentPhone = ' ';

  const consent = name => form.querySelector(`input[name="${name}"]:checked`)?.value;
  if (!consent('photoConsent')) errors.photoConsent = 'Επιλέξτε ΝΑΙ ή ΟΧΙ.';
  if (!consent('dataConsent')) errors.dataConsent = 'Επιλέξτε ΝΑΙ ή ΟΧΙ.';
  else if (consent('dataConsent') === 'no') errors.dataConsent = NO_DATA_CONSENT;

  if (sig.isEmpty()) errors.signature = 'Απαιτείται υπογραφή.';
  return errors;
}

function showErrors(errors, { scroll = true } = {}) {
  FIELD_IDS.forEach(clearError);
  Object.entries(errors).forEach(([k, m]) => setError(k, m.trim()));
  const first = form.querySelector('.card:not([hidden]) .is-invalid');
  if (first && scroll) {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusable = first.querySelector('input:not([type=radio]):not([type=date]), select');
    if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), 350);
  }
}

// Μόνο ψηφία, κενά και + στα τηλέφωνα
form.querySelectorAll('[data-phone]').forEach(el => el.addEventListener('input', () => {
  const clean = el.value.replace(/[^\d+\s]/g, '').replace(/(?!^)\+/g, '');
  if (clean !== el.value) el.value = clean;
}));

// Καθαρισμός σφάλματος όταν ο χρήστης διορθώνει
form.addEventListener('input', e => {
  const t = e.target;
  if (t.name === 'phoneFather' || t.name === 'phoneMother') clearError('parentPhone');
  if (t.type === 'radio') {
    clearError(t.name);
    if (t.name === 'dataConsent' && t.value === 'no') setError('dataConsent', NO_DATA_CONSENT);
    return;
  }
  if (t.name) clearError(t.name);
});
form.addEventListener('change', e => { if (e.target.id === 'birthDate') clearError('birthDate'); });

// Enter → επόμενο πεδίο (για πληκτρολόγια tablet)
form.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'radio') return;
  e.preventDefault();
  const fields = [...form.querySelectorAll('.card:not([hidden]) input:not([type=radio]):not(.datefield__native), .card:not([hidden]) select')];
  const next = fields[fields.indexOf(e.target) + 1];
  if (next) next.focus();
  else if (settings.formMode === 'steps' && step < steps.length - 1) goNext();
  else e.target.blur();
});

/* ---------- Μορφή: μία σελίδα ή βήματα ---------- */
const steps = [...form.querySelectorAll('section.card')];
const REVIEW_STEP = steps.findIndex(s => s.hasAttribute('data-steps-only'));
const stepper = $('#stepper');
let step = 0;
let returnToReview = false; // διόρθωση από τον έλεγχο → επιστροφή κατευθείαν σε αυτόν

const stepOf = name => steps.indexOf(holderOf(name)?.closest('section.card'));

function renderStep() {
  const wizard = settings.formMode === 'steps';
  form.classList.toggle('is-wizard', wizard);
  stepper.hidden = !wizard;
  steps.forEach((s, i) => { s.hidden = wizard ? i !== step : s.hasAttribute('data-steps-only'); });
  // Αρίθμηση καρτών: στη μία σελίδα δεν υπάρχει η κάρτα ελέγχου
  let n = 0;
  steps.forEach(s => { if (wizard || !s.hasAttribute('data-steps-only')) s.querySelector('.card__num').textContent = ++n; });
  [...stepper.children].forEach((li, i) => {
    li.classList.toggle('is-current', i === step);
    li.classList.toggle('is-done', i < step);
    li.querySelector('button').disabled = i > step && !(returnToReview && i === REVIEW_STEP);
    li.querySelector('button').setAttribute('aria-current', i === step ? 'step' : 'false');
  });
  const last = step === steps.length - 1;
  $('#prevBtn').hidden = !wizard || step === 0 || returnToReview;
  $('#nextBtn').hidden = !wizard || last;
  $('#nextBtn').textContent = returnToReview ? 'Επιστροφή στον έλεγχο'
    : step === REVIEW_STEP ? 'Σωστά, συνέχεια' : 'Επόμενο';
  $('#submitBtn').hidden = wizard && !last;
  if (wizard && step === REVIEW_STEP) renderReview();
}

function goTo(i) {
  step = Math.max(0, Math.min(steps.length - 1, i));
  if (step === REVIEW_STEP) returnToReview = false;
  renderStep();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goNext() {
  const errs = Object.fromEntries(Object.entries(validate()).filter(([k]) => stepOf(k) === step));
  showErrors(errs);
  if (Object.keys(errs).length) return toast('Ελέγξτε τα πεδία με κόκκινο.');
  goTo(returnToReview ? REVIEW_STEP : step + 1);
}

$('#nextBtn').addEventListener('click', goNext);
$('#prevBtn').addEventListener('click', () => goTo(step - 1));
stepper.addEventListener('click', e => {
  const b = e.target.closest('[data-step]');
  if (!b || b.disabled || +b.dataset.step === step) return;
  if (+b.dataset.step < step) goTo(+b.dataset.step);
  else goNext(); // επιστροφή στον έλεγχο μετά από διόρθωση
});

/* Σελίδα ελέγχου στοιχείων */
function renderReview() {
  const d = collect();
  const groups = [
    { title: 'Αθλητής / αθλήτρια', step: 0, rows: [
      ['Επώνυμο', d.lastName],
      ['Όνομα', d.firstName],
      ['Όνομα πατέρα', d.fatherName],
      ['Όνομα μητέρας', d.motherName],
      ['Ημ/νία γέννησης', fmtDate(d.birthDate)],
      ['Διεύθυνση', [d.street, d.area, d.postalCode].filter(Boolean).join(', ')],
      ['Σχολείο', d.school]
    ] },
    { title: 'Επικοινωνία', step: 1, rows: [
      ['E-mail', d.email],
      ['Δεύτερο e-mail', d.email2],
      ['Κινητό πατέρα', d.phoneFather],
      ['Κινητό μητέρας', d.phoneMother],
      ['Κινητό αθλητή / τριας', d.phoneAthlete],
      ['Σταθερό', d.landline]
    ] },
    { title: 'Δηλώσεις', step: 2, rows: [
      ['Χρήση φωτογραφιών', yesNo(d.photoConsent), d.photoConsent === 'no'],
      ['Επεξεργασία δεδομένων', yesNo(d.dataConsent)]
    ] }
  ];
  $('#review').innerHTML = groups.map(g => `
    <div class="review__group">
      <div class="review__head">
        <h3>${g.title}</h3>
        <button type="button" class="btn" data-edit="${g.step}">Αλλαγή</button>
      </div>
      <dl>${g.rows.map(([k, v, no]) => `<dt>${k}</dt><dd class="${v ? (no ? 'is-no' : '') : 'is-empty'}">${v ? esc(v) : '—'}</dd>`).join('')}</dl>
    </div>`).join('');
}

$('#review').addEventListener('click', e => {
  const b = e.target.closest('[data-edit]');
  if (!b) return;
  returnToReview = true;
  step = +b.dataset.edit;
  renderStep();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------- Υποβολή ---------- */
form.addEventListener('submit', async e => {
  e.preventDefault();
  const errors = validate();
  if (Object.keys(errors).length) {
    if (settings.formMode === 'steps') {
      const firstStep = Math.min(...Object.keys(errors).map(stepOf));
      if (firstStep !== step) goTo(firstStep);
      showErrors(Object.fromEntries(Object.entries(errors).filter(([k]) => stepOf(k) === firstStep)));
    } else {
      showErrors(errors);
    }
    toast('Ελέγξτε τα πεδία με κόκκινο.');
    return;
  }
  const btn = $('#submitBtn');
  btn.disabled = true;
  try {
    const record = {
      id: uuid(),
      createdAt: new Date().toISOString(),
      synced: false,
      data: collect(),
      signature: sig.toDataURL()
    };
    await dbAdd(record);
    showSuccess(record.data);
    syncPending();
  } catch (err) {
    console.error(err);
    toast('Σφάλμα αποθήκευσης. Δοκιμάστε ξανά.');
  } finally {
    btn.disabled = false;
  }
});

let successTimer = null;
function showSuccess(data) {
  $('#successName').textContent = `${data.firstName} ${data.lastName}`;
  $('#success').hidden = false;
  $('#newForm').focus();
  let left = SUCCESS_RESET_SECONDS;
  const tick = () => {
    $('#successTimer').textContent = `Η φόρμα θα καθαρίσει αυτόματα σε ${left} δευτ.`;
    if (left-- <= 0) resetForm();
  };
  tick();
  successTimer = setInterval(tick, 1000);
}

function resetForm() {
  clearInterval(successTimer);
  form.reset();
  sig.clear();
  showErrors({}, { scroll: false });
  $('#success').hidden = true;
  returnToReview = false;
  goTo(0);
}
$('#newForm').addEventListener('click', resetForm);

/* ---------- Αποστολή στο Google Sheet ---------- */
let syncing = false;

async function postToSheet(payload, url = settings.scriptUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    // text/plain: αποφεύγει το CORS preflight, που το Apps Script δεν υποστηρίζει
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      throw new Error('Μη αναμενόμενη απάντηση. Ελέγξτε το URL και ότι η πρόσβαση είναι «Οποιοσδήποτε».');
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Λήξη χρόνου σύνδεσης.');
    if (err instanceof TypeError) throw new Error('Δεν ήταν δυνατή η σύνδεση με το Google.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const sheetError = res => res.error === 'unauthorized' ? 'Λάθος κωδικός ασφαλείας.' : (res.error || 'Άγνωστο σφάλμα.');

async function syncPending() {
  if (!settings.scriptUrl || syncing || !navigator.onLine) return null;
  syncing = true;
  let sent = 0, failed = 0, lastError = '';
  try {
    const pending = (await getRecords()).filter(r => !r.synced);
    for (const r of pending) {
      try {
        const res = await postToSheet({
          action: 'submit', secret: settings.secret,
          id: r.id, createdAt: r.createdAt, data: r.data, signature: r.signature
        });
        if (!res.ok) throw Object.assign(new Error(sheetError(res)), { fatal: res.error === 'unauthorized' });
        if (settings.deleteAfterSync) await dbDelete(r.id);
        else await dbPut({ ...r, synced: true, syncedAt: new Date().toISOString(), pdfUrl: res.pdfUrl || '' });
        sent++;
      } catch (err) {
        failed++;
        lastError = err.message;
        console.warn('Sync:', err);
        if (err.fatal || err.message.startsWith('Δεν ήταν δυνατή')) break;
      }
    }
  } finally {
    syncing = false;
    updatePendingInfo();
    if (adminDialog.open) renderAdmin();
  }
  return { sent, failed, lastError };
}

async function updatePendingInfo() {
  const pending = (await dbAll()).filter(r => !r.synced).length;
  $('#pendingInfo').textContent = settings.scriptUrl && pending ? ` · ${pending} σε αναμονή` : '';
}

window.addEventListener('online', syncPending);
setInterval(syncPending, SYNC_INTERVAL_MS);

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 3600);
}

/* ---------- Διαχείριση (PIN) ---------- */
async function hash(s) {
  if (!crypto.subtle) return 'plain:' + s;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vrilissiakos:' + s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function checkPin(pin) {
  const stored = localStorage.getItem('adminPinHash');
  return (stored || await hash(DEFAULT_PIN)) === await hash(pin);
}

const pinDialog = $('#pinDialog');
const adminDialog = $('#adminDialog');

$('#adminOpen').addEventListener('click', () => {
  $('#pinInput').value = '';
  $('#pinError').textContent = '';
  $('#pinHint').hidden = !!localStorage.getItem('adminPinHash');
  pinDialog.showModal();
});
$('#pinCancel').addEventListener('click', () => pinDialog.close());
$('#pinForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (await checkPin($('#pinInput').value)) {
    pinDialog.close();
    loadSettingsForm();
    await renderAdmin();
    showTab(settings.scriptUrl ? 'list' : 'settings');
    adminDialog.showModal();
  } else {
    $('#pinError').textContent = 'Λάθος PIN.';
    $('#pinInput').select();
  }
});
$('#adminClose').addEventListener('click', () => adminDialog.close());

function showTab(name) {
  ['list', 'settings'].forEach(t => {
    $('#tab-' + t).setAttribute('aria-selected', String(t === name));
    $('#panel-' + t).hidden = t !== name;
  });
}
$('#tab-list').addEventListener('click', () => showTab('list'));
$('#tab-settings').addEventListener('click', () => showTab('settings'));

/* Ρυθμίσεις */
function sheetStatus(msg, kind = '') {
  const el = $('#sheetStatus');
  el.textContent = msg;
  el.className = 'setting__status' + (kind ? ' is-' + kind : '');
}

function loadSettingsForm() {
  document.querySelector(`input[name="formMode"][value="${settings.formMode}"]`).checked = true;
  $('#scriptUrl').value = settings.scriptUrl;
  $('#scriptSecret').value = settings.secret;
  $('#deleteAfterSync').checked = settings.deleteAfterSync;
  if (settings.scriptUrl) sheetStatus('✓ Συνδεδεμένο. Οι αιτήσεις στέλνονται στο Google Sheet.', 'ok');
  else sheetStatus('Δεν έχει οριστεί Google Sheet. Οι αιτήσεις μένουν μόνο στη συσκευή.');
  $('#disconnectSheet').hidden = !settings.scriptUrl;
  $('#pinSaved').textContent = '';
}

document.querySelectorAll('input[name="formMode"]').forEach(r => r.addEventListener('change', () => {
  settings.formMode = r.value;
  saveSettings();
  showErrors({}, { scroll: false });
  returnToReview = false;
  goTo(0);
  toast(r.value === 'steps' ? 'Η φόρμα εμφανίζεται σε βήματα.' : 'Η φόρμα εμφανίζεται σε μία σελίδα.');
}));

// Δέχεται και URL λογαριασμών Google Workspace (…/a/macros/<domain>/s/…/exec)
const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+\/|macros\/)s\/[\w-]+\/exec$/;

function readSheetForm() {
  const url = $('#scriptUrl').value.trim();
  const secret = $('#scriptSecret').value.trim();
  if (url && !SCRIPT_URL_RE.test(url)) {
    sheetStatus('Το URL πρέπει να είναι της μορφής https://script.google.com/macros/s/…/exec', 'err');
    return null;
  }
  if (url && !secret) {
    sheetStatus('Συμπληρώστε τον κωδικό ασφαλείας.', 'err');
    return null;
  }
  return { url, secret, deleteAfterSync: $('#deleteAfterSync').checked };
}

$('#sheetForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = readSheetForm();
  if (!v) return;
  Object.assign(settings, { scriptUrl: v.url, secret: v.secret, deleteAfterSync: v.deleteAfterSync });
  saveSettings();
  if (v.url) sheetStatus('✓ Αποθηκεύτηκε. Οι αιτήσεις θα στέλνονται στο Google Sheet.', 'ok');
  else sheetStatus('Αποθηκεύτηκε χωρίς Google Sheet.');
  $('#disconnectSheet').hidden = !v.url;
  await renderAdmin();
  updatePendingInfo();
  syncPending();
});

// Η δοκιμή χρησιμοποιεί ό,τι είναι γραμμένο στα πεδία, χωρίς να το αποθηκεύει
$('#testSheet').addEventListener('click', async () => {
  const v = readSheetForm();
  if (!v) return;
  if (!v.url) return sheetStatus('Συμπληρώστε το URL.', 'err');
  sheetStatus('Έλεγχος σύνδεσης…');
  try {
    const res = await postToSheet({ action: 'ping', secret: v.secret }, v.url);
    if (res.ok) sheetStatus(`✓ Η σύνδεση πέτυχε: «${res.sheet}». Πατήστε «Αποθήκευση».`, 'ok');
    else sheetStatus('✗ ' + sheetError(res), 'err');
  } catch (err) {
    sheetStatus('✗ ' + err.message, 'err');
  }
});

$('#disconnectSheet').addEventListener('click', async () => {
  if (!confirm('Αποσύνδεση από το Google Sheet; Οι νέες αιτήσεις θα μένουν μόνο στη συσκευή.')) return;
  Object.assign(settings, { scriptUrl: '', secret: '' });
  saveSettings();
  loadSettingsForm();
  await renderAdmin();
  updatePendingInfo();
});

/* Κωδικός σύνδεσης από το Sheet: «VRL1.» + base64url(JSON {u: URL, s: κωδικός}) */
function parseConnectCode(code) {
  const m = String(code).trim().match(/^VRL1\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - b64.length % 4) % 4);
    const { u, s } = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
    return SCRIPT_URL_RE.test(u) && s ? { url: u, secret: s } : null;
  } catch { return null; }
}

// Ελέγχει τη σύνδεση και, αν πετύχει, την αποθηκεύει
async function connectSheet({ url, secret }, { confirmFirst = false } = {}) {
  const res = await postToSheet({ action: 'ping', secret }, url);
  if (!res.ok) throw new Error(sheetError(res));
  if (confirmFirst && !confirm(`Σύνδεση αυτού του tablet με το Google Sheet «${res.sheet}»;`)) return null;
  Object.assign(settings, { scriptUrl: url, secret });
  saveSettings();
  updatePendingInfo();
  syncPending();
  return res.sheet;
}

$('#applyCode').addEventListener('click', async () => {
  const c = parseConnectCode($('#connectCode').value);
  if (!c) return sheetStatus('Μη έγκυρος κωδικός. Αντιγράψτε τον ολόκληρο από το «Εγγραφές → Σύνδεση tablet».', 'err');
  sheetStatus('Σύνδεση…');
  try {
    const name = await connectSheet(c);
    $('#connectCode').value = '';
    loadSettingsForm();
    sheetStatus(`✓ Συνδέθηκε με το Google Sheet «${name}».`, 'ok');
    renderAdmin();
  } catch (err) {
    sheetStatus('✗ ' + err.message, 'err');
  }
});

// Σύνδεση από QR code / σύνδεσμο: …/#connect=VRL1.…
async function connectFromLink() {
  const m = location.hash.match(/^#connect=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const c = parseConnectCode(decodeURIComponent(m[1]));
  if (!c) return toast('Μη έγκυρος σύνδεσμος σύνδεσης.');
  try {
    const name = await connectSheet(c, { confirmFirst: true });
    if (name) toast(`✓ Το tablet συνδέθηκε με το Google Sheet «${name}».`);
  } catch (err) {
    toast('Η σύνδεση απέτυχε: ' + err.message);
  }
}

$('#syncNow').addEventListener('click', async () => {
  const btn = $('#syncNow');
  btn.disabled = true;
  const r = await syncPending();
  btn.disabled = false;
  if (!r) return toast(navigator.onLine ? 'Η αποστολή είναι ήδη σε εξέλιξη.' : 'Δεν υπάρχει σύνδεση στο internet.');
  if (!r.sent && !r.failed) return toast('Δεν υπάρχουν αιτήσεις σε αναμονή.');
  toast(r.failed ? `Εστάλησαν ${r.sent}, απέτυχαν ${r.failed}: ${r.lastError}` : `Εστάλησαν ${r.sent} αιτήσεις.`);
});

$('#changePinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const p = $('#newPin').value.trim();
  if (!/^\d{4,12}$/.test(p)) { $('#pinSaved').textContent = 'Το PIN πρέπει να έχει 4–12 ψηφία.'; return; }
  localStorage.setItem('adminPinHash', await hash(p));
  $('#newPin').value = '';
  $('#pinSaved').textContent = 'Το PIN άλλαξε.';
});

const fmtDate = iso => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const fmtDateTime = iso => {
  const d = new Date(iso);
  return `${dmy(isoDay(d))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const yesNo = v => (v === 'yes' ? 'ΝΑΙ' : v === 'no' ? 'ΟΧΙ' : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function renderAdmin() {
  const recs = await getRecords();
  const sheetOn = !!settings.scriptUrl;
  $('#adminCount').textContent = recs.length;
  $('#syncNow').hidden = !sheetOn;
  $('#adminIntro').textContent = sheetOn
    ? (settings.deleteAfterSync
      ? 'Οι αιτήσεις στέλνονται αυτόματα στο Google Sheet της ομάδας και διαγράφονται από τη συσκευή. Εδώ φαίνονται όσες δεν έχουν σταλεί ακόμη.'
      : 'Οι αιτήσεις στέλνονται αυτόματα στο Google Sheet της ομάδας και κρατιέται αντίγραφο στη συσκευή.')
    : 'Οι αιτήσεις αποθηκεύονται μόνο τοπικά σε αυτή τη συσκευή. Κάντε εξαγωγή και έπειτα διαγραφή τους, ή συνδέστε Google Sheet από τις Ρυθμίσεις.';
  const list = $('#adminList');
  if (!recs.length) {
    list.innerHTML = `<p class="admin__empty">${sheetOn ? 'Όλες οι αιτήσεις έχουν σταλεί.' : 'Δεν υπάρχουν αιτήσεις σε αυτή τη συσκευή.'}</p>`;
    return;
  }
  list.innerHTML = `<table>
    <thead><tr><th>Υποβολή</th><th>Αθλητής / τρια</th><th>Γέννηση</th>${sheetOn ? '<th>Κατάσταση</th>' : ''}<th></th></tr></thead>
    <tbody>${recs.slice().reverse().map(r => `<tr>
      <td>${esc(fmtDateTime(r.createdAt))}</td>
      <td>${esc(r.data.lastName)} ${esc(r.data.firstName)}</td>
      <td>${esc(fmtDate(r.data.birthDate))}</td>
      ${sheetOn ? `<td>${r.synced ? '<span class="status status--sent">Εστάλη</span>' : '<span class="status status--pending">Σε αναμονή</span>'}</td>` : ''}
      <td><div class="row-actions">
        <button class="btn" data-print="${esc(r.id)}">Εκτύπωση</button>
        <button class="btn btn--danger" data-del="${esc(r.id)}">Διαγραφή</button>
      </div></td></tr>`).join('')}</tbody></table>`;
}

$('#adminList').addEventListener('click', async e => {
  const p = e.target.closest('[data-print]'), d = e.target.closest('[data-del]');
  if (p) {
    const rec = (await dbAll()).find(r => r.id === p.dataset.print);
    if (rec) printRecords([rec]);
  }
  if (d && confirm('Οριστική διαγραφή αυτής της αίτησης από τη συσκευή;')) {
    await dbDelete(d.dataset.del);
    renderAdmin();
    updatePendingInfo();
  }
});

$('#deleteAll').addEventListener('click', async () => {
  const n = (await dbAll()).length;
  if (!n) return;
  if (!confirm(`Οριστική διαγραφή ${n} αιτήσεων από τη συσκευή;\nΒεβαιωθείτε ότι έχετε κάνει εξαγωγή ή αποστολή.`)) return;
  await dbClear();
  renderAdmin();
  updatePendingInfo();
  toast('Οι αιτήσεις διαγράφηκαν.');
});

/* ---------- Εξαγωγή ---------- */
const COLUMNS = [
  ['createdAt', 'Ημ/νία υποβολής', r => fmtDateTime(r.createdAt)],
  ['lastName', 'Επώνυμο'],
  ['firstName', 'Όνομα'],
  ['fatherName', 'Όνομα πατέρα'],
  ['motherName', 'Όνομα μητέρας'],
  ['birthDate', 'Ημ/νία γέννησης', r => fmtDate(r.data.birthDate)],
  ['street', 'Διεύθυνση'],
  ['area', 'Περιοχή'],
  ['postalCode', 'Τ.Κ.'],
  ['email', 'E-mail'],
  ['email2', 'E-mail 2'],
  ['phoneFather', 'Κινητό πατέρα'],
  ['phoneMother', 'Κινητό μητέρας'],
  ['phoneAthlete', 'Κινητό αθλητή/τριας'],
  ['landline', 'Σταθερό'],
  ['school', 'Σχολείο'],
  ['photoConsent', 'Συγκατάθεση φωτογραφιών', r => yesNo(r.data.photoConsent)],
  ['dataConsent', 'Συναίνεση επεξεργασίας δεδομένων', r => yesNo(r.data.dataConsent)],
  ['guardianName', 'Γονέας / κηδεμόνας']
];

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // αποτροπή εκτέλεσης τύπων στο Excel
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

$('#exportCsv').addEventListener('click', async () => {
  const recs = await getRecords();
  if (!recs.length) return toast('Δεν υπάρχουν αιτήσεις.');
  // Ελληνικό Excel: διαχωριστικό ";" και UTF-8 BOM για σωστούς χαρακτήρες
  const lines = [COLUMNS.map(c => csvCell(c[1])).join(';')];
  recs.forEach(r => lines.push(COLUMNS.map(([k, , f]) => csvCell(f ? f(r) : r.data[k])).join(';')));
  download(`aitiseis-${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
});

$('#exportJson').addEventListener('click', async () => {
  const recs = await getRecords();
  if (!recs.length) return toast('Δεν υπάρχουν αιτήσεις.');
  download(`aitiseis-${stamp()}.json`, JSON.stringify(recs, null, 2), 'application/json');
});

$('#printAll').addEventListener('click', async () => {
  const recs = await getRecords();
  if (!recs.length) return toast('Δεν υπάρχουν αιτήσεις.');
  printRecords(recs);
});

/* ---------- Εκτύπωση (αντίγραφο της έντυπης αίτησης) ---------- */
function printRecords(recs) {
  const row = (label, value) => `<tr><td>${label}</td><td>${esc(value)}</td></tr>`;
  $('#printArea').innerHTML = recs.map(r => {
    const d = r.data;
    const signed = new Date(r.createdAt);
    return `<article class="pf">
      <div class="pf__head"><img src="logo.png" alt=""><h1>ΑΙΤΗΣΗ ΕΓΓΡΑΦΗΣ</h1></div>
      <h2>ΠΡΟΣΩΠΙΚΑ ΣΤΟΙΧΕΙΑ ΑΘΛΗΤΗ / ΑΘΛΗΤΡΙΑΣ</h2>
      <table>
        ${row('Επώνυμο', d.lastName)}
        ${row('Όνομα', d.firstName)}
        ${row('Όνομα Πατέρα', d.fatherName)}
        ${row('Όνομα Μητέρας', d.motherName)}
        ${row('Ημ/νία Γεννήσεως', fmtDate(d.birthDate))}
        ${row('Διεύθυνση', [d.street, d.area, d.postalCode].filter(Boolean).join(', '))}
        ${row('e-mail', d.email)}
        ${row('e-mail 2ο', d.email2)}
        ${row('Κινητό 1 (Πατέρα)', d.phoneFather)}
        ${row('Κινητό 2 (Μητέρας)', d.phoneMother)}
        ${row('Κινητό 3 (Αθλητή/τριας)', d.phoneAthlete)}
        ${row('Σταθερό τηλέφωνο', d.landline)}
        ${row('Σχολείο φοίτησης', d.school)}
      </table>
      <h2>ΠΡΟΣ ΤΟ Δ.Σ. ΤΟΥ ΒΡΙΛΗΣΣΙΑΚΟΥ ΑΘΛΗΤΙΚΟΥ ΟΜΙΛΟΥ</h2>
      <p>Με την παρούσα αίτηση παρακαλώ να εγκρίνετε την εγγραφή του / της γιου / κόρης μου ως αθλητή / αθλήτρια στην Ακαδημία του Βριλησσιακού Αθλητικού Ομίλου και δίνω τη συγκατάθεσή μου για τη συμμετοχή του / της στις δραστηριότητες του Συλλόγου.</p>
      <p>Δίνω τη συγκατάθεσή μου στον Σύλλογο να χρησιμοποιεί τις φωτογραφίες του παιδιού μου, που λαμβάνονται εν ώρα προπονήσεων / αγώνων ή γενικά εκδηλώσεων που λαμβάνουν χώρα μέσα στο γήπεδο, στην ιστοσελίδα του Συλλόγου και στη σελίδα που διατηρεί στο Facebook. <span class="pf__choice">— ${yesNo(d.photoConsent)}</span></p>
      <p>Δηλώνω υπεύθυνα ότι συναινώ στην επεξεργασία των προσωπικών μου δεδομένων που αναγράφω ανωτέρω από τον Βριλησσιακό Αθλητικό Όμιλο. <span class="pf__choice">— ${yesNo(d.dataConsent)}</span></p>
      <div class="pf__sign"><div>
        <p>Βριλήσσια, ${dmy(isoDay(signed))}</p>
        <p>ΥΠΟΓΡΑΦΗ ΓΟΝΕΑ / ΚΗΔΕΜΟΝΑ</p>
        <img src="${r.signature}" alt="Υπογραφή">
        <p>${esc(d.guardianName)}</p>
      </div></div>
      <div class="pf__foot">Ολύμπου 19, 152 35 Βριλήσσια – τηλ. 697 852 2982 – 694 859 7130 · www.vrilissiakos.gr · info@vrilissiakos.gr<br>Ηλεκτρονική υποβολή: ${esc(fmtDateTime(r.createdAt))} · Κωδ. ${esc(r.id.slice(0, 8))}</div>
    </article>`;
  }).join('');
  const imgs = [...$('#printArea').querySelectorAll('img')];
  Promise.all(imgs.map(i => i.complete ? null : new Promise(res => { i.onload = i.onerror = res; })))
    .then(() => window.print());
}

/* ---------- Εκκίνηση ---------- */
// Εναλλαγή μορφής και από τη διεύθυνση: ?mode=steps ή ?mode=single
const urlMode = new URLSearchParams(location.search).get('mode');
if (urlMode === 'steps' || urlMode === 'single') {
  settings.formMode = urlMode;
  saveSettings();
  history.replaceState(null, '', location.pathname);
}
connectFromLink();
setupBirthDate();
$('#todayLabel').textContent = 'Βριλήσσια, ' + dmy(isoDay(new Date()));
renderStep();
updatePendingInfo();
syncPending();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW:', err));
}
if (navigator.storage?.persist) navigator.storage.persist();
