# Little Firefly — 流萤桌面宠物

## 项目概述
将一个静态 HTML 页面改造成 Electron 桌面宠物应用，支持透明背景、拖动、点击交互等功能。

## 可调整参数

### 核心配置（config.js）

修改宠物图片大小和窗口大小时，只需修改 `config.js`：

```javascript
const config = {
    petWidth: 150,      // 宠物图片宽度
    petHeight: 150,     // 宠物图片高度
    windowWidth: 550,   // 窗口宽度
    windowHeight: 300,  // 窗口高度
    affection: 50,      // 初始好感度（首次启动或文件不存在时使用）
    maxAffection: 999,  // 最大好感度
    affectionEvalN: 5,  // 好感度评分参考的最近N轮对话
    wanderSpeed: 10,         // 闲逛每帧移动像素数
    wanderPauseMin: 3000,   // 到达目标后最短停留时间(ms)
    wanderPauseMax: 8000,   // 到达目标后最长停留时间(ms)
    wanderDuration: 300000, // 闲逛自动停止时长(ms)，0 表示不自动停止
    wanderBobAmplitude: 4,  // 闲逛上下弹跳幅度(px)
    wanderSwayAmplitude: 3, // 闲逛左右摇摆幅度(px)
    wanderBobFreq: 0.25,    // 弹跳/摇摆频率（越大越快）
};
```

修改后窗口大小自动同步，无需手动调整 main.js。

### 样式参数（index.html :root）

在 `index.html` 的 `:root` 中可以调整以下样式参数：

```css
--button-spacing: 10px;              /* 按钮组与图片的间距 */
--button-vertical-offset: 0px;       /* 按钮组垂直偏移 */
--speech-duration: 8;                /* 气泡停留时间(秒) */
--auto-speak-interval: 30000;        /* 自动说话检测间隔(毫秒) */
--auto-speak-probability: 0.0;       /* 自动说话触发概率(0-1) */
--speech-spacing: 10px;              /* 对话框与图片的间距 */
--input-opacity: 0.9;                /* 输入框透明度(0-1) */
--gif-switch-interval: 60000;        /* 切换到临时GIF的间隔(毫秒) */
--gif-temp-duration: 10000;          /* 临时GIF保持时间(毫秒) */
--gif-flip-probability: 0.0;         /* GIF随机翻转概率(0-1) */
```

### 运行时设置面板（settings.json）

以下参数支持运行时调整，无需重启，通过右键宠物或点击 ⚙ 按钮打开设置面板：

| 参数 | 默认值 | 单位 | 范围 | 说明 |
|------|--------|------|------|------|
| `speechDuration` | 8 | 秒 | 1 ~ 60 | 气泡停留时间（统一用于预设消息和 AI 回复） |
| `autoSpeakInterval` | 30000 | 毫秒 | 5s ~ 300s | 自动说话检测间隔 |
| `autoSpeakProbability` | 0.0 | 概率 | 0 ~ 1 | 每次检测触发说话的概率 |
| `gifSwitchInterval` | 60000 | 毫秒 | 10s ~ 300s | 切换到临时 GIF 的间隔 |
| `gifTempDuration` | 10000 | 毫秒 | 5s ~ 60s | 临时 GIF 保持多久后切回常驻 |
| `provider` | `deepseek-v4-flash` | — | 下拉选择 | LLM Provider（MiniMax / DeepSeek V4 Flash / V4 Pro） |
| `apiKey` | (空) | — | 文本 | API Key，留空沿用本地 `api_config.py` 默认值 |

设置通过 `settings.json` 持久化，存储于用户目录 `%APPDATA%/LittleFirefly/`（与代码分离，重新打包不丢失）。

## 开发流程

### 1. 准备素材
- 原始图片：`image/firefly1.jpg`（兔子角色）
- 转换为 PNG 透明图：`image/firefly1.png`（白色部分透明化）

### 2. 创建 HTML 原型
文件：`pickle-ascii.html`

**核心功能：**
- 显示角色图片（灰度滤镜 `grayscale(100%)`）
- 灰色背景 `#e8e8e8` 与透明区域融合
- 可拖动交互
- 点击显示随机消息气泡
- 自动说话（每 15 秒 30% 概率）

**关键样式：**
```css
.pet-body img {
    width: 120px;
    height: 120px;
    filter: grayscale(100%);
}
```

### 3. Electron 封装

#### 3.1 创建 package.json
```json
{
  "name": "little-firefly",
  "version": "1.0.0",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-packager . LittleFirefly --platform=win32 --arch=x64 --out=dist --overwrite"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-packager": "^17.1.2"
  }
}
```

#### 3.2 创建 main.js（Electron 主进程）
```javascript
const { app, BrowserWindow } = require('electron');
const config = require('./config.js');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: config.windowWidth,    // 从 config.js 读取
    height: config.windowHeight,  // 从 config.js 读取
    frame: false,          // 无边框
    transparent: true,     // 透明背景
    alwaysOnTop: true,     // 置顶
    resizable: false,      // 不可调整大小
    skipTaskbar: true,     // 不显示任务栏图标
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}
```

#### 3.3 修改 index.html（桌面版）
**关键修改：**
- `body` 设置 `-webkit-app-region: drag` 实现拖动
- 添加关闭按钮 `-webkit-app-region: no-drag`
- 背景设为 `transparent`

### 4. 打包流程

#### 4.1 安装依赖
```bash
cd C:\桌宠DEMO
npm install
```

#### 4.2 打包成 exe

**分享给别人（排除 api_config.py，对方自行配置 Key）：**
```bash
npm run build
```

**自己用（含 api_config.py，开箱即用）：**
```bash
npm run build:dev
```

**输出目录：**
```
dist/LittleFirefly-win32-x64/
├── LittleFirefly.exe        # 主程序
├── resources/
│   └── app/                 # 应用文件（含 anthropic_client.exe）
└── ...
```

### 5. 项目结构
```
little-firefly/
├── package.json          # 项目配置（含 build / build:dev 脚本）
├── main.js              # Electron 主进程（窗口管理 + IPC 桥接 Python）
├── config.js            # 核心配置（图片大小、窗口大小、好感度、闲逛参数）
├── index.html           # 界面（含右键设置面板）
├── messages.js          # 预设对话（48条流萤搭话）
├── gifs.js              # GIF 配置（常驻 + 临时 + 闲逛列表）
├── anthropic_client.py  # AI 对话模块 + 好感度评分
├── anthropic_client.exe # PyInstaller 打包产物（可选，无 Python 环境也能跑）
├── api_config.py        # API 配置（支持 MiniMax / DeepSeek，由设置面板自动生成）
├── api_config.example.py # API 配置模板（不含真实 key，供他人参考）
├── FIREFLY_ROLEPLAY.md  # 流萤角色设定
├── image/               # 角色 GIF 素材
├── node_modules/        # 依赖包（npm install 生成）
└── .gitignore           # Git 忽略规则

用户数据（运行时生成，独立于代码目录，重新打包不丢失）：
%APPDATA%/LittleFirefly/
├── settings.json        # 运行时设置
├── affection.json       # 好感度持久化
├── chat_history.json    # 对话历史（跨 session 保留）
└── conv_count.json      # 对话轮次计数
```

## 核心技术点

### 透明背景实现
1. PNG 图片白色部分透明化
2. Electron 窗口设置 `transparent: true`
3. HTML body 背景 `transparent`

### 拖动功能
- Electron：`-webkit-app-region: drag`
- 网页版：监听 `mousedown/mousemove/mouseup` 事件

### 样式适配
- 灰度滤镜：`filter: grayscale(100%)`
- 背景融合：灰色背景 + PNG 透明区域

### GIF 动画轮播
- 在 `gifs.js` 中配置常驻GIF和临时GIF列表
- 常驻GIF：默认显示的待机动画
- 临时GIF：每隔一定间隔随机切换显示，保持后自动切回常驻
- 切换时淡入淡出过渡效果（0.5s）
- **随机翻转**：切换到临时GIF时，根据 `--gif-flip-probability` 配置的概率随机翻转朝向（0表示不翻转，1表示必翻转，默认0.5）

### AI 对话集成
- 通过 Electron IPC 桥接 Python 对话模块
- 输入框发送消息 → 调用 `anthropic_client.py`
- Python 返回流萤角色的 AI 回复，显示在对话框
- 支持 Enter 键和发送按钮两种方式触发
- **上下文记忆**：通过 `chat_history.json` 持久化对话历史，跨 session 保留
- **重置对话**：输入 `/reset` 或设置面板点击"清空聊天记录"可清空
- **多 API Provider 支持**：支持 MiniMax 和 DeepSeek，在 `api_config.py` 中配置和切换

### AI 润色说话（polish 模式）
- 点击 💬 按钮或宠物本体时，随机抽取一条预设消息，发给 AI 润色后显示
- 使用独立的 `--polish` 命令行模式，**不写入对话历史、不计入轮次、不触发好感度评估**
- AI 润色时注入当前时间（如 `14:30`），流萤会根据时段自然调整语气（早安/午后/深夜等）
- 调用失败时自动降级为显示原始预设消息，不影响正常使用
- IPC 通道：`polish-message`（与对话用的 `chat-message` 完全隔离）

### 闲逛模式
- 点击 🚶 按钮开启，开启后按钮隐藏；点击图片区域停止
- 开启后窗口在屏幕工作区内随机游走，自动切换为行走GIF（从 `wanderGifs` 列表随机抽取）
- 第一次移动强制向左，与 GIF 默认朝向一致
- 关闭后恢复常驻GIF，窗口停在当前位置
- 移动风格：匀速直线移动（60fps）+ 上下弹跳与垂直路径方向左右摇摆，到达目标后随机停留 3~8 秒再选下一个目标
- 左右朝向：根据移动方向自动切换 GIF 朝向（向右时 CSS `scaleX(-1)` 翻转）
- 点击停止：闲逛时隐藏 🚶 按钮，点击图片区域即可停止（闲逛期间禁用 `-webkit-app-region: drag` 以确保点击事件正常触发）
- 闲逛期间暂停临时GIF轮播，避免与行走GIF冲突
- 自动停止：默认 5 分钟后自动停止并恢复UI（`wanderDuration: 0` 表示不限时），手动关闭同样有效
- 闲逛期间隐藏输入框、时钟、好感度等UI及 🚶 按钮，仅保留 GIF 和 ❌ 按钮
- 核心参数在 `config.js`：`wanderSpeed`、`wanderPauseMin`、`wanderPauseMax`、`wanderDuration`、`wanderBobAmplitude`、`wanderSwayAmplitude`、`wanderBobFreq`
- 实现：`main.js` 的 `pickNextTarget` + `setInterval(..., 16)` + `screen.getPrimaryDisplay().workAreaSize`

### 好感度系统
- 初始值由 `config.affection` 决定，持久化存储至用户目录 `affection.json`，重启后恢复
- 每 5 轮对话触发一次 LLM 评分（后台异步评估，不阻塞聊天响应）
- 评分范围 -10 ~ +10，实际增减值为评分 ÷ 10（即每次最多变化 ±1.0）
- 好感度以浮点数存储，显示时四舍五入取整（如 60.6 显示为 LV.61）
- 评分参考最近 N 轮对话（N 由 `config.affectionEvalN` 配置，默认 5）
- 对话轮次计数持久化到 `conv_count.json`（跨 session 累计）
- 评分标准（由独立 LLM 调用评估，不使用角色 system prompt）：
  - +5~+10：用户非常体贴、有趣，令流萤开心
  - +1~+4：正常友好交流
  - 0：中性，无明显影响
  - -1~-4：态度敷衍、无聊或略显无礼
  - -5~-10：明显冒犯、粗鲁或恶意内容

### API Provider 配置

`api_config.py` 可由设置面板自动生成，也支持手写。

**自动生成（推荐给最终用户）：**
1. 右键宠物 → ⚙ 设置 → 选择 Provider → 填写 API Key → 保存
2. `api_config.py` 自动生成，下次启动直接可用
3. 如果已有手写的 `api_config.py`，保存时只更新对应 provider 的 key，不覆盖其他配置

**手写配置（开发者）：**
```python
PROVIDERS = {
    "minimax": {
        "base_url": "https://api.minimaxi.com/anthropic",
        "default_model": "MiniMax-M2.7",
        "eval_model": "MiniMax-M2.7",
        "polish_model": "MiniMax-M2.7",
        "api_key": "sk-...",
    },
    "deepseek-v4-flash": {
        "base_url": "https://api.deepseek.com/anthropic",
        "default_model": "deepseek-v4-flash",
        "eval_model": "deepseek-v4-flash",
        "polish_model": "deepseek-v4-flash",
        "api_key": "sk-...",
    },
    "deepseek-v4-pro": {
        "base_url": "https://api.deepseek.com/anthropic",
        "default_model": "deepseek-v4-pro",
        "eval_model": "deepseek-v4-pro",
        "polish_model": "deepseek-v4-pro",
        "api_key": "sk-...",
    },
}
DEFAULT_PROVIDER = "deepseek-v4-flash"
```

**切换方式：** 在设置面板选择 Provider 后保存即可，`DEFAULT_PROVIDER` 会自动更新。

**无 `api_config.py` 时的兜底：** Python 脚本内置了三个 provider 的 `base_url`，通过 CLI 参数 `--provider` + `--api-key` 也能正常运行。

## 运行方式

### 开发模式
```bash
npm start
```

### 打包（分享）
```bash
npm run build        # 分享版（不含 api_config.py）
npm run build:dev    # 自用版（含 api_config.py）
```

### 运行打包产物
```bash
dist\LittleFirefly-win32-x64\LittleFirefly.exe
```

## 功能特性
- ✅ 透明背景，融入桌面
- ✅ 可拖动到任意位置
- ✅ 点击显示随机消息
- ✅ 启动时显示"嗨~"
- ✅ 自动随机说话（可调间隔和概率）
- ✅ 窗口置顶
- ✅ 💬 说话按钮
- ✅ ❌ 关闭按钮（悬停图片时显示）
- ✅ 对话框自动换行（每行约10个中文字符）
- ✅ 输入框发送消息（支持回车和发送按钮）
- ✅ 所有间距、时长、透明度参数可调
- ✅ ⚙ 运行时设置面板（右键宠物或点击 ⚙ 按钮，滑块调节气泡停留/GIF间隔/说话概率，下拉选 Provider，填 API Key 自动生成 api_config.py）
- ✅ 流萤角色对话内容（48条主动搭话预设消息）
- ✅ GIF动画轮播（常驻GIF + 临时GIF定时切换 + 淡入淡出效果 + 随机翻转朝向概率可调）
- ✅ config.js 统一配置（图片大小与窗口大小自动同步）
- ✅ AI 对话集成（输入框 → Python API → 流萤回复）
- ✅ AI 上下文记忆（聊天记录跨 session 保留，设置面板可清空）
- ✅ 启动时自动清空对话历史（新对话）
- ✅ 多 LLM Provider 支持（MiniMax / DeepSeek V4 Flash / DeepSeek V4 Pro；设置面板切换，自动生成 api_config.py；无配置文件时内置兜底）
- ✅ 用户数据独立目录（`%APPDATA%/LittleFirefly/`），重新打包不丢失好感度、聊天记录和设置
- ✅ 好感度系统（LV.50 初始，LLM 评分驱动，每5轮触发）
- ✅ 好感度持久化（affection.json，重启后恢复）
- ✅ 好感度评分 -10~+10，实际变化为评分÷10，四舍五入显示
- ✅ 对话气泡定时器管理（新消息自动取消旧定时器，避免气泡被意外关闭）
- ✅ 💬 按钮 / 点击宠物触发 AI 润色说话（polish 模式，不污染对话上下文）
- ✅ AI 润色注入当前时间，流萤根据时段自然调整语气
- ✅ 🚶 闲逛模式（点击按钮开启，点击图片停止；窗口随机游走 + 上下弹跳/左右摇摆 + 左右朝向自动切换，行走GIF，闲逛期间隐藏非必要UI、暂停自动说话）

## 打包为独立 exe

将 Python 脚本打包为独立 exe，消除对本地 Python 环境的依赖：

```powershell
# 1. 安装依赖
pip install pyinstaller anthropic

# 2. 打包（在项目目录下执行）
pyinstaller --onefile --add-data "FIREFLY_ROLEPLAY.md;." anthropic_client.py

# 3. 复制到项目目录
copy dist\anthropic_client.exe .
```

打包后 `main.js` 会自动检测 `anthropic_client.exe`，优先使用 exe 而非 Python。

## 免责声明

- 本项目为 AI 角色扮演桌面宠物，所有对话内容由大语言模型实时生成，不代表开发者立场。
- 角色"流萤"形象及背景设定版权归属 **HoYoverse / miHoYo**（《崩坏：星穹铁道》），本项目仅供个人学习交流使用，不得用于商业用途。
- 使用者需自行承担 API 调用费用，请妥善保管自己的 API Key。
- 本项目开源仅供技术参考，开发者不对因使用本项目产生的任何后果承担责任。
