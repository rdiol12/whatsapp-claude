// Auto-extracted from dashboard.js
export const COST_ANALYTICS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Cost Analytics</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#x1f4b0;</text></svg>">
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;500;700;800&display=swap');
  :root {
    --bg: #0a0a0f; --surface: #111118; --surface2: #16161f; --border: #1e1e2e; --border2: #2a2a3e;
    --text: #e2e2f0; --text2: #8888aa; --text3: #444466;
    --accent: #7c6af7; --accent2: #a78bfa; --green: #22d3a0; --yellow: #f59e0b; --red: #f43f5e; --cyan: #22d3ee;
    --font-display: 'Syne', sans-serif; --font-mono: 'JetBrains Mono', monospace; --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-mono); background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px; max-width: 720px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
  .header a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .header h1 { font-family: var(--font-display); font-size: 20px; font-weight: 700; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 14px; }
  .card-title { font-family: var(--font-display); font-size: 13px; font-weight: 600; margin-bottom: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }
  .progress-bar { height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 2px; transition: width 0.6s ease; }
  .metrics { display: grid; gap: 8px; }
  .metric { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
  .metric-label { font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
  .metric-value { font-size: 18px; font-weight: 600; }
  .metric-value.accent { color: var(--accent2); }
  .metric-sub { font-size: 10px; color: var(--text3); margin-top: 2px; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .row:last-child { border-bottom: none; }
  .row-label { color: var(--text3); }
  .empty { text-align: center; padding: 40px; color: var(--text3); font-size: 13px; }
  .refresh-btn { background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 4px 10px; color: var(--text2); font-family: var(--font-mono); font-size: 11px; cursor: pointer; }
  .refresh-btn:hover { border-color: var(--accent); color: var(--text); }
</style>
</head>
<body>
<div class="header">
  <a href="/">&larr; Dashboard</a>
  <h1>Cost Analytics</h1>
  <button class="refresh-btn" onclick="load()">&circlearrowright; Refresh</button>
</div>
<div id="budget"></div>
<div id="metrics"></div>
<div id="chart"></div>
<script>
  var API_BASE = '/api';
  async function api(path) {
    var r = await fetch(API_BASE + path, { credentials: 'same-origin' });
    return r.json();
  }

  async function load() {
    try {
      var results = await Promise.allSettled([api('/costs/summary'), api('/costs?period=week')]);
      var d = (results[0].value) || {};
      var weekData = (results[1].value) || {};
      var budgetLimit = 5;

      var todaySpend = d.today ? d.today.total : 0;
      var budgetPct = Math.min(Math.round((todaySpend / budgetLimit) * 100), 100);
      var budgetColor = budgetPct >= 90 ? 'var(--red)' : budgetPct >= 60 ? 'var(--yellow)' : 'var(--green)';

      document.getElementById('budget').innerHTML = '<div class="card">' +
        '<div class="card-title">Daily Budget</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">' +
          '<span style="color:var(--text2)">Today</span>' +
          '<span style="color:' + budgetColor + ';font-weight:600">$' + todaySpend.toFixed(2) + ' / $' + budgetLimit.toFixed(0) + '</span>' +
        '</div>' +
        '<div class="progress-bar" style="height:6px"><div class="progress-fill" style="width:' + budgetPct + '%;background:' + budgetColor + '"></div></div>' +
      '</div>';

      document.getElementById('metrics').innerHTML = '<div class="card">' +
        '<div class="card-title">Summary</div>' +
        '<div class="metrics" style="grid-template-columns:1fr 1fr;margin-bottom:10px">' +
          '<div class="metric"><div class="metric-label">Today</div><div class="metric-value accent">$' + (d.today ? d.today.total : 0).toFixed(2) + '</div><div class="metric-sub">' + (d.today ? d.today.count : 0) + ' turns</div></div>' +
          '<div class="metric"><div class="metric-label">Yesterday</div><div class="metric-value">$' + (d.yesterday ? d.yesterday.total : 0).toFixed(2) + '</div><div class="metric-sub">' + (d.yesterday ? d.yesterday.count : 0) + ' turns</div></div>' +
        '</div>' +
        '<div class="metrics" style="grid-template-columns:1fr 1fr;margin-bottom:10px">' +
          '<div class="metric"><div class="metric-label">This Week</div><div class="metric-value">$' + (d.weekTotal||0).toFixed(2) + '</div><div class="metric-sub">' + (d.weekCount||0) + ' turns</div></div>' +
          '<div class="metric"><div class="metric-label">This Month</div><div class="metric-value">$' + (d.monthTotal||0).toFixed(2) + '</div><div class="metric-sub">' + (d.monthCount||0) + ' turns</div></div>' +
        '</div>' +
        '<div class="row"><span class="row-label">Daily avg</span><span style="color:var(--text2)">$' + (d.dailyAvg||0).toFixed(2) + '</span></div>' +
        (d.topDay && d.topDay.cost > 0 ? '<div class="row"><span class="row-label">Top day</span><span style="color:var(--accent2)">' + d.topDay.date + ' ($' + d.topDay.cost.toFixed(2) + ')</span></div>' : '') +
      '</div>';

      // 7-day bar chart
      var byDay = weekData.byDay || {};
      var days = Object.keys(byDay).sort();
      if (days.length > 1) {
        var maxCost = Math.max.apply(null, days.map(function(k){ return byDay[k].cost; })) || 1;
        var chartHtml = '<div class="card"><div class="card-title">Last 7 Days</div>' +
          '<div style="display:flex;align-items:flex-end;gap:4px;height:100px">';
        days.slice(-7).forEach(function(day) {
          var cost = byDay[day].cost;
          var pct = Math.max(Math.round((cost / maxCost) * 100), 4);
          var dayLabel = day.slice(5);
          var barColor = cost > budgetLimit ? 'var(--red)' : 'var(--accent)';
          chartHtml += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">' +
            '<div style="font-size:9px;color:var(--text2)">$' + cost.toFixed(2) + '</div>' +
            '<div style="width:100%;height:' + pct + '%;background:' + barColor + ';border-radius:3px 3px 0 0;min-height:2px;transition:height 0.3s"></div>' +
            '<div style="font-size:9px;color:var(--text3)">' + dayLabel + '</div>' +
          '</div>';
        });
        chartHtml += '</div></div>';
        document.getElementById('chart').innerHTML = chartHtml;
      } else {
        document.getElementById('chart').innerHTML = '';
      }
    } catch(e) {
      document.getElementById('budget').innerHTML = '<div class="empty">Failed to load cost data: ' + e.message + '</div>';
    }
  }
  load();
</script>
</body>
</html>`;
