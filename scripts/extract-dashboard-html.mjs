import { readFileSync, writeFileSync, mkdirSync } from 'fs';

var content = readFileSync('./dashboard.js', 'utf8');

var templates = [
  ['login', 'LOGIN_HTML'],
  ['agent', 'AGENT_HTML'],
  ['review', 'REVIEW_HTML'],
  ['analytics', 'COST_ANALYTICS_HTML'],
  ['board', 'BOARD_HTML'],
  ['history', 'HISTORY_HTML'],
  ['errors', 'ERRORS_HTML'],
  ['approvals', 'APPROVALS_HTML'],
  ['ideas', 'IDEAS_HTML'],
];

mkdirSync('./lib/dashboard-html', { recursive: true });

for (var t = 0; t < templates.length; t++) {
  var filename = templates[t][0];
  var varName = templates[t][1];
  var prefix = 'const ' + varName + ' = ' + String.fromCharCode(96);
  var declStart = content.indexOf(prefix);
  if (declStart === -1) { console.error('NOT FOUND: ' + varName); continue; }
  var backtickStart = declStart + prefix.length - 1;
  var i = backtickStart + 1;
  var depth = 0;
  while (i < content.length) {
    var ch = content[i];
    if (ch === String.fromCharCode(92)) { i += 2; continue; }
    if (ch === String.fromCharCode(96) && depth === 0) break;
    if (ch === '$' && content[i + 1] === '{') { depth++; i += 2; continue; }
    if (ch === '}' && depth > 0) { depth--; i++; continue; }
    i++;
  }
  var htmlContent = content.slice(backtickStart + 1, i);
  var BT = String.fromCharCode(96);
  var moduleContent = '// Auto-extracted from dashboard.js
export const ' + varName + ' = ' + BT + htmlContent + BT + ';
';
  writeFileSync('./lib/dashboard-html/' + filename + '.js', moduleContent);
  var lineCount = moduleContent.split('
').length - 1;
  console.log('Written: lib/dashboard-html/' + filename + '.js  (' + htmlContent.length + ' chars, ' + lineCount + ' lines)');
}

console.log('Extraction complete.');
