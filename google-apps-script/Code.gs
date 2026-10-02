/**
 * Βριλησσιακός Α.Ο. – Παραλαβή ψηφιακών αιτήσεων εγγραφής
 *
 * Ζει μέσα σε Google Sheet της ομάδας και δημοσιεύεται ως Web app
 * («Εκτέλεση ως: Εγώ», «Πρόσβαση: Οποιοσδήποτε»).
 * Κάθε αίτηση γράφεται ως γραμμή στο φύλλο «Αιτήσεις», με την υπογραφή μέσα στο κελί,
 * και αποθηκεύεται ως PDF στον φάκελο «Αιτήσεις Εγγραφής» στο Drive της ομάδας.
 *
 * Ο κωδικός ασφαλείας δημιουργείται αυτόματα. Η σύνδεση του tablet γίνεται από το μενού
 * «Εγγραφές → Σύνδεση tablet» του Sheet, χωρίς αλλαγές στον κώδικα.
 */

// Η διεύθυνση όπου φιλοξενείται η εφαρμογή της φόρμας (π.χ. https://eggrafi.vrilissiakos.gr/).
// Αν οριστεί, το παράθυρο σύνδεσης δείχνει QR code για σάρωση από το tablet.
const APP_URL = '';

const SHEET_NAME = 'Αιτήσεις';
const FOLDER_NAME = 'Αιτήσεις Εγγραφής';

const HEADERS = [
  'Κωδικός', 'Ημ/νία υποβολής', 'Επώνυμο', 'Όνομα', 'Όνομα πατέρα', 'Όνομα μητέρας',
  'Ημ/νία γέννησης', 'Διεύθυνση', 'Περιοχή', 'Τ.Κ.', 'E-mail', 'E-mail 2',
  'Κινητό πατέρα', 'Κινητό μητέρας', 'Κινητό αθλητή/τριας', 'Σταθερό', 'Σχολείο',
  'Συγκατάθεση φωτογραφιών', 'Συναίνεση επεξεργασίας δεδομένων', 'Γονέας / κηδεμόνας',
  'Υπογραφή', 'PDF αίτησης'
];
const SIGNATURE_COL = HEADERS.indexOf('Υπογραφή') + 1;
const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/;

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'bad_request' });
  }
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret) return json({ ok: false, error: 'Ανοίξτε το Sheet και επιλέξτε «Εγγραφές → Σύνδεση tablet».' });
  if (body.secret !== secret) return json({ ok: false, error: 'unauthorized' });

  if (body.action === 'ping') return json({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getName() });
  if (body.action !== 'submit') return json({ ok: false, error: 'unknown_action' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet();

    // Αν η αίτηση έχει ήδη καταχωρηθεί (π.χ. επανάληψη μετά από διακοπή σύνδεσης), δεν διπλογράφεται
    const last = sheet.getLastRow();
    if (last > 1) {
      const ids = sheet.getRange(2, 1, last - 1, 1).getValues().flat();
      if (ids.indexOf(body.id) !== -1) return json({ ok: true, id: body.id, duplicate: true });
    }

    const d = body.data || {};
    if (!SIGNATURE_RE.test(body.signature || '')) body.signature = '';
    const pdf = makePdf(body);

    sheet.appendRow([
      body.id, fmtDateTime(body.createdAt), d.lastName, d.firstName, d.fatherName, d.motherName,
      fmtDate(d.birthDate), d.street, d.area, d.postalCode, d.email, d.email2,
      d.phoneFather, d.phoneMother, d.phoneAthlete, d.landline, d.school,
      yesNo(d.photoConsent), yesNo(d.dataConsent), d.guardianName,
      '', pdf ? pdf.getUrl() : ''
    ]);

    const row = sheet.getLastRow();
    try {
      if (!body.signature) throw new Error('no signature');
      const img = SpreadsheetApp.newCellImage().setSourceUrl(body.signature).setAltTextTitle('Υπογραφή').build();
      sheet.getRange(row, SIGNATURE_COL).setValue(img);
      sheet.setRowHeight(row, 60);
    } catch (err) {
      sheet.getRange(row, SIGNATURE_COL).setValue('(βλ. PDF)');
    }

    return json({ ok: true, id: body.id, pdfUrl: pdf ? pdf.getUrl() : '' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json({ ok: true, service: 'vrilissiakos-registrations' });
}

/* ---------- Μενού & σύνδεση tablet ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Εγγραφές')
    .addItem('Σύνδεση tablet', 'showConnect')
    .addItem('Νέος κωδικός ασφαλείας (αποσυνδέει τα tablet)', 'resetSecret')
    .addToUi();
}

function getSecret() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('SECRET', secret);
  }
  return secret;
}

function resetSecret() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('Νέος κωδικός', 'Όλα τα tablet θα αποσυνδεθούν και θα πρέπει να συνδεθούν ξανά. Συνέχεια;', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  PropertiesService.getScriptProperties().deleteProperty('SECRET');
  showConnect();
}

function showConnect() {
  getSheet(); // δημιουργεί/μορφοποιεί το φύλλο από την πρώτη φορά
  let url = ScriptApp.getService().getUrl();
  const t = HtmlService.createTemplate(CONNECT_TEMPLATE);
  t.deployed = !!url;
  url = url ? url.replace(/\/dev$/, '/exec') : '';
  // Ένας κωδικός που περιέχει URL + κωδικό ασφαλείας, για επικόλληση ή σάρωση στο tablet
  t.code = url ? 'VRL1.' + Utilities.base64EncodeWebSafe(JSON.stringify({ u: url, s: getSecret() }), Utilities.Charset.UTF_8).replace(/=+$/, '') : '';
  t.link = APP_URL && t.code ? APP_URL.replace(/[#?].*$/, '') + '#connect=' + t.code : '';
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(460).setHeight(t.deployed ? 560 : 360), 'Σύνδεση tablet');
}

const CONNECT_TEMPLATE = `
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #1a1d29; margin: 0; }
  ol { padding-left: 20px; } li { margin: 6px 0; line-height: 1.45; }
  textarea { width: 100%; height: 70px; font: 12px monospace; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; }
  button { margin-top: 8px; padding: 9px 16px; border: 0; border-radius: 6px; background: #c62a35; color: #fff; font-weight: bold; cursor: pointer; }
  #qr { display: flex; justify-content: center; margin: 12px 0; }
  .muted { color: #5d6475; font-size: 12px; }
</style>
<? if (!deployed) { ?>
  <p><b>Πρώτα χρειάζεται μία φορά «Ανάπτυξη»:</b></p>
  <ol>
    <li>Επεκτάσεις → <b>Apps Script</b></li>
    <li>Πάνω δεξιά: <b>Ανάπτυξη → Νέα ανάπτυξη</b></li>
    <li>Τύπος: <b>Εφαρμογή ιστού</b> · Εκτέλεση ως: <b>Εγώ</b> · Πρόσβαση: <b>Οποιοσδήποτε</b></li>
    <li><b>Ανάπτυξη</b> και έγκριση δικαιωμάτων</li>
    <li>Επιστρέψτε εδώ και ανοίξτε ξανά το «Εγγραφές → Σύνδεση tablet».</li>
  </ol>
<? } else { ?>
  <? if (link) { ?>
    <p><b>Σαρώστε με την κάμερα του tablet:</b></p>
    <div id="qr"></div>
    <p class="muted">ή, στο tablet: Διαχείριση → Ρυθμίσεις → επικολλήστε τον κωδικό:</p>
  <? } else { ?>
    <p>Στο tablet ανοίξτε <b>Διαχείριση → Ρυθμίσεις</b> και επικολλήστε τον <b>κωδικό σύνδεσης</b>:</p>
  <? } ?>
  <textarea id="code" readonly onclick="this.select()"><?= code ?></textarea>
  <button onclick="copy()">Αντιγραφή κωδικού</button> <span id="done" class="muted"></span>
  <p class="muted">Ο κωδικός επιτρέπει μόνο την προσθήκη αιτήσεων. Μην τον δημοσιεύετε. Αν διαρρεύσει: Εγγραφές → Νέος κωδικός ασφαλείας.</p>
  <script>
    function copy() { var t = document.getElementById('code'); t.select(); document.execCommand('copy'); document.getElementById('done').textContent = 'Αντιγράφηκε'; }
  </script>
  <? if (link) { ?>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <script>new QRCode(document.getElementById('qr'), { text: <?!= JSON.stringify(link) ?>, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });</script>
  <? } ?>
<? } ?>`;

/* ---------- Βοηθητικά ---------- */

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    // Χρησιμοποιεί την πρώτη καρτέλα αν είναι άδεια, ώστε οι αιτήσεις να φαίνονται αμέσως
    const first = ss.getSheets()[0];
    if (first && first.getLastRow() === 0 && first.getLastColumn() === 0) sheet = first.setName(SHEET_NAME);
    else sheet = ss.insertSheet(SHEET_NAME, 0);
    ss.setActiveSheet(sheet);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#1e2b5e').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    // Όλα ως κείμενο, ώστε να μη χάνονται μηδενικά/+ στα τηλέφωνα
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sheet.setColumnWidth(SIGNATURE_COL, 180);
  }
  return sheet;
}

function getFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* διαγράφηκε: δημιουργείται ξανά */ }
  }
  const folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function makePdf(body) {
  try {
    const d = body.data || {};
    const name = [d.lastName, d.firstName, fmtDate(d.birthDate).replace(/\//g, '-'), String(body.id).slice(0, 8)].join('_');
    const html = HtmlService.createTemplate(PDF_TEMPLATE);
    html.d = d;
    html.signature = body.signature;
    html.submitted = fmtDateTime(body.createdAt);
    html.signedDate = Utilities.formatDate(new Date(body.createdAt), 'Europe/Athens', 'dd/MM/yyyy');
    html.photo = yesNo(d.photoConsent);
    html.consent = yesNo(d.dataConsent);
    html.birth = fmtDate(d.birthDate);
    html.code = String(body.id).slice(0, 8);
    const blob = Utilities.newBlob(html.evaluate().getContent(), 'text/html', name + '.html')
      .getAs('application/pdf').setName(name + '.pdf');
    return getFolder().createFile(blob);
  } catch (err) {
    console.error('PDF:', err);
    return null;
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fmtDate(iso) {
  if (!iso) return '';
  const p = String(iso).slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso);
}

function fmtDateTime(iso) {
  return Utilities.formatDate(new Date(iso), 'Europe/Athens', 'dd/MM/yyyy HH:mm');
}

function yesNo(v) {
  return v === 'yes' ? 'ΝΑΙ' : v === 'no' ? 'ΟΧΙ' : '';
}

const PDF_TEMPLATE = `
<html><head><meta charset="utf-8"><style>
  body { font-family: Arial, sans-serif; font-size: 11pt; color: #000; margin: 0; }
  h1 { font-size: 20pt; letter-spacing: 1px; margin: 0 0 14px; }
  h2 { font-size: 11pt; text-decoration: underline; margin: 16px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; border-bottom: 0.5pt solid #999; }
  td.l { width: 38%; color: #333; }
  p { margin: 6px 0; line-height: 1.45; }
  .sign { margin-top: 18px; text-align: right; }
  .sign div { display: inline-block; text-align: center; }
  .sign img { width: 240px; border-bottom: 0.5pt solid #000; }
  .foot { margin-top: 20px; padding-top: 6px; border-top: 1.5pt solid #5a1f24; text-align: center; font-size: 9pt; }
</style></head><body>
  <h1>ΑΙΤΗΣΗ ΕΓΓΡΑΦΗΣ</h1>
  <h2>ΠΡΟΣΩΠΙΚΑ ΣΤΟΙΧΕΙΑ ΑΘΛΗΤΗ / ΑΘΛΗΤΡΙΑΣ</h2>
  <table>
    <tr><td class="l">Επώνυμο</td><td><?= d.lastName ?></td></tr>
    <tr><td class="l">Όνομα</td><td><?= d.firstName ?></td></tr>
    <tr><td class="l">Όνομα Πατέρα</td><td><?= d.fatherName ?></td></tr>
    <tr><td class="l">Όνομα Μητέρας</td><td><?= d.motherName ?></td></tr>
    <tr><td class="l">Ημ/νία Γεννήσεως</td><td><?= birth ?></td></tr>
    <tr><td class="l">Διεύθυνση</td><td><?= [d.street, d.area, d.postalCode].filter(String).join(', ') ?></td></tr>
    <tr><td class="l">e-mail</td><td><?= d.email ?></td></tr>
    <tr><td class="l">e-mail 2ο</td><td><?= d.email2 ?></td></tr>
    <tr><td class="l">Κινητό 1 (Πατέρα)</td><td><?= d.phoneFather ?></td></tr>
    <tr><td class="l">Κινητό 2 (Μητέρας)</td><td><?= d.phoneMother ?></td></tr>
    <tr><td class="l">Κινητό 3 (Αθλητή/τριας)</td><td><?= d.phoneAthlete ?></td></tr>
    <tr><td class="l">Σταθερό τηλέφωνο</td><td><?= d.landline ?></td></tr>
    <tr><td class="l">Σχολείο φοίτησης</td><td><?= d.school ?></td></tr>
  </table>
  <h2>ΠΡΟΣ ΤΟ Δ.Σ. ΤΟΥ ΒΡΙΛΗΣΣΙΑΚΟΥ ΑΘΛΗΤΙΚΟΥ ΟΜΙΛΟΥ</h2>
  <p>Με την παρούσα αίτηση παρακαλώ να εγκρίνετε την εγγραφή του / της γιου / κόρης μου ως αθλητή / αθλήτρια στην Ακαδημία του Βριλησσιακού Αθλητικού Ομίλου και δίνω τη συγκατάθεσή μου για τη συμμετοχή του / της στις δραστηριότητες του Συλλόγου.</p>
  <p>Δίνω τη συγκατάθεσή μου στον Σύλλογο να χρησιμοποιεί τις φωτογραφίες του παιδιού μου, που λαμβάνονται εν ώρα προπονήσεων / αγώνων ή γενικά εκδηλώσεων που λαμβάνουν χώρα μέσα στο γήπεδο, στην ιστοσελίδα του Συλλόγου και στη σελίδα που διατηρεί στο Facebook. <b>— <?= photo ?></b></p>
  <p>Δηλώνω υπεύθυνα ότι συναινώ στην επεξεργασία των προσωπικών μου δεδομένων που αναγράφω ανωτέρω από τον Βριλησσιακό Αθλητικό Όμιλο. <b>— <?= consent ?></b></p>
  <div class="sign"><div>
    <p>Βριλήσσια, <?= signedDate ?></p>
    <p>ΥΠΟΓΡΑΦΗ ΓΟΝΕΑ / ΚΗΔΕΜΟΝΑ</p>
    <? if (signature) { ?><img src="<?!= signature ?>"><? } ?>
    <p><?= d.guardianName ?></p>
  </div></div>
  <div class="foot">Ολύμπου 19, 152 35 Βριλήσσια – τηλ. 697 852 2982 – 694 859 7130 · www.vrilissiakos.gr · info@vrilissiakos.gr<br>
  Ηλεκτρονική υποβολή: <?= submitted ?> · Κωδ. <?= code ?></div>
</body></html>`;
