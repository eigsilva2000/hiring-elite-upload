require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

const SPREADSHEET_ID = '1tO5CBWVi0zAlowfCyQ7XHQh0qkz4Qx1vgpv42qVTeNs';
const SHEET_NAME = 'Document Audit Folders (HE)';

async function getFirmFolderMap() {
  const sheetsAuth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!B:E`,
  });
  const rows = res.data.values || [];
  const map = {};
  for (const row of rows) {
    const slug = row[1];
    const folderId = row[3];
    if (slug && folderId) {
      map[slug.trim().toLowerCase()] = folderId.trim();
    }
  }
  return map;
}

// Serve frontend per firm
app.get('/upload/:firm', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Generate resumable upload URLs
app.post('/upload/:firm/init', async (req, res) => {
  const firm = req.params.firm.toLowerCase();
  const { files } = req.body;

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files provided.' });
  }

  try {
    const firmMap = await getFirmFolderMap();
    const folderId = firmMap[firm];
    if (!folderId) return res.status(404).json({ error: 'Firm not found.' });

    const accessToken = await (await auth.getClient()).getAccessToken();
    const token = accessToken.token;

    const uploadUrls = [];

    for (const file of files) {
      const metadata = {
        name: file.name,
        parents: [folderId],
      };

      const initRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': file.type,
            'X-Upload-Content-Length': file.size,
          },
          body: JSON.stringify(metadata),
        }
      );

      const uploadUrl = initRes.headers.get('location');
      uploadUrls.push({ name: file.name, uploadUrl });
    }

    res.json({ uploadUrls });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to initialize upload.' });
  }
});

// Confirm upload
app.post('/upload/:firm/confirm', async (req, res) => {
  const firm = req.params.firm.toLowerCase();
  const { fileName } = req.body;

  if (!fileName) {
    return res.status(400).json({ confirmed: false, error: 'Missing fileName.' });
  }

  try {
    const firmMap = await getFirmFolderMap();
    const folderId = firmMap[firm];
    if (!folderId) return res.status(404).json({ confirmed: false, error: 'Firm not found.' });

    const driveClient = google.drive({ version: 'v3', auth });

    const result = await driveClient.files.list({
      q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const found = result.data.files.length > 0;
    res.json({ confirmed: found });
  } catch (err) {
    console.error(err);
    res.status(500).json({ confirmed: false, error: 'Confirmation check failed.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));