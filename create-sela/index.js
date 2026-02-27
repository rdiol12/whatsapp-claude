#!/usr/bin/env node
/**
 * create-sela — Bootstrap a new Sela WhatsApp AI agent.
 *
 * Usage: npx create-sela [directory]
 *
 * Clones the repo, installs dependencies, and runs the setup wizard.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const REPO = 'https://github.com/rondi91/sela.git';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

function log(msg) { console.log(`${colors.blue}${colors.bright}sela${colors.reset} ${msg}`); }
function success(msg) { console.log(`${colors.green}✓${colors.reset} ${msg}`); }
function error(msg) { console.error(`${colors.red}✗${colors.reset} ${msg}`); }

async function main() {
  const dir = process.argv[2] || 'sela';
  const target = resolve(process.cwd(), dir);

  console.log(`\n${colors.bright}${colors.blue}╔═══════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}║   Create Sela                 ║${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}╚═══════════════════════════════╝${colors.reset}\n`);

  // Check prerequisites
  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    error('git is not installed. Please install git first.');
    process.exit(1);
  }

  try {
    execSync('node --version', { stdio: 'ignore' });
    const ver = execSync('node --version', { encoding: 'utf-8' }).trim();
    const major = parseInt(ver.replace('v', ''));
    if (major < 22) {
      error(`Node.js >= 22 required (found ${ver}). Please upgrade.`);
      process.exit(1);
    }
  } catch {
    error('Node.js is not installed.');
    process.exit(1);
  }

  // Clone
  if (existsSync(target)) {
    error(`Directory ${dir} already exists.`);
    process.exit(1);
  }

  log(`Cloning Sela into ${dir}...`);
  try {
    execSync(`git clone --depth 1 ${REPO} ${dir}`, { stdio: 'inherit' });
    success('Repository cloned');
  } catch {
    error('Failed to clone repository.');
    process.exit(1);
  }

  // Install dependencies
  log('Installing dependencies...');
  try {
    execSync('npm install', { cwd: target, stdio: 'inherit' });
    success('Dependencies installed');
  } catch {
    error('npm install failed. You can run it manually later.');
  }

  // Run setup wizard
  log('Starting setup wizard...\n');
  try {
    execSync('node setup.js', { cwd: target, stdio: 'inherit' });
  } catch {
    console.log(`\n${colors.yellow}Setup wizard exited. You can run it again with:${colors.reset}`);
    console.log(`  cd ${dir} && npm run setup\n`);
  }
}

main();
