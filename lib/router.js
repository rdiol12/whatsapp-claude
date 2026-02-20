/**
 * Message router — owns the full classification pipeline.
 * Determines how each message should be processed:
 *   - 'ack': Tier 0 acknowledgment (react only, no LLM)
 *   - 'action': Matched intent or slash command (local handler)
 *   - 'command': Unrecognized slash command (plugin hook)
 *   - 'claude': Falls through to Claude pipeline
 */

import { classifyTier } from './intent.js';
import { matchIntent } from './intent.js';

/**
 * Route a message to the appropriate handler.
 * @param {string} text - Raw message text
 * @returns {{ type: string, tier: number, action?: string, params?: object }}
 */
export function routeMessage(text) {
  const trimmed = text.trim();
  const cmd = trimmed.toLowerCase();

  // 1. Slash commands — exact match, highest priority
  const slashActions = {
    '/clear': 'clear', '/help': 'help', '/status': 'status',
    '/crons': 'crons', '/today': 'today', '/files': 'files',
    '/cost': 'cost', '/costs': 'cost', '/export': 'export',
    '/tasks': 'tasks', '/plugins': 'plugins',
    '/goals': 'goals',
    '/brain': 'brain',
    '/wf': 'workflows',
    '/workflows': 'workflows',
  };
  // /wf <subcommand> — parameterized
  if (cmd.startsWith('/wf ')) {
    const rest = trimmed.slice(4).trim();
    const spaceIdx = rest.indexOf(' ');
    const subCmd = spaceIdx > -1 ? rest.slice(0, spaceIdx).toLowerCase() : rest.toLowerCase();
    const arg = spaceIdx > -1 ? rest.slice(spaceIdx + 1).trim() : '';
    return { type: 'action', tier: 0, action: 'workflow-manage', params: { subCmd, arg } };
  }
  // /goal <subcommand> — parameterized
  if (cmd.startsWith('/goal ')) {
    const rest = trimmed.slice(6).trim();
    const spaceIdx = rest.indexOf(' ');
    const subCmd = spaceIdx > -1 ? rest.slice(0, spaceIdx).toLowerCase() : rest.toLowerCase();
    const arg = spaceIdx > -1 ? rest.slice(spaceIdx + 1).trim() : '';
    return { type: 'action', tier: 0, action: 'goal-manage', params: { subCmd, arg } };
  }
  // /task, /send, /plugin have parameters — partial match
  if (cmd.startsWith('/task ')) {
    return { type: 'claude', tier: 3, taskMode: true };
  }
  if (cmd.startsWith('/send ')) {
    return { type: 'action', tier: 0, action: 'send', params: { file: trimmed.slice(6).trim() } };
  }
  if (cmd.startsWith('/plugin ')) {
    const rest = trimmed.slice(8).trim();
    const [subCmd, ...nameWords] = rest.split(/\s+/);
    return { type: 'action', tier: 0, action: 'plugin-manage', params: { subCmd: subCmd?.toLowerCase(), name: nameWords.join(' ') } };
  }
  if (slashActions[cmd]) {
    return { type: 'action', tier: 0, action: slashActions[cmd], params: {} };
  }

  // 2. Tier classification
  const { tier } = classifyTier(text);

  // 3. Tier 0 — acknowledgments, no processing needed
  if (tier === 0) {
    return { type: 'ack', tier };
  }

  // 4. NLU intent matching
  const intent = matchIntent(text);
  if (intent) {
    return { type: 'action', tier, action: intent.action, params: intent.params || {} };
  }

  // 5. Unrecognized slash commands — try plugin hooks
  if (cmd.startsWith('/')) {
    return { type: 'command', tier, text: trimmed };
  }

  // 6. Everything else — Claude pipeline
  return { type: 'claude', tier };
}
