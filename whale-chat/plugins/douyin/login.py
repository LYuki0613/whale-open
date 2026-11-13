# 抖音扫码登录：开有头 Edge → 点「登录」→ 等 sessionid 落盘。
# 成功判据只有 sessionid / sid_guard（passport_csrf_token 未登录也有，不能用）。
import sys
import time

from playwright.sync_api import sync_playwright

PROFILE = sys.argv[1]
TIMEOUT = int(sys.argv[2]) if len(sys.argv) > 2 else 300
SHOT = sys.argv[3] if len(sys.argv) > 3 else ""


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            PROFILE, channel="msedge", headless=False, viewport=None,
            args=["--start-maximized"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)

        # 点那个真正的「登录」按钮（semi-button），多试几种选择器
        clicked = False
        for sel in ["button.semi-button-primary:has-text('登录')",
                    "button:has-text('登录')",
                    "div.semi-button:has-text('登录')"]:
            try:
                page.click(sel, timeout=4000)
                clicked = True
                break
            except Exception:
                continue
        print("clicked:", clicked, flush=True)
        page.wait_for_timeout(3000)
        if SHOT:
            try:
                page.screenshot(path=SHOT)
                print("shot:", SHOT, flush=True)
            except Exception as e:
                print("shot err:", e, flush=True)

        deadline = time.time() + TIMEOUT
        ok = False
        while time.time() < deadline:
            try:
                names = {c["name"] for c in ctx.cookies()}
            except Exception:
                names = set()
            if "sessionid" in names or "sid_guard" in names:
                ok = True
                break
            time.sleep(2)
        time.sleep(2)
        print("LOGIN_OK" if ok else "LOGIN_TIMEOUT", flush=True)
        ctx.close()


if __name__ == "__main__":
    main()
