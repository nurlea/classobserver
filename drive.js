// === GOOGLE DRIVE INTEGRATION ===

const CLIENT_ID = '414031848105-oiudvqvhh1n93h68jsrs2885v0esdfj6.apps.googleusercontent.com';
const API_KEY = null; // Nicht benötigt für Drive-Zugriff auf eigene Dateien
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
const BACKUP_FILENAME = 'classobserver_backup.json';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let driveFileId = null;
let isSyncing = false;

// === INITIALISIERUNG ===

// Wird aufgerufen wenn gapi geladen ist
function gapiLoaded() {
  gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
  await gapi.client.init({
    discoveryDocs: [
      'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'
    ],
  });
  gapiInited = true;
  maybeEnableSync();
}

// Wird aufgerufen wenn Google Identity Services geladen ist
function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (response) => {
      if (response.error) {
        setSyncStatus('❌ Verbindung fehlgeschlagen', 'red');
        return;
      }
      // Erfolgreich eingeloggt
      localStorage.setItem('co_google_connected', '1');
      setSyncStatus('✅ Verbunden mit Google Drive', 'green');
      document.getElementById('btn-login').style.display = 'none';
      document.getElementById('btn-logout').style.display = 'inline-block';
      await loadFromDrive();
    },
  });
  gisInited = true;
  maybeEnableSync();
}

function maybeEnableSync() {
  if (gapiInited && gisInited) {
    // Automatisch verbinden wenn vorher schon verbunden war
    if (localStorage.getItem('co_google_connected') === '1') {
      tokenClient.requestAccessToken({ prompt: '' });
    }
  }
}

// === ANMELDEN / ABMELDEN ===

function googleSignIn() {
  if (!gapiInited || !gisInited) {
    setSyncStatus('⏳ Bitte kurz warten…', 'gray');
    setTimeout(googleSignIn, 1000);
    return;
  }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function googleSignOut() {
  const token = gapi.client.getToken();
  if (token) {
    google.accounts.oauth2.revoke(token.access_token);
    gapi.client.setToken('');
  }
  localStorage.removeItem('co_google_connected');
  driveFileId = null;
  setSyncStatus('☁️ Nicht verbunden', 'gray');
  document.getElementById('btn-login').style.display = 'inline-block';
  document.getElementById('btn-logout').style.display = 'none';
  document.getElementById('sync-last').textContent = '';
}

// === DRIVE: DATEI FINDEN ODER ERSTELLEN ===

async function getOrCreateDriveFile() {
  // Erst suchen ob Datei schon existiert
  const searchResponse = await gapi.client.drive.files.list({
    spaces: 'appDataFolder',
    fields: 'files(id, name)',
    q: `name = '${BACKUP_FILENAME}'`,
  });

  const files = searchResponse.result.files;

  if (files && files.length > 0) {
    driveFileId = files[0].id;
    return driveFileId;
  }

  // Datei neu erstellen
  const createResponse = await gapi.client.drive.files.create({
    resource: {
      name: BACKUP_FILENAME,
      parents: ['appDataFolder'],
    },
    fields: 'id',
  });

  driveFileId = createResponse.result.id;
  return driveFileId;
}

// === SPEICHERN AUF DRIVE ===

async function saveToDrive() {
  if (isSyncing) return;
  if (!gapi.client.getToken()) return; // Nicht eingeloggt

  isSyncing = true;
  setSyncStatus('🔄 Wird gespeichert…', 'gray');

  try {
    const fileId = await getOrCreateDriveFile();

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

    // Dateiinhalt aktualisieren via multipart upload
    await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${gapi.client.getToken().access_token}`,
          'Content-Type': 'application/json',
        },
        body: content,
      }
    );

    const now = new Date().toLocaleTimeString('de-DE', {
      hour: '2-digit', minute: '2-digit'
    });
    setSyncStatus('✅ Gespeichert in Google Drive', 'green');
    document.getElementById('sync-last').textContent = `Zuletzt: ${now} Uhr`;

  } catch (err) {
    console.error('Drive-Fehler beim Speichern:', err);
    setSyncStatus('⚠️ Speichern fehlgeschlagen', 'red');
  }

  isSyncing = false;
}

// === LADEN VON DRIVE ===

async function loadFromDrive() {
  setSyncStatus('🔄 Lade Daten aus Google Drive…', 'gray');

  try {
    const fileId = await getOrCreateDriveFile();

    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: {
          'Authorization': `Bearer ${gapi.client.getToken().access_token}`,
        },
      }
    );

    if (!response.ok) throw new Error('Datei leer oder nicht lesbar');

    const text = await response.text();
    if (!text || text.trim() === '') {
      setSyncStatus('✅ Verbunden – noch keine Daten in Drive', 'green');
      return;
    }

    const backup = JSON.parse(text);

    if (!backup.classes) throw new Error('Ungültiges Format');

    // Nur laden wenn Drive-Daten neuer sind
    const driveDate = new Date(backup.exportDate);
    const localDate = localStorage.getItem('co_last_save')
      ? new Date(localStorage.getItem('co_last_save'))
      : new Date(0);

    if (driveDate > localDate) {
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

      // UI aktualisieren
      renderClasses();
      renderAuswertung();

      setSyncStatus('✅ Daten aus Google Drive geladen', 'green');
    } else {
      setSyncStatus('✅ Verbunden mit Google Drive', 'green');
    }

  } catch (err) {
    if (err.message === 'Datei leer oder nicht lesbar') {
      setSyncStatus('✅ Verbunden – noch keine Daten in Drive', 'green');
    } else {
      console.error('Drive-Fehler beim Laden:', err);
      setSyncStatus('⚠️ Laden fehlgeschlagen', 'red');
    }
  }
}

// === HILFSFUNKTIONEN ===

function setSyncStatus(text, color) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = color === 'green'
    ? '#2e7d32' : color === 'red'
    ? '#c62828' : '#757575';
}

// Automatisches Speichern nach jeder Datenänderung
// Diese Funktion in alle saveData()-Aufrufe einbinden
function autoSaveToDrive() {
  localStorage.setItem('co_last_save', new Date().toISOString());
  // Kurze Verzögerung damit UI-Updates zuerst fertig werden
  setTimeout(saveToDrive, 800);
}
