import anthropic
import re
from dataclasses import dataclass
import sys
import os
import json
from datetime import datetime

# 清除干扰的环境变量（ANTHROPIC_AUTH_TOKEN 会覆盖 api_key 参数）
os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
os.environ.pop("ANTHROPIC_BASE_URL", None)

# 角色设定文件路径（PyInstaller 打包后资源在 sys._MEIPASS）
if getattr(sys, 'frozen', False):
    _BUNDLE_DIR = sys._MEIPASS
else:
    _BUNDLE_DIR = os.path.dirname(__file__)
ROLEPLAY_FILE = os.path.join(_BUNDLE_DIR, "FIREFLY_ROLEPLAY.md")

# 导入 API 配置（可选：不存在时依赖 CLI 参数 --provider / --api-key）
try:
    from api_config import PROVIDERS, DEFAULT_PROVIDER
    _HAS_API_CONFIG = True
except ImportError:
    PROVIDERS = {}
    DEFAULT_PROVIDER = None
    _HAS_API_CONFIG = False

# 已知 provider 的 base_url 硬编码兜底（api_config.py 不存在时使用）
_BUILTIN_BASE_URLS = {
    "minimax": "https://api.minimaxi.com/anthropic",
    "deepseek-v4-flash": "https://api.deepseek.com/anthropic",
    "deepseek-v4-pro": "https://api.deepseek.com/anthropic",
}


def get_provider_config(provider_name: str = None, api_key: str = None) -> dict:
    """获取指定 provider 的配置。优先从 api_config.py 读取，其次用内置兜底 + CLI 参数。"""
    if provider_name is None:
        provider_name = os.environ.get("PROVIDER", DEFAULT_PROVIDER)
    if not provider_name:
        raise ValueError("未指定 provider，请通过 --provider 参数或 settings.json 配置")

    if provider_name in PROVIDERS:
        config = dict(PROVIDERS[provider_name])
    elif provider_name in _BUILTIN_BASE_URLS:
        config = {
            "base_url": _BUILTIN_BASE_URLS[provider_name],
            "default_model": provider_name,
            "eval_model": provider_name,
            "polish_model": provider_name,
            "api_key": "",
        }
    else:
        known = list(PROVIDERS.keys()) or list(_BUILTIN_BASE_URLS.keys())
        raise ValueError(f"未知的 provider: {provider_name}, 可选: {known}")

    if api_key:
        config["api_key"] = api_key
    if not config.get("api_key"):
        raise ValueError(
            f"provider '{provider_name}' 缺少 API Key，请在 settings.json 中配置或在 api_config.py 中设置"
        )
    return config


def load_roleplay_system():
    """读取角色设定 Markdown 文件，作为 system prompt 使用。"""
    with open(ROLEPLAY_FILE, "r", encoding="utf-8") as f:
        return f.read()


@dataclass
class MessageResponse:
    """单次对话的返回结果。"""

    text: str  # 流萤的回复文本
    thinking: str  # 模型内部思考内容（ThinkingBlock，部分模型返回）
    input_tokens: int  # 本次请求消耗的输入 token 数
    output_tokens: int  # 本次请求消耗的输出 token 数
    cache_read_input_tokens: int  # 命中缓存的 token 数（不计费）
    affection_delta: int = 0  # 好感度变化量（同步模式，已废弃）
    needs_eval: bool = False  # 是否需要后台异步评估好感度
    eval_n: int = 5  # 评估参考的最近 N 轮


class ChatSession:
    """管理与 LLM 的多轮对话，包含历史持久化和好感度评估。"""

    def __init__(self, api_key: str = None, base_url: str = None, provider: str = None, data_dir: str = None):
        # 数据目录（默认 = 脚本所在目录，Electron 通过 --data-dir 传入用户目录）
        if data_dir is None:
            data_dir = os.path.dirname(__file__)
        os.makedirs(data_dir, exist_ok=True)
        self.history_file = os.path.join(data_dir, "chat_history.json")
        self.conv_count_file = os.path.join(data_dir, "conv_count.json")

        # 从配置获取 API 参数
        config = get_provider_config(provider)
        self.base_url = base_url or config["base_url"]
        self.api_key = api_key or config["api_key"]
        self.default_model = config["default_model"]
        self.eval_model = config["eval_model"]

        self.client = anthropic.Anthropic(base_url=self.base_url, api_key=self.api_key)
        self.messages = []
        self.system = load_roleplay_system()
        self._load_history()

    def _load_history(self):
        """从 chat_history.json 恢复上轮对话记录；文件损坏时静默重置。"""
        if os.path.exists(self.history_file):
            try:
                with open(self.history_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.messages = data.get("messages", [])
            except Exception:
                self.messages = []

    def _save_history(self):
        """将当前对话记录写入 chat_history.json 以持久化上下文。"""
        try:
            with open(self.history_file, "w", encoding="utf-8") as f:
                json.dump({"messages": self.messages}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def send_message(
        self,
        prompt: str,
        model: str = None,
        max_tokens: int = 10240,
        eval_n: int = 5,
    ) -> MessageResponse:
        """
        发送一条用户消息，获取流萤回复并持久化历史。
        每 eval_n 轮对话触发一次好感度评估，结果写入 affection_delta。
        """
        model = model or self.default_model

        # 追加用户消息
        self.messages.append(
            {"role": "user", "content": [{"type": "text", "text": prompt}]}
        )

        # 调用 API（携带完整历史和角色 system prompt）
        message = self.client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=self.system,
            messages=self.messages,
        )

        response = self._parse_response(message)

        # 追加助手回复，保持对话历史完整
        self.messages.append(
            {"role": "assistant", "content": [{"type": "text", "text": response.text}]}
        )

        self._save_history()

        # 更新对话轮次计数，标记是否需要后台评估（不阻塞聊天响应）
        count = self._load_conv_count() + 1
        self._save_conv_count(count)
        if count % eval_n == 0:
            response.needs_eval = True
            response.eval_n = eval_n

        return response

    def _parse_response(self, message) -> MessageResponse:
        """
        解析 API 返回的 content block 列表。
        模型可能同时返回 ThinkingBlock（内部推理）和 TextBlock（最终回复），
        分别提取，互不干扰。
        """
        text, thinking = "", ""
        for block in message.content:
            if block.type == "thinking":
                thinking = block.thinking
            elif block.type == "text":
                text = block.text

        return MessageResponse(
            text=text,
            thinking=thinking,
            input_tokens=message.usage.input_tokens,
            output_tokens=message.usage.output_tokens,
            cache_read_input_tokens=getattr(
                message.usage, "cache_read_input_tokens", 0
            ),
        )

    def reset(self):
        """清空内存中的对话历史，并删除 chat_history.json 和 conv_count.json。"""
        self.messages = []
        for f in (self.history_file, self.conv_count_file):
            if os.path.exists(f):
                os.remove(f)

    def _load_conv_count(self) -> int:
        """从 conv_count.json 读取累计对话轮次，文件不存在或损坏时返回 0。"""
        try:
            if os.path.exists(self.conv_count_file):
                with open(self.conv_count_file, "r", encoding="utf-8") as f:
                    return json.load(f).get("count", 0)
        except Exception:
            pass
        return 0

    def _save_conv_count(self, count: int):
        """将累计对话轮次写入 conv_count.json。"""
        try:
            with open(self.conv_count_file, "w", encoding="utf-8") as f:
                json.dump({"count": count}, f)
        except Exception:
            pass

    def evaluate_affection(self, n: int) -> int:
        """
        读取最近 n 轮对话，调用 LLM 评估好感度变化，返回 -10 ~ +10 的整数。

        评分标准：
            +5 ~ +10：用户非常体贴、有趣，令流萤开心
            +1 ~ +4 ：正常友好交流
              0      ：中性，无明显影响
            -1 ~ -4 ：态度敷衍、无聊或略显无礼
            -5 ~ -10：明显冒犯、粗鲁或恶意内容

        注意：模型可能返回 ThinkingBlock，需遍历 content 找到 TextBlock。
        max_tokens 设为 500 以确保 ThinkingBlock 后还有足够空间输出整数。
        解析失败时静默返回 0，不影响主对话流程。
        """
        if not self.messages:
            return 0

        # 取最近 n 轮（每轮含 user + assistant 共2条）
        recent = self.messages[-(n * 2) :]
        lines = []
        for msg in recent:
            role = "开拓者" if msg["role"] == "user" else "流萤"
            content = (
                msg["content"][0]["text"]
                if isinstance(msg["content"], list)
                else msg["content"]
            )
            lines.append(f"{role}: {content}")
        conversation = "\n".join(lines)

        prompt = f"""以下是流萤与开拓者最近的对话记录：

{conversation}

请根据对话中用户（开拓者）的态度、语气、内容，评估本次对话对流萤好感度的影响。
只输出一个整数，范围 -10 到 +10，不要有任何其他内容。

评分参考：
+5 ~ +10：用户非常体贴、有趣，令流萤开心
+1 ~ +4 ：正常友好交流
  0      ：中性，无明显影响
-1 ~ -4 ：态度敷衍、无聊或略显无礼
-5 ~ -10：明显冒犯、粗鲁或恶意内容"""

        try:
            message = self.client.messages.create(
                model=self.eval_model,
                max_tokens=10240,
                messages=[
                    {"role": "user", "content": [{"type": "text", "text": prompt}]}
                ],
            )
            # 遍历 block 找 TextBlock（ThinkingBlock 不含 .text 属性）
            raw = ""
            for block in message.content:
                if block.type == "text":
                    raw = block.text.strip()
                    break
            # 用正则提取整数，兼容模型输出多余文字的情况
            match = re.search(r"[+-]?\d+", raw)
            if match:
                score = int(match.group())
                return max(-10, min(10, score))  # clamp 到合法范围
        except Exception:
            pass
        return 0


def log(msg):
    """以 UTF-8 编码向 stdout 输出一行，供 main.js 的 exec 回调解析。"""
    sys.stdout.buffer.write(f"{msg}\n".encode("utf-8"))


def main():
    """命令行交互模式（直接运行脚本时使用，不经过 Electron）。"""
    chat = ChatSession()

    log("=== 流萤角色扮演对话 ===")
    log(f"角色设定已从 {ROLEPLAY_FILE} 加载")
    log(f"使用 provider: {os.environ.get('PROVIDER', DEFAULT_PROVIDER)}")
    if chat.messages:
        log(f"已加载历史对话 {len(chat.messages)} 条")
    log("（输入 'quit' 退出，输入 'reset' 重置对话）\n")

    while True:
        user_input = input("开拓者: ")
        if user_input.lower() == "quit":
            break
        if user_input.lower() == "reset":
            chat.reset()
            log("\n=== 对话已重置 ===\n")
            continue

        resp = chat.send_message(prompt=user_input)
        log(f"流萤: {resp.text}")
        log(f"[Tokens: 输入{resp.input_tokens} 输出{resp.output_tokens}]\n")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        provider = None
        model = None
        api_key = None
        data_dir = None
        args = sys.argv[1:]

        # 解析可选标志（--provider / --model / --api-key / --data-dir）
        while len(args) >= 2 and args[0].startswith('--') and args[0] not in ('--reset', '--polish', '--eval'):
            flag = args[0]
            if flag == '--provider':
                provider = args[1]
            elif flag == '--model':
                model = args[1]
            elif flag == '--api-key':
                api_key = args[1]
            elif flag == '--data-dir':
                data_dir = args[1]
            else:
                break
            args = args[2:]

        if not args:
            main()
            sys.exit(0)

        user_input = args[0]
        config = get_provider_config(provider, api_key=api_key)

        # CLI model 参数覆盖默认模型
        if model:
            config = dict(config, default_model=model, eval_model=model, polish_model=model)

        if user_input == "--reset":
            # 重置模式：清空对话历史和计数
            chat = ChatSession(provider=provider, data_dir=data_dir)
            chat.reset()
            sys.stdout.buffer.write("对话已重置\n".encode("utf-8"))

        elif user_input == "--eval":
            # 评估模式：由 main.js 在后台单独调用，不阻塞聊天响应
            eval_n = int(args[1]) if len(args) > 1 else 5
            chat = ChatSession(provider=provider, data_dir=data_dir)
            score = chat.evaluate_affection(eval_n)
            log(f"[Affection: {score:+d}]")

        elif user_input == "--polish":
            # 润色模式：给定一句预设消息，用流萤语气润色后返回
            raw_msg = args[1] if len(args) > 1 else ""
            now = datetime.now().strftime("%H:%M")
            client = anthropic.Anthropic(
                base_url=config["base_url"], api_key=config["api_key"]
            )
            system = load_roleplay_system()
            message = client.messages.create(
                model=config["polish_model"],
                max_tokens=200,
                system=system,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": f"[旁白指令，不计入对话] 当前时间是 {now}。流萤正在主动找开拓者搭话。请以下面这句话为灵感，用流萤的语气说一句完整自然的话，让开拓者感觉是流萤主动开口的，可以结合当前时间适当调整语气：「{raw_msg}」只输出润色后的话，不要解释。",
                            }
                        ],
                    }
                ],
            )
            for block in message.content:
                if block.type == "text":
                    log(f"流萤: {block.text.strip()}")
                    break

        else:
            # 正常对话模式：输出格式供 main.js 解析
            eval_n = int(args[1]) if len(args) > 1 else 5
            chat = ChatSession(provider=provider, data_dir=data_dir)
            resp = chat.send_message(prompt=user_input, eval_n=eval_n)
            log(f"流萤: {resp.text}")
            log(f"[Tokens: 输入{resp.input_tokens} 输出{resp.output_tokens}]")
            if resp.needs_eval:
                log(f"[EvalNeeded:{eval_n}]")
    else:
        main()
