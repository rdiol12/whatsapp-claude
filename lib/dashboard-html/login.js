// Auto-extracted from dashboard.js
export const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f"><title>Dashboard Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e2e2f0;font-family:'JetBrains Mono',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center}
.login-box{background:#111118;border:1px solid #1e1e2e;border-radius:10px;padding:32px;width:340px;max-width:92vw}
.login-title{font-family:'Syne',sans-serif;font-weight:700;font-size:18px;margin-bottom:6px;display:flex;align-items:center;gap:10px}
.login-logo{width:32px;height:32px;background:linear-gradient(135deg,#7c6af7,#22d3ee);border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:white}
.login-sub{color:#444466;font-size:11px;margin-bottom:20px}
.login-input{width:100%;background:#16161f;border:1px solid #1e1e2e;border-radius:6px;padding:10px 14px;color:#e2e2f0;font-family:inherit;font-size:13px;outline:none;margin-bottom:14px}
.login-input:focus{border-color:#7c6af7}
.login-btn{width:100%;background:#7c6af7;border:none;border-radius:6px;padding:10px;color:white;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:background 0.15s}
.login-btn:hover{background:#a78bfa}
.login-err{color:#f43f5e;font-size:11px;margin-top:10px;text-align:center;display:none}
</style></head><body>
<div class="login-box">
<div class="login-title"><div class="login-logo">A</div>Agent Dashboard</div>
<div class="login-sub">Enter password to access the dashboard</div>
<form method="POST" action="/login">
<input class="login-input" type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button class="login-btn" type="submit">Sign In</button>
</form>
<div class="login-err" id="err">Invalid password</div>
<div class="login-err" id="lockErr">Too many attempts. Try again in 5 minutes.</div>
</div>
<script>
if(location.search.includes('error=1'))document.getElementById('err').style.display='block';
if(location.search.includes('error=locked'))document.getElementById('lockErr').style.display='block';
</script>
</body></html>`;
