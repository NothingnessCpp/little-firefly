"""
API 配置文件（模板）
将此文件重命名为 api_config.py 并填入你的 API Key。
或者通过桌宠设置面板自动生成。

支持的 Provider：
  - minimax          → MiniMax M2.7
  - deepseek-v4-flash → DeepSeek V4 Flash
  - deepseek-v4-pro   → DeepSeek V4 Pro
"""

PROVIDERS = {
    "minimax": {
        "base_url": "https://api.minimaxi.com/anthropic",
        "default_model": "MiniMax-M2.7",
        "eval_model": "MiniMax-M2.7",
        "polish_model": "MiniMax-M2.7",
        "api_key": "your-api-key-here",
    },
    "deepseek-v4-flash": {
        "base_url": "https://api.deepseek.com/anthropic",
        "default_model": "deepseek-v4-flash",
        "eval_model": "deepseek-v4-flash",
        "polish_model": "deepseek-v4-flash",
        "api_key": "your-api-key-here",
    },
    "deepseek-v4-pro": {
        "base_url": "https://api.deepseek.com/anthropic",
        "default_model": "deepseek-v4-pro",
        "eval_model": "deepseek-v4-pro",
        "polish_model": "deepseek-v4-pro",
        "api_key": "your-api-key-here",
    },
}

DEFAULT_PROVIDER = "deepseek-v4-flash"
