const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'messenger.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec([
  'CREATE TABLE IF NOT EXISTS users (',
  '  id TEXT PRIMARY KEY,',
  '  username TEXT UNIQUE NOT NULL,',
  '  password TEXT NOT NULL,',
  '  display_name TEXT NOT NULL,',
  "  bio TEXT DEFAULT '',",
  "  avatar TEXT DEFAULT '',",
  "  status TEXT DEFAULT '',",
  "  profile_emoji TEXT DEFAULT '',",
  "  theme TEXT DEFAULT 'midnight',",
  "  accent TEXT DEFAULT '#2f8fed',",
  "  wallpaper TEXT DEFAULT 'aurora',",
  "  bubble_style TEXT DEFAULT 'rounded',",
  "  public_key TEXT DEFAULT '',",
  '  doxiki_balance INTEGER DEFAULT 0,',
  '  is_admin INTEGER DEFAULT 0,',
  "  profile_bg_color TEXT DEFAULT '#20242b',",
  "  profile_bg_emoji TEXT DEFAULT '',",
  "  profile_music_title TEXT DEFAULT '',",
  "  profile_music_url TEXT DEFAULT '',",
  '  created_at INTEGER DEFAULT (unixepoch())',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS chats (',
  '  id TEXT PRIMARY KEY,',
  '  name TEXT,',
  '  is_group INTEGER DEFAULT 0,',
  '  created_at INTEGER DEFAULT (unixepoch())',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS chat_members (',
  '  chat_id TEXT NOT NULL,',
  '  user_id TEXT NOT NULL,',
  '  PRIMARY KEY (chat_id, user_id),',
  '  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,',
  '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS chat_keys (',
  '  chat_id TEXT NOT NULL,',
  '  user_id TEXT NOT NULL,',
  '  encrypted_key TEXT NOT NULL,',
  '  created_at INTEGER DEFAULT (unixepoch()),',
  '  PRIMARY KEY (chat_id, user_id),',
  '  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,',
  '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS messages (',
  '  id TEXT PRIMARY KEY,',
  '  chat_id TEXT NOT NULL,',
  '  sender_id TEXT NOT NULL,',
  '  content TEXT NOT NULL,',
  '  iv TEXT,',
  '  encrypted INTEGER DEFAULT 1,',
  '  created_at INTEGER DEFAULT (unixepoch()),',
  '  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,',
  '  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS nft_items (',
  '  id TEXT PRIMARY KEY,',
  "  type TEXT NOT NULL CHECK(type IN ('gift', 'username', 'number')),",
  '  title TEXT NOT NULL,',
  "  image TEXT DEFAULT '',",
  '  price INTEGER NOT NULL DEFAULT 0,',
  '  owner_id TEXT,',
  '  profile_visible INTEGER DEFAULT 0,',
  '  created_by TEXT,',
  '  created_at INTEGER DEFAULT (unixepoch()),',
  '  purchased_at INTEGER,',
  '  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,',
  '  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
  ');',
  '',
  'CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at);',
  'CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);',
  'CREATE INDEX IF NOT EXISTS idx_users_search ON users(username, display_name);',
  'CREATE INDEX IF NOT EXISTS idx_nft_market ON nft_items(owner_id, type, created_at);'
].join('\n'));

function ensureColumn(table, column, definition) {
  const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (!columns.some((item) => item.name === column)) {
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + definition);
  }
}

ensureColumn('users', 'status', "status TEXT DEFAULT ''");
ensureColumn('users', 'profile_emoji', "profile_emoji TEXT DEFAULT ''");
ensureColumn('users', 'accent', "accent TEXT DEFAULT '#2f8fed'");
ensureColumn('users', 'wallpaper', "wallpaper TEXT DEFAULT 'aurora'");
ensureColumn('users', 'bubble_style', "bubble_style TEXT DEFAULT 'rounded'");
ensureColumn('users', 'public_key', "public_key TEXT DEFAULT ''");
ensureColumn('users', 'doxiki_balance', 'doxiki_balance INTEGER DEFAULT 0');
ensureColumn('users', 'is_admin', 'is_admin INTEGER DEFAULT 0');
ensureColumn('users', 'profile_bg_color', "profile_bg_color TEXT DEFAULT '#20242b'");
ensureColumn('users', 'profile_bg_emoji', "profile_bg_emoji TEXT DEFAULT ''");
ensureColumn('users', 'profile_music_title', "profile_music_title TEXT DEFAULT ''");
ensureColumn('users', 'profile_music_url', "profile_music_url TEXT DEFAULT ''");
ensureColumn('messages', 'encrypted', 'encrypted INTEGER DEFAULT 0');
ensureColumn('nft_items', 'profile_visible', 'profile_visible INTEGER DEFAULT 0');
ensureColumn('users', 'profile_music_cover', "profile_music_cover TEXT DEFAULT ''");
ensureColumn('users', 'profile_music_artist', "profile_music_artist TEXT DEFAULT ''");
ensureColumn('nft_items', 'total_supply', 'total_supply INTEGER DEFAULT 1');
ensureColumn('nft_items', 'sold_count', 'sold_count INTEGER DEFAULT 0');
ensureColumn('nft_items', 'template_id', "template_id TEXT DEFAULT ''");

db.exec([
  'CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at);',
  'CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);',
  'CREATE INDEX IF NOT EXISTS idx_users_search ON users(username, display_name);',
  'CREATE INDEX IF NOT EXISTS idx_nft_market ON nft_items(owner_id, type, created_at);'
].join('\n'));

module.exports = db;
