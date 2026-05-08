const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config.js');

const USER_DATA_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), '.pickle-pet'),
  'LittleFirefly'
);
if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

const PYTHON_SCRIPT = path.join(__dirname, 'anthropic_client.py');
const PYTHON_EXE = process.env.PYTHON_EXE || 'python';
const PACKAGED_EXE = path.join(__dirname, 'anthropic_client.exe');

function getPythonCmd() {
  if (fs.existsSync(PACKAGED_EXE)) {
    return `"${PACKAGED_EXE}"`;
  }
  return `"${PYTHON_EXE}" "${PYTHON_SCRIPT}"`;
}

let mainWindow;
let wanderTimer = null, wanderMoveTimer = null, wanderAutoStopTimer = null;
let isWandering = false, wanderCancelled = false;
let imageOffsetX = 0, imageOffsetY = 0;   // 图片左上角相对于窗口左上角的偏移量
function getCurrentWorkArea() {
  if (!mainWindow || mainWindow.isDestroyed()) return screen.getPrimaryDisplay().workArea;
  try {
    const winBounds = mainWindow.getBounds();
    return screen.getDisplayMatching(winBounds).workArea;
  } catch { return screen.getPrimaryDisplay().workArea; }
}

// 图片允许的边界（基于屏幕工作区减去图片宽高）
function getImageBounds() {
  const area = getCurrentWorkArea();
  return {
    minX: area.x,
    maxX: area.x + area.width - config.petWidth,
    minY: area.y,
    maxY: area.y + area.height - config.petHeight
  };
}

// 钳制图片坐标
function clampImagePosition(imgX, imgY) {
  const bounds = getImageBounds();
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, imgX)),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, imgY))
  };
}

// 从图片坐标设置窗口坐标（允许窗口超出屏幕）
function setWindowFromImage(imgX, imgY) {
  const winX = imgX - imageOffsetX;
  const winY = imgY - imageOffsetY;
  // 不再钳制窗口坐标，直接设置
  mainWindow.setPosition(winX, winY);
}

function getWindowPositionFromImage(imgX, imgY) {
  return { x: Math.round(imgX - imageOffsetX), y: Math.round(imgY - imageOffsetY) };
}

function safeSetPositionFromImage(imgX, imgY) {
  const clamped = clampImagePosition(imgX, imgY);
  const { x: winX, y: winY } = getWindowPositionFromImage(clamped.x, clamped.y);
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (typeof winX !== 'number' || isNaN(winX) || typeof winY !== 'number' || isNaN(winY)) return false;
  try { mainWindow.setPosition(winX, winY); return true; } catch { return false; }
}

function stopWander() {
  isWandering = false;
  wanderCancelled = true;
  if (wanderTimer) clearTimeout(wanderTimer);
  if (wanderMoveTimer) clearInterval(wanderMoveTimer);
  if (wanderAutoStopTimer) clearTimeout(wanderAutoStopTimer);
  wanderTimer = wanderMoveTimer = wanderAutoStopTimer = null;
}

function startWander() {
  if (isWandering) return;
  if (wanderTimer) clearTimeout(wanderTimer);
  if (wanderMoveTimer) clearInterval(wanderMoveTimer);
  wanderTimer = wanderMoveTimer = null;
  isWandering = true;
  wanderCancelled = false;
  pickNextTarget();
  if (config.wanderDuration > 0) {
    wanderAutoStopTimer = setTimeout(() => {
      stopWander();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('wander-auto-stopped');
    }, config.wanderDuration);
  }
}

function getCurrentImagePosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0 };
  const [winX, winY] = mainWindow.getPosition();
  return { x: winX + imageOffsetX, y: winY + imageOffsetY };
}

function pickNextTarget() {
  if (!isWandering || wanderCancelled || !mainWindow || mainWindow.isDestroyed()) return;

  const bounds = getImageBounds();
  let currentImg = getCurrentImagePosition();
  let cx = currentImg.x, cy = currentImg.y;

  let targetImgX = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
  let targetImgY = bounds.minY + Math.random() * (bounds.maxY - bounds.minY);
  targetImgX = Math.round(targetImgX);
  targetImgY = Math.round(targetImgY);

  const dx = targetImgX - cx;
  const dy = targetImgY - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(dist / config.wanderSpeed);
  const stepX = dx / steps;
  const stepY = dy / steps;
  let step = 0;

  mainWindow.webContents.send('wander-direction', dx >= 0 ? 'right' : 'left');

  const nx = dist > 0 ? -dy / dist : 0;
  const ny = dist > 0 ? dx / dist : 0;

  if (wanderMoveTimer) clearInterval(wanderMoveTimer);
  wanderMoveTimer = setInterval(() => {
    if (!isWandering || wanderCancelled || !mainWindow || mainWindow.isDestroyed()) {
      clearInterval(wanderMoveTimer);
      return;
    }
    step++;
    if (step >= steps) {
      clearInterval(wanderMoveTimer);
      safeSetPositionFromImage(targetImgX, targetImgY);
      const pause = config.wanderPauseMin + Math.random() * (config.wanderPauseMax - config.wanderPauseMin);
      wanderTimer = setTimeout(() => { if (isWandering && !wanderCancelled) pickNextTarget(); }, pause);
    } else {
      cx += stepX;
      cy += stepY;
      const bob = config.wanderBobAmplitude * Math.sin(step * config.wanderBobFreq * 2);
      const sway = config.wanderSwayAmplitude * Math.sin(step * config.wanderBobFreq);
      let newImgX = cx + sway * nx;
      let newImgY = cy + sway * ny + bob;
      safeSetPositionFromImage(newImgX, newImgY);
    }
  }, 16);
}

ipcMain.on('set-image-offset', (event, offsetX, offsetY) => {
  imageOffsetX = offsetX;
  imageOffsetY = offsetY;
});

ipcMain.handle('toggle-wander', () => {
  if (isWandering) { stopWander(); return { wandering: false }; }
  else { startWander(); return { wandering: true }; }
});

// ========== 以下为设置、聊天、API配置等，请保持原样 ==========
const SETTINGS_FILE = path.join(USER_DATA_DIR, 'settings.json');
const defaultSettings = {
  speechDuration: 8,
  autoSpeakInterval: 30000,
  autoSpeakProbability: 0.0,
  gifSwitchInterval: 60000,
  gifTempDuration: 10000,
  provider: 'deepseek-v4-flash',
  apiKey: ''
};
let currentSettings = loadSettings();
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      return { ...defaultSettings, ...data };
    }
  } catch (e) { }
  return { ...defaultSettings };
}
function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    currentSettings = { ...settings };
    return true;
  } catch (e) { return false; }
}
ipcMain.handle('load-settings', () => currentSettings);
ipcMain.handle('save-settings', (event, settings) => {
  const ok = saveSettings(settings);
  if (ok && settings.apiKey) writeApiConfig(settings.provider, settings.apiKey);
  return ok;
});
ipcMain.handle('get-user-data-dir', () => USER_DATA_DIR);

function buildPythonFlags() {
  let flags = `--provider "${currentSettings.provider}"`;
  if (currentSettings.apiKey) flags += ` --api-key "${currentSettings.apiKey}"`;
  flags += ` --data-dir "${USER_DATA_DIR}"`;
  return flags;
}
const BUILTIN_PROVIDERS = {
  'minimax': { base_url: 'https://api.minimaxi.com/anthropic', default_model: 'MiniMax-M2.7' },
  'deepseek-v4-flash': { base_url: 'https://api.deepseek.com/anthropic', default_model: 'deepseek-v4-flash' },
  'deepseek-v4-pro': { base_url: 'https://api.deepseek.com/anthropic', default_model: 'deepseek-v4-pro' },
};
function writeApiConfig(provider, apiKey) {
  const info = BUILTIN_PROVIDERS[provider];
  if (!info || !apiKey) return;
  const apiConfigPath = path.join(__dirname, 'api_config.py');
  const content = `"""API 配置文件（由桌宠设置自动生成）"""\n\nPROVIDERS = {\n    "${provider}": {\n        "base_url": "${info.base_url}",\n        "default_model": "${info.default_model}",\n        "eval_model": "${info.default_model}",\n        "polish_model": "${info.default_model}",\n        "api_key": "${apiKey}",\n    },\n}\n\nDEFAULT_PROVIDER = "${provider}"\n`;
  if (fs.existsSync(apiConfigPath)) {
    try {
      let existing = fs.readFileSync(apiConfigPath, 'utf-8');
      existing = existing.replace(/^DEFAULT_PROVIDER\s*=\s*".*"/m, `DEFAULT_PROVIDER = "${provider}"`);
      const keyRe = new RegExp(`("${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*\\{[^}]*"api_key"\\s*:\\s*)"[^"]*"`);
      if (keyRe.test(existing)) existing = existing.replace(keyRe, `$1"${apiKey}"`);
      fs.writeFileSync(apiConfigPath, existing, 'utf-8');
      return;
    } catch (e) { }
  }
  fs.writeFileSync(apiConfigPath, content, 'utf-8');
}

function resetChatHistory() {
  const resetCmd = `${getPythonCmd()} ${buildPythonFlags()} "--reset"`;
  exec(resetCmd, { encoding: 'utf-8' }, (error) => { if (error) console.error(error); });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const initX = area.x + Math.max(0, Math.floor((area.width - config.windowWidth) / 3));
  const initY = area.y + area.height - config.windowHeight - 50;
  mainWindow = new BrowserWindow({
    width: config.windowWidth,
    height: config.windowHeight,
    x: Math.round(initX), y: Math.round(initY),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
}

ipcMain.handle('polish-message', async (event, rawMsg) => {
  return new Promise((resolve) => {
    const escapedMsg = rawMsg.replace(/"/g, '\\"');
    const cmd = `${getPythonCmd()} ${buildPythonFlags()} "--polish" "${escapedMsg}"`;
    exec(cmd, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) { resolve({ text: rawMsg }); return; }
      const lines = stdout.split('\n');
      let text = '';
      for (const line of lines) if (line.startsWith('流萤: ')) { text = line.substring(4); break; }
      resolve({ text: text || rawMsg });
    });
  });
});

ipcMain.handle('chat-message', async (event, userInput) => {
  return new Promise((resolve) => {
    if (userInput.trim().toLowerCase() === '/reset') {
      const resetCmd = `${getPythonCmd()} ${buildPythonFlags()} "--reset"`;
      exec(resetCmd, { encoding: 'utf-8' }, (error) => {
        if (error) resolve({ text: `重置失败: ${error.message}`, thinking: '', tokens: 0 });
        else resolve({ text: '对话历史已清除', thinking: '', tokens: 0 });
      });
      return;
    }
    const escapedInput = userInput.replace(/"/g, '\\"');
    const cmd = `${getPythonCmd()} ${buildPythonFlags()} "${escapedInput}" ${config.affectionEvalN}`;
    exec(cmd, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) { resolve({ text: `错误: ${error.message}`, thinking: '', tokens: 0, affection: 0 }); return; }
      const lines = stdout.split('\n');
      let text = '', evalNeeded = false, evalN = config.affectionEvalN, tokens = 0;
      for (const line of lines) {
        if (line.startsWith('流萤: ')) text = line.substring(4);
        else if (line.startsWith('[Tokens:')) { const match = line.match(/输入(\d+) 输出(\d+)/); if (match) tokens = parseInt(match[1]) + parseInt(match[2]); }
        else if (line.startsWith('[EvalNeeded:')) { evalNeeded = true; const match = line.match(/\[EvalNeeded:(\d+)\]/); if (match) evalN = parseInt(match[1]); }
      }
      resolve({ text: text || stdout, thinking: '', tokens, _debug_stdout: stdout });
      if (evalNeeded) {
        const evalCmd = `${getPythonCmd()} ${buildPythonFlags()} "--eval" ${evalN}`;
        exec(evalCmd, { encoding: 'utf-8' }, (evalErr, evalStdout) => {
          if (evalErr || !mainWindow) return;
          const match = evalStdout.match(/\[Affection:\s*([+-]?\d+)\]/);
          if (match) mainWindow.webContents.send('affection-update', parseInt(match[1]));
        });
      }
    });
  });
});

ipcMain.handle('reset-chat', () => {
  const resetCmd = `${getPythonCmd()} ${buildPythonFlags()} "--reset"`;
  return new Promise((resolve) => { exec(resetCmd, (error) => resolve({ ok: !error })); });
});

app.whenReady().then(() => createWindow());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
