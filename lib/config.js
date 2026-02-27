import { resolve } from 'path';

function envInt(key, fallback) {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

const projectRoot = process.env.PROJECT_ROOT || process.cwd();

function parseLlmBackendsFromEnv() {
  const result = [];
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('LLM_') || !key.endsWith('_ENABLED') || process.env[key] !== 'true') continue;
    const name = key.slice(4, -8).toLowerCase();
    const prefix = `LLM_${name.toUpperCase()}_`;
    result.push({
      name,
      baseUrl: process.env[`${prefix}BASE_URL`] || '',
      model: process.env[`${prefix}MODEL`] || '',
      hasApiKey: !!process.env[`${prefix}API_KEY`],
    });
  }
  return result;
}

const config = {
  // --- Core ---
  allowedPhone: process.env.ALLOWED_PHONE || '',
  claudeModel: process.env.CLAUDE_MODEL || 'sonnet',
  maxHistory: envInt('MAX_HISTORY', 20),

  // --- Paths ---
  projectRoot,
  authDir:       resolve(projectRoot, 'auth'),
  dataDir:       resolve(projectRoot, 'data'),
  workspaceDir:  resolve(projectRoot, 'workspace'),
  logsDir:       resolve(projectRoot, 'logs'),
  skillsDir:     resolve(projectRoot, 'skills'),
  pluginsDir:    resolve(projectRoot, 'plugins'),
  testDir:       resolve(projectRoot, 'test'),
  soulPath:      resolve(projectRoot, 'SOUL.md'),
  memoryPath:    resolve(projectRoot, 'MEMORY.md'),
  mcpConfigPath: resolve(projectRoot, 'mcp-config.json'),
  costsFile:     resolve(projectRoot, 'data', 'costs.jsonl'),

  // --- Timezone ---
  timezone: process.env.TIMEZONE || process.env.TZ || 'Asia/Jerusalem',

  // --- Queue ---
  maxConcurrent: envInt('MAX_CONCURRENT', 2),
  maxQueuePerUser: envInt('MAX_QUEUE_PER_USER', 5),

  // --- Timeouts (ms) ---
  cliTimeout: envInt('CLI_TIMEOUT', 900_000),              // Claude CLI absolute max (safety net)
  cliTimeoutHattrick: envInt('CLI_TIMEOUT_HATTRICK', 1_800_000), // Hattrick crons: 30min (MCP scraping is slow)
  cliActivityTimeout: envInt('CLI_ACTIVITY_TIMEOUT', 600_000), // Kill if no stdout for this long (10 min)
  composingTimeout: envInt('COMPOSING_TIMEOUT', 90_000), // "typing" stuck detection
  mcpToolTimeout: envInt('MCP_TOOL_TIMEOUT', 10_000),   // vestige tool calls
  mcpSearchTimeout: envInt('MCP_SEARCH_TIMEOUT', 5_000), // vestige searches

  // --- WhatsApp ---
  maxChunk: envInt('MAX_CHUNK', 4000),         // message length limit
  batchDelay: envInt('BATCH_DELAY', 2000),     // debounce rapid messages (ms)

  // --- Quiet hours (Israel time, 24h format) ---
  quietStart: envInt('QUIET_START', 23),       // 23:00
  quietEnd: envInt('QUIET_END', 8),            // 08:00

  // --- Proactive ---
  proactiveInterval: envInt('PROACTIVE_INTERVAL', 30 * 60_000), // 30 min

  // --- Agent Loop (autonomous ReAct cycle) ---
  agentLoopInterval: envInt('AGENT_LOOP_INTERVAL', 15 * 60_000), // 15 min
  agentLoopRoutineModel: process.env.AGENT_LOOP_ROUTINE_MODEL || 'haiku', // cheap model for reflection/low-signal
  agentLoopSonnetModel: process.env.AGENT_LOOP_SONNET_MODEL || process.env.CLAUDE_MODEL || 'sonnet', // full model for real work
  agentLoopMaxFollowups: envInt('AGENT_LOOP_MAX_FOLLOWUPS', 5),
  agentLoopBackoffThreshold: envInt('AGENT_LOOP_BACKOFF_THRESHOLD', 10), // skip after N consecutive spawns
  agentLoopAlwaysThinkEvery: envInt('AGENT_LOOP_ALWAYS_THINK_EVERY', 4), // reflection every Nth cycle
  agentLoopRecycleDelay: envInt('AGENT_LOOP_RECYCLE_DELAY', 2 * 60_000), // re-cycle delay after productive cycles (ms)
  agentLoopEngagementWindow: envInt('AGENT_LOOP_ENGAGEMENT_WINDOW', 30 * 60_000), // engagement tracking window (ms)

  // --- Costs ---
  dailyCostLimit: parseFloat(process.env.DAILY_COST_LIMIT || '1'),
  costTrackingDisabled: process.env.COST_TRACKING === 'false',


  // --- Persistent mode ---
  persistentMode: process.env.PERSISTENT_MODE === 'true',
  cacheKeepAlive: process.env.CACHE_KEEP_ALIVE !== 'false',    // Send ping every 4min to preserve API cache (default: on)
  cacheKeepAliveMs: envInt('CACHE_KEEP_ALIVE_MS', 4 * 60_000), // 4 minutes (Anthropic cache TTL = 5min)

  // --- Logs & Recap ---
  logRetentionDays: envInt('LOG_RETENTION_DAYS', 7),
  recapRetentionDays: envInt('RECAP_RETENTION_DAYS', 7),

  // --- Agent Brain (decision thresholds + pattern tracking) ---
  agentBrainAutoExecuteThreshold: parseFloat(process.env.AGENT_BRAIN_AUTO_EXECUTE_THRESHOLD || '0.9'),
  agentBrainProposeThreshold: parseFloat(process.env.AGENT_BRAIN_PROPOSE_THRESHOLD || '0.7'),
  agentBrainSuggestThreshold: parseFloat(process.env.AGENT_BRAIN_SUGGEST_THRESHOLD || '0.5'),
  agentBrainMinObserveThreshold: parseFloat(process.env.AGENT_BRAIN_MIN_OBSERVE_THRESHOLD || '0.3'),
  agentBrainMaxProposalsPerDay: envInt('AGENT_BRAIN_MAX_PROPOSALS_PER_DAY', 4),
  agentBrainMinHoursBetweenTopic: envInt('AGENT_BRAIN_MIN_HOURS_BETWEEN_TOPIC', 2),
  agentBrainRejectionCooldownDays: envInt('AGENT_BRAIN_REJECTION_COOLDOWN_DAYS', 3),
  agentBrainConfidenceDecayPerWeek: parseFloat(process.env.AGENT_BRAIN_CONFIDENCE_DECAY_PER_WEEK || '0.05'),
  agentBrainRejectionPenalty: parseFloat(process.env.AGENT_BRAIN_REJECTION_PENALTY || '0.15'),
  agentBrainConfidenceCap: parseFloat(process.env.AGENT_BRAIN_CONFIDENCE_CAP || '0.95'),
  agentBrainConfidenceIncrement: parseFloat(process.env.AGENT_BRAIN_CONFIDENCE_INCREMENT || '0.05'),
  agentBrainMaxPatterns: envInt('AGENT_BRAIN_MAX_PATTERNS', 100),

  // --- Daily Digest (morning LLM briefing) ---
  digestEnabled: process.env.DIGEST_ENABLED !== 'false',
  digestHour: envInt('DIGEST_HOUR', 8),
  digestModel: process.env.DIGEST_MODEL || process.env.CLAUDE_MODEL || 'sonnet',
  digestMaxNotesChars: envInt('DIGEST_MAX_NOTES_CHARS', 3000),
  digestMaxPromptChars: envInt('DIGEST_MAX_PROMPT_CHARS', 8000),

  // --- Memory Tiers (classification thresholds) ---
  memoryTiersMaxTracked: envInt('MEMORY_TIERS_MAX_TRACKED', 250),
  memoryTiersPreviewLen: envInt('MEMORY_TIERS_PREVIEW_LEN', 80),
  memoryTiersT1Threshold: parseFloat(process.env.MEMORY_TIERS_T1_THRESHOLD || '0.7'),
  memoryTiersT2Threshold: parseFloat(process.env.MEMORY_TIERS_T2_THRESHOLD || '0.4'),
  memoryTiersBaseWeightPreference: parseFloat(process.env.MEMORY_TIERS_BASE_WEIGHT_PREFERENCE || '0.7'),
  memoryTiersBaseWeightExplicit: parseFloat(process.env.MEMORY_TIERS_BASE_WEIGHT_EXPLICIT || '0.8'),
  memoryTiersBaseWeightPersonal: parseFloat(process.env.MEMORY_TIERS_BASE_WEIGHT_PERSONAL || '0.75'),
  memoryTiersBaseWeightDecision: parseFloat(process.env.MEMORY_TIERS_BASE_WEIGHT_DECISION || '0.65'),
  memoryTiersBaseWeightDeadline: parseFloat(process.env.MEMORY_TIERS_BASE_WEIGHT_DEADLINE || '0.6'),
  memoryTiersBaseWeightProject: parseFloat(process.env.MEMORY_TIERS_BASE_WEIGHT_PROJECT || '0.5'),
  memoryTiersBaseWeightAction: parseFloat(process.env.MEMORY_TIERS_BASE_WEIGHT_ACTION || '0.4'),
  memoryTiersBaseWeightFact: parseFloat(process.env.MEMORY_TIERS_BASE_WEIGHT_FACT || '0.4'),
  memoryTiersFrequencyBonusFactor: parseFloat(process.env.MEMORY_TIERS_FREQUENCY_BONUS_FACTOR || '0.1'),
  memoryTiersFrequencyBonusMax: parseFloat(process.env.MEMORY_TIERS_FREQUENCY_BONUS_MAX || '0.5'),
  memoryTiersFrequencyMultiplierCap: parseFloat(process.env.MEMORY_TIERS_FREQUENCY_MULTIPLIER_CAP || '1.5'),
  memoryTiersDecayPerWeek: parseFloat(process.env.MEMORY_TIERS_DECAY_PER_WEEK || '0.05'),

  // --- NLU Router (intent classification thresholds) ---
  nluConfidenceThreshold: parseFloat(process.env.NLU_CONFIDENCE_THRESHOLD || '0.6'),
  nluAmbiguityGap: parseFloat(process.env.NLU_AMBIGUITY_GAP || '0.15'),
  nluBonusPerExtra: parseFloat(process.env.NLU_BONUS_PER_EXTRA || '0.06'),
  nluMaxBonus: parseFloat(process.env.NLU_MAX_BONUS || '0.15'),

  // --- Claude (token limits + skill context) ---
  claudeSessionTokenLimit: envInt('CLAUDE_SESSION_TOKEN_LIMIT', 150_000),
  claudeSkillContextLimit: envInt('CLAUDE_SKILL_CONTEXT_LIMIT', 2000),

  // --- Context Gate (sliding budget + dedup + pressure) ---
  contextGateBudgetFull: envInt('CONTEXT_GATE_BUDGET_FULL', 3000),
  contextGateBudgetReduced: envInt('CONTEXT_GATE_BUDGET_REDUCED', 1500),
  contextGateBudgetMinimal: envInt('CONTEXT_GATE_BUDGET_MINIMAL', 500),
  contextGateBudgetCritical: envInt('CONTEXT_GATE_BUDGET_CRITICAL', 100),
  contextGatePressureLow: parseFloat(process.env.CONTEXT_GATE_PRESSURE_LOW || '0.30'),
  contextGatePressureMedium: parseFloat(process.env.CONTEXT_GATE_PRESSURE_MEDIUM || '0.60'),
  contextGatePressureHigh: parseFloat(process.env.CONTEXT_GATE_PRESSURE_HIGH || '0.80'),
  contextGateDedupWindow: envInt('CONTEXT_GATE_DEDUP_WINDOW', 3),

  // --- History (compression + retention) ---
  historyCompressThreshold: envInt('HISTORY_COMPRESS_THRESHOLD', 40),
  historyKeepRaw: envInt('HISTORY_KEEP_RAW', 10),
  historySaveDebounceMs: envInt('HISTORY_SAVE_DEBOUNCE_MS', 5000),

  // --- Proactive (scheduling) ---
  proactiveMaintenance: process.env.PROACTIVE_MAINTENANCE || '22:00 Saturday',
  proactiveGcDays: envInt('PROACTIVE_GC_DAYS', 90),

  // --- WebSocket Gateway (channel adapter server) ---
  wsGatewayPort: envInt('WS_GATEWAY_PORT', 18789),

  // --- MCP Gateway (connection management) ---
  mcpHealthCheckInterval: envInt('MCP_HEALTH_CHECK_INTERVAL', 5 * 60_000),
  mcpReconnectDelay: envInt('MCP_RECONNECT_DELAY', 60_000),
  mcpConnectionCacheTtl: envInt('MCP_CONNECTION_CACHE_TTL', 120_000),

  // --- Metrics (sampling + error tracking) ---
  metricsSampleSize: envInt('METRICS_SAMPLE_SIZE', 500),
  metricsErrorThreshold: envInt('METRICS_ERROR_THRESHOLD', 20),

  // --- Clarification (TTL for pending clarifications) ---
  clarificationTtlMs: envInt('CLARIFICATION_TTL_MS', 5 * 60_000),

  // --- User Notes (limits) ---
  userNotesMaxPerSession: envInt('USER_NOTES_MAX_PER_SESSION', 5),
  userNotesMaxChars: envInt('USER_NOTES_MAX_CHARS', 200),

  // --- Outcome Tracking (engagement rates) ---
  outcomeEngagementWindow: envInt('OUTCOME_ENGAGEMENT_WINDOW', 30 * 60_000),
  outcomeMinDeliveries: envInt('OUTCOME_MIN_DELIVERIES', 5),

  // --- Tool Bridge (Phase 1: external tool execution) ---
  toolBridgeEnabled: process.env.TOOL_BRIDGE_ENABLED !== 'false',
  toolBridgeRateLimit: envInt('TOOL_BRIDGE_RATE_LIMIT', 1000), // default ms between same-tool calls
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  githubToken: process.env.GITHUB_TOKEN || '',

  // --- Trust Engine (Phase 3: dynamic autonomy tiers) ---
  trustEngineEnabled: process.env.TRUST_ENGINE_ENABLED !== 'false',
  trustDecayPerWeek: parseFloat(process.env.TRUST_DECAY_PER_WEEK || '0.05'),
  trustMinSamples: envInt('TRUST_MIN_SAMPLES', 5),
  trustDestructiveMaxLevel: envInt('TRUST_DESTRUCTIVE_MAX_LEVEL', 1),

  // --- Confidence Gate (Phase 4: action scoring before execution) ---
  confidenceGateEnabled: process.env.CONFIDENCE_GATE_ENABLED !== 'false',
  confidenceGateMinScore: envInt('CONFIDENCE_GATE_MIN_SCORE', 4),

  // --- Prompt Assembler (Phase 4: system prompt optimization) ---
  promptTierDefault: process.env.PROMPT_TIER_DEFAULT || 'standard',
  promptMinimalMaxTokens: envInt('PROMPT_MINIMAL_MAX_TOKENS', 800),
  promptStandardMaxTokens: envInt('PROMPT_STANDARD_MAX_TOKENS', 2000),
  knowledgeExtractorEnabled: process.env.KNOWLEDGE_EXTRACTOR_ENABLED !== 'false',

  // --- Mood Engine (Phase 5: emotional intelligence) ---
  moodEngineEnabled: process.env.MOOD_ENGINE_ENABLED !== 'false',
  moodWindowMinutes: envInt('MOOD_WINDOW_MINUTES', 60),
  moodStressedSuppressProactive: process.env.MOOD_STRESSED_SUPPRESS_PROACTIVE !== 'false',

  // --- NVIDIA NIM (free API for routine agent cycles) ---
  nimEnabled: process.env.NIM_ENABLED === 'true',
  nimApiKey: process.env.NVIDIA_API_KEY || '',
  nimModel: process.env.NIM_MODEL || 'meta/llama-3.3-70b-instruct',

  // --- Ollama (local model — zero cost, runs on the user's i9-13900HX + 32GB RAM) ---
  // Recommended: qwen2.5-coder:7b (~4GB). Install: https://ollama.com, then `ollama pull qwen2.5-coder:7b`
  ollamaEnabled: process.env.OLLAMA_ENABLED === 'true',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',

  // --- LLM Router (pluggable backend support) ---
  // Auto-discovered from env: LLM_<NAME>_ENABLED=true, LLM_<NAME>_BASE_URL, LLM_<NAME>_API_KEY, LLM_<NAME>_MODEL
  // See lib/llm-router.js for details. Built-in backends: ollama, nim (configured above).
  llmBackends: parseLlmBackendsFromEnv(),

  // --- WhatsApp Alert Groups (route notifications to dedicated groups) ---
  waGroupAlerts: process.env.WA_GROUP_ALERTS || '',
  waGroupHattrick: process.env.WA_GROUP_HATTRICK || '',
  waGroupDaily: process.env.WA_GROUP_DAILY || '',

  // --- Hattrick (football manager game) ---
  hattrickTeamId: process.env.HATTRICK_TEAM_ID || null,
};

// Baileys uses JID format: <number>@s.whatsapp.net
config.allowedJid = config.allowedPhone + '@s.whatsapp.net';

export default config;
