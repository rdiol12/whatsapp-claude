/**
 * Proposal tracker plugin — captures user feedback on agent brain proposals.
 *
 * Uses preChat hook to intercept responses to pending proposals before
 * they hit the Claude pipeline (saves tokens + faster response).
 *
 * Approval/rejection/snooze signals are detected and routed to agent-brain.js.
 */

export const meta = {
  name: 'proposal-tracker',
  version: '1.1.0',
  description: 'Tracks user responses to agent brain proposals',
  priority: 10, // Run early — before other preChat hooks
};

// Dynamic import to avoid circular dependency at module load time
let checkProposalResponse = null;

export async function onStartup(botApi) {
  try {
    const brain = await import('../lib/agent-brain.js');
    checkProposalResponse = brain.checkProposalResponse;
    botApi.log.info('[proposal-tracker] Plugin started');
  } catch (err) {
    botApi.log.warn({ err: err.message }, '[proposal-tracker] Failed to load agent-brain');
  }
}

/**
 * preChat hook — fires before message goes to Claude.
 * Signature: (text, history, botApi)
 * If the message is a response to a pending proposal, handle it here
 * and return { handled: true } to skip the Claude call.
 */
export async function preChat(text, history, botApi) {
  if (!checkProposalResponse || !text) return;

  const result = checkProposalResponse(text);
  if (!result) return; // Not a response to a proposal

  const { feedback, proposal } = result;

  if (feedback === 'snoozed') {
    if (botApi.send) await botApi.send('OK, I\'ll remind you later.');
    return { handled: true };
  }

  // approved or rejected — both go to LLM
  const action = feedback === 'approved' ? 'approve' : 'reject';
  const label = feedback === 'approved' ? 'On it...' : 'Noted, handling rejection...';
  botApi.log.info({ proposalKey: proposal.patternKey, action }, 'Proposal sent to LLM');
  if (botApi.send) await botApi.send(label);

  try {
    const { executeApprovedAction } = await import('../lib/agent-brain.js');
    await executeApprovedAction(proposal, botApi.send, action);
  } catch (err) {
    botApi.log.warn({ err: err.message }, 'Failed to handle proposal via LLM');
    if (botApi.send) await botApi.send(`Hit an error: ${err.message}`);
  }

  return { handled: true };
}
