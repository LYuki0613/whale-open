"""faster-whisper 转写脚本（由 dsh-memory 的 src/transcribe.mjs 调用）。

用法: python transcribe.py <音频文件> <模型名>
输出: 一行 JSON {"ok":true,"language":...,"duration":...,"text":...}
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少音频文件参数"}, ensure_ascii=False))
        return 1
    path = sys.argv[1]
    size = sys.argv[2] if len(sys.argv) > 2 else "small"
    if not os.path.exists(path):
        print(json.dumps({"ok": False, "error": f"文件不存在: {path}"}, ensure_ascii=False))
        return 1
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"faster-whisper 未安装: {exc}"}, ensure_ascii=False))
        return 1

    cache = os.environ.get("WHISPER_CACHE") or os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "dsh-memory-whisper"
    )
    os.makedirs(cache, exist_ok=True)
    try:
        model = WhisperModel(size, device="cpu", compute_type="int8", download_root=cache)
        segments, info = model.transcribe(path, beam_size=1, vad_filter=True)
        texts = [seg.text.strip() for seg in segments if seg.text and seg.text.strip()]
        print(json.dumps({
            "ok": True,
            "language": getattr(info, "language", None),
            "duration": getattr(info, "duration", None),
            "text": " ".join(texts).strip(),
            "segments": len(texts),
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)[:500]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
