/**
 * Skill companion: Desktop Screenshot
 *
 * Captures the primary display via PowerShell's System.Drawing API
 * and saves as PNG in the workspace directory. Claude can then use
 * [SEND_FILE: path] to send the image back to WhatsApp.
 *
 * Auto-cleans screenshots older than 1 hour on each capture.
 */

import { execSync } from 'child_process';
import { join } from 'path';
import { statSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import config from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('screenshot');
const WORKSPACE = config.workspaceDir;
const MAX_AGE_MS = 60 * 60_000; // 1 hour
const PS_SCRIPT = join(WORKSPACE, '_screenshot.ps1');

function cleanOldScreenshots() {
  try {
    const now = Date.now();
    for (const f of readdirSync(WORKSPACE)) {
      if (f.startsWith('screenshot-') && f.endsWith('.png')) {
        const full = join(WORKSPACE, f);
        try {
          if (now - statSync(full).mtimeMs > MAX_AGE_MS) {
            unlinkSync(full);
          }
        } catch {}
      }
    }
  } catch {}
}

export const tools = [
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the desktop. Returns { path, size }. After calling this, use [SEND_FILE: <path>] to send the image to WhatsApp.',
    rateLimit: 5000,
    async execute() {
      cleanOldScreenshots();

      const fileName = `screenshot-${Date.now()}.png`;
      const outPath = join(WORKSPACE, fileName);

      // Write a temp .ps1 script to avoid shell quoting issues
      writeFileSync(PS_SCRIPT, [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
        '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
        `$bmp.Save('${outPath.replace(/'/g, "''")}')`,
        '$g.Dispose()',
        '$bmp.Dispose()',
      ].join('\n'));

      try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${PS_SCRIPT}"`, {
          timeout: 15_000,
          windowsHide: true,
        });
      } catch (err) {
        log.error({ err: err.message }, 'Screenshot capture failed');
        throw new Error(`Screenshot failed: ${err.message}`);
      } finally {
        try { unlinkSync(PS_SCRIPT); } catch {}
      }

      const { size } = statSync(outPath);
      const sizeKB = (size / 1024).toFixed(1);
      log.info({ path: outPath, sizeKB }, 'Screenshot captured');

      return { path: outPath, size, sizeKB: `${sizeKB}KB`, fileName };
    },
  },
];
