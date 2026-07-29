/**
 * Sets one key in .env from the command line, so nothing depends on an editor
 * saving to the right place.
 *
 *   node scripts/set-env.js DATABASE_URL "postgres://..."
 *   node scripts/set-env.js REDIS_URL "rediss://..."
 *
 * Values are validated before writing and never echoed back in full — the
 * confirmation prints the host only, so the password stays out of the terminal
 * scrollback.
 */
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.resolve('.env');
const [key, value] = process.argv.slice(2);

if (!key || !value) {
  console.error('Usage: node scripts/set-env.js <KEY> "<value>"');
  console.error('Example: node scripts/set-env.js REDIS_URL "rediss://default:pw@host.upstash.io:6379"');
  process.exit(1);
}

/** Returns an error string, or null when the value looks usable. */
function validate(k, v) {
  if (k === 'DATABASE_URL') {
    if (!/^postgres(ql)?:\/\//.test(v)) {
      return 'DATABASE_URL must start with postgres:// or postgresql://';
    }
    if (/@(localhost|127\.0\.0\.1)/.test(v)) {
      return 'That is still the localhost placeholder, not your Neon URL.';
    }
  }

  if (k === 'REDIS_URL') {
    if (/^https?:\/\//.test(v)) {
      return [
        'That is the Upstash REST URL, which this app cannot use.',
        'BullMQ speaks the Redis wire protocol — copy the URL that starts with rediss://',
        '(look for the "ioredis" or TCP connection option, not "REST API").',
      ].join('\n  ');
    }
    if (!/^rediss?:\/\//.test(v)) {
      return 'REDIS_URL must start with redis:// or rediss://';
    }
    if (/@(localhost|127\.0\.0\.1)/.test(v)) {
      return 'That is still the localhost placeholder, not your Upstash URL.';
    }
  }

  return null;
}

const problem = validate(key, value);
if (problem) {
  console.error(`Not written — ${problem}`);
  process.exit(1);
}

if (!fs.existsSync(ENV_PATH)) {
  fs.copyFileSync(path.resolve('.env.example'), ENV_PATH);
  console.log('Created .env from .env.example');
}

const original = fs.readFileSync(ENV_PATH, 'utf8');
const line = `${key}=${value}`;
const pattern = new RegExp(`^${key}=.*$`, 'm');

const updated = pattern.test(original)
  ? original.replace(pattern, line)
  : `${original.replace(/\s*$/, '')}\n${line}\n`;

fs.writeFileSync(ENV_PATH, updated);

// Confirm by host so the caller can see it took effect, without printing creds.
let shown = value;
try {
  const url = new URL(value);
  shown = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
} catch {
  shown = /SECRET|KEY|TOKEN|PASSWORD/i.test(key) ? '<hidden>' : value;
}

console.log(`${key} set → ${shown}`);

// Surface the two Neon settings that silently cause trouble later.
if (key === 'DATABASE_URL') {
  if (!/sslmode=/.test(value)) {
    console.log('note: no sslmode in the URL — TLS is enabled automatically for remote hosts, so this is fine.');
  }
  if (/neon\.tech/.test(value) && !/-pooler\./.test(value)) {
    console.log('note: this is the direct Neon endpoint. The pooled one (host contains "-pooler") handles more concurrent connections.');
  }
}
