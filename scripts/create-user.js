// Create a user from the command line:  npm run create-user -- <username> <cashier|manager|admin|assistant|display> [display name]
// The password is typed when asked (it is shown on screen, so run this on a private terminal).
import readline from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/services/users.js';

const [username, role, ...nameParts] = process.argv.slice(2);
if (!username || !role) {
  console.log('Usage: npm run create-user -- <username> <cashier|manager|admin|assistant|display> [display name]');
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question('Password (at least 8 characters): ');
rl.close();
const db = openDb(loadConfig().dbPath);
try {
  const user = createUser(db, { username, role, display_name: nameParts.join(' '), password });
  console.log(`Created ${user.role} "${user.username}".`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
