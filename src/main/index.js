import { app, shell, BrowserWindow, ipcMain, session, screen, globalShortcut } from 'electron'
import path, { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import axios from 'axios'
import FormData from 'form-data'
import AdmZip from 'adm-zip'
import fs from 'fs'
import tmp from 'tmp'
import log from 'electron-log'
import os from 'os'

log.transports.file.level = 'info'
autoUpdater.logger = log
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

// ─────────────────────────────────────────────────────────────
// BACKEND URL — hardcoded. dotenv does NOT work in packaged
// Electron apps (.env is never bundled into the .asar).
// ─────────────────────────────────────────────────────────────
const BACKEND = 'http://139.59.86.143:3000'

// ─────────────────────────────────────────────────────────────
// SESSION CHECK SETTINGS
// 3 consecutive failures needed before logout (not just 1)
// so a single network blip never kicks a user out.
// 60s interval = 8 req/min for 8 users instead of 16 req/min.
// ─────────────────────────────────────────────────────────────
const FAILURES_BEFORE_LOGOUT = 3
const SESSION_CHECK_INTERVAL_MS = 60000
const REQUEST_TIMEOUT_MS = 15000

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getDeviceInfo() {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus().map((cpu) => cpu.model),
    totalMemory: (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
    freeMemory: (os.freemem() / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
    hostname: os.hostname(),
    uptime: (os.uptime() / 3600).toFixed(2) + ' hours'
  }
}

const loginHandlers = new Map()

app.on('login', (event, webContents, request, authInfo, callback) => {
  const { host } = authInfo
  // console.log(`[AUTH] Proxy login request for host: ${host}`)
  if (loginHandlers.has(host)) {
    const { username, password } = loginHandlers.get(host)
    // console.log(`[AUTH] Providing credentials for ${host}`)
    callback(username, password)
    // CRITICAL: We do NOT delete the handler here. 
    // Proxies often require authentication multiple times as different resources load.
    event.preventDefault()
  } else {
    // console.log(`[AUTH] No credentials found for ${host}`)
    event.preventDefault()
  }
})

async function uploadZipFile(datSessionId, folderPath) {
  const tempZipFile = tmp.fileSync({ postfix: '.zip' })
  const zip = new AdmZip()

  function addFolderSafe(currentPath, zipPath = '') {
    if (!fs.existsSync(currentPath)) return;
    try {
      const items = fs.readdirSync(currentPath);
      for (const item of items) {
        const fullPath = path.join(currentPath, item);
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            addFolderSafe(fullPath, zipPath ? `${zipPath}/${item}` : item);
          } else {
            zip.addLocalFile(fullPath, zipPath);
          }
        } catch (err) {
          console.log(`Skipping locked file/folder: ${fullPath}`);
        }
      }
    } catch (err) {
      console.log(`Skipping folder: ${currentPath} - ${err.message}`);
    }
  }

  addFolderSafe(folderPath);

  zip.writeZip(tempZipFile.name)
  const form = new FormData()
  form.append('file', fs.createReadStream(tempZipFile.name))
  const user = store.get('user')
  await axios.post(`${BACKEND}/file/upload/${datSessionId}`, form, {
    headers: { ...form.getHeaders(), Authorization: user.token },
    maxBodyLength: Infinity,
    timeout: 120000
  })
  tempZipFile.removeCallback()
  console.log('Temporary zip file deleted.')
}

async function downloadAndUnzipFile(fileName, destinationPath) {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'get',
      url: `${BACKEND}/file/download/${fileName}`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      responseType: 'arraybuffer',
      maxBodyLength: Infinity,
      timeout: 120000,
      onDownloadProgress: (progressEvent) => {
        // Guard mainWindow — it can be null during startup
        if (mainWindow && !mainWindow.isDestroyed()) {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          mainWindow.webContents.send('on-downloading-file', percentCompleted)
          console.log(`Download progress: ${percentCompleted}%`)
        }
      }
    })
    const tempZipFile = tmp.fileSync({ postfix: '.zip' })
    fs.writeFileSync(tempZipFile.name, response.data)
    if (!fs.existsSync(destinationPath)) {
      fs.mkdirSync(destinationPath, { recursive: true })
    }
    const zip = new AdmZip(tempZipFile.name)
    zip.extractAllTo(destinationPath, true)
    tempZipFile.removeCallback()
    console.log('Temporary zip file deleted.')
    store.set('currentFileName', fileName)
  } catch (error) {
    console.error('Error downloading or unzipping file:', error)
  }
}

let newWindows = []   // track popup windows opened from userWindow
let mainWindow
let proxyWindow
let userWindow
let intervalId
let store

// ─────────────────────────────────────────────────────────────
// Only compare meaningful fields — NOT isOnline/timestamps.
// isOnline changes on every check-session call and must never
// trigger a logout.
// ─────────────────────────────────────────────────────────────
function userDataChanged(stored, fresh) {
  if (!stored || !fresh) return true
  const relevantKeys = ['id', 'role', 'isBanned', 'token']
  for (const key of relevantKeys) {
    if (String(stored[key]) !== String(fresh[key])) {
      console.log(`[MISMATCH] key: ${key}, stored: ${stored[key]}, fresh: ${fresh[key]}`)
      return true
    }
  }
  const sp = stored.permission || {}
  const fp = fresh.permission || {}
  const permKeys = [
    'dashboard', 'searchTrucks', 'privateLoads', 'myLoads', 'privateNetwork',
    'myTrucks', 'liveSupport', 'tools', 'sendFeedback', 'notifications',
    'profile', 'searchLoadsMultitab', 'searchLoadsNoMultitab',
    'searchLoadsLaneRate', 'searchLoadsViewRoute', 'searchLoadsRateview',
    'searchLoadsViewDirectory', 'dataSessionId', 'domain'
  ]
  for (const key of permKeys) {
    if (String(sp[key]) !== String(fp[key])) {
      console.log(`[MISMATCH] permission key: ${key}, stored: ${sp[key]}, fresh: ${fp[key]}`)
      return true
    }
  }
  return false
}

// ─────────────────────────────────────────────────────────────
// PROXY WINDOW (admin session upload)
// ─────────────────────────────────────────────────────────────
async function createProxyWindow({ proxyUrl, partitionName, datSessionId }) {
  // Sanitize proxy string: remove http:// or https:// if user pasted them
  let proxyStr = (proxyUrl || '').trim()
  proxyStr = proxyStr.replace(/^https?:\/\//, '')

  const [host, port, username, password] = proxyStr.split(':')
  const newSession = session.fromPartition(partitionName)

  try {
    if (host && port) {
      console.log(`[PROXY] Setting proxy rules: http://${host}:${port}`)
      await newSession.setProxy({ proxyRules: `http://${host}:${port}` })
    } else {
      console.log(`[PROXY] No valid host/port found, clearing proxy rules.`)
      await newSession.setProxy({ proxyRules: '' })
    }
  } catch (error) {
    console.error('[PROXY] Error setting proxy:', error)
  }

  if (host) {
    loginHandlers.set(host, { username, password })
    // If the host is an IP, also set it without port just in case authInfo omits it
    if (host.includes(':')) loginHandlers.set(host.split(':')[0], { username, password })
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  proxyWindow = new BrowserWindow({
    width, height,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      webgl: false,
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      preload: join(__dirname, '../preload/index.js'),
      partition: partitionName,
      sandbox: false
    }
  })

  // proxyWindow.webContents.setUserAgent(
  //   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
  // )
  proxyWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  )

  proxyWindow.on('ready-to-show', () => proxyWindow.show())

  proxyWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[LOAD ERROR] Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`)
  })

  proxyWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Try loading a simple page first if DAT is blank, or just stick to DAT
  console.log(`[NAVIGATE] Loading URL: https://one.dat.com`)
  proxyWindow.loadURL('https://one.dat.com')

  proxyWindow.webContents.on('devtools-opened', () => proxyWindow.webContents.closeDevTools())
  proxyWindow.webContents.on('before-input-event', (event, input) => {
    if (
      (input.control && input.shift && input.key.toLowerCase() === 'i') ||
      input.key.toLowerCase() === 'f12' ||
      (input.control && input.shift && input.key.toLowerCase() === 'j')
    ) event.preventDefault()
  })

  proxyWindow.webContents.on('will-navigate', async (event, navigationUrl) => {
    console.log(navigationUrl)
    try {
      const parsedUrl = new URL(navigationUrl)
      if (parsedUrl.hostname !== 'login.dat.com') {
        const user = store.get('user')
        if (user && user.token) {
          await axios.request({
            method: 'put', maxBodyLength: Infinity,
            url: `${BACKEND}/session/${datSessionId}`,
            headers: { 'Content-Type': 'application/json', Authorization: user.token },
            data: JSON.stringify({ isLoggedIn: true }),
            timeout: REQUEST_TIMEOUT_MS
          })
        }
      }
    } catch (e) {
      console.error('Error updating session state on navigate:', e.message)
    }
  })

  proxyWindow.on('close', () => { proxyWindow = null })
  return proxyWindow
}

// ─────────────────────────────────────────────────────────────
// USER WINDOW — NO TABS VERSION
// Uses loadURL(domain) directly, exactly like the old code.
// No tabShell.html, no webview, no + button.
// Popup windows (window.open) still open in a new BrowserWindow
// using setWindowOpenHandler, same as the old reference code.
// ─────────────────────────────────────────────────────────────
async function createUserWindow({ proxyUrl, partitionName, permissions, fileName, datSessionId, domain }) {

  // Download session data if needed
  const currentFileName = store.get('currentFileName')
  if (currentFileName !== fileName && datSessionId && fileName) {
    const userDataPath = app.getPath('userData')
    const destinationPath = path.join(userDataPath, 'Partitions', partitionName.split(':')[1])
    await downloadAndUnzipFile(fileName, destinationPath)
  }

  let proxyStr = (proxyUrl || '').trim()
  proxyStr = proxyStr.replace(/^https?:\/\//, '')
  const [host, port, username, password] = proxyStr.split(':')

  const newSession = session.fromPartition(partitionName)
  try {
    if (host && port) {
      console.log(`[USER PROXY] Setting proxy rules: http://${host}:${port}`)
      await newSession.setProxy({ proxyRules: `http://${host}:${port}` })
    } else {
      console.log(`[USER PROXY] No valid host/port found, clearing proxy rules.`)
      await newSession.setProxy({ proxyRules: '' })
    }
  } catch (error) {
    console.error('[USER PROXY] Error setting proxy:', error)
  }

  if (host) {
    loginHandlers.set(host, { username, password })
    // If the host is an IP, also set it without port just in case authInfo omits it
    if (host.includes(':')) loginHandlers.set(host.split(':')[0], { username, password })
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  // Standard BrowserWindow — no nodeIntegration needed since we
  // are not loading a local HTML file that uses require('electron')
  userWindow = new BrowserWindow({
    width, height,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      webgl: false,
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      preload: join(__dirname, '../preload/index.js'),
      partition: partitionName,
      sandbox: false,
      // Explicitly allow WebAuthn (Passkeys) for modern site compatibility
      webauthn: true
    }
  })

  // Block DevTools
  userWindow.webContents.on('devtools-opened', () => userWindow.webContents.closeDevTools())
  userWindow.webContents.on('before-input-event', (event, input) => {
    if (
      (input.control && input.shift && input.key.toLowerCase() === 'i') ||
      input.key.toLowerCase() === 'f12' ||
      (input.control && input.shift && input.key.toLowerCase() === 'j')
    ) event.preventDefault()
  })

  userWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.log(`[USER LOAD ERROR] Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`)
    if (errorDescription.includes('ERR_PROXY_CONNECTION_FAILED')) {
      console.log('Proxy connection failed!')
    }
    if (errorCode === -10 || errorDescription.includes('ERR_TOO_MANY_RETRIES')) {
      console.log('Infinite redirect loop detected! This usually means your DAT session is expired or the proxy is blocking the authentication.')
    }
  })

  userWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  )

  userWindow.on('ready-to-show', () => {
    userWindow.show()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  })

  // Load the DAT domain directly — no tab shell
  userWindow.loadURL(domain)

  // ── BUILD CSS from permissions ──
  let css = `
    body { visibility: visible !important; opacity: 1 !important; }
    .details.dropdown-menu hr ~ * { display: none !important; }
    .details.dropdown-menu hr { display: none !important; }
    .searchLoads nav { display: none !important; }
    .app-message-box { display: none !important; }
    .stn-wdgt, .stn-wdgt-content { display: none !important; }
    .nav-logo-clickable { pointer-events: none !important; cursor: not-allowed !important; }
  `
  if (!permissions.dashboard)
    css += `a[href="/dashboard"] { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }`
  if (!permissions.searchTrucks)
    css += `a[href="/search-trucks-ow"] { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }`
  if (!permissions.privateLoads)
    css += `a[href="/private-loads"] { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }`
  if (!permissions.myLoads)
    css += `a[href="/my-loads/list/carrier"] { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }`
  if (!permissions.privateNetwork)
    css += `a[href="/private-network"] { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }`
  if (!permissions.myTrucks)
    css += `a[href="/my-trucks"] { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }`
  if (!permissions.liveSupport)
    css += `.link-chat { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }`
  if (!permissions.tools)
    css += `a[href="/tools"] { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }`
  if (!permissions.sendFeedback)
    css += `.nav-feedback { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; display: none !important; }`
  if (!permissions.notifications)
    css += `.nav-notification-inbox { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; display: none !important; }`
  if (!permissions.profile)
    css += `.mat-expansion-panel:not([class*=mat-elevation-z]) { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; display: none !important; }`
  if (!permissions.searchLoadsLaneRate)
    css += `
      .lane-rates { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }
      .trihaul { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }
      .external-links > :nth-child(3) { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; }
    `
  if (!permissions.searchLoadsViewRoute)
    css += `.details-subheader-route { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; display: none !important; }`
  if (!permissions.searchLoadsRateview)
    css += `.rateview-link { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; display: none !important; }`
  if (!permissions.searchLoadsViewDirectory)
    css += `
      .directory { pointer-events: none !important; opacity: 0.5 !important; cursor: not-allowed !important; display: none !important; }
      mat-icon[data-mat-icon-name="chevron-up"][data-mat-icon-namespace="app"] { display: none !important; }
    `
  // Multitab limits — same logic as old code
  if (permissions.searchLoadsMultitab) {
    css += `
      .mat-tab-labels > div:nth-child(${permissions.searchLoadsNoMultitab + 1}) .add-button { display: none !important; }
      .mat-tab-labels > div:nth-child(n+${permissions.searchLoadsNoMultitab + 1}):nth-child(-n+10):not(:last-child) { display: none !important; }
    `
  } else {
    css += `
      .mat-tab-labels .add-button { display: none !important; }
      .mat-tab-labels > div:nth-child(n+2):nth-child(-n+10) { display: none !important; }
    `
  }

  // ── INJECT CSS on every page load ──
  if (datSessionId) {
    userWindow.webContents.on('page-title-updated', () => {
      if (userWindow && !userWindow.isDestroyed()) {
        userWindow.webContents.insertCSS(css)
      }
    })
    userWindow.webContents.on('did-finish-load', () => {
      if (userWindow && !userWindow.isDestroyed()) {
        userWindow.webContents.insertCSS(css)
        // Re-enable the add-button inside DAT's own tab bar
        userWindow.webContents.executeJavaScript(`
          const interval = setInterval(() => {
            const button = document.querySelector('.add-button');
            if (button) {
              button.removeAttribute('disabled');
              button.classList.remove('mat-button-disabled');
            }
          }, 100);

          const intervalSearch = setInterval(() => {
            const searchTitle = document.querySelector('.search-button__title');
            if (searchTitle) {
              const searchButton = searchTitle.closest('button');
              if (searchButton && !searchButton.disabled) {
                searchButton.click();
              }
            }
          }, 30000);
        `)
      }
    })
  }

  // ── POPUP WINDOWS (window.open from DAT) ──
  // Exactly like the old reference code — opens a new BrowserWindow
  // with the same partition and CSS injected.
  userWindow.webContents.setWindowOpenHandler((details) => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize

    const newWindow = new BrowserWindow({
      width, height,
      autoHideMenuBar: true,
      webPreferences: {
        webgl: false,
        contextIsolation: true,
        nodeIntegration: false,
        enableRemoteModule: false,
        preload: join(__dirname, '../preload/index.js'),
        partition: partitionName,
        sandbox: false
      }
    })

    newWindow.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    )
    newWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    newWindow.webContents.on('devtools-opened', () => newWindow.webContents.closeDevTools())
    newWindow.webContents.on('before-input-event', (event, input) => {
      if (
        (input.control && input.shift && input.key.toLowerCase() === 'i') ||
        input.key.toLowerCase() === 'f12' ||
        (input.control && input.shift && input.key.toLowerCase() === 'j')
      ) event.preventDefault()
    })

    // CSS for popup windows — hide sidebar and header like old code
    const popupCSS = `
      .mat-drawer-side { display: none !important; }
      .mat-drawer-content { margin-left: 0px !important; }
      dat-header.ng-trigger { display: none !important; }
      mat-toolbar.beta-banner { display: none !important; }
    `
    newWindow.webContents.on('page-title-updated', () => newWindow.webContents.insertCSS(popupCSS))
    newWindow.webContents.on('did-finish-load', () => newWindow.webContents.insertCSS(popupCSS))

    newWindow.loadURL(details.url)
    newWindows.push(newWindow)

    newWindow.on('closed', () => {
      const idx = newWindows.indexOf(newWindow)
      if (idx > -1) newWindows.splice(idx, 1)
    })

    return { action: 'deny' }
  })

  // ── SESSION KEEP-ALIVE ping every 2 minutes on navigation ──
  let lastRequestTime = 0
  userWindow.webContents.on('did-start-navigation', async (event, url) => {
    try {
      const parsedUrl = new URL(url)
      if (datSessionId && parsedUrl.hostname !== 'login.dat.com') {
        const currentTime = Date.now()
        if (currentTime - lastRequestTime >= 120000) {
          lastRequestTime = currentTime
          const user = store.get('user')
          if (user && user.token) {
            await axios.request({
              method: 'put', maxBodyLength: Infinity,
              url: `${BACKEND}/session/${datSessionId}`,
              headers: { 'Content-Type': 'application/json', Authorization: user.token },
              data: JSON.stringify({ isLoggedIn: true }),
              timeout: REQUEST_TIMEOUT_MS
            })
          }
        }
      }
    } catch (e) { /* ignore */ }
  })

  // ── DAT SESSION LOGOUT DETECTION ──
  // If DAT redirects to login.dat.com, the session has expired on DAT's side.
  // Show maintenance mode and close the window.
  userWindow.webContents.on('will-navigate', async (event, navigationUrl) => {
    try {
      const parsedUrl = new URL(navigationUrl)
      if (datSessionId && parsedUrl.hostname === 'login.dat.com') {
        event.preventDefault()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('maintenance-mode', true)
        }
        userWindow.close()
        const user = store.get('user')
        if (user && user.token) {
          await axios.request({
            method: 'put', maxBodyLength: Infinity,
            url: `${BACKEND}/session/${datSessionId}`,
            headers: { 'Content-Type': 'application/json', Authorization: user.token },
            data: JSON.stringify({ isLoggedIn: false }),
            timeout: REQUEST_TIMEOUT_MS
          })
        }
      }
    } catch (e) {
      console.error('Error on will-navigate:', e.message)
    }
  })

  // ── SESSION VALIDITY CHECK every 60s ──
  // Uses failure counter so one network blip never logs the user out.
  // Random jitter spreads requests from all 8 computers across time.
  let consecutiveFailures = 0
  const jitter = Math.floor(Math.random() * 15000)
  await delay(jitter)

  intervalId = setInterval(async () => {
    try {
      const user = store.get('user')
      if (!user || !user.token) return

      const response = await axios.request({
        method: 'post', maxBodyLength: Infinity,
        url: `${BACKEND}/auth/check-session`,
        headers: { 'Content-Type': 'application/json', Authorization: user.token },
        timeout: REQUEST_TIMEOUT_MS
      })

      consecutiveFailures = 0  // reset on success

      if (userDataChanged(user, response.data)) {
        console.log('User data changed — logging out.')
        forceLogout('User data mismatch (Role/Permission/Ban status change)')
      }
    } catch (error) {
      consecutiveFailures++
      console.error(`Session check failed (${consecutiveFailures}/${FAILURES_BEFORE_LOGOUT}):`, error.message)

      const is401 = error.response && error.response.status === 401
      if (is401) {
        console.log('Server returned 401 — logging out immediately.')
        forceLogout('Server returned 401 (Unauthorized/Session Expired)')
      } else if (consecutiveFailures >= FAILURES_BEFORE_LOGOUT) {
        console.log(`${FAILURES_BEFORE_LOGOUT} consecutive failures — logging out.`)
        forceLogout(`Network connectivity issues (${FAILURES_BEFORE_LOGOUT} consecutive failures)`)
      }
      // else: transient error, stay logged in and retry next interval
    }
  }, SESSION_CHECK_INTERVAL_MS)

  async function forceLogout(reason = 'Unknown') {
    clearInterval(intervalId)
    const user = store.get('user')
    if (user && user.token) {
      try {
        await axios.post(`${BACKEND}/activity-log`, {
          category: 'AUTH',
          actionType: 'FORCEFUL_LOGOUT',
          actionLabel: 'Forceful Logout Detected',
          resourceType: 'SESSION',
          resourceLabel: `Session for ${user.email}`,
          details: reason,
          source: 'Electron Client',
          deviceInfo: getDeviceInfo()
        }, {
          headers: { Authorization: user.token },
          timeout: 5000
        })
      } catch (e) {
        console.error('Failed to send forceful logout log to server:', e.message)
      }
    }
    store.set('user', null)
    if (userWindow && !userWindow.isDestroyed()) userWindow.close()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null)
  }

  // ── WINDOW CLOSE cleanup ──
  // Do NOT clear user store here — only forceLogout() above does that.
  // Closing the window normally returns the user to the login screen
  // still authenticated so they can reopen the session.
  userWindow.on('closed', async () => {
    // Close any popup windows that were opened from this session
    newWindows.forEach((win) => {
      try { if (!win.isDestroyed()) win.close() } catch (e) { }
    })
    newWindows.length = 0
    userWindow = null
    clearInterval(intervalId)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })

  return userWindow
}

// ─────────────────────────────────────────────────────────────
// MAIN (LOGIN) WINDOW
// ─────────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width, height,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      partition: 'persist:main',
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    if (proxyWindow && !proxyWindow.isDestroyed()) { proxyWindow.close(); proxyWindow = null }
    if (process.platform !== 'darwin') app.quit()
  })
}

// ─────────────────────────────────────────────────────────────
// AUTO UPDATER INITIALIZATION
// ─────────────────────────────────────────────────────────────
// Feed URL is now handled by electron-builder.yml (github provider)

// ─────────────────────────────────────────────────────────────
// APP READY
// ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const { default: Store } = await import('electron-store')
  store = new Store()

  ipcMain.handle('electron-store-get', (event, key) => store.get(key) ?? null)
  ipcMain.handle('electron-store-set', (event, key, value) => store.set(key, value))

  electronApp.setAppUserModelId('com.dat.one')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // createWindow FIRST — autoUpdater needs mainWindow to exist
  createWindow()

  if (app.isPackaged) {
    autoUpdater.checkForUpdates()
    // Re-check every 4 hours
    setInterval(() => {
      autoUpdater.checkForUpdates()
    }, 4 * 60 * 60 * 1000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  globalShortcut.register('Control+=', () => {
    const w = BrowserWindow.getFocusedWindow()
    if (w) w.webContents.setZoomLevel(w.webContents.getZoomLevel() + 0.5)
  })
  globalShortcut.register('Control+-', () => {
    const w = BrowserWindow.getFocusedWindow()
    if (w) w.webContents.setZoomLevel(w.webContents.getZoomLevel() - 0.5)
  })
  globalShortcut.register('Control+0', () => {
    const w = BrowserWindow.getFocusedWindow()
    if (w) w.webContents.setZoomLevel(0)
  })
})

// ─────────────────────────────────────────────────────────────
// AUTO UPDATER EVENTS
// ─────────────────────────────────────────────────────────────
autoUpdater.on('checking-for-update', () => {
  log.info('Checking for update...')
})

autoUpdater.on('update-available', (info) => {
  log.info(`Update available: ${info.version}`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-available', { version: info.version })
  }
})

autoUpdater.on('update-not-available', (info) => {
  log.info(`Update not available: ${info?.version}`)
})

autoUpdater.on('download-progress', (progressObj) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-progress', {
      percent: progressObj.percent,
      transferred: progressObj.transferred,
      total: progressObj.total
    })
  }
})

autoUpdater.on('update-downloaded', (info) => {
  log.info(`Update downloaded: ${info.version}`)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-downloaded', { version: info.version })
  }
})

autoUpdater.on('error', (err) => {
  log.error('Error in auto-updater: ', err)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-error', err.message)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─────────────────────────────────────────────────────────────
// IPC HANDLERS
// ─────────────────────────────────────────────────────────────
ipcMain.handle('start-update', () => {
  autoUpdater.downloadUpdate()
})

ipcMain.handle('restart-and-install', () => {
  autoUpdater.quitAndInstall()
})

ipcMain.handle('login', async (event, arg) => {
  try {
    const response = await axios.request({
      method: 'post', maxBodyLength: Infinity,
      url: `${BACKEND}/auth/login`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(arg),
      timeout: REQUEST_TIMEOUT_MS
    })
    store.set('user', response.data)
    return response.data
  } catch (error) {
    if (error.response) return error.response.data
    else console.error('Error:', error)
  }
})

ipcMain.handle('logout-activity', async (event, arg) => {
  try {
    const user = store.get('user')
    if (user && user.token) {
      await axios.post(
        `${BACKEND}/activity-log`,
        {
          category: 'AUTH',
          actionType: 'LOGOUT',
          actionLabel: 'User Logged Out',
          resourceType: 'SESSION',
          resourceLabel: `Session for ${user.email}`,
          details: 'Manual Logout',
          source: 'Electron Client',
          deviceInfo: getDeviceInfo()
        },
        {
          headers: { Authorization: user.token },
          timeout: 5000
        }
      )
    }
  } catch (e) {
    console.error('Failed to send logout log:', e.message)
  }
})

ipcMain.handle('getAllUsers', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'get', maxBodyLength: Infinity,
      url: `${BACKEND}/user`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('create-user', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'post', maxBodyLength: Infinity,
      url: `${BACKEND}/user`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      data: JSON.stringify(arg),
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('update-user', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'put', maxBodyLength: Infinity,
      url: `${BACKEND}/user/${arg._id}`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      data: JSON.stringify(arg),
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    }
    console.error('Error:', error)
  }
})

ipcMain.handle('delete-user', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'delete', maxBodyLength: Infinity,
      url: `${BACKEND}/user/${arg.userId}`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('getAllDatAccounts', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'get', maxBodyLength: Infinity,
      url: `${BACKEND}/session`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('create-datSession', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'post', maxBodyLength: Infinity,
      url: `${BACKEND}/session`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      data: JSON.stringify(arg),
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('update-datSession', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'put', maxBodyLength: Infinity,
      url: `${BACKEND}/session/${arg._id}`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      data: JSON.stringify(arg),
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    }
    console.error('Error:', error)
  }
})

ipcMain.handle('delete-datSession', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'delete', maxBodyLength: Infinity,
      url: `${BACKEND}/session/${arg.datSessionId}`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('getAllDomains', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'get', maxBodyLength: Infinity,
      url: `${BACKEND}/domain`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('create-domain', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'post', maxBodyLength: Infinity,
      url: `${BACKEND}/domain`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      data: JSON.stringify(arg),
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('update-domain', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'put', maxBodyLength: Infinity,
      url: `${BACKEND}/domain/${arg._id}`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      data: JSON.stringify(arg),
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    }
    console.error('Error:', error)
  }
})

ipcMain.handle('delete-domain', async (event, arg) => {
  try {
    const user = store.get('user')
    const response = await axios.request({
      method: 'delete', maxBodyLength: Infinity,
      url: `${BACKEND}/domain/${arg.domainId}`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      timeout: REQUEST_TIMEOUT_MS
    })
    return response.data
  } catch (error) {
    if (error.response) {
      if (error.response.status === 401) { store.set('user', null); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('check-session', null) }
      else return error.response.data
    } else console.error('Error:', error)
  }
})

ipcMain.handle('open-dat-session', async (event, arg) => {
  try {
    createProxyWindow({
      proxyUrl: arg.proxy,
      partitionName: 'persist:' + arg.name,
      datSessionId: arg.datSessionId
    })
  } catch (error) { console.error('Error:', error) }
})

ipcMain.handle('save-dat-session', async (event, arg) => {
  try {
    const userDataPath = app.getPath('userData')
    const partitionsPath = path.join(userDataPath, 'Partitions', arg.name)
    await uploadZipFile(arg.datSessionId, partitionsPath)
    return { status: 'success', message: 'Session successfully Uploaded.' }
  } catch (error) {
    console.error('Error:', error)
    return { status: 'error', message: error.message }
  }
})

ipcMain.handle('clear-dat-session', async (event, arg) => {
  try {
    const userDataPath = app.getPath('userData')
    const partitionsPath = path.join(userDataPath, 'Partitions', arg.name)
    fs.rmSync(partitionsPath, { recursive: true, force: true })
    const user = store.get('user')
    const response = await axios.request({
      method: 'post', maxBodyLength: Infinity,
      url: `${BACKEND}/file/delete/${arg.datSessionId}`,
      headers: { 'Content-Type': 'application/json', Authorization: user.token },
      timeout: REQUEST_TIMEOUT_MS
    })
    return { status: 'success', ...response.data }
  } catch (error) {
    console.log('Error:', error.message)
    return { status: 'error', message: error.message }
  }
})

ipcMain.handle('open-dat-user-session', async (event, arg) => {
  try {
    await delay(5000)
    const user = store.get('user')
    if (user) {
      createUserWindow({
        proxyUrl: arg.proxy,
        partitionName: 'persist:' + arg.name,
        permissions: arg.permissions,
        fileName: arg.fileName,
        datSessionId: arg.datSessionId,
        domain: arg.domain
      })
    }
  } catch (error) { console.error('Error:', error) }
})

ipcMain.handle('download-dat-session', async (event, arg) => {
  try {
    const user = store.get('user')
    const currentFileName = store.get('currentFileName')
    if (user && currentFileName !== arg.fileName && arg.fileName) {
      const userDataPath = app.getPath('userData')
      const destinationPath = path.join(userDataPath, 'Partitions', arg.name)
      await downloadAndUnzipFile(arg.fileName, destinationPath)
    }
  } catch (error) { console.error('Error:', error) }
})

ipcMain.handle('close-main-app', async () => {
  try { app.quit() } catch (error) { console.error('Error:', error) }
})
