# B 站 AI 广告跳过

Manifest V3 Chrome 扩展：从 B 站视频已有字幕中识别广告/推广时间段，并在播放时自动跳过。

## 安装

1. 打开 Chrome 的 `chrome://extensions`，启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本项目目录。
3. 在扩展详情页点击“扩展程序选项”。
4. 填写 OpenRouter API Key、模型名称（例如 `deepseek/deepseek-chat`）和提示词并保存。

## 使用

打开 `https://www.bilibili.com/video/*` 视频页后，右下角会出现悬浮面板。扩展会获取视频已有的官方/上传者字幕，再调用配置的模型分析广告段。开启“自动跳过”时，播放器进入识别区间会跳转到该段结尾；也可以点击区间手动跳转或“重新分析”。

没有字幕的视频会询问是否使用本机语音识别。确认后，扩展把当前播放器的短期音频地址交给本机服务；音频由 FFmpeg 和 faster-whisper 在本机处理，识别文字随后仍会发送到你配置的 OpenRouter。

## 本机语音识别

需要 Python 3.10+、可执行的 FFmpeg，以及支持 CUDA 的 NVIDIA 驱动。默认使用 CUDA/FP16；首次使用 faster-whisper 可能需要下载模型。若需强制使用 CPU，可设置 `BILI_TRANSCRIBER_DEVICE=cpu BILI_TRANSCRIBER_COMPUTE_TYPE=int8`。

```bash
cd local_transcriber
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
python -m uvicorn local_transcriber.app:app --app-dir .. --host 127.0.0.1 --port 8765
```

服务只监听本机 `127.0.0.1`，不会保存原始音频。默认模型为 `small`、`beam_size=1`、CUDA 设备索引为 `0`；可通过环境变量 `BILI_TRANSCRIBER_MODEL`、`BILI_TRANSCRIBER_BEAM_SIZE`、`BILI_TRANSCRIBER_DEVICE_INDEX`、`BILI_TRANSCRIBER_NUM_WORKERS` 和 `BILI_TRANSCRIBER_CPU_THREADS` 调整。若没有启动服务，扩展会在确认后显示失败原因。VAD 默认过滤超过 500 毫秒的静音，并保留 200 毫秒语音边界。

本机服务只接受 HTTPS 的 B 站 CDN 音频地址，并限制下载大小和重定向；不要把服务绑定到 `0.0.0.0`。

注意：音频只在本机转写，但完整识别字幕仍会按照现有设置发送到 OpenRouter。

部分 B 站 CDN 可能要求页面请求头或短期签名。若播放器尚未加载音频资源，请刷新视频后再确认。

本机服务测试：

```bash
python -m unittest discover local_transcriber/tests
```

（当前仓库的 Node 测试仍使用 `npm test`。）


## 隐私与调试

API Key 仅写入本机的 Chrome 扩展本地存储，不会显示在视频页面。字幕文本会发送到你配置的 OpenRouter 模型。展开面板“调试信息”可查看本次请求体与原始响应，便于排查模型格式问题；其中不包含 API Key。

## 测试

需要 Node.js 18+：

```bash
npm test
```
