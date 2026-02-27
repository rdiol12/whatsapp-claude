/**
 * Run all test files — node test/run-all.js
 * Spawns each test file in a subprocess and reports results.
 */

import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testFiles = readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort();

console.log(`\nRunning ${testFiles.length} test suites...\n`);

let allPassed = true;

for (const file of testFiles) {
  const filePath = join(__dirname, file);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${file}`);
  console.log('='.repeat(60));

  try {
    const output = execSync(`node "${filePath}"`, {
      encoding: 'utf-8',
      timeout: 30_000,
      cwd: join(__dirname, '..'),
      env: { ...process.env, LOG_LEVEL: 'silent' },
    });
    console.log(output);
  } catch (err) {
    allPassed = false;
    console.log(err.stdout || '');
    // Only show stderr lines that look like test output (PASS/FAIL/---), skip log noise
    const stderr = (err.stderr || '').split('\n')
      .filter(l => /PASS|FAIL|tests:|===|---/.test(l))
      .join('\n');
    if (stderr) console.log(stderr);
    console.log(`  *** SUITE FAILED ***\n`);
  }
}

console.log('\n' + '='.repeat(60));
console.log(allPassed ? '  ALL SUITES PASSED' : '  SOME SUITES FAILED');
console.log('='.repeat(60) + '\n');

process.exit(allPassed ? 0 : 1);
