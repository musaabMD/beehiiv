// Dev seed: prints SQL for a demo user/workspace/publication + a fixed session token.
// Usage: node scripts/seed.mjs > seed.sql && npx wrangler d1 execute openhive --local --file seed.sql [--persist-to dir]
// Then use cookie  oh_sid=devsession  (login: demo@openhive.dev / demo12345)
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const salt = randomBytes(16);
const hash = `pbkdf2$100000$${b64url(salt)}$${b64url(pbkdf2Sync('demo12345', salt, 100000, 32, 'sha256'))}`;
const sid = createHash('sha256').update('devsession').digest('hex');
const t = Date.now();
console.log(`
INSERT OR IGNORE INTO users (id, email, name, password_hash, email_verified, is_superadmin, created_at) VALUES ('u_demo', 'demo@openhive.dev', 'Demo Writer', '${hash}', 1, 1, ${t});
INSERT OR IGNORE INTO workspaces (id, name, owner_id, created_at) VALUES ('w_demo', 'Demo Workspace', 'u_demo', ${t});
INSERT OR IGNORE INTO publications (id, workspace_id, slug, name, description, from_name, address, settings, created_at) VALUES ('p_demo', 'w_demo', 'demo', 'The Demo Dispatch', 'A weekly newsletter about building on the open web.', 'The Demo Dispatch', '123 Main St, Springfield', '{"utm_tracking":true}', ${t});
INSERT OR IGNORE INTO memberships (workspace_id, pub_id, user_id, role, created_at) VALUES ('w_demo', '', 'u_demo', 'owner', ${t});
INSERT OR IGNORE INTO lists (id, pub_id, name, description, is_default, public, created_at) VALUES ('l_demo', 'p_demo', 'Weekly newsletter', 'The main weekly issue', 1, 1, ${t});
INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES ('${sid}', 'u_demo', ${t + 365 * 86400000}, ${t});
INSERT OR IGNORE INTO subscribers (id, pub_id, email, name, status, tier, source, referral_code, custom, confirmed_at, created_at, updated_at) VALUES
 ('s_1', 'p_demo', 'alice@gmail.com', 'Alice Jones', 'active', 'free', 'website', 'refalice01', '{"company":"Acme"}', ${t}, ${t - 20 * 86400000}, ${t}),
 ('s_2', 'p_demo', 'bob@outlook.com', 'Bob Smith', 'active', 'premium', 'magic_link', 'refbob0002', '{}', ${t}, ${t - 10 * 86400000}, ${t}),
 ('s_3', 'p_demo', 'carol@yahoo.com', 'Carol White', 'active', 'free', 'import', 'refcarol03', '{}', ${t}, ${t - 2 * 86400000}, ${t});
INSERT OR IGNORE INTO list_members (list_id, subscriber_id, status, created_at) VALUES ('l_demo','s_1','subscribed',${t}),('l_demo','s_2','subscribed',${t}),('l_demo','s_3','subscribed',${t});
`);
