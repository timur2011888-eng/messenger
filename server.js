const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { randomUUID } = require('crypto');
const path = require('path');
const fsSync = require('fs');
const os = require('os');
const db = require('./db');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'local_dev_secret_change_me';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_USERNAME = 'sinagoga322';
const PUBLIC_DIR = path.join(__dirname, 'Public');

// Инициализация Supabase клиента
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
  console.warn('⚠️ Внимание: Переменные SUPABASE_URL и SUPABASE_KEY не заданы. Загрузка файлов не будет работать!');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/server-info', (_req, res) => {
  res.json(serverInfo(app.locals.port || PORT));
});

// Храним файлы в оперативной памяти перед отправкой в Supabase
const storage = multer.memoryStorage();

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
    if (!file.mimetype || !(file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/'))) {
      return cb(new Error('Можно загрузить только музыку'));
    }
    cb(null, true);
  }
});

const musicLibraryUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'music' && file.mimetype && (file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/'))) return cb(null, true);
    if (file.fieldname === 'cover' && file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Можно загрузить аудио и изображение обложки'));
  }
});

const voiceUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !(file.mimetype.startsWith('audio/') || file.mimetype === 'video/webm')) {
      return cb(new Error('Можно загрузить только голосовое сообщение'));
    }
    cb(null, true);
  }
});

const adminSoundUpload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !(file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/'))) {
      return cb(new Error('Можно загрузить только аудио'));
    }
    cb(null, true);
  }
});

const messageUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype) return cb(new Error('Файл не распознан'));
    cb(null, true);
  }
});

// Функция для загрузки буфера файла напрямую в Supabase Storage
async function uploadToSupabase(file, folder = 'common') {
  if (!supabase) {
    const safeFolder = String(folder || 'common').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'common';
    const fileExt = path.extname(file.originalname || '.bin') || '.bin';
    const uploadDir = path.join(PUBLIC_DIR, 'uploads', safeFolder);
    fsSync.mkdirSync(uploadDir, { recursive: true });
    const fileName = `${randomUUID()}${fileExt}`;
    fsSync.writeFileSync(path.join(uploadDir, fileName), file.buffer);
    return `/uploads/${safeFolder}/${fileName}`;
  }

  const fileExt = path.extname(file.originalname || '.png');
  const fileName = `${folder}/${randomUUID()}${fileExt}`;

  const { data, error } = await supabase.storage
    .from('uploads')
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      cacheControl: '3600',
      upsert: false
    });

  if (error) {
    throw error;
  }

  // Получаем публичную ссылку на файл
  const { data: publicUrlData } = supabase.storage
    .from('uploads')
    .getPublicUrl(fileName);

  return publicUrlData.publicUrl;
}

const onlineUsers = new Map();
const activeCalls = new Map();
const activeScreenShares = new Map();
const SCREEN_SHARE_TTL_MS = 5 * 60 * 1000;

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

function cleanImageSource(value) {
  const source = clean(value, 4096);
  if (!source) return '';

  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(source)) {
    return source.replace(/\s/g, '');
  }

  try {
    const parsed = new URL(source);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return source;
  } catch {}

  return '';
}

function cleanHttpUrl(value) {
  const source = clean(value, 2000);
  if (!source) return '';

  try {
    const parsed = new URL(source);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {}

  return '';
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
    doxiki_balance: Number(user.doxiki_balance || 0),
    profile_bg_color: cleanColor(user.profile_bg_color || '#20242b'),
    profile_bg_image: user.profile_bg_image || '',
    profile_bg_emoji: user.profile_bg_emoji || '',
    profile_music_title: user.profile_music_title || '',
    profile_music_url: user.profile_music_url || '',
    profile_music_cover: user.profile_music_cover || '',
    profile_music_artist: user.profile_music_artist || '',
    profile_social_icon: user.profile_social_icon || '',
    profile_social_url: user.profile_social_url || '',
    is_admin: isAdminUser(user),
    is_owner_admin: isOwnerUser(user),
    is_anon_plus: Boolean(Number(user.is_anon_plus) || isAdminUser(user)),
    admin_permissions: getAdminPerms(user),
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

async function getUserById(id) {
  return await db.prepare([
    'SELECT id, username, display_name, bio, avatar, status, profile_emoji,',
    'theme, accent, wallpaper, bubble_style, doxiki_balance, is_admin, is_anon_plus,',
    'admin_permissions, profile_bg_color, profile_bg_image, profile_bg_emoji, profile_music_title, profile_music_url,',
    'profile_music_cover, profile_music_artist, profile_social_icon, profile_social_url, created_at',
    'FROM users WHERE id = ?'
  ].join(' ')).get(id);
}

function getAdminPerms(user) {
  if (!user) return {};
  if (isOwnerUser(user)) return { nfts: true, doxiki: true, plus: true, access: true };
  try { var p = JSON.parse(user.admin_permissions || '{}'); return p; } catch { return {}; }
}

function generateRandomNumber(code) {
  var digits = '';
  for (var i = 0; i < 9; i++) digits += Math.floor(Math.random() * 10);
  return code + ' ' + digits.slice(0, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6, 9);
}

function signUser(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function generateTempPassword() {
  return 'anon-' + randomUUID().replace(/-/g, '').slice(0, 10);
}

async function ensureOwnerAdmin() {
  const perms = JSON.stringify({ nfts: true, doxiki: true, plus: true, access: true });
  await db.prepare([
    'UPDATE users SET is_admin = 1, is_anon_plus = 1, admin_permissions = ?',
    'WHERE username = ?'
  ].join(' ')).run(perms, ADMIN_USERNAME);
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

async function isMember(chatId, userId) {
  return Boolean(await db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId));
}

async function peerForDirectChat(chatId, userId) {
  return await db.prepare([
    'SELECT c.id AS chat_id, c.is_group, peer.user_id AS peer_id',
    'FROM chats c',
    'JOIN chat_members mine ON mine.chat_id = c.id AND mine.user_id = ?',
    'LEFT JOIN chat_members peer ON peer.chat_id = c.id AND peer.user_id != ? AND c.is_group = 0',
    'WHERE c.id = ? LIMIT 1'
  ].join(' ')).get(userId, userId, chatId);
}

async function blockState(userId, peerId) {
  if (!peerId) return { i_blocked: false, blocked_me: false };
  const rows = await db.prepare([
    'SELECT blocker_id, blocked_id FROM user_blocks',
    'WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
  ].join(' ')).all(userId, peerId, peerId, userId);
  return {
    i_blocked: rows.some((row) => row.blocker_id === userId && row.blocked_id === peerId),
    blocked_me: rows.some((row) => row.blocker_id === peerId && row.blocked_id === userId)
  };
}

async function directChatBetween(userId, peerId) {
  if (!userId || !peerId || userId === peerId) return null;
  return await db.prepare([
    'SELECT c.id FROM chats c',
    'JOIN chat_members mine ON mine.chat_id = c.id AND mine.user_id = ?',
    'JOIN chat_members peer ON peer.chat_id = c.id AND peer.user_id = ?',
    'WHERE c.is_group = 0 LIMIT 1'
  ].join(' ')).get(userId, peerId);
}

async function enrichChatForUser(chat, userId) {
  if (!chat) return chat;
  const state = await blockState(userId, chat.peer_id);
  return {
    ...chat,
    i_blocked: state.i_blocked,
    blocked_me: state.blocked_me,
    last_message: chat.last_message_type === 'voice' ? 'Голосовое сообщение' : (chat.last_message || '')
  };
}

async function getChatForUser(chatId, userId) {
  const chat = await db.prepare([
    'SELECT c.id, c.name, c.is_group, c.created_at,',
    'peer.id AS peer_id, peer.username AS peer_username, peer.display_name AS peer_display_name,',
    'peer.avatar AS peer_avatar, peer.bio AS peer_bio, peer.status AS peer_status,',
    '(SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,',
    "(SELECT m.message_type FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_type,",
    '(SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_time',
    'FROM chats c',
    'JOIN chat_members own ON own.chat_id = c.id AND own.user_id = ?',
    'LEFT JOIN chat_members peer_member ON peer_member.chat_id = c.id AND peer_member.user_id != ? AND c.is_group = 0',
    'LEFT JOIN users peer ON peer.id = peer_member.user_id',
    'WHERE c.id = ? AND own.hidden_at IS NULL'
  ].join(' ')).get(userId, userId, chatId);
  return enrichChatForUser(chat, userId);
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

function pruneScreenShares() {
  const now = Date.now();
  for (const [requestId, share] of activeScreenShares) {
    if (now - share.createdAt > SCREEN_SHARE_TTL_MS) activeScreenShares.delete(requestId);
  }
}

function getScreenShare(requestId) {
  pruneScreenShares();
  return activeScreenShares.get(clean(requestId, 100));
}

async function notifyChatMembers(chatId) {
  const members = (await db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId)).map((row) => row.user_id);
  notifyUsers(members, 'chats_changed', { chatId });
}

async function ensureChatCanWrite(chatId, userId) {
  if (!(await isMember(chatId, userId))) {
    return { ok: false, status: 403, error: 'Нет доступа к чату' };
  }
  const direct = await peerForDirectChat(chatId, userId);
  if (direct && direct.peer_id) {
    const state = await blockState(userId, direct.peer_id);
    if (state.i_blocked) return { ok: false, status: 403, error: 'Ты заблокировал пользователя' };
    if (state.blocked_me) return { ok: false, status: 403, error: 'Пользователь тебя заблокировал' };
  }
  return { ok: true };
}

function messageTypeForFile(file) {
  const mime = file && file.mimetype ? file.mimetype : '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

async function messageById(messageId) {
  const msg = await db.prepare([
    'SELECT m.id, m.chat_id, m.sender_id, m.content, m.message_type, m.media_url, m.media_mime,',
    'm.file_name, m.file_size, m.duration, m.reply_to_id, m.edited_at, m.deleted_at, m.delivered_at, m.read_at, m.created_at,',
    'u.display_name, u.avatar, u.username,',
    'r.content AS reply_content, r.message_type AS reply_message_type, r.sender_id AS reply_sender_id, ru.display_name AS reply_sender_name',
    'FROM messages m',
    'JOIN users u ON u.id = m.sender_id',
    'LEFT JOIN messages r ON r.id = m.reply_to_id',
    'LEFT JOIN users ru ON ru.id = r.sender_id',
    'WHERE m.id = ? LIMIT 1'
  ].join(' ')).get(messageId);
  if (!msg) return null;
  msg.reactions = await messageReactions(messageId);
  return msg;
}

async function messageReactions(messageId) {
  return await db.prepare([
    'SELECT reaction, COUNT(*) AS count',
    'FROM message_reactions',
    'WHERE message_id = ?',
    'GROUP BY reaction',
    'ORDER BY count DESC, reaction ASC'
  ].join(' ')).all(messageId);
}

async function markDelivered(messageId, chatId, senderId) {
  const others = await db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? AND hidden_at IS NULL').all(chatId, senderId);
  if (others.length) {
    await db.prepare('UPDATE messages SET delivered_at = COALESCE(delivered_at, unixepoch()) WHERE id = ?').run(messageId);
  }
}

function failTransaction(status, error) {
  const failure = new Error(error);
  failure.result = { status, error };
  throw failure;
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
    listed_price: Number(row.listed_price || 0),
    listed_at: row.listed_at || null,
    seller_id: row.seller_id || row.owner_id || null,
    seller_username: row.seller_username || '',
    seller_display_name: row.seller_display_name || '',
    created_at: row.created_at,
    purchased_at: row.purchased_at || null
  };
}

async function profileNfts(userId) {
  const rows = (await db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible,',
    'total_supply, sold_count, template_id, listed_price, listed_at, created_at, purchased_at',
    'FROM nft_items',
    'WHERE owner_id = ? AND profile_visible = 1',
    "ORDER BY CASE type WHEN 'username' THEN 1 WHEN 'number' THEN 2 WHEN 'gift' THEN 3 ELSE 4 END, COALESCE(purchased_at, created_at) DESC"
  ].join(' ')).all(userId)).map(nftItem);
  let hasNumber = false;
  return rows.filter((item) => {
    if (!item || item.type !== 'number') return true;
    if (hasNumber) return false;
    hasNumber = true;
    return true;
  });
}

function parseDoxikiAmount(value, allowZero = false) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1) || amount > 1000000000000) {
    return null;
  }
  return amount;
}

async function adminOnly(req, res, next) {
  const user = await getUserById(req.user.id);
  if (!isAdminUser(user)) {
    return res.status(403).json({ error: 'Админка доступна только владельцу' });
  }
  req.adminUser = user;
  next();
}

async function ownerOnly(req, res, next) {
  const user = await getUserById(req.user.id);
  if (!isOwnerUser(user)) {
    return res.status(403).json({ error: 'Только для владельца' });
  }
  req.ownerUser = user;
  next();
}

// ===== AUTH =====
app.post('/api/register', async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const displayName = clean(req.body.display_name, 48) || username;

  if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'Юзернейм: 3-24 символа, латиница, цифры, _ или .' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть от 6 символов' });
  }

  try {
    const id = randomUUID();
    const hash = await bcrypt.hash(password, 12);
    const ownerPerms = JSON.stringify({ nfts: true, doxiki: true, plus: true, access: true });
    await db.prepare([
      'INSERT INTO users (id, username, password, display_name, is_admin, is_anon_plus, admin_permissions)',
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ].join(' ')).run(
      id, username, hash, displayName,
      username === ADMIN_USERNAME ? 1 : 0,
      username === ADMIN_USERNAME ? 1 : 0,
      username === ADMIN_USERNAME ? ownerPerms : '{}'
    );
    const user = await getUserById(id);
    res.json({ token: signUser(user), user: publicUser(user) });
  } catch (error) {
    res.status(400).json({ error: 'Такой юзернейм уже занят' });
  }
});

app.post('/api/login', async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) return res.status(400).json({ error: 'Неверный юзернейм или пароль' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Неверный юзернейм или пароль' });

  res.json({ token: signUser(user), user: publicUser(user) });
});

// ===== PROFILE =====
app.get('/api/profile', auth, async (req, res) => {
  res.json(publicUser(await getUserById(req.user.id)));
});

app.put('/api/profile', auth, async (req, res) => {
  const current = await getUserById(req.user.id);
  if (!current) return res.status(404).json({ error: 'Профиль не найден' });

  const hasPlus = Boolean(Number(current.is_anon_plus) || isAdminUser(current));

  const next = {
    display_name: clean(req.body.display_name || current.display_name, 48),
    bio: hasPlus ? clean(req.body.bio ?? current.bio, 180) : (current.bio || ''),
    status: hasPlus ? clean(req.body.status ?? current.status, 36) : (current.status || ''),
    profile_emoji: clean(req.body.profile_emoji ?? current.profile_emoji, 16),
    theme: hasPlus ? clean(req.body.theme ?? current.theme, 24) : (current.theme || 'midnight'),
    accent: hasPlus ? clean(req.body.accent ?? current.accent, 16) : (current.accent || '#2f8fed'),
    wallpaper: hasPlus ? clean(req.body.wallpaper ?? current.wallpaper, 24) : (current.wallpaper || 'aurora'),
    bubble_style: hasPlus ? clean(req.body.bubble_style ?? current.bubble_style, 24) : (current.bubble_style || 'rounded'),
    profile_bg_color: hasPlus ? cleanColor(req.body.profile_bg_color ?? current.profile_bg_color) : (current.profile_bg_color || '#20242b'),
    profile_bg_image: hasPlus ? clean(req.body.profile_bg_image ?? current.profile_bg_image, 1000) : (current.profile_bg_image || ''),
    profile_bg_emoji: clean(req.body.profile_bg_emoji ?? current.profile_bg_emoji, 24),
    profile_music_title: hasPlus ? clean(req.body.profile_music_title ?? current.profile_music_title, 80) : (current.profile_music_title || ''),
    profile_music_url: hasPlus ? clean(req.body.profile_music_url ?? current.profile_music_url, 500) : (current.profile_music_url || ''),
    profile_music_cover: hasPlus ? clean(req.body.profile_music_cover ?? current.profile_music_cover, 500) : (current.profile_music_cover || ''),
    profile_music_artist: hasPlus ? clean(req.body.profile_music_artist ?? current.profile_music_artist, 80) : (current.profile_music_artist || ''),
    profile_social_url: hasPlus ? cleanHttpUrl(req.body.profile_social_url ?? current.profile_social_url) : (current.profile_social_url || '')
  };

  await db.prepare([
    'UPDATE users SET display_name = ?, bio = ?, status = ?, profile_emoji = ?,',
    'theme = ?, accent = ?, wallpaper = ?, bubble_style = ?,',
    'profile_bg_color = ?, profile_bg_image = ?, profile_bg_emoji = ?, profile_music_title = ?, profile_music_url = ?,',
    'profile_music_cover = ?, profile_music_artist = ?, profile_social_url = ?',
    'WHERE id = ?'
  ].join(' ')).run(
    next.display_name, next.bio, next.status, next.profile_emoji,
    next.theme, next.accent, next.wallpaper, next.bubble_style,
    next.profile_bg_color, next.profile_bg_image, next.profile_bg_emoji, next.profile_music_title, next.profile_music_url,
    next.profile_music_cover, next.profile_music_artist, next.profile_social_url, req.user.id
  );

  res.json({ ok: true, user: publicUser(await getUserById(req.user.id)) });
});

app.post('/api/profile/password', auth, async (req, res) => {
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть от 6 символов' });
  }

  const user = await db.prepare('SELECT id, password FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Профиль не найден' });

  const ok = await bcrypt.compare(currentPassword, user.password);
  if (!ok) return res.status(400).json({ error: 'Старый пароль неверный' });

  const hash = await bcrypt.hash(newPassword, 12);
  await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);

  res.json({ ok: true });
});

app.post('/api/avatar', auth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выбери изображение' });
  try {
    const avatarUrl = await uploadToSupabase(req.file, 'avatars');
    await db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
    res.json({ avatar: avatarUrl, user: publicUser(await getUserById(req.user.id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить аватарку в Supabase' });
  }
});

app.post('/api/profile/background', auth, upload.single('background'), async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user || !(Number(user.is_anon_plus) || isAdminUser(user))) {
    return res.status(403).json({ error: 'Фон-фото профиля доступно только ANON+' });
  }
  if (!req.file) return res.status(400).json({ error: 'Выбери изображение' });
  try {
    const bgUrl = await uploadToSupabase(req.file, 'profile-backgrounds');
    await db.prepare('UPDATE users SET profile_bg_image = ? WHERE id = ?').run(bgUrl, req.user.id);
    res.json({ background: bgUrl, user: publicUser(await getUserById(req.user.id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить фон профиля' });
  }
});

app.post('/api/profile/social-icon', auth, upload.single('icon'), async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user || !(Number(user.is_anon_plus) || isAdminUser(user))) {
    return res.status(403).json({ error: 'Соц-иконка в профиле доступна только ANON+' });
  }
  if (!req.file) return res.status(400).json({ error: 'Выбери изображение иконки' });
  try {
    const iconUrl = await uploadToSupabase(req.file, 'profile-social-icons');
    await db.prepare('UPDATE users SET profile_social_icon = ? WHERE id = ?').run(iconUrl, req.user.id);
    res.json({ icon: iconUrl, user: publicUser(await getUserById(req.user.id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить соц-иконку' });
  }
});

app.get('/api/music-library', auth, async (req, res) => {
  const rows = await db.prepare([
    'SELECT m.id, m.title, m.artist, m.audio_url, m.cover_url, m.created_at,',
    'u.username AS uploader_username, u.display_name AS uploader_display_name',
    'FROM music_library m',
    'JOIN users u ON u.id = m.uploader_id',
    'ORDER BY m.created_at DESC LIMIT 200'
  ].join(' ')).all();
  res.json(rows);
});

app.post('/api/music-library', auth, musicLibraryUpload.fields([{ name: 'music', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  const music = req.files && req.files.music && req.files.music[0];
  const cover = req.files && req.files.cover && req.files.cover[0];
  const title = clean(req.body.title, 80);
  const artist = clean(req.body.artist, 80);
  if (!music) return res.status(400).json({ error: 'Выбери аудио-файл' });
  if (!title) return res.status(400).json({ error: 'Название обязательно' });
  try {
    const audioUrl = await uploadToSupabase(music, 'music-library');
    const coverUrl = cover ? await uploadToSupabase(cover, 'music-covers') : '';
    const id = randomUUID();
    await db.prepare([
      'INSERT INTO music_library (id, uploader_id, title, artist, audio_url, cover_url)',
      'VALUES (?, ?, ?, ?, ?, ?)'
    ].join(' ')).run(id, req.user.id, title, artist, audioUrl, coverUrl);
    res.json({ ok: true, track: (await db.prepare('SELECT * FROM music_library WHERE id = ?').get(id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить трек' });
  }
});

app.post('/api/profile/music-library/:trackId', auth, async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user || !(Number(user.is_anon_plus) || isAdminUser(user))) {
    return res.status(403).json({ error: 'Музыка профиля доступна только ANON+' });
  }
  const track = await db.prepare('SELECT * FROM music_library WHERE id = ?').get(clean(req.params.trackId, 100));
  if (!track) return res.status(404).json({ error: 'Трек не найден' });
  await db.prepare([
    'UPDATE users SET profile_music_title = ?, profile_music_artist = ?, profile_music_url = ?, profile_music_cover = ?',
    'WHERE id = ?'
  ].join(' ')).run(track.title, track.artist || '', track.audio_url, track.cover_url || '', req.user.id);
  res.json({ ok: true, user: publicUser(await getUserById(req.user.id)), track });
});

// ===== MARKETPLACE =====
app.get('/api/marketplace', auth, async (req, res) => {
  const user = await getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Профиль не найден' });

  const items = (await db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible,',
    'total_supply, sold_count, template_id, listed_price, listed_at, created_at, purchased_at',
    "FROM nft_items WHERE owner_id IS NULL AND template_id = ''",
    "ORDER BY CASE type WHEN 'gift' THEN 1 WHEN 'username' THEN 2 ELSE 3 END, created_at DESC"
  ].join(' ')).all()).map(nftItem);

  const inventory = (await db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible,',
    'total_supply, sold_count, template_id, listed_price, listed_at, created_at, purchased_at',
    'FROM nft_items WHERE owner_id = ?',
    'ORDER BY COALESCE(purchased_at, created_at) DESC'
  ].join(' ')).all(req.user.id)).map(nftItem);

  const userItems = (await db.prepare([
    'SELECT n.id, n.type, n.title, n.image, n.price, n.owner_id, n.owner_id AS seller_id,',
    'n.profile_visible, n.total_supply, n.sold_count, n.template_id, n.listed_price, n.listed_at,',
    'n.created_at, n.purchased_at, u.username AS seller_username, u.display_name AS seller_display_name',
    'FROM nft_items n',
    'JOIN users u ON u.id = n.owner_id',
    'WHERE n.owner_id IS NOT NULL AND n.owner_id != ? AND n.listed_price > 0',
    'ORDER BY n.listed_at DESC LIMIT 200'
  ].join(' ')).all(req.user.id)).map(nftItem);

  const leaders = (await db.prepare([
    'SELECT id, username, display_name, avatar, doxiki_balance',
    'FROM users WHERE doxiki_balance > 0',
    'ORDER BY doxiki_balance DESC, created_at ASC LIMIT 20'
  ].join(' ')).all()).map((row, index) => ({
    rank: index + 1,
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar: row.avatar || '',
    doxiki_balance: Number(row.doxiki_balance || 0)
  }));

  res.json({
    balance: Number(user.doxiki_balance || 0),
    is_admin: isAdminUser(user),
    is_owner_admin: isOwnerUser(user),
    items,
    inventory,
    user_items: userItems,
    leaders
  });
});

app.post('/api/marketplace/:itemId/buy', auth, async (req, res) => {
  const itemId = clean(req.params.itemId, 100);

  const buy = db.transaction(async () => {
    const item = await db.prepare([
      'SELECT id, type, title, image, price, owner_id, profile_visible,',
      'total_supply, sold_count, template_id, created_at, purchased_at',
      'FROM nft_items WHERE id = ?'
    ].join(' ')).get(itemId);
    if (!item) failTransaction(404, 'NFT не найден');

    if (item.template_id) failTransaction(400, 'Этот NFT не продается');

    const user = await getUserById(req.user.id);
    if (!user) failTransaction(404, 'Профиль не найден');
    const price = Number(item.price || 0);
    if (Number(user.doxiki_balance || 0) < price) {
      failTransaction(400, 'Не хватает доксиков');
    }

    const supply = Number(item.total_supply || 1);
    const sold = Number(item.sold_count || 0);

    if (item.type === 'gift' && supply > 1) {
      if (sold >= supply) failTransaction(400, 'Тираж распродан');
      const spend = await db.prepare('UPDATE users SET doxiki_balance = doxiki_balance - ? WHERE id = ? AND doxiki_balance >= ?').run(price, req.user.id, price);
      if (!spend.changes) failTransaction(400, 'Не хватает доксиков');
      await db.prepare('UPDATE nft_items SET sold_count = sold_count + 1 WHERE id = ?').run(itemId);
      const copyId = randomUUID();
      await db.prepare([
        'INSERT INTO nft_items (id, type, title, image, price, owner_id, template_id, total_supply, sold_count, profile_visible, created_by, purchased_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, unixepoch())'
      ].join(' ')).run(copyId, item.type, item.title, item.image, item.price, req.user.id, item.id, req.user.id);
      return {
        ok: true,
        balance: Number(user.doxiki_balance || 0) - price,
        item: nftItem({ ...item, id: copyId, owner_id: req.user.id, template_id: item.id, purchased_at: Math.floor(Date.now() / 1000) })
      };
    }

    if (item.owner_id) failTransaction(400, 'Этот NFT уже купили');
    const spend = await db.prepare('UPDATE users SET doxiki_balance = doxiki_balance - ? WHERE id = ? AND doxiki_balance >= ?').run(price, req.user.id, price);
    if (!spend.changes) failTransaction(400, 'Не хватает доксиков');
    const update = await db.prepare('UPDATE nft_items SET owner_id = ?, purchased_at = unixepoch() WHERE id = ? AND owner_id IS NULL').run(req.user.id, itemId);
    if (!update.changes) failTransaction(400, 'Этот NFT уже купили');

    return {
      ok: true,
      balance: Number(user.doxiki_balance || 0) - price,
      item: nftItem({ ...item, owner_id: req.user.id, purchased_at: Math.floor(Date.now() / 1000) })
    };
  });

  let result;
  try {
    result = await buy();
  } catch (error) {
    if (error.result) result = error.result;
    else throw error;
  }
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Покупка не прошла' });
  res.json(result);
});

app.put('/api/profile/nfts/:itemId', auth, async (req, res) => {
  const itemId = clean(req.params.itemId, 100);
  const visible = req.body.visible ? 1 : 0;
  const item = await db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible,',
    'total_supply, sold_count, template_id, created_at, purchased_at',
    'FROM nft_items WHERE id = ? AND owner_id = ?'
  ].join(' ')).get(itemId, req.user.id);

  if (!item) return res.status(404).json({ error: 'NFT в твоей коллекции не найден' });

  const updateProfileNft = db.transaction(async () => {
    if (visible && item.type === 'number') {
      await db.prepare("UPDATE nft_items SET profile_visible = 0 WHERE owner_id = ? AND type = 'number' AND id <> ?").run(req.user.id, itemId);
    }
    await db.prepare('UPDATE nft_items SET profile_visible = ? WHERE id = ? AND owner_id = ?').run(visible, itemId, req.user.id);
  });
  await updateProfileNft();
  res.json({
    ok: true,
    item: nftItem({ ...item, profile_visible: visible }),
    profile_nfts: await profileNfts(req.user.id)
  });
});

app.post('/api/user-market/:itemId/list', auth, async (req, res) => {
  const itemId = clean(req.params.itemId, 100);
  const price = parseDoxikiAmount(req.body.price, false);
  if (price === null) return res.status(400).json({ error: 'Укажи цену в доксиках' });

  const item = await db.prepare([
    'SELECT id, owner_id FROM nft_items',
    'WHERE id = ? AND owner_id = ?'
  ].join(' ')).get(itemId, req.user.id);
  if (!item) return res.status(404).json({ error: 'NFT в твоей коллекции не найден' });

  await db.prepare('UPDATE nft_items SET listed_price = ?, listed_at = unixepoch(), profile_visible = 0 WHERE id = ? AND owner_id = ?').run(price, itemId, req.user.id);
  res.json({ ok: true, item: nftItem(await db.prepare([
    'SELECT id, type, title, image, price, owner_id, profile_visible, total_supply, sold_count, template_id, listed_price, listed_at, created_at, purchased_at',
    'FROM nft_items WHERE id = ?'
  ].join(' ')).get(itemId)) });
});

app.post('/api/user-market/:itemId/unlist', auth, async (req, res) => {
  const itemId = clean(req.params.itemId, 100);
  const update = await db.prepare('UPDATE nft_items SET listed_price = 0, listed_at = NULL WHERE id = ? AND owner_id = ?').run(itemId, req.user.id);
  if (!update.changes) return res.status(404).json({ error: 'NFT в твоей коллекции не найден' });
  res.json({ ok: true });
});

app.post('/api/user-market/:itemId/buy', auth, async (req, res) => {
  const itemId = clean(req.params.itemId, 100);

  const buy = db.transaction(async () => {
    const item = await db.prepare([
      'SELECT id, type, title, image, price, owner_id, profile_visible, total_supply, sold_count,',
      'template_id, listed_price, listed_at, created_at, purchased_at',
      'FROM nft_items WHERE id = ?'
    ].join(' ')).get(itemId);
    if (!item) failTransaction(404, 'NFT не найден');
    if (!item.owner_id || item.owner_id === req.user.id || Number(item.listed_price || 0) <= 0) {
      failTransaction(400, 'Этот NFT не продается на бирже');
    }

    const buyer = await getUserById(req.user.id);
    if (!buyer) failTransaction(404, 'Профиль не найден');

    const price = Number(item.listed_price || 0);
    const spend = await db.prepare('UPDATE users SET doxiki_balance = doxiki_balance - ? WHERE id = ? AND doxiki_balance >= ?').run(price, req.user.id, price);
    if (!spend.changes) failTransaction(400, 'Не хватает доксиков');

    await db.prepare('UPDATE users SET doxiki_balance = doxiki_balance + ? WHERE id = ?').run(price, item.owner_id);
    const move = await db.prepare([
      'UPDATE nft_items SET owner_id = ?, profile_visible = 0, listed_price = 0, listed_at = NULL, purchased_at = unixepoch()',
      'WHERE id = ? AND owner_id = ? AND listed_price > 0'
    ].join(' ')).run(req.user.id, item.id, item.owner_id);
    if (!move.changes) failTransaction(400, 'Этот NFT уже купили или сняли с продажи');

    return {
      ok: true,
      balance: Number(buyer.doxiki_balance || 0) - price,
      item: nftItem({ ...item, owner_id: req.user.id, listed_price: 0, listed_at: null, purchased_at: Math.floor(Date.now() / 1000) })
    };
  });

  let result;
  try {
    result = await buy();
  } catch (error) {
    if (error.result) result = error.result;
    else throw error;
  }

  if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Покупка не прошла' });
  res.json(result);
});

// ===== ADMIN =====
app.post('/api/admin/nft-gifts', auth, adminOnly, upload.single('image'), async (req, res) => {
  const perms = getAdminPerms(req.adminUser);
  if (!perms.nfts) return res.status(403).json({ error: 'У тебя нет права создавать NFT' });

  const title = clean(req.body.title, 64) || 'NFT подарок';
  const price = parseDoxikiAmount(req.body.price, true);
  const quantity = Math.max(1, Math.min(100000, Number(req.body.quantity) || 1));

  if (price === null) return res.status(400).json({ error: 'Укажи цену в доксиках' });
  if (!req.file) return res.status(400).json({ error: 'Загрузи фото NFT подарка' });

  try {
    const nftImageUrl = await uploadToSupabase(req.file, 'nfts');
    const item = {
      id: randomUUID(), type: 'gift', title,
      image: nftImageUrl, price,
      total_supply: quantity, sold_count: 0
    };

    await db.prepare([
      'INSERT INTO nft_items (id, type, title, image, price, total_supply, sold_count, created_by)',
      'VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
    ].join(' ')).run(item.id, item.type, item.title, item.image, item.price, item.total_supply, req.user.id);

    res.json({ ok: true, item: nftItem(item) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить изображение NFT в Supabase' });
  }
});

app.post('/api/admin/nft-assets', auth, adminOnly, async (req, res) => {
  const perms = getAdminPerms(req.adminUser);
  if (!perms.nfts) return res.status(403).json({ error: 'У тебя нет права создавать NFT' });

  const type = clean(req.body.type, 32);
  const price = parseDoxikiAmount(req.body.price, true);

  if (type !== 'username' && type !== 'number') {
    return res.status(400).json({ error: 'Выбери NFT юзернейм или NFT номер' });
  }
  if (price === null) return res.status(400).json({ error: 'Укажи цену в доксиках' });

  let title;
  if (type === 'number') {
    const code = clean(req.body.value || req.body.code, 8).replace(/[^0-9+]/g, '');
    if (!code || !code.startsWith('+')) return res.status(400).json({ error: 'Введи код страны (пример: +888)' });
    title = generateRandomNumber(code);
  } else {
    const value = clean(req.body.value, 64).replace(/^@+/, '').toLowerCase();
    if (!value) return res.status(400).json({ error: 'Введи значение NFT юзернейма' });
    if (!/^[a-z0-9_.]{3,24}$/.test(value)) return res.status(400).json({ error: 'Юз: 3-24 символа, латиница, цифры, _ или .' });
    title = value;
  }

  const item = { id: randomUUID(), type, title, image: '', price };

  const existing = await db.prepare('SELECT id FROM nft_items WHERE type = ? AND lower(title) = lower(?) LIMIT 1').get(type, title);
  if (existing) return res.status(400).json({ error: 'Такой NFT уже существует' });

  try {
    await db.prepare([
    'INSERT INTO nft_items (id, type, title, image, price, created_by)',
    'VALUES (?, ?, ?, ?, ?, ?)'
  ].join(' ')).run(item.id, item.type, item.title, item.image, item.price, req.user.id);
  } catch (error) {
    return res.status(400).json({ error: 'Такой NFT уже существует' });
  }

  res.json({ ok: true, item: nftItem(item) });
});

app.post('/api/admin/doxiki', auth, adminOnly, async (req, res) => {
  const perms = getAdminPerms(req.adminUser);
  if (!perms.doxiki) return res.status(403).json({ error: 'У тебя нет права выдавать доксики' });

  const username = normalizeUsername(req.body.username);
  const mode = clean(req.body.mode || 'add', 16);
  const amount = parseDoxikiAmount(req.body.amount, false);

  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });
  if (amount === null) return res.status(400).json({ error: 'Введи количество доксиков' });

  const target = await db.prepare('SELECT id, username, display_name, doxiki_balance FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  const delta = mode === 'take' ? -amount : amount;
  if (delta < 0 && Number(target.doxiki_balance || 0) + delta < 0) {
    return res.status(400).json({ error: 'Нельзя забрать больше, чем есть на балансе' });
  }

  await db.prepare('UPDATE users SET doxiki_balance = doxiki_balance + ? WHERE id = ?').run(delta, target.id);
  await db.prepare([
    'INSERT INTO economy_log (id, admin_id, user_id, amount, action, note)',
    'VALUES (?, ?, ?, ?, ?, ?)'
  ].join(' ')).run(randomUUID(), req.user.id, target.id, delta, delta < 0 ? 'take' : 'give', clean(req.body.note, 120));
  const updated = await getUserById(target.id);

  res.json({
    ok: true,
    user: { id: updated.id, username: updated.username, display_name: updated.display_name, doxiki_balance: Number(updated.doxiki_balance || 0) }
  });
});

app.post('/api/admin/access', auth, ownerOnly, async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const enabled = req.body.enabled !== false;

  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });
  if (username === ADMIN_USERNAME && !enabled) {
    return res.status(400).json({ error: 'Нельзя снять админку с владельца' });
  }

  const target = await db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  await db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(enabled ? 1 : 0, target.id);
  const updated = await getUserById(target.id);

  res.json({
    ok: true,
    user: { id: updated.id, username: updated.username, display_name: updated.display_name, is_admin: isAdminUser(updated), is_owner_admin: isOwnerUser(updated) }
  });
});

app.post('/api/admin/anon-plus', auth, adminOnly, async (req, res) => {
  const perms = getAdminPerms(req.adminUser);
  if (!perms.plus) return res.status(403).json({ error: 'У тебя нет права выдавать ANON+' });

  const username = normalizeUsername(req.body.username);
  const enabled = req.body.enabled !== false;

  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });

  const target = await db.prepare('SELECT id, username, display_name, is_anon_plus FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  await db.prepare('UPDATE users SET is_anon_plus = ? WHERE id = ?').run(enabled ? 1 : 0, target.id);
  const updated = await getUserById(target.id);

  res.json({
    ok: true,
    user: { id: updated.id, username: updated.username, display_name: updated.display_name, is_anon_plus: Boolean(Number(updated.is_anon_plus)) }
  });
});

app.post('/api/admin/screen-photo', auth, ownerOnly, upload.single('image'), async (req, res) => {
  const username = normalizeUsername(req.body.username);
  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });

  const target = await db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  let image = cleanImageSource(req.body.image_url || req.body.image);
  if (req.file) {
    try {
      image = await uploadToSupabase(req.file, 'screen-photos');
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Не удалось загрузить фото. Можно вставить прямую ссылку на картинку.' });
    }
  }

  if (!image) return res.status(400).json({ error: 'Вставь ссылку на фото или загрузи картинку' });

  const payload = {
    image,
    duration: 5000,
    from: req.user.username,
    created_at: Date.now()
  };
  const delivered = socketsForUser(target.id).size;
  notifyUsers([target.id], 'screen_photo', payload);

  res.json({
    ok: true,
    delivered,
    user: { id: target.id, username: target.username, display_name: target.display_name },
    duration: payload.duration
  });
});

app.post('/api/admin/fun', auth, ownerOnly, async (req, res) => {
  const username = normalizeUsername(req.body.username);
  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });

  const target = await db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  const allowed = new Set(['confetti', 'shake', 'flash', 'emoji', 'message']);
  const type = clean(req.body.type || 'confetti', 24);
  const message = clean(req.body.message || 'Привет от админа', 80);
  if (!allowed.has(type)) return res.status(400).json({ error: 'Такого эффекта нет' });

  const payload = {
    type,
    message,
    from: req.user.username,
    created_at: Date.now()
  };
  const delivered = socketsForUser(target.id).size;
  notifyUsers([target.id], 'admin_fun', payload);

  res.json({
    ok: true,
    delivered,
    user: { id: target.id, username: target.username, display_name: target.display_name }
  });
});

app.post('/api/admin/sound', auth, ownerOnly, adminSoundUpload.single('sound'), async (req, res) => {
  const username = normalizeUsername(req.body.username);
  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });

  const target = await db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  let soundUrl = clean(req.body.sound_url, 2000);
  if (soundUrl) {
    try {
      const parsed = new URL(soundUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') soundUrl = '';
    } catch {
      soundUrl = '';
    }
  }
  if (req.file) {
    try {
      soundUrl = await uploadToSupabase(req.file, 'admin-sounds');
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Не удалось загрузить звук' });
    }
  }
  if (!soundUrl) return res.status(400).json({ error: 'Загрузи звук или вставь ссылку' });

  const volume = Math.max(0, Math.min(1, Number(req.body.volume) || 1));
  const duration = Math.max(1000, Math.min(15000, Number(req.body.duration) || 8000));
  const payload = {
    sound_url: soundUrl,
    volume,
    duration,
    from: req.user.username,
    created_at: Date.now()
  };
  const delivered = socketsForUser(target.id).size;
  notifyUsers([target.id], 'admin_sound', payload);

  res.json({
    ok: true,
    delivered,
    user: { id: target.id, username: target.username, display_name: target.display_name }
  });
});

app.post('/api/admin/screen-share/request', auth, ownerOnly, async (req, res) => {
  const username = normalizeUsername(req.body.username);
  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });
  if (username === ADMIN_USERNAME) return res.status(400).json({ error: 'Себе экран запрашивать не нужно' });

  const target = await db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  pruneScreenShares();
  const requestId = randomUUID();
  const share = {
    id: requestId,
    adminId: req.user.id,
    adminUsername: req.user.username,
    targetId: target.id,
    targetUsername: target.username,
    createdAt: Date.now()
  };
  activeScreenShares.set(requestId, share);

  notifyUsers([target.id], 'screen_share:request', {
    requestId,
    from: req.user.username,
    duration: SCREEN_SHARE_TTL_MS
  });

  res.json({
    ok: true,
    requestId,
    delivered: socketsForUser(target.id).size,
    user: { id: target.id, username: target.username, display_name: target.display_name }
  });
});

app.post('/api/admin/impersonate', auth, ownerOnly, async (req, res) => {
  const username = normalizeUsername(req.body.username);
  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });

  const target = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  res.json({ token: signUser(target), user: publicUser(target) });
});

app.post('/api/admin/users/:userId/reset-password', auth, ownerOnly, async (req, res) => {
  const userId = clean(req.params.userId, 100);
  const target = await db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.username === ADMIN_USERNAME) {
    return res.status(400).json({ error: 'Пароль владельца меняется только в своем профиле' });
  }

  const password = clean(req.body.password, 128) || generateTempPassword();
  if (password.length < 6) return res.status(400).json({ error: 'Новый пароль должен быть от 6 символов' });

  const hash = await bcrypt.hash(password, 12);
  await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, target.id);

  res.json({
    ok: true,
    user: { id: target.id, username: target.username, display_name: target.display_name },
    password
  });
});

app.delete('/api/admin/users/:userId', auth, ownerOnly, async (req, res) => {
  const userId = clean(req.params.userId, 100);
  const target = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.username === ADMIN_USERNAME) {
    return res.status(400).json({ error: 'Нельзя удалить владельца' });
  }

  await db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  res.json({ ok: true });
});

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const users = await db.prepare([
    'SELECT id, username, display_name, avatar, bio, status, doxiki_balance, is_admin, is_anon_plus, admin_permissions, created_at',
    'FROM users ORDER BY created_at DESC LIMIT 200'
  ].join(' ')).all();
  res.json(users.map(u => {
    let perms = {};
    try { perms = JSON.parse(u.admin_permissions || '{}'); } catch {}
    return {
      id: u.id, username: u.username, display_name: u.display_name,
      avatar: u.avatar || '', doxiki_balance: Number(u.doxiki_balance || 0),
      is_admin: Boolean(u.is_admin) || u.username === ADMIN_USERNAME,
      is_anon_plus: Boolean(Number(u.is_anon_plus)) || u.username === ADMIN_USERNAME,
      admin_permissions: u.username === ADMIN_USERNAME ? { nfts: true, doxiki: true, plus: true, access: true } : perms,
      created_at: u.created_at
    };
  }));
});

app.post('/api/admin/permissions', auth, ownerOnly, async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const permissions = req.body.permissions || {};

  if (!username) return res.status(400).json({ error: 'Введи юзернейм' });
  if (username === ADMIN_USERNAME) return res.status(400).json({ error: 'Нельзя менять права владельца' });

  const target = await db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  const perms = {
    nfts: Boolean(permissions.nfts),
    doxiki: Boolean(permissions.doxiki),
    plus: Boolean(permissions.plus),
    access: Boolean(permissions.access)
  };

  await db.prepare('UPDATE users SET admin_permissions = ? WHERE id = ?').run(JSON.stringify(perms), target.id);

  res.json({ ok: true, username: target.username, permissions: perms });
});

app.get('/api/admin/nfts', auth, adminOnly, async (req, res) => {
  const perms = getAdminPerms(req.adminUser);
  if (!perms.nfts) return res.status(403).json({ error: 'У тебя нет права управлять NFT' });

  const items = await db.prepare([
    'SELECT n.id, n.type, n.title, n.image, n.price, n.owner_id, n.profile_visible,',
    'n.total_supply, n.sold_count, n.template_id, n.listed_price, n.listed_at, n.created_at, n.purchased_at,',
    'u.username AS owner_username, u.display_name AS owner_display_name',
    'FROM nft_items n',
    'LEFT JOIN users u ON u.id = n.owner_id',
    'ORDER BY COALESCE(n.purchased_at, n.created_at) DESC LIMIT 500'
  ].join(' ')).all();

  res.json(items.map((item) => ({
    ...nftItem(item),
    owner_username: item.owner_username || '',
    owner_display_name: item.owner_display_name || ''
  })));
});

app.delete('/api/admin/nfts/:itemId', auth, adminOnly, async (req, res) => {
  const perms = getAdminPerms(req.adminUser);
  if (!perms.nfts) return res.status(403).json({ error: 'У тебя нет права удалять NFT' });

  const itemId = clean(req.params.itemId, 100);
  const item = await db.prepare('SELECT id, template_id, type FROM nft_items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'NFT не найден' });

  const remove = db.transaction(async () => {
    if (!item.template_id && item.type === 'gift') {
      await db.prepare('DELETE FROM nft_items WHERE template_id = ?').run(item.id);
    }
    await db.prepare('DELETE FROM nft_items WHERE id = ?').run(item.id);
    return { ok: true };
  });

  res.json(await remove());
});

app.get('/api/admin/economy-log', auth, adminOnly, async (req, res) => {
  const perms = getAdminPerms(req.adminUser);
  if (!perms.doxiki) return res.status(403).json({ error: 'У тебя нет права смотреть операции' });

  const rows = await db.prepare([
    'SELECT l.id, l.amount, l.action, l.note, l.created_at,',
    'a.username AS admin_username, u.username AS username, u.display_name',
    'FROM economy_log l',
    'LEFT JOIN users a ON a.id = l.admin_id',
    'LEFT JOIN users u ON u.id = l.user_id',
    'ORDER BY l.created_at DESC LIMIT 50'
  ].join(' ')).all();

  res.json(rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount || 0),
    action: row.action,
    note: row.note || '',
    created_at: row.created_at,
    admin_username: row.admin_username || '',
    username: row.username || '',
    display_name: row.display_name || ''
  })));
});

// ===== USERS & CHATS =====
app.get('/api/users/search', auth, async (req, res) => {
  const query = clean(req.query.q, 32);
  if (!query) return res.json([]);

  const like = '%' + query + '%';
  const users = await db.prepare([
    'SELECT id, username, display_name, avatar, bio, status',
    'FROM users',
    'WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)',
    'ORDER BY username LIMIT 12'
  ].join(' ')).all(req.user.id, like, like);

  res.json(users);
});

app.get('/api/users/:userId/profile', auth, async (req, res) => {
  const user = await getUserById(clean(req.params.userId, 100));
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const directChat = await db.prepare([
    'SELECT c.id FROM chats c',
    'JOIN chat_members mine ON mine.chat_id = c.id AND mine.user_id = ?',
    'JOIN chat_members peer ON peer.chat_id = c.id AND peer.user_id = ?',
    'WHERE c.is_group = 0 LIMIT 1'
  ].join(' ')).get(req.user.id, user.id);

  const shared = await db.prepare([
    'SELECT COUNT(*) AS count FROM chat_members mine',
    'JOIN chat_members peer ON peer.chat_id = mine.chat_id AND peer.user_id = ?',
    'WHERE mine.user_id = ?'
  ].join(' ')).get(user.id, req.user.id);

  res.json({
    user: publicUser(user),
    profile_nfts: await profileNfts(user.id),
    is_self: user.id === req.user.id,
    is_online: onlineUsers.has(user.id),
    shared_chats: shared ? shared.count : 0,
    direct_chat_id: directChat ? directChat.id : null,
    block_state: user.id === req.user.id ? { i_blocked: false, blocked_me: false } : await blockState(req.user.id, user.id)
  });
});

app.get('/api/blocks', auth, async (req, res) => {
  const rows = await db.prepare([
    'SELECT u.id, u.username, u.display_name, u.avatar, b.created_at',
    'FROM user_blocks b',
    'JOIN users u ON u.id = b.blocked_id',
    'WHERE b.blocker_id = ?',
    'ORDER BY b.created_at DESC'
  ].join(' ')).all(req.user.id);
  res.json(rows);
});

app.delete('/api/blocks/:userId', auth, async (req, res) => {
  const blockedId = clean(req.params.userId, 100);
  await db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, blockedId);
  notifyUsers([req.user.id, blockedId], 'block_changed', { userId: blockedId, by: req.user.id });
  res.json({ ok: true });
});

app.get('/api/chats', auth, async (req, res) => {
  const chats = await db.prepare([
    'SELECT c.id, c.name, c.is_group, c.created_at, own.pinned_at,',
    'peer.id AS peer_id, peer.username AS peer_username, peer.display_name AS peer_display_name,',
    'peer.avatar AS peer_avatar, peer.bio AS peer_bio, peer.status AS peer_status,',
    '(SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,',
    "(SELECT m.message_type FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_type,",
    '(SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_time',
    'FROM chats c',
    'JOIN chat_members own ON own.chat_id = c.id AND own.user_id = ?',
    'LEFT JOIN chat_members peer_member ON peer_member.chat_id = c.id AND peer_member.user_id != ? AND c.is_group = 0',
    'LEFT JOIN users peer ON peer.id = peer_member.user_id',
    'WHERE own.hidden_at IS NULL',
    'ORDER BY CASE WHEN own.pinned_at IS NULL THEN 1 ELSE 0 END, own.pinned_at DESC, COALESCE((SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1), c.created_at) DESC'
  ].join(' ')).all(req.user.id, req.user.id);

  res.json(await Promise.all(chats.map((chat) => enrichChatForUser(chat, req.user.id))));
});

app.post('/api/chats', auth, async (req, res) => {
  const targetId = clean(req.body.user_id, 100);
  if (!targetId || targetId === req.user.id) {
    return res.status(400).json({ error: 'Выбери другого пользователя' });
  }

  const target = await getUserById(targetId);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  const createChat = db.transaction(async () => {
    const existing = await db.prepare([
      'SELECT c.id FROM chats c',
      'JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?',
      'JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?',
      'WHERE c.is_group = 0 LIMIT 1'
    ].join(' ')).get(req.user.id, targetId);

    const chatId = existing ? existing.id : randomUUID();
    if (!existing) {
      await db.prepare('INSERT INTO chats (id, is_group) VALUES (?, 0)').run(chatId);
      await db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(chatId, req.user.id);
      await db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(chatId, targetId);
    } else {
      await db.prepare('UPDATE chat_members SET hidden_at = NULL WHERE chat_id = ? AND user_id = ?').run(chatId, req.user.id);
    }
    return { chatId, existing: Boolean(existing) };
  });

  const result = await createChat();
  notifyUsers([req.user.id, targetId], 'chats_changed', { chatId: result.chatId });
  res.json({ id: result.chatId, existing: result.existing, chat: await getChatForUser(result.chatId, req.user.id) });
});

app.get('/api/chats/:chatId/messages', auth, async (req, res) => {
  if (!(await isMember(req.params.chatId, req.user.id))) {
    return res.status(403).json({ error: 'Нет доступа к этому чату' });
  }

  const messages = await db.prepare([
    'SELECT m.id, m.chat_id, m.sender_id, m.content, m.message_type, m.media_url, m.media_mime,',
    'm.file_name, m.file_size, m.duration, m.reply_to_id, m.edited_at, m.deleted_at, m.delivered_at, m.read_at, m.created_at,',
    'u.display_name, u.avatar, u.username,',
    'r.content AS reply_content, r.message_type AS reply_message_type, r.sender_id AS reply_sender_id, ru.display_name AS reply_sender_name',
    'FROM messages m',
    'JOIN users u ON u.id = m.sender_id',
    'LEFT JOIN messages r ON r.id = m.reply_to_id',
    'LEFT JOIN users ru ON ru.id = r.sender_id',
    'WHERE m.chat_id = ?',
    'ORDER BY m.created_at ASC LIMIT 500'
  ].join(' ')).all(req.params.chatId);

  for (const msg of messages) {
    msg.reactions = await messageReactions(msg.id);
  }

  res.json(messages);
});

app.get('/api/chats/:chatId/messages/search', auth, async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  const query = clean(req.query.q, 80);
  if (!(await isMember(chatId, req.user.id))) return res.status(403).json({ error: 'Нет доступа к чату' });
  if (!query) return res.json([]);

  const rows = await db.prepare([
    'SELECT m.id, m.chat_id, m.sender_id, m.content, m.message_type, m.created_at, u.display_name, u.username',
    'FROM messages m',
    'JOIN users u ON u.id = m.sender_id',
    'WHERE m.chat_id = ? AND m.deleted_at IS NULL AND m.content LIKE ?',
    'ORDER BY m.created_at DESC LIMIT 50'
  ].join(' ')).all(chatId, '%' + query + '%');
  res.json(rows);
});

app.post('/api/chats/:chatId/read', auth, async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  if (!(await isMember(chatId, req.user.id))) return res.status(403).json({ error: 'Нет доступа к чату' });
  await db.prepare([
    'UPDATE messages SET read_at = COALESCE(read_at, unixepoch())',
    'WHERE chat_id = ? AND sender_id != ? AND deleted_at IS NULL'
  ].join(' ')).run(chatId, req.user.id);
  io.to(chatId).emit('messages_read', { chatId, by: req.user.id });
  res.json({ ok: true });
});

app.post('/api/chats/:chatId/pin', auth, async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  if (!(await isMember(chatId, req.user.id))) return res.status(403).json({ error: 'Нет доступа к чату' });
  await db.prepare('UPDATE chat_members SET pinned_at = unixepoch(), hidden_at = NULL WHERE chat_id = ? AND user_id = ?').run(chatId, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/chats/:chatId/pin', auth, async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  if (!(await isMember(chatId, req.user.id))) return res.status(403).json({ error: 'Нет доступа к чату' });
  await db.prepare('UPDATE chat_members SET pinned_at = NULL WHERE chat_id = ? AND user_id = ?').run(chatId, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/chats/:chatId', auth, async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  if (!(await isMember(chatId, req.user.id))) return res.status(403).json({ error: 'Нет доступа к чату' });

  await db.prepare('UPDATE chat_members SET hidden_at = unixepoch() WHERE chat_id = ? AND user_id = ?').run(chatId, req.user.id);
  res.json({ ok: true });
});

app.post('/api/chats/:chatId/files', auth, messageUpload.single('file'), async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  const can = await ensureChatCanWrite(chatId, req.user.id);
  if (!can.ok) return res.status(can.status).json({ error: can.error });
  if (!req.file) return res.status(400).json({ error: 'Выбери файл' });

  const caption = clean(req.body.caption, 1000);
  const replyToId = clean(req.body.reply_to_id, 100) || null;
  if (replyToId) {
    const reply = await db.prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(replyToId, chatId);
    if (!reply) return res.status(400).json({ error: 'Сообщение для ответа не найдено' });
  }

  try {
    const mediaUrl = await uploadToSupabase(req.file, 'chat-files');
    const id = randomUUID();
    const type = messageTypeForFile(req.file);
    const content = caption || (type === 'image' ? 'Фото' : type === 'video' ? 'Видео' : type === 'audio' ? 'Аудио' : (req.file.originalname || 'Файл'));
    await db.prepare('UPDATE chat_members SET hidden_at = NULL WHERE chat_id = ?').run(chatId);
    await db.prepare([
      'INSERT INTO messages (id, chat_id, sender_id, content, encrypted, message_type, media_url, media_mime, file_name, file_size, reply_to_id)',
      'VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)'
    ].join(' ')).run(id, chatId, req.user.id, content, type, mediaUrl, req.file.mimetype || '', req.file.originalname || '', req.file.size || 0, replyToId);
    await markDelivered(id, chatId, req.user.id);
    const message = await messageById(id);
    io.to(chatId).emit('message', message);
    await notifyChatMembers(chatId);
    res.json({ ok: true, message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить файл' });
  }
});

app.get('/api/chats/:chatId/block-state', auth, async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  const chat = await peerForDirectChat(chatId, req.user.id);
  if (!chat) return res.status(403).json({ error: 'Нет доступа к чату' });
  if (!chat.peer_id) return res.json({ i_blocked: false, blocked_me: false });
  res.json(await blockState(req.user.id, chat.peer_id));
});

app.post('/api/chats/:chatId/block', auth, async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  const chat = await peerForDirectChat(chatId, req.user.id);
  if (!chat) return res.status(403).json({ error: 'Нет доступа к чату' });
  if (!chat.peer_id) return res.status(400).json({ error: 'Блокировка доступна только в личных чатах' });

  await db.prepare([
    'INSERT INTO user_blocks (blocker_id, blocked_id)',
    'VALUES (?, ?)',
    'ON CONFLICT(blocker_id, blocked_id) DO NOTHING'
  ].join(' ')).run(req.user.id, chat.peer_id);
  const state = await blockState(req.user.id, chat.peer_id);
  notifyUsers([req.user.id, chat.peer_id], 'block_changed', { chatId, by: req.user.id });
  await notifyChatMembers(chatId);
  res.json({ ok: true, ...state });
});

app.delete('/api/chats/:chatId/block', auth, async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  const chat = await peerForDirectChat(chatId, req.user.id);
  if (!chat) return res.status(403).json({ error: 'Нет доступа к чату' });
  if (!chat.peer_id) return res.status(400).json({ error: 'Блокировка доступна только в личных чатах' });

  await db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, chat.peer_id);
  const state = await blockState(req.user.id, chat.peer_id);
  notifyUsers([req.user.id, chat.peer_id], 'block_changed', { chatId, by: req.user.id });
  await notifyChatMembers(chatId);
  res.json({ ok: true, ...state });
});

app.post('/api/chats/:chatId/voice', auth, voiceUpload.single('voice'), async (req, res) => {
  const chatId = clean(req.params.chatId, 100);
  if (!(await isMember(chatId, req.user.id))) return res.status(403).json({ error: 'Нет доступа к чату' });
  if (!req.file) return res.status(400).json({ error: 'Запиши голосовое сообщение' });

  const direct = await peerForDirectChat(chatId, req.user.id);
  if (direct && direct.peer_id) {
    const state = await blockState(req.user.id, direct.peer_id);
    if (state.i_blocked) return res.status(403).json({ error: 'Ты заблокировал пользователя' });
    if (state.blocked_me) return res.status(403).json({ error: 'Пользователь тебя заблокировал' });
  }

  try {
    const mediaUrl = await uploadToSupabase(req.file, 'voice');
    const id = randomUUID();
    const duration = Math.max(0, Math.min(3600, Math.round(Number(req.body.duration) || 0)));
    const replyToId = clean(req.body.reply_to_id, 100) || null;
    if (replyToId) {
      const reply = await db.prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(replyToId, chatId);
      if (!reply) return res.status(400).json({ error: 'Сообщение для ответа не найдено' });
    }
    await db.prepare('UPDATE chat_members SET hidden_at = NULL WHERE chat_id = ?').run(chatId);
    await db.prepare([
      'INSERT INTO messages (id, chat_id, sender_id, content, encrypted, message_type, media_url, media_mime, file_name, file_size, duration, reply_to_id)',
      "VALUES (?, ?, ?, ?, 0, 'voice', ?, ?, ?, ?, ?, ?)"
    ].join(' ')).run(id, chatId, req.user.id, 'Голосовое сообщение', mediaUrl, req.file.mimetype || 'audio/webm', req.file.originalname || 'voice.webm', req.file.size || 0, duration, replyToId);
    await markDelivered(id, chatId, req.user.id);
    const message = await messageById(id);

    io.to(chatId).emit('message', message);
    await notifyChatMembers(chatId);
    res.json({ ok: true, message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось загрузить голосовое. Проверь Supabase или отправь текстом.' });
  }
});

app.put('/api/messages/:messageId', auth, async (req, res) => {
  const messageId = clean(req.params.messageId, 100);
  const content = clean(req.body.content, 20000);
  if (!content) return res.status(400).json({ error: 'Сообщение пустое' });
  const msg = await db.prepare('SELECT id, chat_id, sender_id, message_type FROM messages WHERE id = ?').get(messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Можно редактировать только свои сообщения' });
  if (msg.message_type !== 'text') return res.status(400).json({ error: 'Редактировать можно только текст' });

  await db.prepare('UPDATE messages SET content = ?, edited_at = unixepoch() WHERE id = ?').run(content, messageId);
  const updated = await messageById(messageId);
  io.to(msg.chat_id).emit('message_updated', updated);
  await notifyChatMembers(msg.chat_id);
  res.json({ ok: true, message: updated });
});

app.delete('/api/messages/:messageId', auth, async (req, res) => {
  const messageId = clean(req.params.messageId, 100);
  const msg = await db.prepare('SELECT id, chat_id, sender_id FROM messages WHERE id = ?').get(messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Можно удалить только свои сообщения' });

  await db.prepare([
    "UPDATE messages SET content = 'Сообщение удалено', deleted_at = unixepoch(), message_type = 'deleted',",
    "media_url = '', media_mime = '', file_name = '', file_size = 0, duration = 0",
    'WHERE id = ?'
  ].join(' ')).run(messageId);
  const updated = await messageById(messageId);
  io.to(msg.chat_id).emit('message_deleted', updated);
  await notifyChatMembers(msg.chat_id);
  res.json({ ok: true, message: updated });
});

app.post('/api/messages/:messageId/reactions', auth, async (req, res) => {
  const messageId = clean(req.params.messageId, 100);
  const reaction = clean(req.body.reaction, 8) || '👍';
  if (!['👍','❤️','🔥','😂','😮','😢','👏'].includes(reaction)) return res.status(400).json({ error: 'Нельзя поставить такую реакцию' });
  const msg = await db.prepare('SELECT id, chat_id FROM messages WHERE id = ? AND deleted_at IS NULL').get(messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (!(await isMember(msg.chat_id, req.user.id))) return res.status(403).json({ error: 'Нет доступа к сообщению' });

  await db.prepare([
    'INSERT INTO message_reactions (message_id, user_id, reaction)',
    'VALUES (?, ?, ?)',
    'ON CONFLICT(message_id, user_id) DO UPDATE SET reaction = excluded.reaction, created_at = unixepoch()'
  ].join(' ')).run(messageId, req.user.id, reaction);
  const reactions = await messageReactions(messageId);
  io.to(msg.chat_id).emit('message_reactions', { messageId, reactions });
  res.json({ ok: true, reactions });
});

app.delete('/api/messages/:messageId/reactions', auth, async (req, res) => {
  const messageId = clean(req.params.messageId, 100);
  const msg = await db.prepare('SELECT id, chat_id FROM messages WHERE id = ?').get(messageId);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (!(await isMember(msg.chat_id, req.user.id))) return res.status(403).json({ error: 'Нет доступа к сообщению' });

  await db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, req.user.id);
  const reactions = await messageReactions(messageId);
  io.to(msg.chat_id).emit('message_reactions', { messageId, reactions });
  res.json({ ok: true, reactions });
});

// ===== SOCKET.IO =====
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', async (socket) => {
  try {
    const userSockets = onlineUsers.get(socket.user.id) || new Set();
    userSockets.add(socket.id);
    onlineUsers.set(socket.user.id, userSockets);

    const chatIds = await db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(socket.user.id);
    for (const row of chatIds) socket.join(row.chat_id);
  } catch (error) {
    console.error('Socket connection init failed:', error);
    socket.disconnect(true);
    return;
  }

  socket.on('join_chat', async (chatId) => {
    const id = clean(chatId, 100);
    if (await isMember(id, socket.user.id)) socket.join(id);
  });

  socket.on('message', async (data, ack) => {
    const chatId = clean(data && data.chatId, 100);
    const content = String((data && data.content) || '');
    const replyToId = clean(data && data.replyToId, 100) || null;

    if (!chatId || !content || content.length > 20000) {
      if (ack) ack({ ok: false, error: 'Сообщение не отправлено' });
      return;
    }
    const can = await ensureChatCanWrite(chatId, socket.user.id);
    if (!can.ok) {
      if (ack) ack({ ok: false, error: can.error });
      return;
    }
    if (replyToId) {
      const reply = await db.prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(replyToId, chatId);
      if (!reply) {
        if (ack) ack({ ok: false, error: 'Сообщение для ответа не найдено' });
        return;
      }
    }

    const id = randomUUID();
    const user = await db.prepare('SELECT display_name, avatar, username FROM users WHERE id = ?').get(socket.user.id);
    if (!user) {
      if (ack) ack({ ok: false, error: 'Пользователь не найден' });
      return;
    }

    await db.prepare([
      'INSERT INTO messages (id, chat_id, sender_id, content, encrypted, reply_to_id)',
      'VALUES (?, ?, ?, ?, 0, ?)'
    ].join(' ')).run(id, chatId, socket.user.id, content, replyToId);
    await db.prepare('UPDATE chat_members SET hidden_at = NULL WHERE chat_id = ?').run(chatId);
    await markDelivered(id, chatId, socket.user.id);
    const message = await messageById(id);

    io.to(chatId).emit('message', message);
    const members = await db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(chatId, socket.user.id);
    notifyUsers(members.map((row) => row.user_id), 'notify', {
      chatId,
      title: user.display_name || user.username,
      body: content.slice(0, 120)
    });
    await notifyChatMembers(chatId);
    if (ack) ack({ ok: true, id });
  });

  socket.on('typing', async (data) => {
    const chatId = clean(data && data.chatId, 100);
    if (!chatId || !(await isMember(chatId, socket.user.id))) return;
    socket.to(chatId).emit('typing', { chatId, userId: socket.user.id, username: socket.user.username });
  });

  // ===== VOICE CALLS VIA WEBRTC SIGNALING =====
  socket.on('call:offer', async (data) => {
    const targetId = clean(data && data.targetId, 100);
    const offer = data && data.offer;
    if (!targetId || !offer) return;
    if (!(await directChatBetween(socket.user.id, targetId))) {
      socket.emit('call:rejected', { error: 'Нет личного чата' });
      return;
    }
    const state = await blockState(socket.user.id, targetId);
    if (state.i_blocked || state.blocked_me) {
      socket.emit('call:rejected', { error: state.blocked_me ? 'Пользователь тебя заблокировал' : 'Ты заблокировал пользователя' });
      return;
    }

    activeCalls.set(socket.user.id, { targetId, status: 'ringing' });
    const caller = await db.prepare('SELECT display_name, avatar, username FROM users WHERE id = ?').get(socket.user.id);
    for (const sid of socketsForUser(targetId)) {
      io.to(sid).emit('call:incoming', {
        callerId: socket.user.id,
        callerName: caller ? caller.display_name : 'Аноним',
        callerAvatar: caller ? caller.avatar : '',
        callerUsername: caller ? caller.username : '',
        offer
      });
    }
  });

  socket.on('call:answer', (data) => {
    const callerId = clean(data && data.callerId, 100);
    const answer = data && data.answer;
    if (!callerId || !answer) return;

    activeCalls.set(callerId, { targetId: socket.user.id, status: 'active' });
    for (const sid of socketsForUser(callerId)) {
      io.to(sid).emit('call:answered', { answer });
    }
  });

  socket.on('call:ice', (data) => {
    const targetId = clean(data && data.targetId, 100);
    const candidate = data && data.candidate;
    if (!targetId || !candidate) return;
    for (const sid of socketsForUser(targetId)) {
      io.to(sid).emit('call:ice', { candidate, fromId: socket.user.id });
    }
  });

  socket.on('call:end', (data) => {
    const targetId = clean(data && data.targetId, 100);
    activeCalls.delete(socket.user.id);
    activeCalls.delete(targetId);
    if (targetId) {
      for (const sid of socketsForUser(targetId)) {
        io.to(sid).emit('call:ended', { fromId: socket.user.id });
      }
    }
  });

  socket.on('call:reject', (data) => {
    const callerId = clean(data && data.callerId, 100);
    activeCalls.delete(callerId);
    if (callerId) {
      for (const sid of socketsForUser(callerId)) {
        io.to(sid).emit('call:rejected', {});
      }
    }
  });

  socket.on('screen_share:accept', (data) => {
    const requestId = clean(data && data.requestId, 100);
    const share = getScreenShare(requestId);
    if (!share || share.targetId !== socket.user.id) return;
    notifyUsers([share.adminId], 'screen_share:accepted', {
      requestId,
      username: share.targetUsername
    });
  });

  socket.on('screen_share:decline', (data) => {
    const requestId = clean(data && data.requestId, 100);
    const share = getScreenShare(requestId);
    if (!share || share.targetId !== socket.user.id) return;
    activeScreenShares.delete(requestId);
    notifyUsers([share.adminId], 'screen_share:declined', {
      requestId,
      username: share.targetUsername
    });
  });

  socket.on('screen_share:offer', (data) => {
    const requestId = clean(data && data.requestId, 100);
    const share = getScreenShare(requestId);
    const offer = data && data.offer;
    if (!share || share.targetId !== socket.user.id || !offer) return;
    notifyUsers([share.adminId], 'screen_share:offer', {
      requestId,
      offer,
      username: share.targetUsername
    });
  });

  socket.on('screen_share:answer', (data) => {
    const requestId = clean(data && data.requestId, 100);
    const share = getScreenShare(requestId);
    const answer = data && data.answer;
    if (!share || share.adminId !== socket.user.id || !answer) return;
    notifyUsers([share.targetId], 'screen_share:answer', { requestId, answer });
  });

  socket.on('screen_share:ice', (data) => {
    const requestId = clean(data && data.requestId, 100);
    const share = getScreenShare(requestId);
    const candidate = data && data.candidate;
    if (!share || !candidate) return;

    if (share.adminId === socket.user.id) {
      notifyUsers([share.targetId], 'screen_share:ice', { requestId, candidate });
    } else if (share.targetId === socket.user.id) {
      notifyUsers([share.adminId], 'screen_share:ice', { requestId, candidate });
    }
  });

  socket.on('screen_share:end', (data) => {
    const requestId = clean(data && data.requestId, 100);
    const share = getScreenShare(requestId);
    if (!share || (share.adminId !== socket.user.id && share.targetId !== socket.user.id)) return;
    activeScreenShares.delete(requestId);
    notifyUsers([share.adminId, share.targetId], 'screen_share:ended', { requestId });
  });

  socket.on('disconnect', () => {
    const sockets = onlineUsers.get(socket.user.id);
    if (!sockets) return;
    sockets.delete(socket.id);
    if (!sockets.size) {
      onlineUsers.delete(socket.user.id);
      const call = activeCalls.get(socket.user.id);
      if (call) {
        activeCalls.delete(socket.user.id);
        for (const sid of socketsForUser(call.targetId)) {
          io.to(sid).emit('call:ended', { fromId: socket.user.id });
        }
      }
    }
  });
});

function startListening(port) {
  server.listen(port, HOST, () => {
    app.locals.port = port;
    const info = serverInfo(port);
    console.log('Анон запущен: ' + info.local_url);
    if (info.lan_urls.length) {
      console.log('Друзья в сети могут зайти:');
      for (const url of info.lan_urls) console.log('  ' + url);
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

db.ready
  .then(() => ensureOwnerAdmin())
  .then(() => startListening(PORT))
  .catch((error) => {
    console.error('Не удалось подготовить базу данных:', error);
    process.exit(1);
  });
