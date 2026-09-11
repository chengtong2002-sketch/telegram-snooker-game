import { InlineKeyboard } from 'grammy';
import { config } from './config.js';

/**
 * Mini App buttons only work over https. When GAME_URL is missing or http (a
 * fresh clone, or local dev), fall back to a plain message so the bot is still
 * usable instead of throwing on every command.
 */
export const canOpenGame = () => config.gameUrl.startsWith('https://');

const gameLink = (params = {}) => {
  const url = new URL(config.gameUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
};

export function menuKeyboard() {
  const kb = new InlineKeyboard();
  if (canOpenGame()) {
    kb.webApp('🎯 Practice', gameLink({ mode: 'practice' })).row();
  }
  kb.text('⚔️ Find opponent', 'play').row();
  kb.text('🏆 Leaderboard', 'leaderboard').text('👛 Wallet', 'wallet');
  return kb;
}

export function matchKeyboard(matchId) {
  const kb = new InlineKeyboard();
  if (canOpenGame()) kb.webApp('🎱 Take your shot', gameLink({ mode: 'pvp', match: matchId }));
  return kb;
}

export function practiceKeyboard() {
  const kb = new InlineKeyboard();
  if (canOpenGame()) kb.webApp('🎯 Start practice', gameLink({ mode: 'practice' }));
  return kb;
}

export function walletKeyboard() {
  const kb = new InlineKeyboard();
  if (canOpenGame()) kb.webApp('👛 Open wallet screen', gameLink({ screen: 'wallet' }));
  return kb;
}
