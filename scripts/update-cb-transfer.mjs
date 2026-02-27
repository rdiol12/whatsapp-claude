import { getState, setState } from '../lib/state.js';

// 1. Resolve the active bid as WON
const bidsKey = 'hattrick-active-bids';
const bidsState = getState(bidsKey);
const bids = bidsState.items || [];
console.log('Current bids before update:', JSON.stringify(bids, null, 2));

const resolved = bids.map(b => {
  if (b.playerId === '502711013') {
    return { ...b, status: 'WON', wonAt: 325000, resolvedAt: Date.now() };
  }
  return b;
});
setState(bidsKey, { items: resolved });
console.log('✅ Active bid resolved as WON for Suttipong Thairung at 325,000 NIS');

// 2. Update transfer watchlist - remove CB item
const watchlistKey = 'hattrick-transfer-watchlist';
const watchlist = getState(watchlistKey);
console.log('Current watchlist:', JSON.stringify(watchlist, null, 2));

const updatedItems = (watchlist.items || []).filter(i => i.position !== 'CentralDefender');
const updatedNotes = [
  ...(watchlist.notes || []),
  {
    ts: Date.now(),
    note: 'CB item removed: Suttipong Thairung (Def skill 7, age 17y108d, salary 2160 NIS/wk) acquired 26.02.2026 for 325,000 NIS.'
  }
];
setState(watchlistKey, { items: updatedItems, notes: updatedNotes });
console.log('✅ Watchlist updated - CB item removed');
console.log('Remaining watchlist items:', updatedItems.length);
console.log('Transfer watchlist is now empty:', updatedItems.length === 0);
