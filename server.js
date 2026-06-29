const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { randomUUID, createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto');
const path = require('path');
const fsSync = require('fs');
const os = require('os');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'local_dev_secret_change_me';
const MESSAGE_SECRET = process.env.MESSAGE_SECRET || JWT_SECRET;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_USERNAME = 'sinagoga322';
const PUBLIC_DIR = path.join(__dirname, 'Public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fsSync.existsSync(UPLOAD_DIR)) {
  fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/server-info', (_req, res) => {
  res.json(serverInfo(app.locals.port || PORT));
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname || '.png'))
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Можно загрузить только изображение'));
    }
    cb(null, true);
  }
});

const audioUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('audio/')) {
      return cb(new Error('Можно загрузить только музыку'));
    }
    cb(null, true);
  }
});

const onlineUsers = new Map();

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function cleanColor(value, fallback = '#20242b') {
  const color = clean(value, 16);
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function isAdminUser(user) {
  return Boolean(user && (user.username === ADMIN_USERNAME || Number(user.is_admin)));
}

function isOwnerUser(user) {
  return Boolean(user && user.username === ADMIN_USERNAME);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    bio: user.bio || '',
    avatar: user.avatar || '',
    status: user.status || '',
    profile_emoji: user.profile_emoji || '',
    theme: user.theme || 'midnight',
    accent: user.accent || '#2f8fed',
    wallpaper: user.wallpaper || 'aurora',
    bubble_style: user.bubble_style || 'rounded',
    public_key: user.public_key || '',
    doxiki_balance: Number(user.doxiki_balance || 0),
    profile_bg_color: cleanColor(user.profile_bg_color || '#20242b'),
    profile_bg_emoji: user.profile_bg_emoji || '',
    profile_music_title: user.profile_music_title || '',
    profile_music_url: user.profile_music_url || '',
    profile_music_cover: user.profile_music_cover || '',
    profile_music_artist: user.profile_music_artist || '',
    is_admin: isAdminUser(user),
    is_owner_admin: isOwnerUser(user),
    created_at: user.created_at
  };
}

function lanUrls(port) {
  const urls = [];
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push('http://' + address.address + ':' + port);
      }
    }
  }
  return urls;
}

function serverInfo(port) {
  return {
    host: HOST,
    port,
    local_url: 'http://localhost:' + port,
    lan_urls: lanUrls(port)
  };
}

function messageKey() {
  return createHash('sha256').update(String(MESSAGE_SECRET)).digest();
}

function encryptAtRest(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', messageKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    content: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('base64')
  };
}

function decryptAtRest(content, iv) {
  const payload = Buffer.from(String(content || ''), 'base64');
  const tag = payload.subarray(payload.length - 16);
  const encrypted = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', messageKey(), Buffer.from(String(iv || ''), 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function exposeMessage(row) {
  if (!row) return row;
  if (Number(row.encrypted) === 2) {
    try {
      return { ...row, content: decryptAtRest(row.content, row.iv), encrypted: 0, server_encrypted: 1 };
    } catch {
      return { ...row, content: 'Не удалось расшифровать сообщение на сервере', encrypted: 0, server_encrypted: 1 };
    }
  }
  return row;
}

function exposeChatRow(row) {
  if (!row) return row;
  if (Number(row.last_encrypted) === 2) {
    try {
      return { ...row, last_message: decryptAtRest(row.last_message, row.last_iv), last_encrypted: 0, last_server_encrypted: 1 };
    } catch {
      return { ...row, last_message: 'Зашифрованное сообщение', last_encrypted: 0, last_server_encrypted: 1 };
    }
  }
  return row;
}

function getUserById(id) {
  return db.prepare([
    'SELECT id, username, display_name, bio, avatar, status, profile_emoji,',
    'theme, accent, wallpaper, bubble_style, public_key, doxiki_balance, is_admin,',
    'profile_bg_color, profile_bg_emoji, profile_music_title, profile_music_url,',
    'profile_music_cover, profile_music_artist, created_at',
    'FROM users WHERE id = ?'
  ].join(' ')).get(id);
}

function signUser(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нужен вход в аккаунт' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Сессия устарела, войди снова' });
  }
}

function isMember(chatId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId));
}

function getChatForUser(chatId, userId) {
  return exposeChatRow(db.prepare([
    'SELECT c.id, c.name, c.is_group, c.created_at, ck.encrypted_key,',
    'peer.id AS peer_id, peer.username AS peer_username, peer.display_name AS peer_display_name,',
    'peer.avatar AS peer_avatar, peer.bio AS peer_bio, peer.status AS peer_status,',
    '(SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,',
    '(SELECT m.iv FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_iv,',
    '(SELECT m.encrypted FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_encrypted,',
    '(SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_time',
    'FROM chats c',
    'JOIN chat_members own ON own.chat_id = c.id AND own.user_id = ?',
    'LEFT JOIN chat_keys ck ON ck.chat_id = c.id AND ck.user_id = ?',
    'LEFT JOIN chat_members peer_member ON peer_member.chat_id = c.id AND peer_member.user_id != ? AND c.is_group = 0',
    'LEFT JOIN users peer ON peer.id = peer_member.user_id',
    'WHERE c.id = ?'
  ].join(' ')).get(userId, userId, userId, chatId));
}

function storeChatKeys(chatId, memberIds, keys) {
  if (!Array.isArray(keys)) return;
  const members = new Set(memberIds);
  const saveKey = db.prepare([
    'INSERT INTO chat_keys (chat_id, user_id, encrypted_key) VALUES (?, ?, ?)',
    'ON CONFLICT(chat_id, user_id) DO UPDATE SET encrypted_key = excluded.encrypted_key'
  ].join(' '));

  for (const item of keys) {
    const userId = clean(item && item.user_id, 100);
    const encryptedKey = clean(item && item.encrypted_key, 20000);
    if (members.has(userId) && encryptedKey) {
      saveKey.run(chatId, userId, encryptedKey);
    }
  }
}

function socketsForUser(userId) {
  return onlineUsers.get(userId) || new Set();
}

function notifyUsers(userIds, event, payload) {
  for (const userId of userIds) {
    for (const socketId of socketsForUser(userId)) {
      io.to(socketId).emit(event, payload);
    }
  }
}

function notifyChatMembers(chatId) {
  const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map((row) => row.user_id);
  notifyUsers(members, 'chats_changed', { chatId });
}

function nftItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    image: row.image || '',
    price: Number(row.price || 0),
    owner_id: row.owner_id || null,
    profile_visible: Boolean(row.profile_visible),
    total_supply: Number(row.total_supply || 1),
    sold_count: Number(row.sold_count || 0),
    template_id: row.template_id || '',
    created_at: row.created_at,
    purchased_at: row.purchased_at || null
  };
}

function profileNfts(userId) {
  return db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible, total_supply, sold_count, template_id, created_at, purchased_at',
    'FROM nft_items',
    'WHERE owner_id = ? AND profile_visible = 1',
    "ORDER BY CASE type WHEN 'username' THEN 1 WHEN 'number' THEN 2 WHEN 'gift' THEN 3 ELSE 4 END, COALESCE(purchased_at, created_at) DESC"
  ].join(' ')).all(userId).map(nftItem);
}

function parseDoxikiAmount(value, allowZero = false) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1) || amount > 1000000000000) {
    return null;
  }
  return amount;
}

function adminOnly(req, res, next) {
  const user = getUserById(req.user.id);
  if (!isAdminUser(user)) {
    return res.status(403).json({ error: 'Админка доступна только владельцу' });
  }
  req.adminUser = user;
  next();
}

function ownerOnly(req, res, next) {
  const user = getUserById(req.user.id);
  if (!isOwnerUser(user)) {
    return res.status(403).json({ error: 'Выдавать админку может только владелец' });
  }
  req.ownerUser = user;
  next();
}

app.post('/api/register', async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const displayName = clean(req.body.display_name, 48) || username;
  const publicKey = clean(req.body.public_key, 20000);

  if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Юзернейм: 3-24 символа, латиница, цифры, _ или .' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть от 6 символов' });
  }

  try {
    const id = randomUUID();
    const hash = await bcrypt.hash(password, 12);
    db.prepare([
      'INSERT INTO users (id, username, password, display_name, public_key)',
      'VALUES (?, ?, ?, ?, ?)'
    ].join(' ')).run(id, username, hash, displayName, publicKey);
    const user = getUserById(id);
    res.json({ token: signUser(user), user: publicUser(user) });
  } catch (error) {
    res.status(400).json({ error: 'Такой юзернейм уже занят' });
  }
});

app.post('/api/login', async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) return res.status(400).json({ error: 'Неверный юзернейм или пароль' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Неверный юзернейм или пароль' });

  res.json({ token: signUser(user), user: publicUser(user) });
});

app.get('/api/profile', auth, (req, res) => {
  res.json(publicUser(getUserById(req.user.id)));
});

app.put('/api/profile', auth, (req, res) => {
  const current = getUserById(req.user.id);
  if (!current) return res.status(404).json({ error: 'Профиль не найден' });

  const next = {
    display_name: clean(req.body.display_name || current.display_name, 48),
    bio: clean(req.body.bio ?? current.bio, 180),
    status: clean(req.body.status ?? current.status, 36),
    profile_emoji: clean(req.body.profile_emoji ?? current.profile_emoji, 8),
    theme: clean(req.body.theme ?? current.theme, 24),
    accent: clean(req.body.accent ?? current.accent, 16),
    wallpaper: clean(req.body.wallpaper ?? current.wallpaper, 24),
    bubble_style: clean(req.body.bubble_style ?? current.bubble_style, 24),
    profile_bg_color: cleanColor(req.body.profile_bg_color ?? current.profile_bg_color),
    profile_bg_emoji: clean(req.body.profile_bg_emoji ?? current.profile_bg_emoji, 12),
    profile_music_title: clean(req.body.profile_music_title ?? current.profile_music_title, 80),
    profile_music_url: clean(req.body.profile_music_url ?? current.profile_music_url, 500),
    profile_music_cover: clean(req.body.profile_music_cover ?? current.profile_music_cover, 500),
    profile_music_artist: clean(req.body.profile_music_artist ?? current.profile_music_artist, 80)
  };

  db.prepare([
    'UPDATE users SET display_name = ?, bio = ?, status = ?, profile_emoji = ?,',
    'theme = ?, accent = ?, wallpaper = ?, bubble_style = ?,',
    'profile_bg_color = ?, profile_bg_emoji = ?, profile_music_title = ?, profile_music_url = ?,',
    'profile_music_cover = ?, profile_music_artist = ?',
    'WHERE id = ?'
  ].join(' ')).run(
    next.display_name,
    next.bio,
    next.status,
    next.profile_emoji,
    next.theme,
    next.accent,
    next.wallpaper,
    next.bubble_style,
    next.profile_bg_color,
    next.profile_bg_emoji,
    next.profile_music_title,
    next.profile_music_url,
    next.profile_music_cover,
    next.profile_music_artist,
    req.user.id
  );

  res.json({ ok: true, user: publicUser(getUserById(req.user.id)) });
});

app.put('/api/profile/key', auth, (req, res) => {
  const publicKey = clean(req.body.public_key, 20000);
  if (!publicKey) return res.status(400).json({ error: 'Публичный ключ не передан' });
  db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(publicKey, req.user.id);
  res.json({ ok: true, user: publicUser(getUserById(req.user.id)) });
});

app.post('/api/avatar', auth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выбери изображение' });
  const avatar = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.user.id);
  res.json({ avatar, user: publicUser(getUserById(req.user.id)) });
});

app.post('/api/profile/music', auth, audioUpload.single('music'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выбери аудио-файл' });
  const music = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET profile_music_url = ? WHERE id = ?').run(music, req.user.id);
  res.json({ music, user: publicUser(getUserById(req.user.id)) });
});

app.post('/api/profile/music-cover', auth, upload.single('cover'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выбери изображение обложки' });
  const cover = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET profile_music_cover = ? WHERE id = ?').run(cover, req.user.id);
  res.json({ cover, user: publicUser(getUserById(req.user.id)) });
});

app.get('/api/marketplace', auth, (req, res) => {
  const user = getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Профиль не найден' });

  const order = [
    "CASE type WHEN 'gift' THEN 1 WHEN 'username' THEN 2 ELSE 3 END",
    'created_at DESC'
  ].join(', ');

  const items = db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible, total_supply, sold_count, template_id, created_at, purchased_at',
    "FROM nft_items WHERE owner_id IS NULL AND template_id = ''",
    'ORDER BY ' + order
  ].join(' ')).all().map(nftItem);

  const inventory = db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible, total_supply, sold_count, template_id, created_at, purchased_at',
    'FROM nft_items WHERE owner_id = ?',
    'ORDER BY COALESCE(purchased_at, created_at) DESC'
  ].join(' ')).all(req.user.id).map(nftItem);

  res.json({
    balance: Number(user.doxiki_balance || 0),
    is_admin: isAdminUser(user),
    is_owner_admin: isOwnerUser(user),
    items,
    inventory
  });
});

app.post('/api/marketplace/:itemId/buy', auth, (req, res) => {
  const itemId = clean(req.params.itemId, 100);

  const buy = db.transaction(() => {
    const item = db.prepare([
      'SELECT id, type, title, image, price, owner_id, profile_visible, total_supply, sold_count, template_id, created_at, purchased_at',
      'FROM nft_items WHERE id = ?'
    ].join(' ')).get(itemId);
    if (!item) return { status: 404, error: 'NFT не найден' };

    const user = getUserById(req.user.id);
    if (!user) return { status: 404, error: 'Профиль не найден' };
    const price = Number(item.price || 0);
    if (Number(user.doxiki_balance || 0) < price) {
      return { status: 400, error: 'Не хватает доксиков' };
    }

    const supply = Number(item.total_supply || 1);
    const sold = Number(item.sold_count || 0);

    if (item.type === 'gift' && supply > 1) {
      if (sold >= supply) return { status: 400, error: 'Тираж распродан' };
      db.prepare('UPDATE users SET doxiki_balance = doxiki_balance - ? WHERE id = ?').run(price, req.user.id);
      db.prepare('UPDATE nft_items SET sold_count = sold_count + 1 WHERE id = ?').run(itemId);
      const copyId = randomUUID();
      db.prepare([
        'INSERT INTO nft_items (id, type, title, image, price, owner_id, template_id, total_supply, sold_count, profile_visible, created_by, purchased_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, unixepoch())'
      ].join(' ')).run(copyId, item.type, item.title, item.image, item.price, req.user.id, item.id, req.user.id);
      return {
        ok: true,
        balance: Number(user.doxiki_balance || 0) - price,
        item: nftItem({ ...item, id: copyId, owner_id: req.user.id, template_id: item.id, purchased_at: Math.floor(Date.now() / 1000) })
      };
    }

    if (item.owner_id) return { status: 400, error: 'Этот NFT уже купили' };
    db.prepare('UPDATE users SET doxiki_balance = doxiki_balance - ? WHERE id = ?').run(price, req.user.id);
    db.prepare([
      'UPDATE nft_items SET owner_id = ?, purchased_at = unixepoch()',
      'WHERE id = ? AND owner_id IS NULL'
    ].join(' ')).run(req.user.id, itemId);

    return {
      ok: true,
      balance: Number(user.doxiki_balance || 0) - price,
      item: nftItem({ ...item, owner_id: req.user.id, purchased_at: Math.floor(Date.now() / 1000) })
    };
  });

  const result = buy();
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Покупка не прошла' });
  res.json(result);
});

app.put('/api/profile/nfts/:itemId', auth, (req, res) => {
  const itemId = clean(req.params.itemId, 100);
  const visible = req.body.visible ? 1 : 0;
  const item = db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible, total_supply, sold_count, template_id, created_at, purchased_at',
    'FROM nft_items WHERE id = ? AND owner_id = ?'
  ].join(' ')).get(itemId, req.user.id);

  if (!item) return res.status(404).json({ error: 'NFT в твоей коллекции не найден' });

  db.prepare('UPDATE nft_items SET profile_visible = ? WHERE id = ? AND owner_id = ?').run(visible, itemId, req.user.id);
  res.json({
    ok: true,
    item: nftItem({ ...item, profile_visible: visible }),
    profile_nfts: profileNfts(req.user.id)
  });
});

app.post('/api/admin/nft-gifts', auth, adminOnly, upload.single('image'), (req, res) => {
  const title = clean(req.body.title, 64) || 'NFT подарок';
  const price = parseDoxikiAmount(req.body.price, true);
  const quantity = Math.max(1, Math.min(100000, Number(req.body.quantity) || 1));

  if (price === null) return res.status(400).json({ error: 'Укажи цену в доксиках' });
  if (!req.file) return res.status(400).json({ error: 'Загрузи фото NFT подарка' });

  const item = {
    id: randomUUID(),
    type: 'gift',
    title,
    image: '/uploads/' + req.file.filename,
    price,
    total_supply: quantity,
    sold_count: 0
  };

  db.prepare([
    'INSERT INTO nft_items (id, type, title, image, price, total_supply, sold_count, created_by)',
    'VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
  ].join(' ')).run(item.id, item.type, item.title, item.image, item.price, item.total_supply, req.user.id);

  res.json({ ok: true, item: nftItem(item) });
});

app.post('/api/admin/nft-assets', auth, adminOnly, (req, res) => {
  const type = clean(req.body.type, 32);
  const value = clean(req.body.value, 64);
  const price = parseDoxikiAmount(req.body.price, true);

  if (type !== 'username' && type !== 'number') {
    return res.status(400).json({ error: 'Выбери NFT юзернейм или NFT номер' });
  }
  if (!value) return res.status(400).json({ error: 'Введи значение NFT' });
  if (price === null) return res.status(400).json({ error: 'Укажи цену в доксиках' });

  const item = {
    id: randomUUID(),
    type,
    title: value,
    image: '',
    price
  };

  db.prepare([
    'INSERT INTO nft_items (id, type, title, image, price, created_by)',
    'VALUES (?, ?, ?, ?, ?, ?)'
  ].join(' ')).run(item.id, item.type, item.title, item.image, item.price, req.user.id);

  res.json({ ok: true, item: nftItem(item) });
});

app.post('/api/admin/doxiki', auth, adminOnly, (req, res) => {
  const username = normalizeUsername(req.body.username);
  const amount = parseDoxikiAmount(req.body.amount, false);

  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });
  if (amount === null) return res.status(400).json({ error: 'Введи количество доксиков' });

  const target = db.prepare('SELECT id, username, display_name, doxiki_balance FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare('UPDATE users SET doxiki_balance = doxiki_balance + ? WHERE id = ?').run(amount, target.id);
  const updated = getUserById(target.id);

  res.json({
    ok: true,
    user: {
      id: updated.id,
      username: updated.username,
      display_name: updated.display_name,
      doxiki_balance: Number(updated.doxiki_balance || 0)
    }
  });
});

app.post('/api/admin/access', auth, ownerOnly, (req, res) => {
  const username = normalizeUsername(req.body.username);
  const enabled = req.body.enabled !== false;

  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });
  if (username === ADMIN_USERNAME && !enabled) {
    return res.status(400).json({ error: 'Нельзя снять админку с владельца' });
  }

  const target = db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(enabled ? 1 : 0, target.id);
  const updated = getUserById(target.id);

  res.json({
    ok: true,
    user: {
      id: updated.id,
      username: updated.username,
      display_name: updated.display_name,
      is_admin: isAdminUser(updated),
      is_owner_admin: isOwnerUser(updated)
    }
  });
});

  app.post('/api/admin/impersonate', auth, ownerOnly, (req, res) => {
    const username = normalizeUsername(req.body.username);
    if (!username) return res.status(400).json({ error: 'Введи юзернейм' });

    const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

    res.json({ token: signUser(target), user: publicUser(target) });
  });

  app.get('/api/admin/users', auth, adminOnly, (req, res) => {
    const users = db.prepare([
      'SELECT id, username, display_name, avatar, bio, status, doxiki_balance, is_admin, created_at',
      'FROM users ORDER BY created_at DESC LIMIT 200'
    ].join(' ')).all();
    res.json(users.map(u => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      avatar: u.avatar || '',
      bio: u.bio || '',
      status: u.status || '',
      doxiki_balance: Number(u.doxiki_balance || 0),
      is_admin: Boolean(u.is_admin),
      created_at: u.created_at
    })));
  });

app.get('/api/users/search', auth, (req, res) => {
  const query = clean(req.query.q, 32);
  if (!query) return res.json([]);

  const like = '%' + query + '%';
  const users = db.prepare([
    'SELECT id, username, display_name, avatar, bio, status, public_key',
    'FROM users',
    'WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)',
    'ORDER BY username LIMIT 12'
  ].join(' ')).all(req.user.id, like, like);

  res.json(users);
});

app.get('/api/users/:userId/profile', auth, (req, res) => {
  const user = getUserById(clean(req.params.userId, 100));
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const directChat = db.prepare([
    'SELECT c.id FROM chats c',
    'JOIN chat_members mine ON mine.chat_id = c.id AND mine.user_id = ?',
    'JOIN chat_members peer ON peer.chat_id = c.id AND peer.user_id = ?',
    'WHERE c.is_group = 0 LIMIT 1'
  ].join(' ')).get(req.user.id, user.id);

  const shared = db.prepare([
    'SELECT COUNT(*) AS count FROM chat_members mine',
    'JOIN chat_members peer ON peer.chat_id = mine.chat_id AND peer.user_id = ?',
    'WHERE mine.user_id = ?'
  ].join(' ')).get(user.id, req.user.id);

  res.json({
    user: publicUser(user),
    profile_nfts: profileNfts(user.id),
    is_self: user.id === req.user.id,
    is_online: onlineUsers.has(user.id),
    shared_chats: shared ? shared.count : 0,
    direct_chat_id: directChat ? directChat.id : null,
    encryption_ready: Boolean(user.public_key)
  });
});

app.get('/api/chats', auth, (req, res) => {
  const chats = db.prepare([
    'SELECT c.id, c.name, c.is_group, c.created_at, ck.encrypted_key,',
    'peer.id AS peer_id, peer.username AS peer_username, peer.display_name AS peer_display_name,',
    'peer.avatar AS peer_avatar, peer.bio AS peer_bio, peer.status AS peer_status,',
    '(SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,',
    '(SELECT m.iv FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_iv,',
    '(SELECT m.encrypted FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_encrypted,',
    '(SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_time',
    'FROM chats c',
    'JOIN chat_members own ON own.chat_id = c.id AND own.user_id = ?',
    'LEFT JOIN chat_keys ck ON ck.chat_id = c.id AND ck.user_id = ?',
    'LEFT JOIN chat_members peer_member ON peer_member.chat_id = c.id AND peer_member.user_id != ? AND c.is_group = 0',
    'LEFT JOIN users peer ON peer.id = peer_member.user_id',
    'ORDER BY COALESCE((SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1), c.created_at) DESC'
  ].join(' ')).all(req.user.id, req.user.id, req.user.id).map(exposeChatRow);

  res.json(chats);
});

app.post('/api/chats', auth, (req, res) => {
  const targetId = clean(req.body.user_id, 100);
  if (!targetId || targetId === req.user.id) {
    return res.status(400).json({ error: 'Выбери другого пользователя' });
  }

  const target = getUserById(targetId);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  const createChat = db.transaction(() => {
    const existing = db.prepare([
      'SELECT c.id FROM chats c',
      'JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?',
      'JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?',
      'WHERE c.is_group = 0 LIMIT 1'
    ].join(' ')).get(req.user.id, targetId);

    const chatId = existing ? existing.id : randomUUID();
    if (!existing) {
      db.prepare('INSERT INTO chats (id, is_group) VALUES (?, 0)').run(chatId);
      db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(chatId, req.user.id);
      db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(chatId, targetId);
    }

    if (!existing) {
      storeChatKeys(chatId, [req.user.id, targetId], req.body.keys);
    } else {
      const keyCount = db.prepare('SELECT COUNT(*) AS count FROM chat_keys WHERE chat_id = ?').get(chatId).count;
      if (!keyCount) storeChatKeys(chatId, [req.user.id, targetId], req.body.keys);
    }
    return { chatId, existing: Boolean(existing) };
  });

  const result = createChat();
  notifyUsers([req.user.id, targetId], 'chats_changed', { chatId: result.chatId });
  res.json({ id: result.chatId, existing: result.existing, chat: getChatForUser(result.chatId, req.user.id) });
});

app.get('/api/chats/:chatId/messages', auth, (req, res) => {
  if (!isMember(req.params.chatId, req.user.id)) {
    return res.status(403).json({ error: 'Нет доступа к этому чату' });
  }

  const messages = db.prepare([
    'SELECT m.id, m.chat_id, m.sender_id, m.content, m.iv, m.encrypted, m.created_at,',
    'u.display_name, u.avatar, u.username',
    'FROM messages m',
    'JOIN users u ON u.id = m.sender_id',
    'WHERE m.chat_id = ?',
    'ORDER BY m.created_at ASC LIMIT 200'
  ].join(' ')).all(req.params.chatId).map(exposeMessage);

  res.json(messages);
});

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const userSockets = onlineUsers.get(socket.user.id) || new Set();
  userSockets.add(socket.id);
  onlineUsers.set(socket.user.id, userSockets);

  const chatIds = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(socket.user.id);
  for (const row of chatIds) socket.join(row.chat_id);

  socket.on('join_chat', (chatId) => {
    const id = clean(chatId, 100);
    if (isMember(id, socket.user.id)) socket.join(id);
  });

  socket.on('message', (data, ack) => {
    const chatId = clean(data && data.chatId, 100);
    const content = String((data && data.content) || '');
    const iv = data && data.iv ? clean(data.iv, 2000) : null;
    const encrypted = data && data.encrypted ? 1 : 0;

    if (!chatId || !content || content.length > 20000) {
      if (ack) ack({ ok: false, error: 'Сообщение не отправлено' });
      return;
    }
    if (!isMember(chatId, socket.user.id)) {
      if (ack) ack({ ok: false, error: 'Нет доступа к чату' });
      return;
    }

    const id = randomUUID();
    const user = db.prepare('SELECT display_name, avatar, username FROM users WHERE id = ?').get(socket.user.id);
    let storedContent = content;
    let storedIv = iv;
    let storedEncrypted = encrypted;
    let serverEncrypted = 0;

    if (!encrypted) {
      const packed = encryptAtRest(content);
      storedContent = packed.content;
      storedIv = packed.iv;
      storedEncrypted = 2;
      serverEncrypted = 1;
    }

    db.prepare([
      'INSERT INTO messages (id, chat_id, sender_id, content, iv, encrypted)',
      'VALUES (?, ?, ?, ?, ?, ?)'
    ].join(' ')).run(id, chatId, socket.user.id, storedContent, storedIv, storedEncrypted);

    const message = {
      id,
      chatId,
      chat_id: chatId,
      content,
      iv: encrypted ? iv : null,
      encrypted,
      server_encrypted: serverEncrypted,
      sender_id: socket.user.id,
      display_name: user.display_name,
      avatar: user.avatar,
      username: user.username,
      created_at: Math.floor(Date.now() / 1000)
    };

    io.to(chatId).emit('message', message);
    notifyChatMembers(chatId);
    if (ack) ack({ ok: true, id });
  });

  socket.on('disconnect', () => {
    const sockets = onlineUsers.get(socket.user.id);
    if (!sockets) return;
    sockets.delete(socket.id);
    if (!sockets.size) onlineUsers.delete(socket.user.id);
  });
});

function startListening(port) {
  server.listen(port, HOST, () => {
    app.locals.port = port;
    const info = serverInfo(port);
    console.log('Messenger is running on this PC: ' + info.local_url);
    if (info.lan_urls.length) {
      console.log('Friends on your Wi-Fi/LAN can open:');
      for (const url of info.lan_urls) console.log('  ' + url);
    } else {
      console.log('LAN link: find your IPv4 in ipconfig and open http://YOUR-IP:' + port);
    }
  });
}

server.once('error', (error) => {
  if (error.code === 'EADDRINUSE' && PORT !== 3001) {
    startListening(3001);
    return;
  }
  throw error;
});

startListening(PORT);
