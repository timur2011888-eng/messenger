const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const connectionString = process.env.DATABASE_URL;
const isPostgres = Boolean(connectionString);
const txStore = new AsyncLocalStorage();

let sqlite = null;
let pgPool = null;

function sqliteNowDefault() {
  return 'INTEGER DEFAULT (unixepoch())';
}

function pgNowDefault() {
  return 'INTEGER DEFAULT (extract(epoch from now())::int)';
}

function sqliteSchema() {
  return [
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
    '  is_anon_plus INTEGER DEFAULT 0,',
    "  admin_permissions TEXT DEFAULT '{}',",
    "  profile_bg_color TEXT DEFAULT '#20242b',",
    "  profile_bg_image TEXT DEFAULT '',",
    "  profile_bg_emoji TEXT DEFAULT '',",
    "  profile_music_title TEXT DEFAULT '',",
    "  profile_music_url TEXT DEFAULT '',",
    "  profile_music_cover TEXT DEFAULT '',",
    "  profile_music_artist TEXT DEFAULT '',",
    "  profile_social_icon TEXT DEFAULT '',",
    "  profile_social_url TEXT DEFAULT '',",
    '  created_at ' + sqliteNowDefault(),
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS music_library (',
    '  id TEXT PRIMARY KEY,',
    '  uploader_id TEXT NOT NULL,',
    '  title TEXT NOT NULL,',
    "  artist TEXT DEFAULT '',",
    '  audio_url TEXT NOT NULL,',
    "  cover_url TEXT DEFAULT '',",
    '  created_at ' + sqliteNowDefault() + ',',
    '  FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS chats (',
    '  id TEXT PRIMARY KEY,',
    '  name TEXT,',
    '  is_group INTEGER DEFAULT 0,',
    '  created_at ' + sqliteNowDefault(),
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS chat_members (',
    '  chat_id TEXT NOT NULL,',
    '  user_id TEXT NOT NULL,',
    '  hidden_at INTEGER,',
    '  pinned_at INTEGER,',
    '  PRIMARY KEY (chat_id, user_id),',
    '  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,',
    '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS chat_keys (',
    '  chat_id TEXT NOT NULL,',
    '  user_id TEXT NOT NULL,',
    '  encrypted_key TEXT NOT NULL,',
    '  created_at ' + sqliteNowDefault() + ',',
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
    '  encrypted INTEGER DEFAULT 0,',
    "  message_type TEXT DEFAULT 'text',",
    "  media_url TEXT DEFAULT '',",
    "  media_mime TEXT DEFAULT '',",
    "  file_name TEXT DEFAULT '',",
    '  file_size INTEGER DEFAULT 0,',
    '  duration INTEGER DEFAULT 0,',
    '  reply_to_id TEXT,',
    '  edited_at INTEGER,',
    '  deleted_at INTEGER,',
    '  delivered_at INTEGER,',
    '  read_at INTEGER,',
    '  created_at ' + sqliteNowDefault() + ',',
    '  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,',
    '  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,',
    '  FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS message_reactions (',
    '  message_id TEXT NOT NULL,',
    '  user_id TEXT NOT NULL,',
    "  reaction TEXT NOT NULL DEFAULT '👍',",
    '  created_at ' + sqliteNowDefault() + ',',
    '  PRIMARY KEY (message_id, user_id),',
    '  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,',
    '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS user_blocks (',
    '  blocker_id TEXT NOT NULL,',
    '  blocked_id TEXT NOT NULL,',
    '  created_at ' + sqliteNowDefault() + ',',
    '  PRIMARY KEY (blocker_id, blocked_id),',
    '  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,',
    '  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE',
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
    '  total_supply INTEGER DEFAULT 1,',
    '  sold_count INTEGER DEFAULT 0,',
    "  template_id TEXT DEFAULT '',",
    '  listed_price INTEGER DEFAULT 0,',
    '  listed_at INTEGER,',
    '  created_by TEXT,',
    '  created_at ' + sqliteNowDefault() + ',',
    '  purchased_at INTEGER,',
    '  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,',
    '  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS economy_log (',
    '  id TEXT PRIMARY KEY,',
    '  admin_id TEXT,',
    '  user_id TEXT,',
    '  amount INTEGER NOT NULL,',
    '  action TEXT NOT NULL,',
    "  note TEXT DEFAULT '',",
    '  created_at ' + sqliteNowDefault() + ',',
    '  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL,',
    '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL',
    ');',
    '',
    'CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at);',
    'CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);',
    'CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);',
    'CREATE INDEX IF NOT EXISTS idx_users_search ON users(username, display_name);',
    'CREATE INDEX IF NOT EXISTS idx_music_library_time ON music_library(created_at);',
    'CREATE INDEX IF NOT EXISTS idx_nft_market ON nft_items(owner_id, type, created_at);',
    'CREATE INDEX IF NOT EXISTS idx_economy_log_time ON economy_log(created_at);'
  ].join('\n');
}

function postgresStatements() {
  return [
    [
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
      '  doxiki_balance BIGINT DEFAULT 0,',
      '  is_admin INTEGER DEFAULT 0,',
      '  is_anon_plus INTEGER DEFAULT 0,',
      "  admin_permissions TEXT DEFAULT '{}',",
      "  profile_bg_color TEXT DEFAULT '#20242b',",
      "  profile_bg_image TEXT DEFAULT '',",
      "  profile_bg_emoji TEXT DEFAULT '',",
      "  profile_music_title TEXT DEFAULT '',",
      "  profile_music_url TEXT DEFAULT '',",
      "  profile_music_cover TEXT DEFAULT '',",
      "  profile_music_artist TEXT DEFAULT '',",
      "  profile_social_icon TEXT DEFAULT '',",
      "  profile_social_url TEXT DEFAULT '',",
      '  created_at ' + pgNowDefault(),
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS music_library (',
      '  id TEXT PRIMARY KEY,',
      '  uploader_id TEXT NOT NULL,',
      '  title TEXT NOT NULL,',
      "  artist TEXT DEFAULT '',",
      '  audio_url TEXT NOT NULL,',
      "  cover_url TEXT DEFAULT '',",
      '  created_at ' + pgNowDefault() + ',',
      '  FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE',
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS chats (',
      '  id TEXT PRIMARY KEY,',
      '  name TEXT,',
      '  is_group INTEGER DEFAULT 0,',
      '  created_at ' + pgNowDefault(),
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS chat_members (',
      '  chat_id TEXT NOT NULL,',
      '  user_id TEXT NOT NULL,',
      '  hidden_at INTEGER,',
      '  pinned_at INTEGER,',
      '  PRIMARY KEY (chat_id, user_id),',
      '  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,',
      '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS chat_keys (',
      '  chat_id TEXT NOT NULL,',
      '  user_id TEXT NOT NULL,',
      '  encrypted_key TEXT NOT NULL,',
      '  created_at ' + pgNowDefault() + ',',
      '  PRIMARY KEY (chat_id, user_id),',
      '  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,',
      '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS messages (',
      '  id TEXT PRIMARY KEY,',
      '  chat_id TEXT NOT NULL,',
      '  sender_id TEXT NOT NULL,',
      '  content TEXT NOT NULL,',
      '  iv TEXT,',
      '  encrypted INTEGER DEFAULT 0,',
      "  message_type TEXT DEFAULT 'text',",
      "  media_url TEXT DEFAULT '',",
      "  media_mime TEXT DEFAULT '',",
      "  file_name TEXT DEFAULT '',",
      '  file_size BIGINT DEFAULT 0,',
      '  duration INTEGER DEFAULT 0,',
      '  reply_to_id TEXT,',
      '  edited_at INTEGER,',
      '  deleted_at INTEGER,',
      '  delivered_at INTEGER,',
      '  read_at INTEGER,',
      '  created_at ' + pgNowDefault() + ',',
      '  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,',
      '  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,',
      '  FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL',
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS message_reactions (',
      '  message_id TEXT NOT NULL,',
      '  user_id TEXT NOT NULL,',
      "  reaction TEXT NOT NULL DEFAULT '👍',",
      '  created_at ' + pgNowDefault() + ',',
      '  PRIMARY KEY (message_id, user_id),',
      '  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,',
      '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS user_blocks (',
      '  blocker_id TEXT NOT NULL,',
      '  blocked_id TEXT NOT NULL,',
      '  created_at ' + pgNowDefault() + ',',
      '  PRIMARY KEY (blocker_id, blocked_id),',
      '  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,',
      '  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE',
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS nft_items (',
      '  id TEXT PRIMARY KEY,',
      "  type TEXT NOT NULL CHECK(type IN ('gift', 'username', 'number')),",
      '  title TEXT NOT NULL,',
      "  image TEXT DEFAULT '',",
      '  price BIGINT NOT NULL DEFAULT 0,',
      '  owner_id TEXT,',
      '  profile_visible INTEGER DEFAULT 0,',
      '  total_supply INTEGER DEFAULT 1,',
      '  sold_count INTEGER DEFAULT 0,',
      "  template_id TEXT DEFAULT '',",
      '  listed_price BIGINT DEFAULT 0,',
      '  listed_at INTEGER,',
      '  created_by TEXT,',
      '  created_at ' + pgNowDefault() + ',',
      '  purchased_at INTEGER,',
      '  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,',
      '  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
      ')'
    ].join('\n'),
    [
      'CREATE TABLE IF NOT EXISTS economy_log (',
      '  id TEXT PRIMARY KEY,',
      '  admin_id TEXT,',
      '  user_id TEXT,',
      '  amount BIGINT NOT NULL,',
      '  action TEXT NOT NULL,',
      "  note TEXT DEFAULT '',",
      '  created_at ' + pgNowDefault() + ',',
      '  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL,',
      '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL',
      ')'
    ].join('\n'),
    'CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id)',
    'CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id)',
    'CREATE INDEX IF NOT EXISTS idx_users_search ON users(username, display_name)',
    'CREATE INDEX IF NOT EXISTS idx_music_library_time ON music_library(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_nft_market ON nft_items(owner_id, type, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_economy_log_time ON economy_log(created_at)'
  ];
}

const columns = {
  users: [
    ['status', "status TEXT DEFAULT ''"],
    ['profile_emoji', "profile_emoji TEXT DEFAULT ''"],
    ['theme', "theme TEXT DEFAULT 'midnight'"],
    ['accent', "accent TEXT DEFAULT '#2f8fed'"],
    ['wallpaper', "wallpaper TEXT DEFAULT 'aurora'"],
    ['bubble_style', "bubble_style TEXT DEFAULT 'rounded'"],
    ['public_key', "public_key TEXT DEFAULT ''"],
    ['doxiki_balance', 'doxiki_balance BIGINT DEFAULT 0'],
    ['is_admin', 'is_admin INTEGER DEFAULT 0'],
    ['is_anon_plus', 'is_anon_plus INTEGER DEFAULT 0'],
    ['admin_permissions', "admin_permissions TEXT DEFAULT '{}'"],
    ['profile_bg_color', "profile_bg_color TEXT DEFAULT '#20242b'"],
    ['profile_bg_image', "profile_bg_image TEXT DEFAULT ''"],
    ['profile_bg_emoji', "profile_bg_emoji TEXT DEFAULT ''"],
    ['profile_music_title', "profile_music_title TEXT DEFAULT ''"],
    ['profile_music_url', "profile_music_url TEXT DEFAULT ''"],
    ['profile_music_cover', "profile_music_cover TEXT DEFAULT ''"],
    ['profile_music_artist', "profile_music_artist TEXT DEFAULT ''"],
    ['profile_social_icon', "profile_social_icon TEXT DEFAULT ''"],
    ['profile_social_url', "profile_social_url TEXT DEFAULT ''"]
  ],
  messages: [
    ['iv', 'iv TEXT'],
    ['encrypted', 'encrypted INTEGER DEFAULT 0'],
    ['message_type', "message_type TEXT DEFAULT 'text'"],
    ['media_url', "media_url TEXT DEFAULT ''"],
    ['media_mime', "media_mime TEXT DEFAULT ''"],
    ['file_name', "file_name TEXT DEFAULT ''"],
    ['file_size', 'file_size BIGINT DEFAULT 0'],
    ['duration', 'duration INTEGER DEFAULT 0'],
    ['reply_to_id', 'reply_to_id TEXT'],
    ['edited_at', 'edited_at INTEGER'],
    ['deleted_at', 'deleted_at INTEGER'],
    ['delivered_at', 'delivered_at INTEGER'],
    ['read_at', 'read_at INTEGER']
  ],
  chat_members: [
    ['hidden_at', 'hidden_at INTEGER'],
    ['pinned_at', 'pinned_at INTEGER']
  ],
  nft_items: [
    ['image', "image TEXT DEFAULT ''"],
    ['profile_visible', 'profile_visible INTEGER DEFAULT 0'],
    ['total_supply', 'total_supply INTEGER DEFAULT 1'],
    ['sold_count', 'sold_count INTEGER DEFAULT 0'],
    ['template_id', "template_id TEXT DEFAULT ''"],
    ['listed_price', 'listed_price BIGINT DEFAULT 0'],
    ['listed_at', 'listed_at INTEGER'],
    ['created_by', 'created_by TEXT'],
    ['purchased_at', 'purchased_at INTEGER']
  ],
  economy_log: [
    ['note', "note TEXT DEFAULT ''"]
  ]
};

function sqliteColumnDefinition(definition) {
  return definition.replace(/\bBIGINT\b/g, 'INTEGER');
}

function normalizeSqlForPostgres(sql) {
  let formatted = '';
  let index = 1;
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'" && sql[i + 1] === "'") {
      formatted += "''";
      i++;
      continue;
    }
    if (char === "'") {
      inSingle = !inSingle;
      formatted += char;
      continue;
    }
    if (char === '?' && !inSingle) {
      formatted += '$' + index++;
      continue;
    }
    formatted += char;
  }

  return formatted
    .replace(/unixepoch\(\)/gi, 'extract(epoch from now())::int')
    .replace(/\bTRUE\b/g, '1')
    .replace(/\bFALSE\b/g, '0');
}

async function pgQuery(sql, params = []) {
  const client = txStore.getStore() || pgPool;
  return client.query(sql, params);
}

async function ensureSqliteColumn(table, column, definition) {
  const existing = sqlite.prepare('PRAGMA table_info(' + table + ')').all();
  if (!existing.some((item) => item.name === column)) {
    sqlite.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + sqliteColumnDefinition(definition));
  }
}

async function ensurePostgresColumn(table, column, definition) {
  const found = await pgPool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
    [table, column]
  );
  if (!found.rowCount) {
    await pgPool.query('ALTER TABLE ' + table + ' ADD COLUMN ' + definition);
  }
}

async function createOptionalUniqueIndex(sql, label) {
  try {
    if (isPostgres) await pgPool.query(sql);
    else sqlite.exec(sql);
  } catch (error) {
    console.warn('Не удалось создать уникальный индекс ' + label + ': ' + error.message);
  }
}

async function migrateSqlite() {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(sqliteSchema());

  for (const [table, tableColumns] of Object.entries(columns)) {
    for (const [column, definition] of tableColumns) {
      await ensureSqliteColumn(table, column, definition);
    }
  }

  await createOptionalUniqueIndex(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower_unique ON users(lower(username))',
    'users.username'
  );
  await createOptionalUniqueIndex(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_nft_unique_asset ON nft_items(type, lower(title)) WHERE type IN ('username', 'number')",
    'nft_items type/title'
  );
  await createOptionalUniqueIndex(
    'CREATE INDEX IF NOT EXISTS idx_chat_members_pinned ON chat_members(user_id, pinned_at)',
    'chat_members pinned_at'
  );
}

async function migratePostgres() {
  for (const statement of postgresStatements()) {
    await pgPool.query(statement);
  }

  for (const [table, tableColumns] of Object.entries(columns)) {
    for (const [column, definition] of tableColumns) {
      await ensurePostgresColumn(table, column, definition);
    }
  }

  await createOptionalUniqueIndex(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower_unique ON users(lower(username))',
    'users.username'
  );
  await createOptionalUniqueIndex(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_nft_unique_asset ON nft_items(type, lower(title)) WHERE type IN ('username', 'number')",
    'nft_items type/title'
  );
  await createOptionalUniqueIndex(
    'CREATE INDEX IF NOT EXISTS idx_chat_members_pinned ON chat_members(user_id, pinned_at)',
    'chat_members pinned_at'
  );
}

async function init() {
  if (isPostgres) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
    await pgPool.query('SELECT 1');
    await migratePostgres();
    console.log('База данных подключена: Postgres');
    return;
  }

  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(__dirname, 'messenger.db'));
  await migrateSqlite();
  console.log('База данных подключена: SQLite');
}

const ready = init();

const db = {
  isPostgres,
  ready,
  prepare(sql) {
    if (isPostgres) {
      const formatted = normalizeSqlForPostgres(sql);
      return {
        async run(...params) {
          const result = await pgQuery(formatted, params);
          return { changes: result.rowCount };
        },
        async get(...params) {
          const result = await pgQuery(formatted, params);
          return result.rows[0] || null;
        },
        async all(...params) {
          const result = await pgQuery(formatted, params);
          return result.rows || [];
        }
      };
    }

    const statement = sqlite.prepare(sql);
    return {
      async run(...params) {
        return statement.run(...params);
      },
      async get(...params) {
        return statement.get(...params) || null;
      },
      async all(...params) {
        return statement.all(...params);
      }
    };
  },
  transaction(fn) {
    return async (...args) => {
      if (isPostgres) {
        const client = await pgPool.connect();
        try {
          await client.query('BEGIN');
          const result = await txStore.run(client, () => fn(...args));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }

      sqlite.exec('BEGIN');
      try {
        const result = await fn(...args);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    };
  },
  async exec(sql) {
    if (isPostgres) {
      return pgPool.query(sql);
    }
    return sqlite.exec(sql);
  }
};

module.exports = db;
