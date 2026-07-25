// Generates a short random note for Cash App / PayPal memo matching
// e.g. "pizzatip4821", "redsox037", "bluewave9142"
//
// This note is the ONLY thing binding an incoming payment email to an order,
// so it has to be unguessable: anyone who can guess a pending order's note can
// send a matching payment mail and claim that order. The adjective/noun pair
// alone is 24x24 = 576 combinations — enumerable in a single email — so a
// crypto-random 4-digit suffix widens it to ~5.8M. The generator must stay on
// crypto.randomInt: the PRNG behind Math's random is seeded predictably and its
// output can be reconstructed from prior samples, which is not safe for a value
// that guards money.

const crypto = require('crypto');

const adjectives = [
  'red', 'blue', 'black', 'gold', 'dark', 'fast', 'cold', 'hot',
  'steel', 'iron', 'cyber', 'neo', 'nova', 'zero', 'alpha', 'neon',
  'ghost', 'storm', 'fire', 'ice', 'void', 'flux', 'grid', 'apex'
];

const nouns = [
  'tip', 'fox', 'wolf', 'hawk', 'wave', 'pulse', 'core', 'node',
  'byte', 'code', 'gate', 'link', 'loop', 'ray', 'shot', 'blade',
  'drift', 'rush', 'peak', 'zone', 'mark', 'drop', 'star', 'run'
];

function generateNote() {
  const adj = adjectives[crypto.randomInt(adjectives.length)];
  const noun = nouns[crypto.randomInt(nouns.length)];
  const suffix = String(crypto.randomInt(10000)).padStart(4, '0');
  return `${adj}${noun}${suffix}`;
}

module.exports = { generateNote };
