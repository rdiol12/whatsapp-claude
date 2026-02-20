/**
 * WhatsApp-native response formatter.
 * Post-processes Claude's output for clean WhatsApp rendering.
 */

/**
 * Format text for WhatsApp display.
 * Converts markdown → WhatsApp formatting, trims long code blocks,
 * removes filler phrases.
 */
export function formatForWhatsApp(text) {
  if (!text) return text;
  let result = text;

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
