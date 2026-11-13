# 抖音取数（插件专用，带登录态）
#   python dy.py feed [条数]            → 推荐流里的视频（id/标题/作者/封面/时长）
#   python dy.py video <链接或视频id>    → 单条视频详情（含播放地址）
# 登录态放在 persistent profile（由 login.py 扫码建立），env DY_PROFILE 指定。
import json
import os
import re
import sys
import tempfile

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
PROFILE = os.environ.get("DY_PROFILE") or os.path.join(tempfile.gettempdir(), "whale-douyin-profile")


def _collect(page, sink, want_id=None):
    def on_response(resp):
        if "/aweme/" not in resp.url:
            return
        try:
            data = resp.json()
        except Exception:
            return
        cand = []
        item = data.get("aweme_detail")
        if isinstance(item, dict):
            cand.append(item)
        for key in ("aweme_list", "data"):
            lst = data.get(key)
            if isinstance(lst, list):
                cand.extend([x for x in lst if isinstance(x, dict)])
        for it in cand:
            if not it.get("aweme_id") or not it.get("video"):
                continue
            if want_id and str(it.get("aweme_id")) != want_id:
                continue
            sink.append(it)
    page.on("response", on_response)


def _launch(p, headless=True):
    return p.chromium.launch_persistent_context(
        PROFILE, channel="msedge", headless=headless, user_agent=UA,
        viewport={"width": 1280, "height": 900},
    )


def feed(count=8):
    from playwright.sync_api import sync_playwright

    items = []
    with sync_playwright() as p:
        ctx = _launch(p)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        _collect(page, items)
        try:
            page.goto("https://www.douyin.com/?recommend=1", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(7000)
            for _ in range(2):
                page.mouse.wheel(0, 1400)
                page.wait_for_timeout(2500)
        except Exception:
            pass
        ctx.close()

    seen, out = set(), []
    for it in items:
        aid = str(it.get("aweme_id"))
        if aid in seen:
            continue
        seen.add(aid)
        v = it.get("video") or {}
        if not (v.get("duration") or 0):
            continue   # 图文/音乐帖没有视频流，跳过
        out.append({
            "id": aid,
            "desc": it.get("desc") or "",
            "author": (it.get("author") or {}).get("nickname") or "",
            "duration_ms": v.get("duration") or 0,
            "cover": ((v.get("cover") or {}).get("url_list") or [None])[0],
            "stats": {k: (it.get("statistics") or {}).get(k)
                      for k in ("digg_count", "comment_count", "share_count")},
        })
        if len(out) >= count:
            break
    return {"ok": True, "items": out}


def _pick_play(v):
    """从 video 里挑一个真正的视频地址；图文/纯音乐帖只有 mp3，要排除。"""
    cands = []
    for pa in [v.get("play_addr") or {}] + [(b.get("play_addr") or {}) for b in (v.get("bit_rate") or [])]:
        for u in (pa.get("url_list") or []):
            if not u or ".mp3" in u:
                continue
            cands.append(u)
    for u in cands:
        if "video/tos" in u or ".mp4" in u:
            return u
    return cands[0] if cands else ""


def detail(arg):
    from playwright.sync_api import sync_playwright

    m = re.search(r"/(?:video|note)/(\d{15,25})", arg)
    vid = m.group(1) if m else (arg if arg.isdigit() else "")
    if not vid:
        import urllib.request
        req = urllib.request.Request(arg, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=25) as r:
            m2 = re.search(r"/(?:video|note)/(\d{15,25})", r.geturl())
        vid = m2.group(1) if m2 else ""
    if not vid:
        return {"ok": False, "error": "解析不出视频 id"}

    hit = []
    with sync_playwright() as p:
        ctx = _launch(p)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        _collect(page, hit, want_id=vid)
        try:
            page.goto(f"https://www.douyin.com/video/{vid}", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(6000)
        except Exception:
            pass
        ctx.close()

    if not hit:
        return {"ok": False, "error": "没截到视频详情（可能被风控）", "id": vid}
    it = hit[-1]
    v = it.get("video") or {}
    play = _pick_play(v)
    return {
        "ok": bool(play),
        "id": it.get("aweme_id"),
        "desc": it.get("desc") or "",
        "author": (it.get("author") or {}).get("nickname") or "",
        "duration_ms": v.get("duration") or 0,
        "play": play,
        "stats": {k: (it.get("statistics") or {}).get(k)
                  for k in ("digg_count", "comment_count", "share_count")},
        "music": (it.get("music") or {}).get("title") or "",
        "error": "" if play else "没拿到播放地址",
    }


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    mode = sys.argv[1] if len(sys.argv) > 1 else "feed"
    arg = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        if mode == "feed":
            out = feed(int(arg) if arg else 8)
        elif mode == "video":
            out = detail(arg)
        else:
            out = {"ok": False, "error": f"未知模式 {mode}"}
    except Exception as e:  # noqa: BLE001
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
