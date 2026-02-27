/**
 * Seed Hattrick automation cron jobs.
 *
 * Israel schedule (from wiki):
 *   League: Saturday 10:30 Israel time
 *   Cup:    Tuesday  20:30 Israel time
 *
 * Usage: node scripts/seed-hattrick-crons.js
 */

import { getDb } from '../lib/db.js';
import { load, addCron, listCrons } from '../lib/crons.js';
import config from '../lib/config.js';

getDb(); // triggers auto-init
load();

const existing = listCrons().map(j => j.name);

const crons = [
  // ---------------------------------------------------------------
  // 1. Pre-league lineup — Friday 20:00 (night before Saturday 10:30 match)
  // ---------------------------------------------------------------
  {
    name: 'ht-league-lineup',
    schedule: '0 20 * * 5',        // Friday 20:00 Israel
    delivery: 'announce',
    prompt: `You are the Hattrick automation manager for the configured Hattrick team.

TASK: Set the lineup for the upcoming LEAGUE match (Saturday 10:30).

Steps:
1. Use hattrick_get_matches to find the next league match and its matchID.
2. Use hattrick_get_players to check the full roster — note form, stamina, injuries, specialties.
3. Read data/hattrick-strategy.json for formation rules and lineup priority.
4. Use hattrick_inspect on the match orders page to discover position slots and dropdowns.
5. Use hattrick_action to set the lineup:
   - Pick formation based on strategy rules (home/away, opponent strength).
   - Assign best players by form > stamina > injury status > training position.
   - Set substitutions (tired/injured subs).
   - Set tactic if applicable.
6. Use hattrick_scrape on the match orders page to VERIFY the lineup was saved.
7. Report what you set: formation, starting 11, subs, tactic.

If no upcoming league match found, report that and do nothing.`,
  },

  // ---------------------------------------------------------------
  // 2. Pre-cup lineup — Tuesday 18:00 (2.5h before 20:30 cup match)
  // ---------------------------------------------------------------
  {
    name: 'ht-cup-lineup',
    schedule: '0 18 * * 2',        // Tuesday 18:00 Israel
    delivery: 'announce',
    prompt: `You are the Hattrick automation manager for the configured Hattrick team.

TASK: Set the lineup for the upcoming CUP match (Tuesday 20:30).

Steps:
1. Use hattrick_get_matches to find the next cup match and its matchID.
2. If no cup match this week, report "No cup match" and stop.
3. Use hattrick_get_players to check roster — form, stamina, injuries.
4. Read data/hattrick-strategy.json for formation rules.
5. Use hattrick_inspect + hattrick_action on the match orders page to set lineup.
6. For cup: prioritize winning (best formation for opponent), but don't risk injured players.
7. Verify with hattrick_scrape.
8. Report: formation, starting 11, subs.`,
  },

  // ---------------------------------------------------------------
  // 3. Post-match review — Saturday 12:00 (1.5h after league match)
  // ---------------------------------------------------------------
  {
    name: 'ht-match-review',
    schedule: '0 12 * * 6',        // Saturday 12:00 Israel
    delivery: 'announce',
    prompt: `You are the Hattrick automation manager for the configured Hattrick team.

TASK: Review the latest match result.

Steps:
1. Use hattrick_get_matches to find the most recent completed match.
2. Use hattrick_scrape on the match report page to get full details.
3. Summarize: score, ratings (midfield/attack/defense), possession, highlights, injuries, cards.
4. Use hattrick_get_league to check current league standing.
5. Note any injuries or suspensions that affect next week's lineup.
6. Report a brief match summary + league position.

Keep it concise — 5-10 lines max.`,
  },

  // ---------------------------------------------------------------
  // 4. Weekly training check — Sunday 09:00
  // ---------------------------------------------------------------
  {
    name: 'ht-training-check',
    schedule: '0 9 * * 0',         // Sunday 09:00 Israel
    delivery: 'announce',
    prompt: `You are the Hattrick automation manager for the configured Hattrick team.

TASK: Weekly training review.

Steps:
1. Use hattrick_get_training to check current training type, intensity, stamina share.
2. Use hattrick_get_players to review the roster — check who is in training slots.
3. Read data/hattrick-strategy.json for training rules.
4. Verify:
   - Training type matches the chosen strategy.
   - Intensity is at 100%, stamina share at 10%.
   - All training slot positions are filled with the right players.
   - No injured players blocking training slots.
5. If anything needs changing, use hattrick_inspect + hattrick_action on /en/Club/Training/ to fix it.
6. Report: current training type, number of players in slots, any changes made.

If everything looks correct, just confirm "Training OK" with a brief status.`,
  },

  // ---------------------------------------------------------------
  // 5. Weekly economy check — Sunday 10:00
  // ---------------------------------------------------------------
  {
    name: 'ht-economy-check',
    schedule: '0 10 * * 0',        // Sunday 10:00 Israel
    delivery: 'silent',
    prompt: `You are the Hattrick automation manager for the configured Hattrick team.

TASK: Weekly economy check.

Steps:
1. Use hattrick_get_economy to check finances — cash, weekly income/expenses, sponsors.
2. Read data/hattrick-strategy.json for economy rules (min 300K cash reserve, stadium upgrade triggers).
3. Check:
   - Is cash above 300K reserve? If below, include ALERT in your response.
   - Are wages sustainable (income > expenses)?
   - Any sponsor changes needed?
4. Use hattrick_get_league to check if league matches are selling out (relevant for stadium upgrade decision).
5. Report: cash balance, weekly net, any concerns.

Only include ALERT if cash is critically low or finances are unsustainable.`,
  },

  // ---------------------------------------------------------------
  // 6. Friendly scheduler — Wednesday 10:00
  // ---------------------------------------------------------------
  {
    name: 'ht-friendly-scheduler',
    schedule: '0 10 * * 3',        // Wednesday 10:00 Israel
    delivery: 'silent',
    prompt: `You are the Hattrick automation manager for the configured Hattrick team.

TASK: Ensure a friendly match is scheduled for this week.

Steps:
1. Use hattrick_get_matches to check if there's already a friendly scheduled.
2. If a friendly is already booked, report "Friendly already scheduled" and stop.
3. If no friendly this week:
   a. Use hattrick_scrape on /en/Club/Matches/MatchFriendly/ to find the friendly booking page.
   b. Use hattrick_inspect to discover the booking form.
   c. Book an international HOME friendly (better for income).
   d. Verify with hattrick_scrape.
4. Report: friendly status (booked/already scheduled/failed).

Friendlies maximize training slots — this is critical for player development.
If booking fails, include ALERT in your response.`,
  },

  // ---------------------------------------------------------------
  // 7. Transfer market scout — Monday + Thursday 14:00
  // ---------------------------------------------------------------
  {
    name: 'ht-transfer-scout',
    schedule: '0 14 * * 1,4',      // Mon + Thu 14:00 Israel
    delivery: 'silent',
    prompt: `You are the Hattrick automation manager for the configured Hattrick team.

TASK: Scout the transfer market for promising young players.

Steps:
1. Read data/hattrick-strategy.json — check training type and buy criteria.
2. Use hattrick_get_players to see current roster size and gaps.
3. If roster is full (no training slots empty), report "Roster full, no scouting needed" and stop.
4. Use hattrick_scrape on the transfer search page: /en/World/Transfers/
5. Use hattrick_inspect to find search filters.
6. Search with criteria from strategy:
   - Age: 17 years max
   - Skills matching training type requirements
   - Must have specialty
7. Report: number of candidates found, top 3 with name/age/skills/price.

Do NOT place any bids — only scout and report. Include ALERT if there's an exceptional bargain.`,
  },
];

let added = 0;
let skipped = 0;

for (const c of crons) {
  if (existing.includes(c.name)) {
    console.log(`SKIP: "${c.name}" already exists`);
    skipped++;
    continue;
  }
  try {
    const job = addCron(c.name, c.schedule, c.prompt, config.timezone, c.delivery);
    console.log(`ADDED: "${c.name}" [${c.schedule}] → id ${job.id}`);
    added++;
  } catch (err) {
    console.error(`ERROR: "${c.name}": ${err.message}`);
  }
}

console.log(`\nDone. Added: ${added}, Skipped: ${skipped}, Total Hattrick crons: ${added + skipped}`);
