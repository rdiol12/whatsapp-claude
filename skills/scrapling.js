/**
 * Skill companion: Scrapling MCP (web scraping)
 *
 * Tools: web_scrape, web_scrape_bulk, web_scrape_dynamic, web_scrape_dynamic_bulk,
 *        web_scrape_stealth, web_scrape_stealth_bulk
 *
 * Spawns `scrapling mcp` as stdio MCP child process.
 * Lazy connection — connects on first tool call, auto-reconnects if process dies.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../lib/logger.js';

const log = createLogger('scrapling-mcp');

const SCRAPLING_PATH = process.env.SCRAPLING_PATH || 'scrapling';
const WIN_CA_BUNDLE = join(homedir(), '.ssl', 'cacert.pem');
const SINGLE_TIMEOUT = 30_000;
const BULK_TIMEOUT = 60_000;

let client = null;
let transport = null;
let connected = false;
let connecting = false;

// --- MCP Connection ---

async function connect() {
  if (connecting) return;
  connecting = true;

  try {
    if (client) {
      try { await client.close(); } catch {}
      client = null;
      transport = null;
      connected = false;
    }

    transport = new StdioClientTransport({
      command: SCRAPLING_PATH,
      args: ['mcp'],
      stderr: 'pipe',
      env: { ...process.env, SSL_CERT_FILE: WIN_CA_BUNDLE, CURL_CA_BUNDLE: WIN_CA_BUNDLE },
    });

    client = new Client(
      { name: 'sela-scrapling', version: '1.0.0' },
      { capabilities: {} },
    );

    client.onclose = () => {
      log.warn('scrapling-mcp connection closed');
      connected = false;
    };

    client.onerror = (err) => {
      log.warn({ err: err?.message || String(err) }, 'scrapling-mcp client error');
    };

    await client.connect(transport);
    connected = true;

    // Route stderr through logger
    const stderrStream = transport.stderr;
    if (stderrStream) {
      let buf = '';
      stderrStream.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.includes('ERROR')) log.error({ scrapling: trimmed }, 'scrapling-mcp stderr');
          else log.debug({ scrapling: trimmed }, 'scrapling-mcp stderr');
        }
      });
    }

    log.info('Connected to scrapling-mcp');
  } catch (err) {
    log.error({ err: err.message }, 'Failed to connect to scrapling-mcp');
    throw err;
  } finally {
    connecting = false;
  }
}

async function ensureConnected() {
  if (connected && client) return;
  await connect();
}

function extractText(result) {
  if (!result?.content) return '';
  return result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

async function callTool(name, args, timeout) {
  await ensureConnected();
  const start = Date.now();
  log.info({ tool: name, args: JSON.stringify(args).slice(0, 200) }, 'Calling scrapling tool');

  try {
    const result = await Promise.race([
      client.callTool({ name, arguments: args }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`scrapling ${name} timeout (${timeout}ms)`)), timeout),
      ),
    ]);
    const text = extractText(result);
    log.info({ tool: name, latencyMs: Date.now() - start, resultLen: text.length }, 'Scrapling tool OK');
    return text;
  } catch (err) {
    log.warn({ tool: name, err: err.message, latencyMs: Date.now() - start }, 'Scrapling tool FAILED');
    if (err.message?.includes('closed') || err.message?.includes('EPIPE')) {
      connected = false;
    }
    throw err;
  }
}

// --- Tool Definitions ---

export const tools = [
  {
    name: 'web_scrape',
    description: 'Scrape a URL using fast HTTP with TLS fingerprint impersonation. Params: { url: string, headless?: boolean, disable_resources?: boolean }',
    rateLimit: 2000,
    async execute(params) {
      if (!params.url) throw new Error('url is required');
      const content = await callTool('get', params, SINGLE_TIMEOUT);
      return { status: 'ok', url: params.url, content: content.slice(0, 50000) };
    },
  },
  {
    name: 'web_scrape_bulk',
    description: 'Scrape multiple URLs using fast HTTP (async). Params: { urls: string[], headless?: boolean, disable_resources?: boolean }',
    rateLimit: 5000,
    async execute(params) {
      if (!params.urls || !Array.isArray(params.urls) || params.urls.length === 0) {
        throw new Error('urls array is required');
      }
      const content = await callTool('bulk_get', params, BULK_TIMEOUT);
      return { status: 'ok', urls: params.urls, content: content.slice(0, 100000) };
    },
  },
  {
    name: 'web_scrape_dynamic',
    description: 'Scrape a URL with Playwright browser (JS rendering). Use for SPAs and JS-heavy pages. Params: { url: string, headless?: boolean, disable_resources?: boolean, wait_selector?: string, timeout?: number }',
    rateLimit: 2000,
    async execute(params) {
      if (!params.url) throw new Error('url is required');
      const content = await callTool('fetch', params, SINGLE_TIMEOUT);
      return { status: 'ok', url: params.url, content: content.slice(0, 50000) };
    },
  },
  {
    name: 'web_scrape_dynamic_bulk',
    description: 'Scrape multiple URLs with Playwright browser. Params: { urls: string[], headless?: boolean, disable_resources?: boolean, wait_selector?: string }',
    rateLimit: 5000,
    async execute(params) {
      if (!params.urls || !Array.isArray(params.urls) || params.urls.length === 0) {
        throw new Error('urls array is required');
      }
      const content = await callTool('bulk_fetch', params, BULK_TIMEOUT);
      return { status: 'ok', urls: params.urls, content: content.slice(0, 100000) };
    },
  },
  {
    name: 'web_scrape_stealth',
    description: 'Scrape a URL with Cloudflare/anti-bot bypass (stealth browser). Params: { url: string, headless?: boolean, disable_resources?: boolean, wait_selector?: string }',
    rateLimit: 2000,
    async execute(params) {
      if (!params.url) throw new Error('url is required');
      const content = await callTool('stealthy_fetch', params, SINGLE_TIMEOUT);
      return { status: 'ok', url: params.url, content: content.slice(0, 50000) };
    },
  },
  {
    name: 'web_scrape_stealth_bulk',
    description: 'Scrape multiple URLs with stealth browser (Cloudflare bypass). Params: { urls: string[], headless?: boolean, disable_resources?: boolean, wait_selector?: string }',
    rateLimit: 5000,
    async execute(params) {
      if (!params.urls || !Array.isArray(params.urls) || params.urls.length === 0) {
        throw new Error('urls array is required');
      }
      const content = await callTool('bulk_stealthy_fetch', params, BULK_TIMEOUT);
      return { status: 'ok', urls: params.urls, content: content.slice(0, 100000) };
    },
  },
];

// --- Lifecycle ---

export async function close() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    transport = null;
    connected = false;
    log.info('scrapling-mcp connection closed');
  }
}
