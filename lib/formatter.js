/**
 * WhatsApp-native response formatter.
 * Post-processes Claude's output for clean WhatsApp rendering.
 */

/**
 * Split a long message into WhatsApp-safe chunks at natural break points.
 * Tries paragraph breaks → newlines → spaces → hard cut (in that order).
 *
 * @param {string} text       Message text to chunk
 * @param {number} maxChunk   Maximum characters per chunk (default 3800)
 * @returns {string[]}        Array of chunks (1 item if text fits in one chunk)
 */
export function chunkMessage(text, maxChunk = 3800) {
  if (text.length <= maxChunk) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxChunk) {
    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', maxChunk);
    if (splitIdx < maxChunk * 0.3) {
      // No good paragraph break, try single newline
      splitIdx = remaining.lastIndexOf('\n', maxChunk);
    }
    if (splitIdx < maxChunk * 0.3) {
      // No good newline, try space
      splitIdx = remaining.lastIndexOf(' ', maxChunk);
    }
    if (splitIdx < maxChunk * 0.3) {
      // Hard cut
      splitIdx = maxChunk;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Convert a markdown table block to WhatsApp-friendly plain text.
 * Strips separator rows, removes pipes, joins cells with " | ".
 * First row (header) gets bold.
 */
function convertMarkdownTable(tableText) {
  const lines = tableText.trim().split('\n');
  const out = [];
  let isHeader = true;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip separator rows like |---|:---:|---|
    if (/^\|[-| :]+\|$/.test(trimmed)) {
      isHeader = false;
      continue;
    }
    // Parse cells
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map(c => c.trim())
      .filter(c => c.length > 0);
    if (cells.length === 0) continue;

    if (isHeader) {
      out.push('*' + cells.join(' | ') + '*');
      isHeader = false;
    } else {
      // First cell bold, rest joined with " | ", bullet prefix
      const [first, ...rest] = cells;
      const row = rest.length > 0
        ? `• *${first}* | ${rest.join(' | ')}`
        : `• ${first}`;
      out.push(row);
    }
  }

  return out.join('\n');
}

/**
 * Format text for WhatsApp display.
 * Converts markdown → WhatsApp formatting, trims long code blocks,
 * removes filler phrases.
 */
export function formatForWhatsApp(text) {
  if (!text) return text;
  let result = text;

  // Convert markdown tables to plain text (before header conversion)
  result = result.replace(/(?:^\|.+\|\s*$\n?)+/gm, (table) => convertMarkdownTable(table) + '\n');

  // Convert markdown headers to WhatsApp bold
  result = result.replace(/^#{1,3}\s+(.+)$/gm, '*$1*');

  // Convert markdown links to plain text + URL
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2');

  // Strip triple backtick language identifiers (WhatsApp doesn't render them)
  result = result.replace(/```\w+\n/g, '```\n');

  // Collapse triple+ newlines to double
  result = result.replace(/\n{3,}/g, '\n\n');

  // Trim overly long code blocks (>20 lines → truncate to 15)
  result = result.replace(/```[\s\S]*?```/g, (block) => {
    const lines = block.split('\n');
    if (lines.length > 20) {
      return lines.slice(0, 15).join('\n') + '\n... _(truncated)_\n```';
    }
    return block;
  });

  // Remove common AI filler phrases at the start
  result = result.replace(/^(Great question!|I'd be happy to help!|Sure thing!|Absolutely!|Of course!)\s*/gmi, '');

  return result.trim();
}
