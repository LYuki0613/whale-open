"""faster-whisper 转写（抖音插件版）。

用法: python transcribe.py <音频文件> <模型目录|模型名>
输出: 一行 JSON {"ok":true,"language":...,"duration":...,"text":...}

为什么自己解 wav：faster-whisper 用 PyAV 解码，而本机 av 版本不认
metadata_errors 参数。我们反正已经用 ffmpeg 转成 16k 单声道 wav，
直接用 wave 模块读成 float32 数组喂给模型，绕开 PyAV。
"""
import json
import os
import sys
import wave

import numpy as np


def read_wav(path: str) -> "np.ndarray":
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("需要 16-bit 单声道 wav")
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少音频文件参数"}, ensure_ascii=False))
        return 1
    path = sys.argv[1]
    model_ref = sys.argv[2] if len(sys.argv) > 2 else "small"
    if not os.path.exists(path):
        print(json.dumps({"ok": False, "error": f"文件不存在: {path}"}, ensure_ascii=False))
        return 1
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"faster-whisper 未安装: {exc}"}, ensure_ascii=False))
        return 1

    try:
        audio = read_wav(path)
        model = WhisperModel(model_ref, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio, language="zh", vad_filter=True, beam_size=1)
        text = "".join(seg.text for seg in segments).strip()
        print(json.dumps({
            "ok": True,
            "language": getattr(info, "language", ""),
            "duration": round(float(getattr(info, "duration", 0) or 0), 2),
            "text": text,
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
