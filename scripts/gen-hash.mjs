/**
 * gen-hash.mjs — Generate a founder password hash for Vercel env vars.
 *
 * Usage (run locally, NEVER commit output):
 *   node scripts/gen-hash.mjs
 *
 * You will be prompted for:
 *   1. PIN_PEPPER  — the shared pepper (already set in Vercel, ask Srijay)
 *   2. Your password — the password you want to use to log in
 *
 * The script prints the HMAC-SHA256 hash to copy into Vercel as:
 *   FOUNDER_HASH_SRIJAY  /  FOUNDER_HASH_ADIT  /  FOUNDER_HASH_ASIM
 *
 * The raw password is NEVER stored. Only this hash goes into Vercel.
 */

import crypto from 'crypto';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, silent = false) {
  return new Promise(resolve => {
    if (silent) {
      // Hide input for passwords
      process.stdout.write(question);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let input = '';
      process.stdin.on('data', function handler(char) {
        char = char.toString();
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          resolve(input);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007f') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(question + '*'.repeat(input.length));
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      });
    } else {
      rl.question(question, resolve);
    }
  });
}

async function main() {
  console.log('\n🔐  Proxi CRM — Password Hash Generator\n');
  console.log('This script generates the hash you\'ll paste into Vercel.');
  console.log('Your raw password is never saved or transmitted.\n');

  const pepper = await ask('Enter PIN_PEPPER (from Vercel env vars): ', true);
  if (!pepper.trim()) {
    console.error('\n❌  PEPPER cannot be empty.');
    process.exit(1);
  }

  const password = await ask('Enter your chosen password: ', true);
  if (!password.trim()) {
    console.error('\n❌  Password cannot be empty.');
    process.exit(1);
  }

  const hash = crypto.createHmac('sha256', pepper.trim()).update(password.trim()).digest('hex');

  console.log('\n✅  Hash generated successfully!\n');
  console.log('Copy the line below into Vercel env vars (Settings → Environment Variables):');
  console.log('─'.repeat(70));
  console.log(`FOUNDER_HASH_<YOURNAME>=${hash}`);
  console.log('─'.repeat(70));
  console.log('\n⚠️   Do NOT share this hash or commit it to git.');
  console.log('     The hash is only safe because PIN_PEPPER stays secret.\n');

  rl.close();
}

main();
