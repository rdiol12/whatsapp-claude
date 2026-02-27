/**
 * Skill companion: Google Calendar API
 *
 * Tools: list_events, create_event, check_availability
 * Uses Google API key from environment (GOOGLE_API_KEY) or OAuth token.
 *
 * For OAuth, requires access token in GOOGLE_ACCESS_TOKEN env var.
 * Calendar operations use the primary calendar by default.
 */

import https from 'https';
import config from '../lib/config.js';

const CALENDAR_API = 'www.googleapis.com';
const DEFAULT_CALENDAR = 'primary';

function getAuth() {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (token) return { type: 'oauth', value: token };
  if (apiKey) return { type: 'apikey', value: apiKey };
  return null;
}

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const auth = getAuth();
    if (!auth) return reject(new Error('No Google API credentials configured (set GOOGLE_ACCESS_TOKEN or GOOGLE_API_KEY)'));

    const headers = { 'Content-Type': 'application/json' };
    let fullPath = path;

    if (auth.type === 'oauth') {
      headers['Authorization'] = `Bearer ${auth.value}`;
    } else {
      fullPath += (fullPath.includes('?') ? '&' : '?') + `key=${auth.value}`;
    }

    const opts = {
      method,
      hostname: CALENDAR_API,
      path: fullPath,
      headers,
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
            reject(new Error(`Google API ${res.statusCode}: ${data.error?.message || raw.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error(`Google API: invalid JSON response (${res.statusCode})`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Google Calendar API timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export const tools = [
  {
    name: 'google_calendar_list',
    description: 'List upcoming Google Calendar events. Params: { days?: number (default 7), maxResults?: number (default 10) }',
    rateLimit: 3000,
    async execute(params) {
      const { days = 7, maxResults = 10, calendarId = DEFAULT_CALENDAR } = params;

      const now = new Date();
      const future = new Date(now.getTime() + days * 86400_000);
      const timeMin = now.toISOString();
      const timeMax = future.toISOString();

      const path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${timeMin}&timeMax=${timeMax}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`;
      const data = await apiRequest('GET', path);

      return {
        events: (data.items || []).map(e => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          location: e.location || null,
          description: (e.description || '').slice(0, 200),
          status: e.status,
          attendees: (e.attendees || []).map(a => a.email).slice(0, 5),
        })),
        count: (data.items || []).length,
      };
    },
  },
  {
    name: 'google_calendar_create',
    description: 'Create a Google Calendar event. Params: { summary, startTime (ISO), endTime (ISO), description?, location?, attendees?: string[] }',
    rateLimit: 5000,
    async execute(params) {
      const { summary, startTime, endTime, description = '', location = '', attendees = [], calendarId = DEFAULT_CALENDAR } = params;

      if (!summary || !startTime || !endTime) {
        throw new Error('summary, startTime, and endTime are required');
      }

      const event = {
        summary,
        description,
        location,
        start: { dateTime: startTime, timeZone: config.timezone },
        end: { dateTime: endTime, timeZone: config.timezone },
      };

      if (attendees.length > 0) {
        event.attendees = attendees.map(email => ({ email }));
      }

      const path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      const data = await apiRequest('POST', path, event);

      return {
        id: data.id,
        summary: data.summary,
        start: data.start?.dateTime || data.start?.date,
        end: data.end?.dateTime || data.end?.date,
        htmlLink: data.htmlLink,
        created: true,
      };
    },
  },
  {
    name: 'google_calendar_availability',
    description: 'Check free/busy status for a time range. Params: { startTime (ISO), endTime (ISO) }',
    rateLimit: 3000,
    async execute(params) {
      const { startTime, endTime } = params;
      if (!startTime || !endTime) {
        throw new Error('startTime and endTime are required');
      }

      const body = {
        timeMin: startTime,
        timeMax: endTime,
        items: [{ id: DEFAULT_CALENDAR }],
      };

      const data = await apiRequest('POST', '/calendar/v3/freeBusy', body);
      const busy = data.calendars?.[DEFAULT_CALENDAR]?.busy || [];

      return {
        busy: busy.map(b => ({ start: b.start, end: b.end })),
        free: busy.length === 0,
        busyCount: busy.length,
      };
    },
  },
];
