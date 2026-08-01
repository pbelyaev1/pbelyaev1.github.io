CREATE TABLE IF NOT EXISTS pets (token TEXT PRIMARY KEY, link_code TEXT, save TEXT, last_time INTEGER, next_call_at INTEGER, call_reason TEXT, notified_for INTEGER, pet_name TEXT, created_at INTEGER, updated_at INTEGER, hash TEXT, last_active INTEGER, needs TEXT, notified TEXT, last_seen INTEGER, last_notify INTEGER, tz INTEGER, mode TEXT, sim TEXT, notify_day TEXT, notify_count INTEGER, last_writer TEXT, gen INTEGER, last_error TEXT, log TEXT, story TEXT, facts TEXT, bond TEXT);
CREATE INDEX IF NOT EXISTS idx_pets_call ON pets(next_call_at);
CREATE INDEX IF NOT EXISTS idx_pets_link ON pets(link_code);
CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, token TEXT, p256dh TEXT, auth TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_subs_token ON subs(token);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
