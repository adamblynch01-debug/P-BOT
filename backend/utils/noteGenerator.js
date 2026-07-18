// Generates a short random note for Cash App / PayPal memo matching
// e.g. "pizzatip", "redsox", "bluewave"

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
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}${noun}`;
}

module.exports = { generateNote };
