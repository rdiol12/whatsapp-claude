/**
 * Skill companion: Gmail API
 *
 * Tools: list recent emails, search emails, read thread summary.
 * Requires GOOGLE_ACCESS_TOKEN with Gmail scope.
 */

import https from 'https';

const GMAIL_API = 'www.googleapis.com';

function gmailRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.GOOGLE_ACCESS_TOKEN;
    if (!token) return reject(new Error('No GOOGLE_ACCESS_TOKEN configured for Gmail access'));

    const opts = {
      method,
      hostname: GMAIL_API,
      path,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(`Gmail API ${res.statusCode}: ${data.error?.message || raw.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error(`Gmail API: invalid JSON response (${res.statusCode})`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gmail API timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function decodeBase64Url(str) {
  if (!str) return '';
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function extractHeaders(headers, names) {
  const result = {};
  for (const name of names) {
    const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
    result[name.toLowerCase()] = h?.value || '';
  }
  return result;
}

export const tools = [
  {
    name: 'gmail_list',
    description: 'List recent emails. Params: { maxResults?: number (default 10), label?: string (default INBOX) }',
    rateLimit: 3000,
    async execute(params) {
      const { maxResults = 10, label = 'INBOX' } = params;
      const path = `/gmail/v1/users/me/messages?maxResults=${maxResults}&labelIds=${encodeURIComponent(label)}`;
      const list = await gmailRequest('GET', path);

      const messages = [];
      for (const msg of (list.messages || []).slice(0, maxResults)) {
        try {
          const detail = await gmailRequest('GET', `/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          const h = extractHeaders(detail.payload?.headers, ['From', 'Subject', 'Date']);
          messages.push({
            id: msg.id,
            threadId: msg.threadId,
            from: h.from,
            subject: h.subject,
            date: h.date,
            snippet: (detail.snippet || '').slice(0, 200),
            unread: (detail.labelIds || []).includes('UNREAD'),
          });
        } catch {
          messages.push({ id: msg.id, error: 'Failed to fetch details' });
        }
      }

      return { messages, count: messages.length, totalEstimate: list.resultSizeEstimate || 0 };
    },
  },
  {
    name: 'gmail_search',
    description: 'Search Gmail. Params: { query: string (Gmail search syntax), maxResults?: number (default 5) }',
    rateLimit: 3000,
    async execute(params) {
      const { query, maxResults = 5 } = params;
      if (!query) throw new Error('query is required');

      const path = `/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`;
      const list = await gmailRequest('GET', path);

      const messages = [];
      for (const msg of (list.messages || []).slice(0, maxResults)) {
        try {
          const detail = await gmailRequest('GET', `/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          const h = extractHeaders(detail.payload?.headers, ['From', 'Subject', 'Date']);
          messages.push({
            id: msg.id,
            threadId: msg.threadId,
            from: h.from,
            subject: h.subject,
            date: h.date,
            snippet: (detail.snippet || '').slice(0, 200),
          });
        } catch {
          messages.push({ id: msg.id, error: 'Failed to fetch details' });
        }
      }

      return { messages, count: messages.length, query };
    },
  },
  {
    name: 'gmail_read_thread',
    description: 'Read a Gmail thread summary. Params: { threadId: string }',
    rateLimit: 3000,
    async execute(params) {
      const { threadId } = params;
      if (!threadId) throw new Error('threadId is required');

      const data = await gmailRequest('GET', `/gmail/v1/users/me/threads/${threadId}?format=full`);
      const msgs = (data.messages || []).map(msg => {
        const h = extractHeaders(msg.payload?.headers, ['From', 'Subject', 'Date']);
        let bodyText = '';

        // Extract plain text body
        if (msg.payload?.body?.data) {
          bodyText = decodeBase64Url(msg.payload.body.data);
        } else if (msg.payload?.parts) {
          const textPart = msg.payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            bodyText = decodeBase64Url(textPart.body.data);
          }
        }

        return {
          id: msg.id,
          from: h.from,
          subject: h.subject,
          date: h.date,
          body: bodyText.slice(0, 1000),
        };
      });

      return { threadId, messageCount: msgs.length, messages: msgs };
    },
  },
];
