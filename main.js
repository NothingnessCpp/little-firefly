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
let wanderTimer = null;
let wanderMoveTimer = null;
let wanderAutoStopTimer = null;
let isWandering = false;

function stopWander() {
  isWandering = false;
  if (wanderTimer) { clearTimeout(wanderTimer); wanderTimer = null; }
  if (wanderMoveTimer) { clearInterval(wanderMoveTimer); wanderMoveTimer = null; }
  if (wanderAutoStopTimer) { clearTimeout(wanderAutoStopTimer); wanderAutoStopTimer = null; }
}

function startWander() {
  if (isWandering) return;
  isWandering = true;
  pickNextTarget(true); // 第一次强制向左
  if (config.wanderDuration > 0) {
    wanderAutoStopTimer = setTimeout(() => {
      stopWander();
      if (mainWindow) mainWindow.webContents.send('wander-auto-stopped');
    }, config.wanderDuration);
  }
}

function pickNextTarget(forceLeft = false) {
  if (!isWandering || !mainWindow) return;

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [wx, wy] = mainWindow.getPosition();
  // forceLeft：目标X限制在当前位置左侧，保证第一段移动方向向左与GIF默认朝向一致
  const maxX = forceLeft ? Math.max(0, wx - 1) : sw - config.windowWidth;
  const targetX = Math.floor(Math.random() * (maxX + 1));
  const targetY = Math.floor(Math.random() * (sh - config.windowHeight));

  let cx = wx, cy = wy;
  const dx = targetX - cx;
  const dy = targetY - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(dist / config.wanderSpeed);
  const stepX = dx / steps;
  const stepY = dy / steps;
  let step = 0;

  // 通知渲染进程当前移动方向，用于切换左/右朝向 GIF
  if (mainWindow) mainWindow.webContents.send('wander-direction', dx >= 0 ? 'right' : 'left');

  // 法向量（垂直于移动方向），用于左右摇摆
  const nx = dist > 0 ? -dy / dist : 0;
  const ny = dist > 0 ?  dx / dist : 0;

  wanderMoveTimer = setInterval(() => {
    if (!isWandering) { clearInterval(wanderMoveTimer); return; }
    step++;
    if (step >= steps) {
      clearInterval(wanderMoveTimer);
      mainWindow.setPosition(targetX, targetY);
      // 到达后随机停留再选下一个目标
      const pause = config.wanderPauseMin + Math.random() * (config.wanderPauseMax - config.wanderPauseMin);
      wanderTimer = setTimeout(pickNextTarget, pause);
    } else {
      cx += stepX;
      cy += stepY;
      // A: 上下弹跳（bob），B: 垂直路径方向左右摇摆（sway）
      const bob  = config.wanderBobAmplitude  * Math.sin(step * config.wanderBobFreq * 2);
      const sway = config.wanderSwayAmplitude * Math.sin(step * config.wanderBobFreq);
      mainWindow.setPosition(
        Math.round(cx + sway * nx),
        Math.round(cy + sway * ny + bob)
      );
    }
  }, 16); // ~60fps
}

ipcMain.handle('toggle-wander', () => {
  if (isWandering) {
    stopWander();
    return { wandering: false };
  } else {
    startWander();
    return { wandering: true };
  }
});

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
  } catch (e) { console.error('loadSettings error:', e); }
  return { ...defaultSettings };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    currentSettings = { ...settings };
    return true;
  } catch (e) { console.error('saveSettings error:', e); return false; }
}

ipcMain.handle('load-settings', () => currentSettings);
ipcMain.handle('save-settings', (event, settings) => {
  const ok = saveSettings(settings);
  if (ok && settings.apiKey) {
    writeApiConfig(settings.provider, settings.apiKey);
  }
  return ok;
});
ipcMain.handle('get-user-data-dir', () => USER_DATA_DIR);

function buildPythonFlags() {
  let flags = `--provider "${currentSettings.provider}"`;
  if (currentSettings.apiKey) {
    flags += ` --api-key "${currentSettings.apiKey}"`;
  }
  flags += ` --data-dir "${USER_DATA_DIR}"`;
  return flags;
}

const BUILTIN_PROVIDERS = {
  'minimax':           { base_url: 'https://api.minimaxi.com/anthropic', default_model: 'MiniMax-M2.7' },
  'deepseek-v4-flash': { base_url: 'https://api.deepseek.com/anthropic', default_model: 'deepseek-v4-flash' },
  'deepseek-v4-pro':   { base_url: 'https://api.deepseek.com/anthropic', default_model: 'deepseek-v4-pro' },
};

function writeApiConfig(provider, apiKey) {
  const info = BUILTIN_PROVIDERS[provider];
  if (!info || !apiKey) return;

  const apiConfigPath = path.join(__dirname, 'api_config.py');
  const content =
`"""
API 配置文件（由桌宠设置自动生成）
"""

PROVIDERS = {
    "${provider}": {
        "base_url": "${info.base_url}",
        "default_model": "${info.default_model}",
        "eval_model": "${info.default_model}",
        "polish_model": "${info.default_model}",
        "api_key": "${apiKey}",
    },
}

DEFAULT_PROVIDER = "${provider}"
`;

  // 已有 api_config.py 时只更新 key，避免覆盖用户手写配置
  if (fs.existsSync(apiConfigPath)) {
    try {
      let existing = fs.readFileSync(apiConfigPath, 'utf-8');
      existing = existing.replace(
        /^DEFAULT_PROVIDER\s*=\s*".*"/m,
        `DEFAULT_PROVIDER = "${provider}"`
      );
      const keyRe = new RegExp(
        `("${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*\\{[^}]*"api_key"\\s*:\\s*)"[^"]*"`
      );
      if (keyRe.test(existing)) {
        existing = existing.replace(keyRe, `$1"${apiKey}"`);
      }
      fs.writeFileSync(apiConfigPath, existing, 'utf-8');
      return;
    } catch (e) { /* 解析失败则覆盖写入 */ }
  }

  fs.writeFileSync(apiConfigPath, content, 'utf-8');
}

function resetChatHistory() {
  const resetCmd = `${getPythonCmd()} ${buildPythonFlags()} "--reset"`;
  exec(resetCmd, { encoding: 'utf-8' }, (error, stdout, stderr) => {
    if (error) {
      console.error('重置对话历史失败:', error.message);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: config.windowWidth,
    height: config.windowHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

ipcMain.handle('polish-message', async (event, rawMsg) => {
  return new Promise((resolve) => {
    const escapedMsg = rawMsg.replace(/"/g, '\\"');
    const cmd = `${getPythonCmd()} ${buildPythonFlags()} "--polish" "${escapedMsg}"`;
    exec(cmd, { encoding: 'utf-8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ text: rawMsg }); // 润色失败时降级为原始消息
        return;
      }
      const lines = stdout.split('\n');
      let text = '';
      for (const line of lines) {
        if (line.startsWith('流萤: ')) {
          text = line.substring(4);
          break;
        }
      }
      resolve({ text: text || rawMsg });
    });
  });
});

ipcMain.handle('chat-message', async (event, userInput) => {
  return new Promise((resolve) => {
    // 检查是否需要重置
    if (userInput.trim().toLowerCase() === '/reset') {
      const resetCmd = `${getPythonCmd()} ${buildPythonFlags()} "--reset"`;
      exec(resetCmd, { encoding: 'utf-8' }, (error, stdout, stderr) => {
        if (error) {
          resolve({ text: `重置失败: ${error.message}`, thinking: '', tokens: 0 });
          return;
        }
        resolve({ text: '对话历史已清除', thinking: '', tokens: 0 });
      });
      return;
    }

    const escapedInput = userInput.replace(/"/g, '\\"');
    const cmd = `${getPythonCmd()} ${buildPythonFlags()} "${escapedInput}" ${config.affectionEvalN}`;

    exec(cmd, { encoding: 'utf-8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ text: `错误: ${error.message}`, thinking: '', tokens: 0, affection: 0 });
        return;
      }
      const lines = stdout.split('\n');
      let text = '', thinking = '', tokens = 0;
      let evalNeeded = false, evalN = config.affectionEvalN;

      for (const line of lines) {
        if (line.startsWith('流萤: ')) {
          text = line.substring(4);
        } else if (line.startsWith('[Tokens:')) {
          const match = line.match(/输入(\d+) 输出(\d+)/);
          if (match) tokens = parseInt(match[1]) + parseInt(match[2]);
        } else if (line.startsWith('[EvalNeeded:')) {
          evalNeeded = true;
          const match = line.match(/\[EvalNeeded:(\d+)\]/);
          if (match) evalN = parseInt(match[1]);
        }
      }

      resolve({ text: text || stdout, thinking, tokens, _debug_stdout: stdout });

      // 后台异步评估好感度（不阻塞聊天响应）
      if (evalNeeded) {
        const evalCmd = `${getPythonCmd()} ${buildPythonFlags()} "--eval" ${evalN}`;
        exec(evalCmd, { encoding: 'utf-8' }, (evalErr, evalStdout) => {
          if (evalErr || !mainWindow) return;
          const evalLines = evalStdout.split('\n');
          for (const line of evalLines) {
            if (line.startsWith('[Affection:')) {
              const match = line.match(/\[Affection:\s*([+-]?\d+)\]/);
              if (match) {
                mainWindow.webContents.send('affection-update', parseInt(match[1]));
              }
            }
          }
        });
      }
    });
  });
});

ipcMain.handle('reset-chat', () => {
  const resetCmd = `${getPythonCmd()} ${buildPythonFlags()} "--reset"`;
  return new Promise((resolve) => {
    exec(resetCmd, { encoding: 'utf-8' }, (error, stdout, stderr) => {
      resolve({ ok: !error });
    });
  });
});

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
