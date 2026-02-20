#!/usr/bin/env node
/**
 * Skills MCP Server
 *
 * Exposes WhatsApp bot skills via MCP so Claude can load them on demand
 * instead of stuffing all 50K chars into every prompt.
 *
 * Tools:
 *   list_skills  — returns skill names + first-line summaries
 *   get_skill    — returns full content of a single skill
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

const SKILLS_DIR = join(import.meta.dirname, 'skills');

function getSkillFiles() {
  try {
    return readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
}

function firstLine(content) {
  // Skip leading headings/blank lines, return first meaningful line
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed.slice(0, 120);
    }
  }
  return '(no description)';
}

const server = new McpServer({
  name: 'skills',
  version: '1.0.0',
});

server.tool(
  'list_skills',
  'List all available skills with short descriptions',
  {},
  async () => {
    const files = getSkillFiles();
    const listing = files.map(f => {
      const name = f.replace(/\.md$/, '');
      try {
        const content = readFileSync(join(SKILLS_DIR, f), 'utf-8');
        return `- ${name}: ${firstLine(content)}`;
      } catch {
        return `- ${name}: (unreadable)`;
      }
    });
    return {
      content: [{ type: 'text', text: listing.join('\n') || 'No skills available.' }],
    };
  }
);

server.tool(
  'get_skill',
  'Get the full content of a skill by name',
  { name: z.string().describe('The skill name (e.g. "weather", "github")') },
  async ({ name }) => {
    const safeName = name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
    const filePath = join(SKILLS_DIR, `${safeName}.md`);
    try {
      const content = readFileSync(filePath, 'utf-8');
      return {
        content: [{ type: 'text', text: content }],
      };
    } catch {
      const available = getSkillFiles().map(f => f.replace(/\.md$/, ''));
      return {
        content: [{ type: 'text', text: `Skill "${name}" not found. Available: ${available.join(', ')}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
