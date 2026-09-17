/**
 * Янлин — Professional Telegram Mini App
 * Level 9999999 Developer Build
 * Real Stars (XTR), Tickets, Raffles, Roulette, Gifts, Admin, Referrals, Chat
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const { Telegraf, Markup } = require('telegraf');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const JWT_SECRET = process.env.JWT_SECRET || 'yanlin_super_secret_999';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'nightro';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '9944191q';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Ensure folders
['uploads', 'db', 'public'].forEach(d => {
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ==================== DATABASE ====================
const db = new Database(path.join(__dirname, 'db', 'yanlin.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    photo_url TEXT,
    stars INTEGER DEFAULT 0,
    tickets INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    referrer_id TEXT,
    referral_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL, -- buy_tickets, roulette_win, raffle_win, withdraw, promo, bonus, referral
    amount_stars INTEGER DEFAULT 0,
    amount_tickets INTEGER DEFAULT 0,
    description TEXT,
    meta TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS withdraw_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, approved, rejected
    admin_note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    processed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS promo_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL, -- stars, tickets
    amount INTEGER NOT NULL,
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS promo_uses (
    id TEXT PRIMARY KEY,
    promo_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    used_at TEXT DEFAULT (datetime('now')),
    UNIQUE(promo_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS raffles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    image_url TEXT,
    gift_type TEXT DEFAULT 'custom', -- custom, tg_gift, nft
    total_tickets INTEGER DEFAULT 0,
    winner_id TEXT,
    status TEXT DEFAULT 'active', -- active, finished, cancelled
    created_by TEXT,
    ends_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS raffle_entries (
    id TEXT PRIMARY KEY,
    raffle_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    tickets INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS roulette_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    prize_type TEXT,
    prize_value INTEGER,
    prize_label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    login TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations
try {
  db.exec(`ALTER TABLE users ADD COLUMN last_daily_bonus TEXT`);
} catch (e) { /* column already exists */ }

// Tasks system tables
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL, -- link, subscribe, like, comment
    url TEXT NOT NULL,
    reward_type TEXT NOT NULL, -- tickets, stars
    reward_amount INTEGER NOT NULL,
    max_completions INTEGER NOT NULL,
    current_completions INTEGER DEFAULT 0,
    escrow_left INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_completions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(task_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS task_reports (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending', -- pending, resolved, rejected
    admin_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default admin
const adminExists = db.prepare('SELECT id FROM admins WHERE login = ?').get(ADMIN_LOGIN);
if (!adminExists) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare('INSERT INTO admins (id, login, password_hash) VALUES (?, ?, ?)').run(uuidv4(), ADMIN_LOGIN, hash);
  console.log('✅ Default admin created:', ADMIN_LOGIN);
}

// ==================== HELPERS ====================
function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
}

function createOrUpdateUser(tgUser, photoUrl = null) {
  const existing = getUser(tgUser.id);
  if (existing) {
    db.prepare(`
      UPDATE users SET username = ?, first_name = ?, last_name = ?, photo_url = COALESCE(?, photo_url), last_seen = datetime('now')
      WHERE telegram_id = ?
    `).run(tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, photoUrl, String(tgUser.id));
    return getUser(tgUser.id);
  }
  // New user + welcome bonus 50 tickets
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, tickets)
    VALUES (?, ?, ?, ?, ?, 50)
  `).run(String(tgUser.id), tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, photoUrl);
  
  const user = getUser(tgUser.id);
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_tickets, description)
    VALUES (?, ?, 'bonus', 50, 'Бонус за первый вход: 50 билетов')
  `).run(uuidv4(), String(tgUser.id));
  
  return user;
}

function addTransaction(userId, type, stars = 0, tickets = 0, description = '', meta = null) {
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, amount_stars, amount_tickets, description, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), String(userId), type, stars, tickets, description, meta ? JSON.stringify(meta) : null);
}

function updateBalance(userId, starsDelta = 0, ticketsDelta = 0) {
  db.prepare(`
    UPDATE users SET stars = stars + ?, tickets = tickets + ?, last_seen = datetime('now')
    WHERE telegram_id = ?
  `).run(starsDelta, ticketsDelta, String(userId));
}

// ==================== ROULETTE PRIZES (different chances, different values) ====================
const ROULETTE_PRIZES = [
  { type: 'nothing', label: 'Ничего 😢', value: 0, chance: 0.35, color: '#6b7280' },
  { type: 'tickets', label: '5 билетов', value: 5, chance: 0.22, color: '#3b82f6' },
  { type: 'tickets', label: '15 билетов', value: 15, chance: 0.12, color: '#2563eb' },
  { type: 'tickets', label: '50 билетов', value: 50, chance: 0.05, color: '#1d4ed8' },
  { type: 'stars', label: '10 ⭐', value: 10, chance: 0.12, color: '#f59e0b' },
  { type: 'stars', label: '25 ⭐', value: 25, chance: 0.06, color: '#d97706' },
  { type: 'stars', label: '100 ⭐', value: 100, chance: 0.02, color: '#b45309' },
  { type: 'gift', label: '🎁 Подарок TG', value: 1, chance: 0.04, color: '#ec4899' },
  { type: 'gift', label: '💎 Редкий подарок', value: 1, chance: 0.015, color: '#a855f7' },
  { type: 'stars', label: '500 ⭐ JACKPOT', value: 500, chance: 0.005, color: '#ef4444' }
];

function spinRoulette() {
  const r = Math.random();
  let cumulative = 0;
  for (const prize of ROULETTE_PRIZES) {
    cumulative += prize.chance;
    if (r <= cumulative) return prize;
  }
  return ROULETTE_PRIZES[0]; // fallback nothing
}

// ==================== EXPRESS + SOCKET ====================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

// Explicit root — avoids Railway 404 if static order is wrong
app.get('/', (req, res) => {
  if (fs.existsSync(INDEX_HTML)) return res.sendFile(INDEX_HTML);
  return res.status(500).send('public/index.html missing in deploy. Upload full yanlin-app folder.');
});

app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(file.originalname) || '.png'}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(png|jpeg|jpg|gif|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// Online tracking
const onlineUsers = new Map(); // socketId -> { telegramId, username }

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    if (data && data.telegramId) {
      onlineUsers.set(socket.id, {
        telegramId: String(data.telegramId),
        username: data.username || 'User',
        photo: data.photo || null
      });
      io.emit('online_count', onlineUsers.size);
      io.emit('online_users', Array.from(onlineUsers.values()));
    }
  });

  socket.on('chat_message', (msg) => {
    if (!msg || !msg.text || !msg.telegramId) return;
    const id = uuidv4();
    db.prepare(`
      INSERT INTO chat_messages (id, user_id, username, text) VALUES (?, ?, ?, ?)
    `).run(id, String(msg.telegramId), msg.username || 'User', msg.text.slice(0, 500));
    
    const payload = {
      id,
      user_id: String(msg.telegramId),
      username: msg.username || 'User',
      text: msg.text.slice(0, 500),
      created_at: new Date().toISOString()
    };
    io.emit('chat_message', payload);
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('online_count', onlineUsers.size);
    io.emit('online_users', Array.from(onlineUsers.values()));
  });
});

// ==================== TELEGRAM BOT ====================
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  
  bot.start(async (ctx) => {
    const ref = ctx.startPayload;
    const user = ctx.from;
    let photoUrl = null;
    try {
      const photos = await ctx.telegram.getUserProfilePhotos(user.id, 0, 1);
      if (photos.total_count > 0) {
        const fileId = photos.photos[0][0].file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        photoUrl = link.href;
      }
    } catch (e) {}
    
    const dbUser = createOrUpdateUser(user, photoUrl);
    
    if (ref && ref.startsWith('ref_') && !dbUser.referrer_id) {
      const referrerId = ref.replace('ref_', '');
      if (referrerId !== String(user.id)) {
        const referrer = getUser(referrerId);
        if (referrer) {
          db.prepare('UPDATE users SET referrer_id = ? WHERE telegram_id = ?').run(referrerId, String(user.id));
          db.prepare('UPDATE users SET referral_count = referral_count + 1, tickets = tickets + 10 WHERE telegram_id = ?').run(referrerId);
          addTransaction(referrerId, 'referral', 0, 10, `Реферал @${user.username || user.id}`);
          addTransaction(String(user.id), 'referral', 0, 5, 'Бонус за переход по реферальной ссылке');
          updateBalance(String(user.id), 0, 5);
        }
      }
    }
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.webApp('🚀 Открыть Янлин', APP_URL)]
    ]);
    
    await ctx.reply(
      `🌟 Добро пожаловать в *Янлин*!\n\n` +
      `Тебе начислено *50 билетов* за вход.\n` +
      `Покупай билеты за настоящие Stars, крути рулетку, участвуй в розыгрышах подарков и NFT.\n\n` +
      `Реферальная ссылка:\n` +
      `https://t.me/${ctx.botInfo.username}?start=ref_${user.id}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });

  // Stars payment handlers
  bot.on('pre_checkout_query', async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
  });

  bot.on('successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;
    const payload = payment.invoice_payload; // e.g. "tickets:100:userId"
    const parts = payload.split(':');
    if (parts[0] === 'tickets') {
      const ticketsAmount = parseInt(parts[1], 10);
      const userId = parts[2];
      updateBalance(userId, 0, ticketsAmount);
      addTransaction(userId, 'buy_tickets', payment.total_amount, ticketsAmount, `Покупка ${ticketsAmount} билетов за ${payment.total_amount} ⭐`);
      
      // Notify via socket if online
      io.emit('balance_update', { userId, tickets: ticketsAmount });
      
      await ctx.reply(`✅ Успешно! Начислено *${ticketsAmount}* билетов.`, { parse_mode: 'Markdown' });
    }
  });

  bot.launch().then(() => console.log('🤖 Bot started')).catch(e => console.error('Bot error:', e.message));
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
  console.warn('⚠️ BOT_TOKEN not set — payments and bot disabled');
}

// ==================== API ROUTES ====================

// Auth / Me
app.post('/api/auth', (req, res) => {
  const { initData, user } = req.body;
  // In production: validate Telegram WebApp initData signature
  // For now we trust the client data (add crypto validation later)
  if (!user || !user.id) return res.status(400).json({ error: 'No user' });
  
  const dbUser = createOrUpdateUser(user, user.photo_url);
  if (dbUser.is_banned) return res.status(403).json({ error: 'Banned' });
  
  res.json({
    ok: true,
    user: {
      id: dbUser.telegram_id,
      username: dbUser.username,
      first_name: dbUser.first_name,
      photo_url: dbUser.photo_url,
      stars: dbUser.stars,
      tickets: dbUser.tickets,
      is_admin: !!dbUser.is_admin,
      referral_count: dbUser.referral_count
    }
  });
});

app.get('/api/me/:telegramId', (req, res) => {
  const user = getUser(req.params.telegramId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: user.telegram_id,
    username: user.username,
    first_name: user.first_name,
    photo_url: user.photo_url,
    stars: user.stars,
    tickets: user.tickets,
    is_admin: !!user.is_admin,
    referral_count: user.referral_count,
    is_banned: !!user.is_banned
  });
});

// Shop — create Stars invoice for tickets
app.post('/api/shop/buy', async (req, res) => {
  const { telegramId, packageId } = req.body;
  if (!bot) return res.status(503).json({ error: 'Bot not configured' });
  
  const packages = {
    '10': { tickets: 10, stars: 15 },
    '50': { tickets: 50, stars: 60 },
    '100': { tickets: 100, stars: 100 },
    '500': { tickets: 500, stars: 400 },
    '1000': { tickets: 1000, stars: 700 }
  };
  
  const pack = packages[String(packageId)];
  if (!pack) return res.status(400).json({ error: 'Invalid package' });
  
  const user = getUser(telegramId);
  if (!user || user.is_banned) return res.status(403).json({ error: 'Forbidden' });
  
  try {
    const invoiceLink = await bot.telegram.createInvoiceLink({
      title: `Янлин — ${pack.tickets} билетов`,
      description: `Покупка ${pack.tickets} билетов для участия в розыгрышах и рулетке`,
      payload: `tickets:${pack.tickets}:${telegramId}`,
      currency: 'XTR',
      prices: [{ label: `${pack.tickets} билетов`, amount: pack.stars }]
    });
    res.json({ ok: true, invoiceLink, pack });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Roulette spin (costs 1 ticket)
app.post('/api/roulette/spin', (req, res) => {
  const { telegramId } = req.body;
  const user = getUser(telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_banned) return res.status(403).json({ error: 'Banned' });
  if (user.tickets < 1) return res.status(400).json({ error: 'Недостаточно билетов' });
  
  updateBalance(telegramId, 0, -1);
  const prize = spinRoulette();
  
  let starsAdd = 0, ticketsAdd = 0;
  if (prize.type === 'stars') starsAdd = prize.value;
  if (prize.type === 'tickets') ticketsAdd = prize.value;
  
  if (starsAdd || ticketsAdd) updateBalance(telegramId, starsAdd, ticketsAdd);
  
  addTransaction(telegramId, 'roulette_win', starsAdd, ticketsAdd - 1, `Рулетка: ${prize.label}`);
  db.prepare(`
    INSERT INTO roulette_history (id, user_id, prize_type, prize_value, prize_label)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidv4(), String(telegramId), prize.type, prize.value, prize.label);
  
  // Broadcast win if significant
  if (prize.type !== 'nothing' && (prize.value >= 25 || prize.type === 'gift')) {
    io.emit('big_win', {
      username: user.username || user.first_name || 'User',
      prize: prize.label
    });
  }
  
  const updated = getUser(telegramId);
  res.json({
    ok: true,
    prize,
    balance: { stars: updated.stars, tickets: updated.tickets }
  });
});

// Raffles
app.get('/api/raffles', (req, res) => {
  const raffles = db.prepare(`
    SELECT r.*, 
      (SELECT COUNT(*) FROM raffle_entries re WHERE re.raffle_id = r.id) as entries_count,
      (SELECT SUM(tickets) FROM raffle_entries re WHERE re.raffle_id = r.id) as total_tickets_spent
    FROM raffles r WHERE r.status = 'active' ORDER BY r.created_at DESC
  `).all();
  res.json(raffles);
});

app.post('/api/raffles/create', upload.single('image'), (req, res) => {
  // Can be called by admin or user (for their gift)
  const { title, description, gift_type, created_by, ends_at } = req.body;
  if (!title || !created_by) return res.status(400).json({ error: 'Missing fields' });
  
  const id = uuidv4();
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  
  db.prepare(`
    INSERT INTO raffles (id, title, description, image_url, gift_type, created_by, ends_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, description || '', imageUrl, gift_type || 'custom', created_by, ends_at || null);
  
  res.json({ ok: true, id, imageUrl });
});

app.post('/api/raffles/:id/enter', (req, res) => {
  const { telegramId, tickets } = req.body;
  const raffleId = req.params.id;
  const ticketsNum = Math.max(1, parseInt(tickets, 10) || 1);
  
  const user = getUser(telegramId);
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ? AND status = ?').get(raffleId, 'active');
  
  if (!user || !raffle) return res.status(404).json({ error: 'Not found' });
  if (user.is_banned) return res.status(403).json({ error: 'Banned' });
  if (user.tickets < ticketsNum) return res.status(400).json({ error: 'Недостаточно билетов' });
  
  updateBalance(telegramId, 0, -ticketsNum);
  db.prepare(`
    INSERT INTO raffle_entries (id, raffle_id, user_id, tickets) VALUES (?, ?, ?, ?)
  `).run(uuidv4(), raffleId, String(telegramId), ticketsNum);
  
  db.prepare('UPDATE raffles SET total_tickets = total_tickets + ? WHERE id = ?').run(ticketsNum, raffleId);
  addTransaction(telegramId, 'raffle_enter', 0, -ticketsNum, `Участие в розыгрыше: ${raffle.title} (${ticketsNum} билетов)`);
  
  const updated = getUser(telegramId);
  res.json({ ok: true, balance: { stars: updated.stars, tickets: updated.tickets } });
});

app.post('/api/raffles/:id/draw', (req, res) => {
  // Admin only — weighted random by tickets
  const raffleId = req.params.id;
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
  if (!raffle || raffle.status !== 'active') return res.status(400).json({ error: 'Invalid raffle' });
  
  const entries = db.prepare('SELECT * FROM raffle_entries WHERE raffle_id = ?').all(raffleId);
  if (entries.length === 0) return res.status(400).json({ error: 'No entries' });
  
  // Weighted random
  const total = entries.reduce((s, e) => s + e.tickets, 0);
  let r = Math.random() * total;
  let winner = entries[0];
  for (const e of entries) {
    r -= e.tickets;
    if (r <= 0) { winner = e; break; }
  }
  
  db.prepare('UPDATE raffles SET status = ?, winner_id = ? WHERE id = ?').run('finished', winner.user_id, raffleId);
  
  const winnerUser = getUser(winner.user_id);
  addTransaction(winner.user_id, 'raffle_win', 0, 0, `Победа в розыгрыше: ${raffle.title}`);
  
  io.emit('raffle_winner', {
    raffleId,
    title: raffle.title,
    winner: winnerUser ? (winnerUser.username || winnerUser.first_name) : winner.user_id
  });
  
  res.json({ ok: true, winner: winner.user_id, username: winnerUser?.username });
});

// Withdraw
app.post('/api/withdraw', (req, res) => {
  const { telegramId, amount } = req.body;
  const amt = parseInt(amount, 10);
  if (!amt || amt < 10 || amt > 1000) return res.status(400).json({ error: 'Сумма от 10 до 1000 ⭐' });
  
  const user = getUser(telegramId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.is_banned) return res.status(403).json({ error: 'Banned' });
  if (user.stars < amt) return res.status(400).json({ error: 'Недостаточно Stars' });
  
  // Hold the stars
  updateBalance(telegramId, -amt, 0);
  const id = uuidv4();
  db.prepare(`
    INSERT INTO withdraw_requests (id, user_id, amount) VALUES (?, ?, ?)
  `).run(id, String(telegramId), amt);
  addTransaction(telegramId, 'withdraw', -amt, 0, `Заявка на вывод ${amt} ⭐`);
  
  res.json({ ok: true, requestId: id });
});

app.get('/api/withdraw/history/:telegramId', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM withdraw_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(String(req.params.telegramId));
  res.json(rows);
});

// Promo
app.post('/api/promo/activate', (req, res) => {
  const { telegramId, code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });
  
  const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND is_active = 1').get(code.toUpperCase());
  if (!promo) return res.status(404).json({ error: 'Промокод не найден или неактивен' });
  if (promo.used_count >= promo.max_uses) return res.status(400).json({ error: 'Лимит использований исчерпан' });
  
  const already = db.prepare('SELECT id FROM promo_uses WHERE promo_id = ? AND user_id = ?').get(promo.id, String(telegramId));
  if (already) return res.status(400).json({ error: 'Вы уже использовали этот промокод' });
  
  db.prepare('INSERT INTO promo_uses (id, promo_id, user_id) VALUES (?, ?, ?)').run(uuidv4(), promo.id, String(telegramId));
  db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?').run(promo.id);
  
  if (promo.type === 'stars') {
    updateBalance(telegramId, promo.amount, 0);
    addTransaction(telegramId, 'promo', promo.amount, 0, `Промокод ${promo.code}: +${promo.amount} ⭐`);
  } else {
    updateBalance(telegramId, 0, promo.amount);
    addTransaction(telegramId, 'promo', 0, promo.amount, `Промокод ${promo.code}: +${promo.amount} билетов`);
  }
  
  const updated = getUser(telegramId);
  res.json({ ok: true, type: promo.type, amount: promo.amount, balance: { stars: updated.stars, tickets: updated.tickets } });
});

// ==================== DAILY BONUS ====================
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

app.get('/api/daily-bonus/:telegramId', (req, res) => {
  const user = getUser(req.params.telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  let canClaim = true;
  let nextClaimAt = null;
  let remainingMs = 0;
  
  if (user.last_daily_bonus) {
    const last = new Date(user.last_daily_bonus + 'Z').getTime(); // assume UTC
    const now = Date.now();
    const elapsed = now - last;
    if (elapsed < DAILY_COOLDOWN_MS) {
      canClaim = false;
      remainingMs = DAILY_COOLDOWN_MS - elapsed;
      nextClaimAt = new Date(last + DAILY_COOLDOWN_MS).toISOString();
    }
  }
  
  res.json({ canClaim, remainingMs, nextClaimAt, lastClaim: user.last_daily_bonus });
});

app.post('/api/daily-bonus/claim', (req, res) => {
  const { telegramId } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'No telegramId' });
  
  const user = getUser(telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_banned) return res.status(403).json({ error: 'Banned' });
  
  if (user.last_daily_bonus) {
    const last = new Date(user.last_daily_bonus + 'Z').getTime();
    const elapsed = Date.now() - last;
    if (elapsed < DAILY_COOLDOWN_MS) {
      const remainingMs = DAILY_COOLDOWN_MS - elapsed;
      return res.status(400).json({ 
        error: 'Ещё рано', 
        remainingMs,
        nextClaimAt: new Date(last + DAILY_COOLDOWN_MS).toISOString()
      });
    }
  }
  
  // Random 1-20 tickets
  const amount = Math.floor(Math.random() * 20) + 1; // 1..20
  
  db.prepare(`UPDATE users SET last_daily_bonus = datetime('now'), tickets = tickets + ? WHERE telegram_id = ?`)
    .run(amount, String(telegramId));
  
  addTransaction(telegramId, 'bonus', 0, amount, `Ежедневный бонус: +${amount} билетов`);
  
  const updated = getUser(telegramId);
  res.json({ 
    ok: true, 
    amount, 
    balance: { stars: updated.stars, tickets: updated.tickets },
    nextClaimAt: new Date(Date.now() + DAILY_COOLDOWN_MS).toISOString()
  });
});

// ==================== TASKS ====================
const TASK_TYPES = new Set(['link', 'subscribe', 'like', 'comment']);
const REWARD_TYPES = new Set(['tickets', 'stars']);

app.get('/api/tasks', (req, res) => {
  const telegramId = req.query.telegramId ? String(req.query.telegramId) : null;
  const rows = db.prepare(`
    SELECT t.*, u.username as creator_username, u.first_name as creator_name
    FROM tasks t
    LEFT JOIN users u ON u.telegram_id = t.creator_id
    WHERE t.is_active = 1 AND t.current_completions < t.max_completions
    ORDER BY t.created_at DESC
    LIMIT 100
  `).all();

  const result = rows.map(t => {
    let completed = false;
    if (telegramId) {
      completed = !!db.prepare('SELECT id FROM task_completions WHERE task_id = ? AND user_id = ?')
        .get(t.id, telegramId);
    }
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      type: t.type,
      url: t.url,
      reward_type: t.reward_type,
      reward_amount: t.reward_amount,
      max_completions: t.max_completions,
      current_completions: t.current_completions,
      creator_id: t.creator_id,
      creator_username: t.creator_username,
      creator_name: t.creator_name,
      created_at: t.created_at,
      completed
    };
  });
  res.json(result);
});

app.post('/api/tasks/create', (req, res) => {
  const { telegramId, title, description, type, url, reward_type, reward_amount, max_completions } = req.body;
  if (!telegramId || !title || !type || !url || !reward_type || !reward_amount || !max_completions) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (!TASK_TYPES.has(type)) return res.status(400).json({ error: 'Неверный тип задания' });
  if (!REWARD_TYPES.has(reward_type)) return res.status(400).json({ error: 'Неверный тип награды' });

  const amount = parseInt(reward_amount, 10);
  const maxC = parseInt(max_completions, 10);
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
    return res.status(400).json({ error: 'Награда: от 1 до 10000' });
  }
  if (!Number.isFinite(maxC) || maxC < 1 || maxC > 5000) {
    return res.status(400).json({ error: 'Выполнений: от 1 до 5000' });
  }

  let cleanUrl = String(url).trim();
  if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = 'https://' + cleanUrl;
  try { new URL(cleanUrl); } catch { return res.status(400).json({ error: 'Некорректная ссылка' }); }

  const user = getUser(telegramId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.is_banned) return res.status(403).json({ error: 'Вы заблокированы' });

  const totalCost = amount * maxC;
  if (reward_type === 'tickets') {
    if (user.tickets < totalCost) {
      return res.status(400).json({
        error: 'Недостаточно средств',
        detail: `Нужно ${totalCost} билетов, у вас ${user.tickets}`,
        need: totalCost,
        have: user.tickets,
        currency: 'tickets'
      });
    }
    updateBalance(telegramId, 0, -totalCost);
  } else {
    if (user.stars < totalCost) {
      return res.status(400).json({
        error: 'Недостаточно средств',
        detail: `Нужно ${totalCost} Stars, у вас ${user.stars}`,
        need: totalCost,
        have: user.stars,
        currency: 'stars'
      });
    }
    updateBalance(telegramId, -totalCost, 0);
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO tasks (id, creator_id, title, description, type, url, reward_type, reward_amount, max_completions, escrow_left)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(telegramId),
    String(title).slice(0, 80),
    description ? String(description).slice(0, 300) : '',
    type,
    cleanUrl,
    reward_type,
    amount,
    maxC,
    totalCost
  );

  addTransaction(
    telegramId,
    'task_create',
    reward_type === 'stars' ? -totalCost : 0,
    reward_type === 'tickets' ? -totalCost : 0,
    `Создание задания: ${String(title).slice(0, 40)} (эскроу ${totalCost})`
  );

  const updated = getUser(telegramId);
  res.json({
    ok: true,
    id,
    totalCost,
    balance: { stars: updated.stars, tickets: updated.tickets }
  });
});

app.post('/api/tasks/:id/complete', (req, res) => {
  const { telegramId } = req.body;
  const taskId = req.params.id;
  if (!telegramId) return res.status(400).json({ error: 'No telegramId' });

  const user = getUser(telegramId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.is_banned) return res.status(403).json({ error: 'Вы заблокированы' });

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task || !task.is_active) return res.status(404).json({ error: 'Задание не найдено' });
  if (task.current_completions >= task.max_completions) {
    return res.status(400).json({ error: 'Лимит выполнений исчерпан' });
  }
  if (task.creator_id === String(telegramId)) {
    return res.status(400).json({ error: 'Нельзя выполнять своё задание' });
  }
  if (task.escrow_left < task.reward_amount) {
    return res.status(400).json({ error: 'Награда недоступна' });
  }

  const already = db.prepare('SELECT id FROM task_completions WHERE task_id = ? AND user_id = ?')
    .get(taskId, String(telegramId));
  if (already) return res.status(400).json({ error: 'Вы уже выполнили это задание' });

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO task_completions (id, task_id, user_id) VALUES (?, ?, ?)')
      .run(uuidv4(), taskId, String(telegramId));

    db.prepare(`
      UPDATE tasks SET
        current_completions = current_completions + 1,
        escrow_left = escrow_left - ?,
        is_active = CASE WHEN current_completions + 1 >= max_completions THEN 0 ELSE is_active END
      WHERE id = ?
    `).run(task.reward_amount, taskId);

    if (task.reward_type === 'stars') {
      updateBalance(telegramId, task.reward_amount, 0);
      addTransaction(telegramId, 'task_reward', task.reward_amount, 0, `Задание: ${task.title}`);
    } else {
      updateBalance(telegramId, 0, task.reward_amount);
      addTransaction(telegramId, 'task_reward', 0, task.reward_amount, `Задание: ${task.title}`);
    }
  });
  tx();

  const updated = getUser(telegramId);
  res.json({
    ok: true,
    reward_type: task.reward_type,
    reward_amount: task.reward_amount,
    balance: { stars: updated.stars, tickets: updated.tickets }
  });
});

app.post('/api/tasks/:id/report', (req, res) => {
  const { telegramId, reason } = req.body;
  const taskId = req.params.id;
  if (!telegramId) return res.status(400).json({ error: 'No telegramId' });

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Задание не найдено' });

  const exists = db.prepare(`
    SELECT id FROM task_reports WHERE task_id = ? AND reporter_id = ? AND status = 'pending'
  `).get(taskId, String(telegramId));
  if (exists) return res.status(400).json({ error: 'Жалоба уже отправлена' });

  db.prepare(`
    INSERT INTO task_reports (id, task_id, reporter_id, reason) VALUES (?, ?, ?, ?)
  `).run(uuidv4(), taskId, String(telegramId), (reason || '').slice(0, 300));

  res.json({ ok: true });
});

app.get('/api/admin/task-reports', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, t.title, t.url, t.type, t.creator_id, t.is_active, t.escrow_left, t.reward_type,
           u.username as reporter_username
    FROM task_reports r
    LEFT JOIN tasks t ON t.id = r.task_id
    LEFT JOIN users u ON u.telegram_id = r.reporter_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

app.post('/api/admin/tasks/resolve-report', adminAuth, (req, res) => {
  const { reportId, action, note } = req.body; // action: delete_task | dismiss
  const report = db.prepare('SELECT * FROM task_reports WHERE id = ?').get(reportId);
  if (!report || report.status !== 'pending') return res.status(400).json({ error: 'Invalid report' });

  if (action === 'delete_task') {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(report.task_id);
    if (task && task.is_active) {
      // Refund remaining escrow
      if (task.escrow_left > 0) {
        if (task.reward_type === 'stars') {
          updateBalance(task.creator_id, task.escrow_left, 0);
          addTransaction(task.creator_id, 'task_refund', task.escrow_left, 0, 'Возврат эскроу (задание удалено)');
        } else {
          updateBalance(task.creator_id, 0, task.escrow_left);
          addTransaction(task.creator_id, 'task_refund', 0, task.escrow_left, 'Возврат эскроу (задание удалено)');
        }
      }
      db.prepare('UPDATE tasks SET is_active = 0, escrow_left = 0 WHERE id = ?').run(task.id);
    }
    db.prepare(`UPDATE task_reports SET status = 'resolved', admin_note = ? WHERE id = ?`)
      .run(note || 'Задание удалено', reportId);
  } else {
    db.prepare(`UPDATE task_reports SET status = 'rejected', admin_note = ? WHERE id = ?`)
      .run(note || 'Отклонено', reportId);
  }
  res.json({ ok: true });
});

// History
app.get('/api/history/:telegramId', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(String(req.params.telegramId));
  res.json(rows);
});

// Chat history
app.get('/api/chat', (req, res) => {
  const rows = db.prepare('SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT 100').all().reverse();
  res.json(rows);
});

// Online
app.get('/api/online', (req, res) => {
  res.json({ count: onlineUsers.size, users: Array.from(onlineUsers.values()) });
});

// ==================== ADMIN API ====================
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE login = ?').get(login);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = jwt.sign({ id: admin.id, login: admin.login }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token, login: admin.login });
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const pendingWithdraws = db.prepare("SELECT COUNT(*) as c FROM withdraw_requests WHERE status = 'pending'").get().c;
  const activeRaffles = db.prepare("SELECT COUNT(*) as c FROM raffles WHERE status = 'active'").get().c;
  const totalStars = db.prepare('SELECT SUM(stars) as s FROM users').get().s || 0;
  res.json({ users, pendingWithdraws, activeRaffles, totalStars, online: onlineUsers.size });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 200').all();
  res.json(users);
});

app.post('/api/admin/ban', adminAuth, (req, res) => {
  const { telegramId, ban } = req.body;
  db.prepare('UPDATE users SET is_banned = ? WHERE telegram_id = ?').run(ban ? 1 : 0, String(telegramId));
  res.json({ ok: true });
});

app.post('/api/admin/make-admin', adminAuth, (req, res) => {
  const { telegramId } = req.body;
  db.prepare('UPDATE users SET is_admin = 1 WHERE telegram_id = ?').run(String(telegramId));
  res.json({ ok: true });
});

app.get('/api/admin/withdraws', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT w.*, u.username, u.first_name FROM withdraw_requests w
    LEFT JOIN users u ON u.telegram_id = w.user_id
    ORDER BY w.created_at DESC LIMIT 100
  `).all();
  res.json(rows);
});

app.post('/api/admin/withdraw/process', adminAuth, (req, res) => {
  const { id, status, note } = req.body; // approved | rejected
  const wr = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(id);
  if (!wr || wr.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
  
  if (status === 'rejected') {
    // Return stars
    updateBalance(wr.user_id, wr.amount, 0);
    addTransaction(wr.user_id, 'withdraw', wr.amount, 0, 'Вывод отклонён, Stars возвращены');
  }
  // If approved — admin must process manually (send gift / TON / etc.)
  
  db.prepare(`
    UPDATE withdraw_requests SET status = ?, admin_note = ?, processed_at = datetime('now') WHERE id = ?
  `).run(status, note || '', id);
  
  res.json({ ok: true });
});

app.post('/api/admin/promo/create', adminAuth, (req, res) => {
  const { code, type, amount, max_uses } = req.body;
  if (!code || !type || !amount) return res.status(400).json({ error: 'Missing' });
  
  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO promo_codes (id, code, type, amount, max_uses, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, code.toUpperCase(), type, parseInt(amount, 10), parseInt(max_uses, 10) || 1, req.admin.login);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: 'Код уже существует' });
  }
});

app.get('/api/admin/promos', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all());
});

app.post('/api/admin/promo/toggle', adminAuth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'No id' });
  const promo = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id);
  if (!promo) return res.status(404).json({ error: 'Not found' });
  const newActive = promo.is_active ? 0 : 1;
  db.prepare('UPDATE promo_codes SET is_active = ? WHERE id = ?').run(newActive, id);
  res.json({ ok: true, is_active: newActive });
});

// Health (Railway)
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'yanlin' });
});

// Fallback SPA
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found — check deploy of public/ folder');
  }
});

const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n🌟 Янлин running on http://${HOST}:${PORT}`);
  console.log(`   Admin: ${ADMIN_LOGIN} / ${ADMIN_PASSWORD}`);
  console.log(`   Open: ${APP_URL}`);
  console.log(`   index.html: ${fs.existsSync(INDEX_HTML) ? 'OK' : 'MISSING!'}`);
  try {
    console.log(`   public files: ${fs.readdirSync(PUBLIC_DIR).join(', ')}`);
  } catch (e) {
    console.log(`   public dir error: ${e.message}`);
  }
  console.log('');
});
