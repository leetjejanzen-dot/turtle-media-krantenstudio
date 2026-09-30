const { app, BrowserWindow, dialog, ipcMain, net, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');

let mainWindow;
let pendingUpdate = null;

async function readPublisherConfig() {
  const configPath = app.isPackaged
    ? path.join(process.resourcesPath, 'publisher-config.json')
    : path.join(__dirname, 'publisher-config.json');
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    return {
      githubRepo: typeof parsed.githubRepo === 'string' ? parsed.githubRepo.trim() : '',
      fourthwallProductUrl: typeof parsed.fourthwallProductUrl === 'string' ? parsed.fourthwallProductUrl.trim() : ''
    };
  } catch {
    return { githubRepo: '', fourthwallProductUrl: '' };
  }
}

function githubSlug(input) {
  const match = input.match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : '';
}

function versionParts(input) {
  return String(input).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  return next.some((part, index) => part !== installed[index] && part > installed[index] && next.slice(0, index).every((value, i) => value === installed[i]));
}

function assertGithubUrl(rawUrl) {
  const url = new URL(rawUrl);
  const allowed = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname)) throw new Error('Onveilige update-URL geweigerd');
  return url.toString();
}

async function fetchBuffer(url, maxBytes = 300 * 1024 * 1024) {
  const response = await net.fetch(assertGithubUrl(url), { redirect: 'follow' });
  assertGithubUrl(response.url);
  if (!response.ok) throw new Error(`Download mislukt (${response.status})`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error('Updatebestand is onverwacht groot');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('Updatebestand is onverwacht groot');
  return bytes;
}

function createWindow() {
  const smokeTest = process.argv.includes('--smoke-test');
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#101114',
    icon: path.join(__dirname, 'src', 'assets', 'turtle-media-app-icon.png'),
    show: !smokeTest,
    title: 'Turtle Media Krantenstudio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (smokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(() => {
          localStorage.removeItem('fivem-krantenstudio-autosave');
          document.getElementById('newProject').click();
          const required = ['paperName','headline','article','newspaper','exportPng','exportPdf','exportPngBottom','exportPdfBottom','zoomFit','vLogo','pageTabs','addPage','updateButton'];
          const missing = required.filter(id => !document.getElementById(id));
          const logo = document.getElementById('vLogo');
          const editor = document.querySelector('.editor');
          editor.scrollTop = editor.scrollHeight;
          const initialPageCount = document.querySelectorAll('.page-tab').length;
          document.getElementById('addPage').click();
          return {
            missing,
            name: document.getElementById('paperName').value,
            headline: document.getElementById('vHeadline').textContent,
            logoLoaded: logo.complete && logo.naturalWidth > 0,
            newspaperLayoutWidth: document.getElementById('newspaper').offsetWidth,
            zoom: document.getElementById('zoomLabel').textContent,
            editorScrollable: editor.scrollHeight > editor.clientHeight && editor.scrollTop > 0,
            bottomActionsVisible: document.getElementById('exportPngBottom').getBoundingClientRect().bottom <= innerHeight,
            initialPageCount,
            pageCount: document.querySelectorAll('.page-tab').length,
            activePageNumber: document.getElementById('vPageNumber').textContent
          };
        })()`);
        const image = await mainWindow.webContents.capturePage();
        await fs.mkdir(path.join(__dirname, 'test-output'), { recursive: true });
        await fs.writeFile(path.join(__dirname, 'test-output', 'app-smoke.png'), image.toPNG());
        console.log(JSON.stringify(result));
        if (result.missing.length || result.name !== 'TURTLE MEDIA' || !result.logoLoaded
          || result.newspaperLayoutWidth !== 794 || !result.editorScrollable || !result.bottomActionsVisible
          || result.initialPageCount !== 1 || result.pageCount !== 2 || result.activePageNumber !== '02') process.exitCode = 1;
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('save-project', async (_event, project) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Krantenproject opslaan',
    defaultPath: `${project.slug || 'krant'}.krant.json`,
    filters: [{ name: 'Krantenproject', extensions: ['json'] }]
  });
  if (result.canceled) return { canceled: true };
  await fs.writeFile(result.filePath, JSON.stringify(project, null, 2), 'utf8');
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('load-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Krantenproject openen',
    properties: ['openFile'],
    filters: [{ name: 'Krantenproject', extensions: ['json'] }]
  });
  if (result.canceled) return { canceled: true };
  const project = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
  return { canceled: false, project, path: result.filePaths[0] };
});

ipcMain.handle('save-png', async (_event, payload) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Krant exporteren als PNG',
    defaultPath: `${payload.slug || 'krant'}.png`,
    filters: [{ name: 'PNG-afbeelding', extensions: ['png'] }]
  });
  if (result.canceled) return { canceled: true };
  const data = payload.dataUrl.replace(/^data:image\/png;base64,/, '');
  await fs.writeFile(result.filePath, Buffer.from(data, 'base64'));
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('save-pdf', async (_event, payload) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Krant exporteren als PDF',
    defaultPath: `${payload.slug || 'krant'}.pdf`,
    filters: [{ name: 'PDF-document', extensions: ['pdf'] }]
  });
  if (result.canceled) return { canceled: true };
  if (!Array.isArray(payload.pages) || payload.pages.length < 1 || payload.pages.length > 64) throw new Error('Ongeldig aantal pagina’s');
  const pdf = await PDFDocument.create();
  for (const dataUrl of payload.pages) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('Ongeldige PDF-pagina');
    const image = await pdf.embedPng(Buffer.from(dataUrl.split(',')[1], 'base64'));
    const page = pdf.addPage([595.28, 841.89]);
    page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  await fs.writeFile(result.filePath, await pdf.save());
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('check-updates', async () => {
  pendingUpdate = null;
  const config = await readPublisherConfig();
  const repo = githubSlug(config.githubRepo);
  const base = { currentVersion: app.getVersion(), storeUrl: config.fourthwallProductUrl, configured: !!repo };
  if (!repo) return { ...base, available: false };
  const response = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Turtle-Media-Krantenstudio' }
  });
  if (response.status === 404) return { ...base, available: false };
  if (!response.ok) throw new Error(`Updatecontrole mislukt (${response.status})`);
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/i, '');
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find(asset => /Turtle-Media-Krantenstudio-Setup-.*-x64\.exe$/i.test(asset.name));
  const checksum = installer && assets.find(asset => asset.name === `${installer.name}.sha256`);
  if (!version || !installer || !checksum || !isNewerVersion(version, app.getVersion())) return { ...base, available: false };
  pendingUpdate = {
    version,
    installerName: path.basename(installer.name),
    installerUrl: assertGithubUrl(installer.browser_download_url),
    checksumUrl: assertGithubUrl(checksum.browser_download_url)
  };
  return { ...base, available: true, version, notes: String(release.body || '').slice(0, 1000) };
});

ipcMain.handle('open-store', async () => {
  const { fourthwallProductUrl } = await readPublisherConfig();
  if (!fourthwallProductUrl) return { opened: false };
  const url = new URL(fourthwallProductUrl);
  if (url.protocol !== 'https:') throw new Error('Ongeldige Fourthwall-URL');
  await shell.openExternal(url.toString());
  return { opened: true };
});

ipcMain.handle('install-update', async () => {
  if (!pendingUpdate) throw new Error('Controleer eerst op updates');
  const update = pendingUpdate;
  const [installer, checksumFile] = await Promise.all([
    fetchBuffer(update.installerUrl),
    fetchBuffer(update.checksumUrl, 4096)
  ]);
  const expected = checksumFile.toString('utf8').match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  const actual = crypto.createHash('sha256').update(installer).digest('hex');
  if (!expected || actual !== expected) throw new Error('Updatecontrole mislukt: checksum klopt niet');
  const updateDir = path.join(app.getPath('temp'), 'TurtleMediaKrantenstudio');
  await fs.mkdir(updateDir, { recursive: true });
  const installerPath = path.join(updateDir, update.installerName);
  await fs.writeFile(installerPath, installer);
  spawn(installerPath, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  setTimeout(() => app.quit(), 500);
  return { started: true };
});
