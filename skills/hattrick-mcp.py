"""
Hattrick MCP Server — full browser automation for hattrick.org.

Uses scrapling's StealthyFetcher (anti-bot detection).
Every call: open browser → login if needed → navigate → extract/act.

Key tools:
  - hattrick_inspect: discover interactive elements (buttons, inputs, selects, forms)
  - hattrick_action: perform any browser action (click, fill, select, drag, check, goto)
  - hattrick_scrape: read any page content
  - hattrick_get_*: shortcut readers for common pages

The bot workflow: scrape → inspect → action → verify.

Run: python skills/hattrick-mcp.py
"""

import json
import os
import re

from mcp.server.fastmcp import FastMCP

# --- Config ---
DATA_DIR = os.path.join(os.path.expanduser("~"), "sela", "data", "hattrick-browser")
os.makedirs(DATA_DIR, exist_ok=True)

HATTRICK_USERNAME = os.environ.get("HATTRICK_USERNAME", "")
HATTRICK_PASSWORD = os.environ.get("HATTRICK_PASSWORD", "")
TEAM_ID = os.environ.get("HATTRICK_TEAM_ID", "")
LEAGUE_ID = os.environ.get("HATTRICK_LEAGUE_ID", "")
BASE = "https://www.hattrick.org"
TIMEOUT = 60_000

# SSL certs for Windows
CA_BUNDLE = os.path.join(os.path.expanduser("~"), ".ssl", "cacert.pem")
if os.path.exists(CA_BUNDLE):
    os.environ["SSL_CERT_FILE"] = CA_BUNDLE
    os.environ["CURL_CA_BUNDLE"] = CA_BUNDLE

mcp = FastMCP("hattrick")

# --- Session persistence (cookies + authenticated subdomain) ---
_session_file = os.path.join(DATA_DIR, "session.json")


def _load_session() -> dict:
    """Load saved session: {cookies: [...], auth_base: "https://www84.hattrick.org"}"""
    try:
        with open(_session_file, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_session(cookies: list, auth_base: str):
    """Save session for reuse on next call."""
    try:
        with open(_session_file, "w") as f:
            json.dump({"cookies": cookies, "auth_base": auth_base}, f)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Core browser engine
# ---------------------------------------------------------------------------

async def _open_page(target_url: str, page_callback=None, wait_ms: int = 3000) -> dict:
    """
    Open browser → reuse session if possible → login only if expired → navigate → extract.
    Session (cookies + auth subdomain) persists across calls.
    """
    from scrapling import StealthyFetcher

    if target_url.startswith("/"):
        target_url = BASE + target_url

    captured = {"text": "", "url": target_url, "links": [], "tables": [], "elements": [], "error": None}
    session = _load_session()
    saved_cookies = session.get("cookies", [])
    saved_auth_base = session.get("auth_base", "")

    async def flow(page):
        nonlocal saved_auth_base

        auth_base = saved_auth_base or BASE
        logged_in = False

        # --- Fast path: try saved session (cookies + known subdomain) ---
        if saved_cookies and saved_auth_base:
            try:
                await page.context.add_cookies(saved_cookies)

                # Navigate directly to target on the saved subdomain (skip homepage)
                fast_target = target_url.replace(BASE, saved_auth_base, 1) if target_url.startswith(BASE) else saved_auth_base + target_url if target_url.startswith("/") else target_url
                await page.goto(fast_target, wait_until="domcontentloaded", timeout=25000)
                await page.wait_for_timeout(2000)

                # Check if session is still valid (no login redirect)
                cur = page.url
                if "ReturnUrl" not in cur and "Startpage" not in cur:
                    # Check page has real content (not login page)
                    login_el = page.locator('text=Log In')
                    has_login = await login_el.count() > 0
                    if has_login:
                        try:
                            has_login = await login_el.first.is_visible()
                        except Exception:
                            has_login = False
                    if not has_login:
                        logged_in = True
                        auth_base = saved_auth_base
            except Exception:
                pass

        # --- Slow path: fresh login ---
        if not logged_in and HATTRICK_USERNAME and HATTRICK_PASSWORD:
            # Go to homepage
            await page.goto(f"{BASE}/en/", wait_until="networkidle", timeout=20000)
            await page.wait_for_timeout(1500)

            # Click "Log In" to reveal form
            login_el = page.locator('text=Log In')
            if await login_el.count() > 0 and await login_el.first.is_visible():
                await login_el.first.click()
                await page.wait_for_timeout(2000)

                await page.fill("#inputLoginname", HATTRICK_USERNAME)
                await page.fill("#inputPassword", HATTRICK_PASSWORD)
                await page.wait_for_timeout(500)

                submit = page.locator('button.primary-button:has-text("Log In")')
                await submit.click()

                try:
                    await page.wait_for_url("**/MyHattrick/**", timeout=15000)
                except Exception:
                    await page.wait_for_load_state("networkidle", timeout=10000)
                await page.wait_for_timeout(2000)

            # Capture authenticated subdomain (e.g. https://www84.hattrick.org)
            import re as _re
            m = _re.match(r"(https://[^/]+)", page.url)
            auth_base = m.group(1) if m else BASE

            # Save session for next call
            cookies = await page.context.cookies()
            _save_session(cookies, auth_base)

            # Navigate to target on the authenticated subdomain
            actual_target = target_url.replace(BASE, auth_base, 1) if target_url.startswith(BASE) else auth_base + target_url if target_url.startswith("/") else target_url
            await page.goto(actual_target, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(wait_ms)

        # Run callback (actions, inspection, etc.)
        if page_callback:
            await page_callback(page)

        # Extract page data
        captured["url"] = page.url
        captured["text"] = await page.evaluate("() => document.body.innerText")

        captured["links"] = await page.evaluate("""() =>
            Array.from(document.querySelectorAll('a[href]'))
                .map(a => ({ href: a.href, text: (a.innerText || '').trim().substring(0, 80) }))
                .filter(l => l.href && l.text && !l.href.startsWith('javascript:'))
                .slice(0, 60)
        """)

        captured["tables"] = await page.evaluate("""() =>
            Array.from(document.querySelectorAll('table')).slice(0, 10).map(t => ({
                rows: Array.from(t.querySelectorAll('tr')).map(tr =>
                    Array.from(tr.querySelectorAll('td, th')).map(c => (c.innerText || '').trim())
                ).filter(r => r.length > 0 && r.some(c => c))
            })).filter(t => t.rows.length > 0)
        """)

    try:
        await StealthyFetcher.async_fetch(
            f"{BASE}/en/",
            headless=True,
            network_idle=True,
            timeout=TIMEOUT,
            page_action=flow,
            user_data_dir=DATA_DIR,
            wait=1000,
        )
    except Exception as e:
        captured["error"] = str(e)

    return captured


def _trunc(text: str, limit: int = 4000) -> str:
    return text[:limit] + "\n...(truncated)" if len(text) > limit else text


def _filter_links(links: list, pattern: str) -> list:
    return [l for l in links if pattern.lower() in l.get("href", "").lower()]


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
async def hattrick_login() -> str:
    """Login to hattrick.org. Returns dashboard info and team ID."""
    if not HATTRICK_USERNAME or not HATTRICK_PASSWORD:
        return json.dumps({"error": "HATTRICK_USERNAME/PASSWORD env vars required"})

    data = await _open_page(f"{BASE}/en/MyHattrick/Dashboard.aspx")
    team_id = TEAM_ID
    for link in data.get("links", []):
        m = re.search(r"TeamID=(\d+)", link.get("href", ""))
        if m:
            team_id = m.group(1)
            break

    return json.dumps({
        "status": "error" if data.get("error") else "logged_in",
        "team_id": team_id,
        "url": data["url"],
        "text": _trunc(data["text"], 2000),
        "error": data.get("error"),
    })


@mcp.tool()
async def hattrick_scrape(url: str) -> str:
    """Read any hattrick.org page (auto-login). Returns page text, links, tables.

    Args:
        url: Full URL or path like '/en/Club/Players/?TeamID=YOUR_TEAM_ID'
    """
    data = await _open_page(url)
    return json.dumps({
        "url": data["url"],
        "text": _trunc(data["text"], 5000),
        "links": data["links"][:50],
        "tables": data["tables"],
        "error": data.get("error"),
    })


@mcp.tool()
async def hattrick_inspect(url: str) -> str:
    """Discover all interactive elements on a hattrick page. Use this BEFORE hattrick_action
    to find the correct selectors for buttons, dropdowns, inputs, checkboxes, etc.

    Returns for each element:
      - selector: CSS selector to use in hattrick_action
      - tag: HTML tag (button, input, select, a, etc.)
      - type: input type if applicable
      - text: visible label/text
      - value: current value
      - options: dropdown options (for <select> elements)
      - name/id: for identification
      - visible: whether element is visible on screen

    Args:
        url: Full URL or path to inspect
    """
    elements = []

    async def inspect(page):
        nonlocal elements
        elements = await page.evaluate("""() => {
            const results = [];
            const seen = new Set();

            function bestSelector(el) {
                if (el.id) return '#' + CSS.escape(el.id);
                if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
                // Build a path
                const path = [];
                let cur = el;
                while (cur && cur !== document.body) {
                    let seg = cur.tagName.toLowerCase();
                    if (cur.id) { seg = '#' + CSS.escape(cur.id); path.unshift(seg); break; }
                    if (cur.className && typeof cur.className === 'string') {
                        const cls = cur.className.trim().split(/\\s+/).slice(0, 2).join('.');
                        if (cls) seg += '.' + cls;
                    }
                    const parent = cur.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
                    }
                    path.unshift(seg);
                    cur = cur.parentElement;
                }
                return path.join(' > ');
            }

            // Buttons
            document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]').forEach(el => {
                const sel = bestSelector(el);
                if (seen.has(sel)) return;
                seen.add(sel);
                const rect = el.getBoundingClientRect();
                results.push({
                    selector: sel,
                    tag: el.tagName.toLowerCase(),
                    type: el.type || '',
                    text: (el.innerText || el.value || el.title || el.ariaLabel || '').trim().substring(0, 80),
                    value: el.value || '',
                    name: el.name || '',
                    id: el.id || '',
                    visible: rect.width > 0 && rect.height > 0,
                    disabled: el.disabled || false,
                    category: 'button'
                });
            });

            // Text inputs
            document.querySelectorAll('input[type="text"], input[type="email"], input[type="number"], input[type="search"], input[type="tel"], input[type="url"], input:not([type]), textarea').forEach(el => {
                if (el.type === 'hidden') return;
                const sel = bestSelector(el);
                if (seen.has(sel)) return;
                seen.add(sel);
                const rect = el.getBoundingClientRect();
                results.push({
                    selector: sel,
                    tag: el.tagName.toLowerCase(),
                    type: el.type || 'text',
                    text: el.placeholder || el.ariaLabel || '',
                    value: el.value || '',
                    name: el.name || '',
                    id: el.id || '',
                    visible: rect.width > 0 && rect.height > 0,
                    disabled: el.disabled || false,
                    category: 'input'
                });
            });

            // Dropdowns
            document.querySelectorAll('select').forEach(el => {
                const sel = bestSelector(el);
                if (seen.has(sel)) return;
                seen.add(sel);
                const rect = el.getBoundingClientRect();
                const options = Array.from(el.options).map(o => ({
                    value: o.value,
                    text: o.text.trim(),
                    selected: o.selected
                }));
                results.push({
                    selector: sel,
                    tag: 'select',
                    type: 'select',
                    text: el.ariaLabel || el.name || '',
                    value: el.value,
                    name: el.name || '',
                    id: el.id || '',
                    visible: rect.width > 0 && rect.height > 0,
                    disabled: el.disabled || false,
                    options: options,
                    category: 'dropdown'
                });
            });

            // Checkboxes and radios
            document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(el => {
                const sel = bestSelector(el);
                if (seen.has(sel)) return;
                seen.add(sel);
                const rect = el.getBoundingClientRect();
                // Try to find label
                let label = '';
                if (el.id) {
                    const lbl = document.querySelector('label[for="' + el.id + '"]');
                    if (lbl) label = lbl.innerText.trim();
                }
                if (!label && el.parentElement) label = el.parentElement.innerText.trim().substring(0, 80);
                results.push({
                    selector: sel,
                    tag: 'input',
                    type: el.type,
                    text: label,
                    value: el.value || '',
                    checked: el.checked,
                    name: el.name || '',
                    id: el.id || '',
                    visible: rect.width > 0 && rect.height > 0,
                    disabled: el.disabled || false,
                    category: 'checkbox'
                });
            });

            // Clickable links that look like actions (not navigation)
            document.querySelectorAll('a[href*="javascript:"], a[onclick], a.btn, a[role="button"]').forEach(el => {
                const sel = bestSelector(el);
                if (seen.has(sel)) return;
                seen.add(sel);
                const rect = el.getBoundingClientRect();
                results.push({
                    selector: sel,
                    tag: 'a',
                    type: 'link-action',
                    text: (el.innerText || el.title || '').trim().substring(0, 80),
                    href: el.href || '',
                    name: el.name || '',
                    id: el.id || '',
                    visible: rect.width > 0 && rect.height > 0,
                    category: 'action-link'
                });
            });

            return results.filter(r => r.visible);
        }""")

    data = await _open_page(url, page_callback=inspect)
    return json.dumps({
        "url": data["url"],
        "elements": elements,
        "element_count": len(elements),
        "text": _trunc(data["text"], 2000),
        "error": data.get("error"),
    })


@mcp.tool()
async def hattrick_action(url: str, actions: str) -> str:
    """Perform browser actions on a hattrick page (auto-login).

    Use hattrick_inspect first to discover element selectors!

    Args:
        url: Page URL or path
        actions: JSON array of action objects. Supported types:

            Click:     {"type": "click", "selector": "#myButton"}
            Fill:      {"type": "fill", "selector": "#myInput", "value": "text"}
            Select:    {"type": "select", "selector": "#myDropdown", "value": "optionValue"}
            Check:     {"type": "check", "selector": "#myCheckbox"}
            Uncheck:   {"type": "uncheck", "selector": "#myCheckbox"}
            Wait:      {"type": "wait", "ms": 2000}
            Goto:      {"type": "goto", "url": "/en/Club/Training/"}
            Evaluate:  {"type": "eval", "js": "document.title"}
            DragDrop:  {"type": "drag", "source": "#player1", "target": "#position1"}
            Hover:     {"type": "hover", "selector": "#element"}
            Press:     {"type": "press", "selector": "#input", "key": "Enter"}

        Selectors support CSS selectors and Playwright text selectors:
            "text=Save Changes" — matches element by visible text
            "#saveBtn" — matches by ID
            "button.primary" — matches by class

    Returns page text after all actions complete (for verification).
    """
    try:
        action_list = json.loads(actions)
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"Invalid JSON: {e}"})

    results = []

    async def run(page):
        for i, act in enumerate(action_list):
            t = act.get("type", "")
            sel = act.get("selector", "")
            val = act.get("value", "")
            try:
                if t == "click":
                    await page.click(sel, timeout=10000)
                elif t == "fill":
                    await page.fill(sel, val, timeout=10000)
                elif t == "select":
                    await page.select_option(sel, val, timeout=10000)
                elif t == "check":
                    await page.check(sel, timeout=10000)
                elif t == "uncheck":
                    await page.uncheck(sel, timeout=10000)
                elif t == "hover":
                    await page.hover(sel, timeout=10000)
                elif t == "press":
                    key = act.get("key", "Enter")
                    await page.press(sel, key, timeout=10000)
                elif t == "goto":
                    goto_url = act.get("url", "")
                    if goto_url.startswith("/"):
                        goto_url = BASE + goto_url
                    await page.goto(goto_url, wait_until="networkidle", timeout=20000)
                    await page.wait_for_timeout(2000)
                elif t == "eval":
                    js = act.get("js", "")
                    eval_result = await page.evaluate(js)
                    results.append({"i": i, "type": t, "ok": True, "result": str(eval_result)[:500]})
                    continue
                elif t == "drag":
                    src = act.get("source", "")
                    tgt = act.get("target", "")
                    await page.drag_and_drop(src, tgt, timeout=10000)
                elif t == "wait":
                    await page.wait_for_timeout(int(act.get("ms", 2000)))
                else:
                    results.append({"i": i, "error": f"unknown: {t}"})
                    continue
                results.append({"i": i, "type": t, "ok": True})
            except Exception as e:
                results.append({"i": i, "type": t, "error": str(e)[:200]})

        await page.wait_for_timeout(1500)

    data = await _open_page(url, page_callback=run)
    return json.dumps({
        "url": data["url"],
        "actions": results,
        "text": _trunc(data["text"], 3000),
        "error": data.get("error"),
    })


# ---------------------------------------------------------------------------
# Shortcut read tools
# ---------------------------------------------------------------------------

@mcp.tool()
async def hattrick_get_team() -> str:
    """Get team overview — name, league, rating, stadium, manager info."""
    data = await _open_page(f"/en/Club/?TeamID={TEAM_ID}")
    return json.dumps({
        "team_id": TEAM_ID,
        "text": _trunc(data["text"]),
        "links": _filter_links(data["links"], "TeamID")[:20],
        "tables": data["tables"][:5],
        "error": data.get("error"),
    })


@mcp.tool()
async def hattrick_get_players() -> str:
    """Get full player roster — names, ages, skills, TSI, salary, specialty."""
    data = await _open_page(f"/en/Club/Players/?TeamID={TEAM_ID}")
    return json.dumps({
        "team_id": TEAM_ID,
        "text": _trunc(data["text"], 6000),
        "player_links": _filter_links(data["links"], "playerID")[:30],
        "tables": data["tables"],
        "error": data.get("error"),
    })


@mcp.tool()
async def hattrick_get_matches() -> str:
    """Get upcoming and recent match fixtures."""
    data = await _open_page(f"/en/Club/Matches/?TeamID={TEAM_ID}")
    return json.dumps({
        "team_id": TEAM_ID,
        "text": _trunc(data["text"]),
        "match_links": _filter_links(data["links"], "matchID")[:20],
        "tables": data["tables"][:5],
        "error": data.get("error"),
    })


@mcp.tool()
async def hattrick_get_training() -> str:
    """Get current training type, intensity, and player training status."""
    data = await _open_page("/en/Club/Training/")
    return json.dumps({
        "text": _trunc(data["text"]),
        "tables": data["tables"][:5],
        "error": data.get("error"),
    })


@mcp.tool()
async def hattrick_get_economy() -> str:
    """Get club finances — cash, weekly income/expenses, sponsors, arena."""
    data = await _open_page("/en/Club/Finances/")
    return json.dumps({
        "text": _trunc(data["text"]),
        "tables": data["tables"][:5],
        "error": data.get("error"),
    })


@mcp.tool()
async def hattrick_get_league() -> str:
    """Get league table for team's current division."""
    data = await _open_page(f"/en/World/Series/?LeagueLevelUnitID={LEAGUE_ID}")
    return json.dumps({
        "league_id": LEAGUE_ID,
        "text": _trunc(data["text"]),
        "tables": data["tables"][:5],
        "error": data.get("error"),
    })


if __name__ == "__main__":
    mcp.run(transport="stdio")
