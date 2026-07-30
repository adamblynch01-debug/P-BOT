// Static check: a helper called as fn(...) must be bound in that same file.
// The module load-test misses this because an unbound call only throws when
// the route actually runs — which for a notify path could be a real order.
const fs = require('fs');

const helpers = [
  'notifyBot', 'logAdminAction', 'safeCompare', 'botAuthorized',
  'botAuthUnavailable', 'withTransaction', 'requireOwnerAdmin', 'verifyTOTP',
  'generateSecret', 'hashBackupCode', 'generateBackupCodes', 'otpauthUrl',
  'raiseAlert', 'publicUser', 'createSession', 'hashPassword', 'verifyPassword',
];

let bad = 0;
for (const dir of ['routes', 'utils', 'watchers']) {
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const p = dir + '/' + f;
    // Strip comments first: prose like "raiseAlert() has always written…" is
    // not a call, and flagging it trains people to ignore this check.
    const s = fs.readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const h of helpers) {
      const used = new RegExp('(?<![\\w.])' + h + '\\s*\\(').test(s);
      if (!used) continue;
      const bound =
        new RegExp('function\\s+' + h + '\\b').test(s) ||
        new RegExp('(?:const|let|var)\\s+' + h + '\\s*=').test(s) ||
        new RegExp('\\{[^}]*\\b' + h + '\\b[^}]*\\}\\s*=\\s*require', 's').test(s);
      if (!bound) { bad++; console.log(`UNBOUND: ${p} calls ${h}() but never imports it`); }
    }
  }
}
console.log(bad ? `${bad} unbound helper call(s)` : 'every helper call is bound in its file');
process.exit(bad ? 1 : 0);
