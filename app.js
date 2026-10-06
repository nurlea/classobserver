// === GOOGLE DRIVE INTEGRATION ===
const GOOGLE_CLIENT_ID = '414031848105-oiudvqvhh1n93h68jsrs2885v0esdfj6.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const BACKUP_FILENAME = 'ClassObserver_Drive_Backup.json';

let driveTokenClient = null;
let driveAccessToken = null;
let driveFileId = null; // ID der gespeicherten Backup-Datei in Drive
// === GOOGLE DRIVE: INITIALISIERUNG ===
function initDrive() {
  if (typeof google === 'undefined') return;

  driveTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (tokenResponse) => {
      if (tokenResponse.error) {
        console.error('Drive Auth Fehler:', tokenResponse.error);
        return;
      }
      driveAccessToken = tokenResponse.access_token;
      localStorage.setItem('co_drive_token', driveAccessToken);
      updateDriveUI(true);
    }
  });

  // Gespeicherten Token wiederherstellen
  const savedToken = localStorage.getItem('co_drive_token');
  if (savedToken) {
    driveAccessToken = savedToken;
    updateDriveUI(true);
  }
}

// === DRIVE UI AKTUALISIEREN ===
function updateDriveUI(connected) {
  const btn = document.getElementById('drive-btn');
  const status = document.getElementById('drive-status');
  if (!btn || !status) return;

  if (connected) {
    btn.textContent = '☁️ Drive verbunden';
    btn.style.background = 'rgba(255,255,255,0.35)';
    status.textContent = '✅ Verbunden';
  } else {
    btn.textContent = '☁️ Google Drive';
    btn.style.background = 'rgba(255,255,255,0.2)';
    status.textContent = '';
    driveAccessToken = null;
    localStorage.removeItem('co_drive_token');
    driveFileId = null;
  }
}

// === DRIVE: ANMELDEN / ABMELDEN ===
function toggleDriveLogin() {
  if (driveAccessToken) {
    if (!confirm('Drive-Verbindung trennen?')) return;
    google.accounts.oauth2.revoke(driveAccessToken, () => {});
    updateDriveUI(false);
  } else {
    if (!driveTokenClient) {
      alert('Google API noch nicht geladen. Bitte kurz warten und erneut versuchen.');
      return;
    }
    driveTokenClient.requestAccessToken();
  }
}

// === DRIVE: BACKUP-DATEI SUCHEN ===
async function findDriveFile() {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${BACKUP_FILENAME}'&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${driveAccessToken}` } }
  );
  const data = await resp.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

// === DRIVE: IN DRIVE SPEICHERN ===
async function saveToDrive() {
  if (!driveAccessToken) {
    alert('Bitte zuerst mit Google Drive verbinden (☁️-Button im Header).');
    return;
  }

  const backup = {
    version: 1,
    exportDate: new Date().toISOString(),
    classes,
    stundenplan,
    beobachtungen,
    criteria,
    activeScale,
    obsPeriod
  };

  const content = JSON.stringify(backup, null, 2);
  const blob = new Blob([content], { type: 'application/json' });

  try {
    // Prüfen ob Datei schon existiert
    const existingId = await findDriveFile();

    let url, method;
    if (existingId) {
      // Aktualisieren (PATCH)
      url = `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`;
      method = 'PATCH';
    } else {
      // Neu anlegen (POST) im appDataFolder
      const meta = { name: BACKUP_FILENAME, parents: ['appDataFolder'] };
      const metaBlob = new Blob([JSON.stringify(meta)], { type: 'application/json' });

      const form = new FormData();
      form.append('metadata', metaBlob);
      form.append('file', blob);

      const createResp = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${driveAccessToken}` },
          body: form
        }
      );
      const created = await createResp.json();
      driveFileId = created.id;
      alert('✅ Erfolgreich in Google Drive gespeichert!');
      return;
    }

    await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${driveAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: content
    });

    alert('✅ Erfolgreich in Google Drive gespeichert!');
  } catch (err) {
    console.error(err);
    alert('❌ Fehler beim Speichern in Drive. Bitte erneut verbinden.');
    updateDriveUI(false);
  }
}

// === DRIVE: AUS DRIVE LADEN ===
async function loadFromDrive() {
  if (!driveAccessToken) {
    alert('Bitte zuerst mit Google Drive verbinden (☁️-Button im Header).');
    return;
  }

  try {
    const fileId = await findDriveFile();
    if (!fileId) {
      alert('Keine Drive-Sicherung gefunden. Bitte zuerst speichern.');
      return;
    }

    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${driveAccessToken}` } }
    );
    const backup = await resp.json();

    if (!backup.classes || !backup.stundenplan || !backup.beobachtungen) {
      throw new Error('Ungültiges Format');
    }

    if (!confirm('Alle aktuellen Daten werden durch die Drive-Sicherung ersetzt. Fortfahren?')) return;

    classes       = backup.classes       || [];
    stundenplan   = backup.stundenplan   || [];
    beobachtungen = backup.beobachtungen || [];
    criteria      = backup.criteria      || criteria;
    activeScale   = backup.activeScale   || 'pflanze';
    obsPeriod     = backup.obsPeriod     || 'month';

    saveData();
    saveStundenplan();
    saveBeobachtungen();
    saveCriteria();
    localStorage.setItem('co_scale', activeScale);
    localStorage.setItem('co_obs_period', obsPeriod);

    alert('✅ Daten aus Google Drive geladen!');
    renderAuswertung();
  } catch (err) {
    console.error(err);
    alert('❌ Fehler beim Laden aus Drive. Bitte erneut versuchen.');
  }
}
// === AUTOMATISCHE ABMELDUNG nach 15 Minuten Inaktivität ===
let inactivityTimer;

function resetTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    logout();
    alert('Du wurdest nach 15 Minuten Inaktivität automatisch abgemeldet.');
  }, 15 * 60 * 1000);
}

document.addEventListener('mousemove', resetTimer);
document.addEventListener('keydown', resetTimer);

// === PASSWORT SPEICHERN ===
function savePassword() {
  const newPw = document.getElementById('new-password').value;
  const confirmPw = document.getElementById('confirm-password').value;
  const errorMsg = document.getElementById('set-error-msg');
  const successMsg = document.getElementById('set-success-msg');

  errorMsg.classList.add('hidden');
  successMsg.classList.add('hidden');

  if (newPw !== confirmPw || newPw === '') {
    errorMsg.classList.remove('hidden');
    return;
  }

  // Passwort im LocalStorage speichern (für Light-Version ausreichend)
  localStorage.setItem('co_password', newPw);
  successMsg.classList.remove('hidden');
}

// === LOGIN ===
function login() {
  const input = document.getElementById('password').value;
  const stored = localStorage.getItem('co_password');
  const errorMsg = document.getElementById('error-msg');

  errorMsg.classList.add('hidden');

  if (!stored) {
    alert('Bitte zuerst ein Passwort erstellen.');
    showSetPassword();
    return;
  }

  if (input === stored) {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
    resetTimer();
  } else {
    errorMsg.classList.remove('hidden');
  }
}

// === ABMELDEN ===
function logout() {
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('password').value = '';
  clearTimeout(inactivityTimer);
}

// === NAVIGATION ===
function showSetPassword() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('set-password-screen').classList.remove('hidden');
}

function showLogin() {
  document.getElementById('set-password-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

// === ENTER-TASTE beim Login ===
document.getElementById('password').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') login();
});
// === NAVIGATION ===
function showSection(name) {
  // Alle Sektionen ausblenden
  document.querySelectorAll('.content-section').forEach(s => s.classList.add('hidden'));
  // Alle Nav-Buttons deaktivieren
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  // Gewählte Sektion anzeigen
  document.getElementById('section-' + name).classList.remove('hidden');

  // Aktiven Button markieren
  const btns = document.querySelectorAll('.nav-btn');
  const sectionNames = ['klassen', 'stundenplan', 'beobachtung', 'auswertung'];
  const index = sectionNames.indexOf(name);
  if (index !== -1) btns[index].classList.add('active');
}

// === DATENSPEICHERUNG ===
function saveData() {
  localStorage.setItem('co_classes', JSON.stringify(classes));
}

function loadData() {
  const stored = localStorage.getItem('co_classes');
  if (stored) classes = JSON.parse(stored);
}

// === KLASSENVERWALTUNG (erweitert) ===
let activeClassId = null; // Aktuell geöffnete Klasse

// Klasse hinzufügen
function addClass() {
  const input = document.getElementById('new-class-name');
  const name = input.value.trim();
  const errorEmpty = document.getElementById('class-error');
  const errorDupe = document.getElementById('class-duplicate-error');
  errorEmpty.classList.add('hidden');
  errorDupe.classList.add('hidden');

  if (name === '') {
    errorEmpty.classList.remove('hidden');
    return;
  }

  if (classes.find(c => c.name.toLowerCase() === name.toLowerCase())) {
    errorDupe.classList.remove('hidden');
    return;
  }

  classes.push({ id: Date.now(), name, students: [] });
  input.value = '';
  saveData();
  renderClasses();
}

// Klassen-Übersicht rendern
function renderClasses() {
  const container = document.getElementById('class-list');
  container.innerHTML = '';

  if (classes.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏫</div>
        <p>Noch keine Klassen angelegt.</p>
      </div>`;
    return;
  }

  classes.forEach(cls => {
    const studentCount = cls.students ? cls.students.length : 0;
    const obsCount = beobachtungen.filter(b => b.classId === cls.id).length;

    const card = document.createElement('div');
    card.className = 'card class-card';
    card.onclick = () => openClassDetail(cls.id);
    card.innerHTML = `
      <h3>🏫 Klasse ${cls.name}</h3>
      <p style="color:#6a8f6a; font-size:0.88rem; margin-top:8px;">
        👥 ${studentCount} Schüler*in${studentCount !== 1 ? 'nen' : ''}
      </p>
      <p style="color:#6a8f6a; font-size:0.88rem;">
        🎯 ${obsCount} Beobachtung${obsCount !== 1 ? 'en' : ''}
      </p>
      <p style="margin-top:12px; font-size:0.82rem; color:#a5d6a7;">
        Klicken zum Bearbeiten →
      </p>
    `;
    container.appendChild(card);
  });
}

// Detailansicht öffnen
function openClassDetail(classId) {
  activeClassId = classId;
  const cls = classes.find(c => c.id === classId);
  if (!cls) return;

  document.getElementById('class-detail-title').textContent = `🏫 Klasse ${cls.name}`;
  document.getElementById('class-list').classList.add('hidden');
  document.getElementById('class-detail').classList.remove('hidden');

  // Eingabefeld leeren
  document.getElementById('new-student-name').value = '';
  document.getElementById('student-error').classList.add('hidden');
  document.getElementById('student-duplicate-error').classList.add('hidden');

  renderStudentList();
}

// Detailansicht schließen
function closeClassDetail() {
  activeClassId = null;
  document.getElementById('class-detail').classList.add('hidden');
  document.getElementById('class-list').classList.remove('hidden');
  renderClasses();
}

// Schüler*innen-Liste rendern
function renderStudentList() {
  const cls = classes.find(c => c.id === activeClassId);
  if (!cls) return;

  const list = document.getElementById('student-list');
  const emptyHint = document.getElementById('student-empty');
  const countLabel = document.getElementById('student-count-label');

  list.innerHTML = '';

  if (!cls.students || cls.students.length === 0) {
    emptyHint.classList.remove('hidden');
    countLabel.textContent = '';
    return;
  }

  emptyHint.classList.add('hidden');
  countLabel.textContent =
    `${cls.students.length} Schüler*in${cls.students.length !== 1 ? 'nen' : ''} eingetragen`;

  // Alphabetisch sortiert anzeigen
  const sorted = [...cls.students].sort((a, b) => a.name.localeCompare(b.name, 'de'));

  sorted.forEach(student => {
    const obsCount = beobachtungen.filter(b => b.studentId === student.id).length;
    const lastObs = beobachtungen
      .filter(b => b.studentId === student.id)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    const lastDate = lastObs
      ? new Date(lastObs.date).toLocaleDateString('de-DE')
      : 'Noch nie';

    const li = document.createElement('li');
    li.innerHTML = `
      <span>👤 ${student.name}</span>
      <span class="student-obs-badge">
        🎯 ${obsCount}× beobachtet · zuletzt: ${lastDate}
      </span>
      <button class="delete-btn" onclick="deleteStudent(${student.id})" title="Löschen">🗑️</button>
    `;
    list.appendChild(li);
  });
}

// Schüler*in hinzufügen
function addStudent() {
  const input = document.getElementById('new-student-name');
  const name = input.value.trim();
  const errorEmpty = document.getElementById('student-error');
  const errorDupe = document.getElementById('student-duplicate-error');
  errorEmpty.classList.add('hidden');
  errorDupe.classList.add('hidden');

  if (name === '') {
    errorEmpty.classList.remove('hidden');
    return;
  }

  const cls = classes.find(c => c.id === activeClassId);
  if (!cls) return;

  if (!cls.students) cls.students = [];

  if (cls.students.find(s => s.name.toLowerCase() === name.toLowerCase())) {
    errorDupe.classList.remove('hidden');
    return;
  }

  cls.students.push({ id: Date.now(), name });
  input.value = '';
  input.focus();
  saveData();
  renderStudentList();
}

// Schüler*in löschen
function deleteStudent(studentId) {
  const cls = classes.find(c => c.id === activeClassId);
  if (!cls) return;

  const student = cls.students.find(s => s.id === studentId);
  const obsCount = beobachtungen.filter(b => b.studentId === studentId).length;

  let confirmMsg = `"${student.name}" wirklich löschen?`;
  if (obsCount > 0) {
    confirmMsg += `\n\n⚠️ Achtung: Es gibt ${obsCount} gespeicherte Beobachtung${obsCount !== 1 ? 'en' : ''} zu dieser Person. Diese bleiben erhalten, sind aber keiner Schülerin/keinem Schüler mehr zugeordnet.`;
  }

  if (!confirm(confirmMsg)) return;

  cls.students = cls.students.filter(s => s.id !== studentId);
  saveData();
  renderStudentList();
}

// Klasse löschen
function deleteClass() {
  const cls = classes.find(c => c.id === activeClassId);
  if (!cls) return;

  const obsCount = beobachtungen.filter(b => b.classId === activeClassId).length;
  let confirmMsg = `Klasse "${cls.name}" wirklich löschen?`;
  if (obsCount > 0) {
    confirmMsg += `\n\n⚠️ Achtung: Es gibt ${obsCount} gespeicherte Beobachtung${obsCount !== 1 ? 'en' : ''} für diese Klasse.`;
  }

  if (!confirm(confirmMsg)) return;

  classes = classes.filter(c => c.id !== activeClassId);
  saveData();
  closeClassDetail();
}

// === BEIM LOGIN: DATEN LADEN ===
const originalLogin = login;
// Daten laden sobald die App startet
document.addEventListener('DOMContentLoaded', () => {
  loadData();
});
// === STUNDENPLAN ===
let stundenplan = []; // Format: [{ id, day, lesson, timeFrom, timeTo, subject, classId }]

const dayOrder = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];

function saveStundenplan() {
  localStorage.setItem('co_stundenplan', JSON.stringify(stundenplan));
}

function loadStundenplan() {
  const stored = localStorage.getItem('co_stundenplan');
  if (stored) stundenplan = JSON.parse(stored);
}

// Klassen-Dropdown im Stundenplan-Formular befüllen
function updateClassDropdown() {
  const select = document.getElementById('sp-class');
  if (!select) return;
  select.innerHTML = '';

  if (classes.length === 0) {
    select.innerHTML = '<option value="">– Keine Klassen vorhanden –</option>';
    return;
  }

  classes.forEach(cls => {
    const option = document.createElement('option');
    option.value = cls.id;
    option.textContent = `Klasse ${cls.name}`;
    select.appendChild(option);
  });
}

function addLesson() {
  const day = document.getElementById('sp-day').value;
  const lesson = document.getElementById('sp-lesson').value;
  const timeFrom = document.getElementById('sp-time-from').value;
  const timeTo = document.getElementById('sp-time-to').value;
  const subject = document.getElementById('sp-subject').value.trim();
  const classId = parseInt(document.getElementById('sp-class').value);

  const errorEmpty = document.getElementById('sp-error');
  const errorDupe = document.getElementById('sp-duplicate-error');
  errorEmpty.classList.add('hidden');
  errorDupe.classList.add('hidden');

  if (!subject || !timeFrom || !timeTo || !classId) {
    errorEmpty.classList.remove('hidden');
    return;
  }

  // Doppelte Einträge prüfen (gleicher Tag, gleiche Stunde, gleiche Klasse)
  const duplicate = stundenplan.find(e =>
    e.day === day && e.lesson === lesson && e.classId === classId
  );
  if (duplicate) {
    errorDupe.classList.remove('hidden');
    return;
  }

  stundenplan.push({
    id: Date.now(),
    day,
    lesson: parseInt(lesson),
    timeFrom,
    timeTo,
    subject,
    classId
  });

  document.getElementById('sp-subject').value = '';
  saveStundenplan();
  renderStundenplan();
}

function deleteLesson(id) {
  if (!confirm('Stunde wirklich löschen?')) return;
  stundenplan = stundenplan.filter(e => e.id !== id);
  saveStundenplan();
  renderStundenplan();
}

function renderStundenplan() {
  const container = document.getElementById('stundenplan-grid');
  container.innerHTML = '';

  // Nur Tage anzeigen, für die Einträge existieren
  const daysWithLessons = dayOrder.filter(day =>
    stundenplan.some(e => e.day === day)
  );

  if (daysWithLessons.length === 0) {
    container.innerHTML = '<p style="color:#6a8f6a;">Noch keine Stunden eingetragen.</p>';
    return;
  }

  daysWithLessons.forEach(day => {
    const dayEntries = stundenplan
      .filter(e => e.day === day)
      .sort((a, b) => a.lesson - b.lesson);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.innerHTML = `<h3>📅 ${day}</h3>`;

    dayEntries.forEach(entry => {
      const cls = classes.find(c => c.id === entry.classId);
      const className = cls ? `Klasse ${cls.name}` : 'Unbekannte Klasse';

      const div = document.createElement('div');
      div.className = 'lesson-entry';
      div.innerHTML = `
        <span class="lesson-subject">${entry.lesson}. Std – ${entry.subject}</span>
        <span class="lesson-info">🕐 ${entry.timeFrom} – ${entry.timeTo}</span>
        <span class="lesson-info">🏫 ${className}</span>
        <button class="delete-btn" onclick="deleteLesson(${entry.id})" title="Löschen">🗑️</button>
      `;
      col.appendChild(div);
    });

    container.appendChild(col);
  });
}

// === DATEN BEIM START LADEN (erweitert) ===
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  loadStundenplan();
});

// Klassen-Dropdown aktualisieren, wenn Stundenplan-Tab geöffnet wird
const originalShowSection = showSection;
showSection = function(name) {
  originalShowSection(name);
  if (name === 'stundenplan') {
    updateClassDropdown();
    renderStundenplan();
  }
};
// === BEOBACHTUNGSALGORITHMUS ===
let beobachtungen = []; // Format: [{ id, date, classId, lessonId, studentId, ratings: {criteriaId: value}, notes }]
let activeBeobachtung = null; // Aktuell laufende Beobachtung

// Bewertungskriterien (Standard)
let criteria = [
  { id: 1, text: 'Hat sich regelmäßig gemeldet' },
  { id: 2, text: 'Hat Mitschülerinnen und Mitschüler unterstützt' },
  { id: 3, text: 'Hat selbstständig gearbeitet' },
  { id: 4, text: 'Hat sorgfältig gearbeitet' },
  { id: 5, text: 'Hat aktiv zugehört' }
];

// Pflanzenskala (Standard)
const scales = {
  pflanze: [
    { value: 1, label: '🌱', title: 'Samen – noch am Anfang' },
    { value: 2, label: '🌿', title: 'Keimling – auf dem Weg' },
    { value: 3, label: '🪴', title: 'Pflanze – macht Fortschritte' },
    { value: 4, label: '🌳', title: 'Baum – sehr stark!' }
  ],
  plus: [
    { value: 5, label: '++', title: 'Sehr gut' },
    { value: 4, label: '+', title: 'Gut' },
    { value: 3, label: '0', title: 'Befriedigend' },
    { value: 2, label: '–', title: 'Ausreichend' },
    { value: 1, label: '– –', title: 'Nicht ausreichend' }
  ],
  noten: [
    { value: 1, label: '1', title: 'Sehr gut' },
    { value: 2, label: '2', title: 'Gut' },
    { value: 3, label: '3', title: 'Befriedigend' },
    { value: 4, label: '4', title: 'Ausreichend' },
    { value: 5, label: '5', title: 'Mangelhaft' },
    { value: 6, label: '6', title: 'Ungenügend' }
  ]
};

let activeScale = 'pflanze'; // Standardskala

function saveBeobachtungen() {
  localStorage.setItem('co_beobachtungen', JSON.stringify(beobachtungen));
}

function loadBeobachtungen() {
  const stored = localStorage.getItem('co_beobachtungen');
  if (stored) beobachtungen = JSON.parse(stored);
}

// === KLASSEN-DROPDOWN IM BEOBACHTUNGSBEREICH ===
function updateBeobClasses() {
  const select = document.getElementById('beob-class');
  if (!select) return;
  select.innerHTML = '';

  if (classes.length === 0) {
    select.innerHTML = '<option value="">– Keine Klassen vorhanden –</option>';
    return;
  }

  classes.forEach(cls => {
    const option = document.createElement('option');
    option.value = cls.id;
    option.textContent = `Klasse ${cls.name}`;
    select.appendChild(option);
  });

  updateBeobLessons();
}

// === STUNDEN-DROPDOWN je nach gewählter Klasse ===
function updateBeobLessons() {
  const classId = parseInt(document.getElementById('beob-class').value);
  const select = document.getElementById('beob-lesson');
  select.innerHTML = '';

  const lessonsForClass = stundenplan.filter(e => e.classId === classId);

  if (lessonsForClass.length === 0) {
    select.innerHTML = '<option value="">– Keine Stunden eingetragen –</option>';
    return;
  }

  lessonsForClass
    .sort((a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day) || a.lesson - b.lesson)
    .forEach(entry => {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = `${entry.day}, ${entry.lesson}. Std – ${entry.subject} (${entry.timeFrom}–${entry.timeTo})`;
      select.appendChild(option);
    });
}

// === ALGORITHMUS: Welche Kinder werden heute beobachtet? ===
function selectStudentsForObservation(classId, count) {
  const cls = classes.find(c => c.id === classId);
  if (!cls || cls.students.length === 0) return [];

  const students = cls.students;

  // Letzte Beobachtungsdaten pro Kind ermitteln
  const lastObserved = {};
  students.forEach(s => {
    const obs = beobachtungen
      .filter(b => b.classId === classId && b.studentId === s.id)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    lastObserved[s.id] = obs.length > 0 ? new Date(obs[0].date) : new Date(0);
  });

  // Kinder nach "am längsten nicht beobachtet" sortieren, mit Zufallskomponente
  const sorted = [...students].sort((a, b) => {
    const timeDiff = lastObserved[a.id] - lastObserved[b.id];
    // Kleine Zufallskomponente, damit es nicht immer dieselbe Reihenfolge ist
    return timeDiff + (Math.random() - 0.5) * 1000 * 60 * 60 * 24;
  });

  return sorted.slice(0, Math.min(count, students.length));
}

// === BEOBACHTUNG STARTEN ===
function startBeobachtung() {
  const classId = parseInt(document.getElementById('beob-class').value);
  const lessonId = parseInt(document.getElementById('beob-lesson').value);
  const count = parseInt(document.getElementById('beob-count').value);
  const errorEl = document.getElementById('beob-select-error');
  errorEl.classList.add('hidden');

  if (!classId || !lessonId) {
    errorEl.classList.remove('hidden');
    return;
  }

  const lesson = stundenplan.find(e => e.id === lessonId);
  const cls = classes.find(c => c.id === classId);
  const selectedStudents = selectStudentsForObservation(classId, count);

  if (selectedStudents.length === 0) {
    alert('Diese Klasse hat noch keine Schülerinnen und Schüler.');
    return;
  }

  activeBeobachtung = {
    classId,
    lessonId,
    lesson,
    students: selectedStudents,
    ratings: {} // { studentId: { criteriaId: value } }
  };

  // Ratings-Objekt initialisieren
  selectedStudents.forEach(s => {
    activeBeobachtung.ratings[s.id] = {};
  });

  // UI umschalten
  document.getElementById('beob-select').classList.add('hidden');
  document.getElementById('beob-active').classList.remove('hidden');

  // Titel setzen
  document.getElementById('beob-active-title').textContent =
    `${lesson.day}, ${lesson.lesson}. Stunde – ${lesson.subject}`;
  document.getElementById('beob-active-subtitle').textContent =
    `🏫 Klasse ${cls.name} · 🕐 ${lesson.timeFrom}–${lesson.timeTo}`;

  renderBeobStudentCards(selectedStudents);
  renderBeobForms(selectedStudents);
}

// === SCHÜLER*INNEN-KARTEN ANZEIGEN ===
function renderBeobStudentCards(students) {
  const container = document.getElementById('beob-student-cards');
  container.innerHTML = '';

  const emojis = ['🌟', '⭐', '✨', '🌈', '🦋', '🌸', '🍀', '🎯'];

  students.forEach((s, i) => {
    const lastObs = beobachtungen
      .filter(b => b.studentId === s.id)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const lastDate = lastObs.length > 0
      ? new Date(lastObs[0].date).toLocaleDateString('de-DE')
      : 'Noch nie';

    const card = document.createElement('div');
    card.className = 'beob-student-card';
    card.innerHTML = `
      <div class="student-emoji">${emojis[i % emojis.length]}</div>
      <div class="student-name">${s.name}</div>
      <div class="student-last">Zuletzt beobachtet: ${lastDate}</div>
    `;
    container.appendChild(card);
  });
}

// === BEWERTUNGSFORMULARE RENDERN ===
function renderBeobForms(students) {
  const container = document.getElementById('beob-forms');
  container.innerHTML = '';

  // Fortschrittsanzeige
  const total = students.length * criteria.length;
  const progressWrap = document.createElement('div');
  progressWrap.innerHTML = `
    <p class="progress-label" id="progress-label">0 von ${total} Kriterien bewertet</p>
    <div class="progress-bar-wrap">
      <div class="progress-bar" id="progress-bar" style="width:0%"></div>
    </div>
  `;
  container.appendChild(progressWrap);

  const scale = scales[activeScale];

  students.forEach(s => {
    const block = document.createElement('div');
    block.className = 'beob-form-block';
    block.innerHTML = `<h4>👤 ${s.name}</h4>`;

    criteria.forEach(c => {
      const row = document.createElement('div');
      row.className = 'criteria-row';

      const label = document.createElement('span');
      label.className = 'criteria-label';
      label.textContent = c.text;

      const btnGroup = document.createElement('div');
      btnGroup.className = 'scale-buttons';

      scale.forEach(option => {
        const btn = document.createElement('button');
        btn.className = 'scale-btn';
        btn.textContent = option.label;
        btn.title = option.title;
        btn.onclick = () => {
          // Auswahl toggeln
          btnGroup.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          if (!activeBeobachtung.ratings[s.id]) activeBeobachtung.ratings[s.id] = {};
          activeBeobachtung.ratings[s.id][c.id] = option.value;
          updateProgress(students);
        };
        btnGroup.appendChild(btn);
      });

      row.appendChild(label);
      row.appendChild(btnGroup);
      block.appendChild(row);
    });

    // Notizfeld
    const notes = document.createElement('textarea');
    notes.className = 'beob-notes';
    notes.placeholder = `Individuelle Anmerkungen zu ${s.name}...`;
    notes.rows = 2;
    notes.oninput = () => {
      activeBeobachtung.ratings[s.id]['notes'] = notes.value;
    };
    block.appendChild(notes);

    container.appendChild(block);
  });
}

// === FORTSCHRITT AKTUALISIEREN ===
function updateProgress(students) {
  let filled = 0;
  const total = students.length * criteria.length;

  students.forEach(s => {
    criteria.forEach(c => {
      if (activeBeobachtung.ratings[s.id] &&
          activeBeobachtung.ratings[s.id][c.id] !== undefined) {
        filled++;
      }
    });
  });

  const percent = Math.round((filled / total) * 100);
  document.getElementById('progress-bar').style.width = percent + '%';
  document.getElementById('progress-label').textContent =
    `${filled} von ${total} Kriterien bewertet`;
}

// === BEOBACHTUNGEN SPEICHERN ===
function saveBeobachtung() {
  if (!activeBeobachtung) return;

  const date = new Date().toISOString();

  activeBeobachtung.students.forEach(s => {
    beobachtungen.push({
      id: Date.now() + Math.random(),
      date,
      classId: activeBeobachtung.classId,
      lessonId: activeBeobachtung.lessonId,
      lessonLabel: `${activeBeobachtung.lesson.day}, ${activeBeobachtung.lesson.lesson}. Std – ${activeBeobachtung.lesson.subject}`,
      studentId: s.id,
      studentName: s.name,
      ratings: activeBeobachtung.ratings[s.id] || {},
      scale: activeScale
    });
  });

  saveBeobachtungen();
  cancelBeobachtung();
  alert('✅ Beobachtungen wurden gespeichert!');
}

// === BEOBACHTUNG ABBRECHEN ===
function cancelBeobachtung() {
  activeBeobachtung = null;
  document.getElementById('beob-active').classList.add('hidden');
  document.getElementById('beob-select').classList.remove('hidden');
}

// === DATEN LADEN (erweitert) ===
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  loadStundenplan();
  loadBeobachtungen();
});

// showSection erweitern für Beobachtung
const originalShowSection2 = showSection;
showSection = function(name) {
  originalShowSection2(name);
  if (name === 'beobachtung') {
    updateBeobClasses();
  }
};
// === EINSTELLUNGEN ===

// --- BEWERTUNGSSKALA ---
function selectScale(scaleName) {
  activeScale = scaleName;
  localStorage.setItem('co_scale', scaleName);

  // Alle Optionen deaktivieren
  document.querySelectorAll('.scale-option').forEach(el => el.classList.remove('active'));
  // Gewählte Option aktivieren
  document.getElementById('scale-opt-' + scaleName).classList.add('active');

  // Erfolgsmeldung
  const msg = document.getElementById('scale-saved-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2000);
}

function loadScale() {
  const stored = localStorage.getItem('co_scale');
  if (stored) activeScale = stored;
  // UI aktualisieren (wenn Einstellungsbereich sichtbar ist)
  const el = document.getElementById('scale-opt-' + activeScale);
  if (el) {
    document.querySelectorAll('.scale-option').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
  }
}

// --- BEOBACHTUNGSZEITRAUM ---
let obsPeriod = 'month';

function savePeriod() {
  obsPeriod = document.getElementById('obs-period').value;
  localStorage.setItem('co_obs_period', obsPeriod);
  const msg = document.getElementById('period-saved-msg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2000);
}

function loadPeriod() {
  const stored = localStorage.getItem('co_obs_period');
  if (stored) {
    obsPeriod = stored;
    const el = document.getElementById('obs-period');
    if (el) el.value = obsPeriod;
  }
}

// --- BEWERTUNGSKRITERIEN ---
function saveCriteria() {
  localStorage.setItem('co_criteria', JSON.stringify(criteria));
}

function loadCriteria() {
  const stored = localStorage.getItem('co_criteria');
  if (stored) criteria = JSON.parse(stored);
}

function addCriteria() {
  const input = document.getElementById('new-criteria-input');
  const text = input.value.trim();
  const errorEmpty = document.getElementById('criteria-error');
  const errorDupe = document.getElementById('criteria-duplicate-error');

  errorEmpty.classList.add('hidden');
  errorDupe.classList.add('hidden');

  if (text === '') {
    errorEmpty.classList.remove('hidden');
    return;
  }

  if (criteria.find(c => c.text.toLowerCase() === text.toLowerCase())) {
    errorDupe.classList.remove('hidden');
    return;
  }

  criteria.push({ id: Date.now(), text });
  input.value = '';
  saveCriteria();
  renderCriteria();
}

function deleteCriteria(id) {
  if (criteria.length <= 1) {
    alert('Du benötigst mindestens ein Bewertungskriterium.');
    return;
  }
  if (!confirm('Kriterium wirklich löschen?')) return;
  criteria = criteria.filter(c => c.id !== id);
  saveCriteria();
  renderCriteria();
}

function renderCriteria() {
  const list = document.getElementById('criteria-list');
  if (!list) return;
  list.innerHTML = '';

  criteria.forEach(c => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="drag-handle">☰</span>
      <span>${c.text}</span>
      <button class="delete-btn" onclick="deleteCriteria(${c.id})" title="Löschen">🗑️</button>
    `;
    list.appendChild(li);
  });
}

// --- PASSWORT ÄNDERN ---
function changePassword() {
  const newPw = document.getElementById('change-pw-new').value;
  const confirmPw = document.getElementById('change-pw-confirm').value;
  const errorEl = document.getElementById('change-pw-error');
  const successEl = document.getElementById('change-pw-success');

  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  if (newPw === '' || newPw !== confirmPw) {
    errorEl.classList.remove('hidden');
    return;
  }

  localStorage.setItem('co_password', newPw);
  document.getElementById('change-pw-new').value = '';
  document.getElementById('change-pw-confirm').value = '';
  successEl.classList.remove('hidden');
  setTimeout(() => successEl.classList.add('hidden'), 2000);
}

// === DATEN LADEN (final) ===
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  loadStundenplan();
  loadBeobachtungen();
  loadCriteria();
  loadScale();
  loadPeriod();
  // NEU:
  window.addEventListener('load', initDrive); // warten bis Google-Script geladen
});

// showSection erweitern für Einstellungen
const originalShowSection3 = showSection;
showSection = function(name) {
  originalShowSection3(name);
  if (name === 'einstellungen') {
    renderCriteria();
    loadScale();
    loadPeriod();
  }
};
// === AUSWERTUNG ===

function updateAuswertClasses() {
  const select = document.getElementById('auswert-class');
  if (!select) return;
  // Bestehende Optionen außer "Alle" entfernen
  select.innerHTML = '<option value="">Alle Klassen</option>';
  classes.forEach(cls => {
    const option = document.createElement('option');
    option.value = cls.id;
    option.textContent = `Klasse ${cls.name}`;
    select.appendChild(option);
  });
}

function getFilteredBeobachtungen() {
  const classId = document.getElementById('auswert-class').value;
  const period = document.getElementById('auswert-period').value;

  let filtered = [...beobachtungen];

  // Nach Klasse filtern
  if (classId) {
    filtered = filtered.filter(b => b.classId === parseInt(classId));
  }

  // Nach Zeitraum filtern
  const now = new Date();
  if (period === 'week') {
    const cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000);
    filtered = filtered.filter(b => new Date(b.date) >= cutoff);
  } else if (period === 'month') {
    const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
    filtered = filtered.filter(b => new Date(b.date) >= cutoff);
  }

  return filtered;
}

function calcAverage(ratings) {
  const values = Object.entries(ratings)
    .filter(([key]) => key !== 'notes')
    .map(([, val]) => val);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function avgToBadge(avg, scale) {
  if (avg === null) return '<span class="badge badge-gray">–</span>';

  if (scale === 'pflanze' || scale === 'plus') {
    // Beide Skalen: höher = besser, max 4
    const max = scale === 'pflanze' ? 4 : 5;
    const ratio = avg / max;
    if (ratio >= 0.75) return `<span class="badge badge-green">⬆ ${avg.toFixed(1)}</span>`;
    if (ratio >= 0.5) return `<span class="badge badge-yellow">➡ ${avg.toFixed(1)}</span>`;
    return `<span class="badge badge-red">⬇ ${avg.toFixed(1)}</span>`;
  } else {
    // Notenskala: niedriger = besser
    if (avg <= 2.5) return `<span class="badge badge-green">⬆ ${avg.toFixed(1)}</span>`;
    if (avg <= 3.5) return `<span class="badge badge-yellow">➡ ${avg.toFixed(1)}</span>`;
    return `<span class="badge badge-red">⬇ ${avg.toFixed(1)}</span>`;
  }
}

function renderAuswertung() {
  const filtered = getFilteredBeobachtungen();
  const classId = document.getElementById('auswert-class').value;
  const tableWrap = document.getElementById('auswert-table-wrap');
  const warningsCard = document.getElementById('auswert-warnings');
  const warningList = document.getElementById('auswert-warning-list');

  // Welche Klassen relevant?
  const relevantClasses = classId
    ? classes.filter(c => c.id === parseInt(classId))
    : classes;

  // Alle relevanten Schülerinnen und Schüler
  const allStudents = relevantClasses.flatMap(cls =>
    cls.students.map(s => ({ ...s, classId: cls.id, className: cls.name }))
  );

  if (allStudents.length === 0) {
    tableWrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>Keine Schülerinnen und Schüler gefunden.</p>
      </div>`;
    warningsCard.classList.add('hidden');
    return;
  }

  // Tabelle aufbauen
  let html = `
    <table class="auswert-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Klasse</th>
          <th>Beobachtungen</th>
          <th>Ø Bewertung</th>
          <th>Zuletzt beobachtet</th>
          <th>Notizen</th>
        </tr>
      </thead>
      <tbody>
  `;

  const notObserved = [];

  allStudents.forEach(student => {
    const obs = filtered.filter(b => b.studentId === student.id);

    if (obs.length === 0) {
      notObserved.push(student);
    }

    const count = obs.length;

    // Durchschnitt über alle Beobachtungen
    const allRatings = {};
    obs.forEach(o => {
      Object.entries(o.ratings).forEach(([key, val]) => {
        if (key !== 'notes') {
          if (!allRatings[key]) allRatings[key] = [];
          allRatings[key].push(val);
        }
      });
    });

    const avgValues = Object.values(allRatings).map(arr =>
      arr.reduce((a, b) => a + b, 0) / arr.length
    );
    const totalAvg = avgValues.length > 0
      ? avgValues.reduce((a, b) => a + b, 0) / avgValues.length
      : null;

    // Letzte Beobachtung
    const lastObs = obs.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    const lastDate = lastObs
      ? new Date(lastObs.date).toLocaleDateString('de-DE')
      : '–';

    // Fortschrittsbalken (max. 10 Beobachtungen als 100%)
    const barPercent = Math.min(count / 10 * 100, 100);

    // Notizen sammeln
    const notes = obs
      .filter(o => o.ratings.notes && o.ratings.notes.trim() !== '')
      .map(o => `• ${o.ratings.notes.trim()}`)
      .join('<br>');

    const scaleUsed = lastObs ? lastObs.scale : activeScale;

    html += `
      <tr>
        <td><strong>${student.name}</strong></td>
        <td>Klasse ${student.className}</td>
        <td>
          <div class="mini-bar-wrap">
            <div class="mini-bar" style="width:${barPercent}%"></div>
          </div>
          ${count}×
        </td>
        <td>${avgToBadge(totalAvg, scaleUsed)}</td>
        <td>${lastDate}</td>
        <td style="font-size:0.8rem; color:#6a8f6a; max-width:200px;">
          ${notes || '–'}
        </td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  tableWrap.innerHTML = html;

  // Warnhinweise
  if (notObserved.length > 0) {
    warningsCard.classList.remove('hidden');
    warningList.innerHTML = notObserved
      .map(s => `<li>👤 ${s.name} <span style="color:#6a8f6a;">(Klasse ${s.className})</span></li>`)
      .join('');
  } else {
    warningsCard.classList.add('hidden');
  }
}

// === CSV EXPORT ===
function exportCSV() {
  if (beobachtungen.length === 0) {
    alert('Noch keine Beobachtungen vorhanden.');
    return;
  }

  const header = [
    'Datum', 'Klasse', 'Name', 'Stunde', 'Skala',
    ...criteria.map(c => c.text),
    'Notizen'
  ];

  const rows = beobachtungen.map(b => {
    const cls = classes.find(c => c.id === b.classId);
    const className = cls ? cls.name : '–';
    const criteriaValues = criteria.map(c =>
      b.ratings[c.id] !== undefined ? b.ratings[c.id] : ''
    );
    const notes = b.ratings.notes ? b.ratings.notes.replace(/"/g, '""') : '';

    return [
      new Date(b.date).toLocaleDateString('de-DE'),
      className,
      b.studentName,
      b.lessonLabel || '–',
      b.scale || activeScale,
      ...criteriaValues,
      `"${notes}"`
    ];
  });

  const csv = [header, ...rows]
    .map(row => row.join(';'))
    .join('\n');

  // BOM für korrekte Darstellung in Excel
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ClassObserver_Export_${new Date().toLocaleDateString('de-DE').replace(/\./g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// === JSON BACKUP ===
function exportJSON() {
  const backup = {
    version: 1,
    exportDate: new Date().toISOString(),
    classes,
    stundenplan,
    beobachtungen,
    criteria,
    activeScale,
    obsPeriod
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ClassObserver_Backup_${new Date().toLocaleDateString('de-DE').replace(/\./g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJSON() {
  document.getElementById('import-file').click();
}

function handleImport(event) {
  const file = event.target.files[0];
  const successEl = document.getElementById('import-success');
  const errorEl = document.getElementById('import-error');
  successEl.classList.add('hidden');
  errorEl.classList.add('hidden');

  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const backup = JSON.parse(e.target.result);

      if (!backup.classes || !backup.stundenplan || !backup.beobachtungen) {
        throw new Error('Ungültiges Format');
      }

      if (!confirm('Alle aktuellen Daten werden durch die Sicherung ersetzt. Fortfahren?')) return;

      classes = backup.classes || [];
      stundenplan = backup.stundenplan || [];
      beobachtungen = backup.beobachtungen || [];
      criteria = backup.criteria || criteria;
      activeScale = backup.activeScale || 'pflanze';
      obsPeriod = backup.obsPeriod || 'month';

      saveData();
      saveStundenplan();
      saveBeobachtungen();
      saveCriteria();
      localStorage.setItem('co_scale', activeScale);
      localStorage.setItem('co_obs_period', obsPeriod);

      successEl.classList.remove('hidden');
      renderAuswertung();
    } catch (err) {
      errorEl.classList.remove('hidden');
    }
  };
  reader.readAsText(file);

  // Input zurücksetzen damit dieselbe Datei nochmal geladen werden kann
  event.target.value = '';
}

// === showSection erweitern für Auswertung ===
const originalShowSection4 = showSection;
showSection = function(name) {
  originalShowSection4(name);
  if (name === 'auswertung') {
    updateAuswertClasses();
    renderAuswertung();
  }
};
