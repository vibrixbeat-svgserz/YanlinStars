/**
 * Янлин Frontend — Professional Telegram Mini App
 */

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#0a0a0f');
  tg.setBackgroundColor('#0a0a0f');
}

const API = '';
let user = null;
let socket = null;
let adminToken = null;
let logoClicks = 0;
let logoTimer = null;

function forceShowApp() {
  const splashEl = document.getElementById('splash');
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.classList.add('ready');
    appEl.style.opacity = '1';
  }
  if (splashEl) {
    splashEl.classList.add('hide');
    setTimeout(() => { try { splashEl.remove(); } catch(_){} }, 600);
  }
}

async function init() {
  // Hard safety — show UI no matter what
  setTimeout(forceShowApp, 2800);

  let tgUser = tg?.initDataUnsafe?.user;
  if (!tgUser) {
    tgUser = {
      id: 123456789,
      username: 'demo_user',
      first_name: 'Demo',
      last_name: 'User',
      photo_url: null
    };
  }
  if (!tgUser.photo_url && tg?.initDataUnsafe?.user?.photo_url) {
    tgUser.photo_url = tg.initDataUnsafe.user.photo_url;
  }

  // Сразу показываем имя из Telegram (чтобы не было «Гость»)
  user = {
    id: String(tgUser.id),
    username: tgUser.username || null,
    first_name: tgUser.first_name || tgUser.username || 'User',
    photo_url: tgUser.photo_url || null,
    stars: 0,
    tickets: 0,
    referral_count: 0
  };
  try { updateUI(); } catch (_) {}

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: tgUser, initData: tg?.initData }),
      signal: controller.signal
    });
    clearTimeout(t);
    const data = await res.json();
    if (data.ok && data.user) {
      user = data.user;
      updateUI();
    } else if (data.error === 'Banned') {
      document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#ef4444">Вы заблокированы</div>';
      return;
    }
  } catch (e) {
    console.warn('Auth fallback', e);
    // user уже заполнен из Telegram выше
    updateUI();
  }

  try { connectSocket(); } catch (e) { console.warn(e); }
  try { loadRaffles(); } catch (e) {}
  try { loadChat(); } catch (e) {}
  try { loadHistory(); } catch (e) {}
  try { renderShop(); } catch (e) {}
  try { loadTasks(); } catch (e) {}
  try { setupTasksUI(); } catch (e) {}
  try { setupNavigation(); } catch (e) {}
  try { setupLogoSecret(); } catch (e) {}
  try { setupDailyBonus(); } catch (e) {}

  // Normal reveal after short delay
  setTimeout(forceShowApp, 1600);
}

function updateUI() {
  if (!user) return;

  // Balance with pulse animation
  const starsEl = document.getElementById('starsBal');
  const ticketsEl = document.getElementById('ticketsBal');
  const oldStars = parseInt(starsEl.textContent) || 0;
  const oldTickets = parseInt(ticketsEl.textContent) || 0;
  starsEl.textContent = user.stars || 0;
  ticketsEl.textContent = user.tickets || 0;
  if (user.stars !== oldStars) {
    starsEl.parentElement.classList.add('pulse');
    setTimeout(() => starsEl.parentElement.classList.remove('pulse'), 450);
  }
  if (user.tickets !== oldTickets) {
    ticketsEl.parentElement.classList.add('pulse');
    setTimeout(() => ticketsEl.parentElement.classList.remove('pulse'), 450);
  }

  // Name + username
  const displayName = user.first_name || user.username || 'User';
  document.getElementById('userName').textContent = displayName;
  document.getElementById('profUsername').textContent = user.username ? '@' + user.username : '—';
  document.getElementById('profStars').textContent = user.stars || 0;
  document.getElementById('profTickets').textContent = user.tickets || 0;
  document.getElementById('profRefs').textContent = user.referral_count || 0;

  // Username tag under name
  const tag = document.getElementById('userTag');
  if (tag) {
    if (user.username) {
      tag.textContent = '@' + user.username;
      tag.style.display = 'inline-block';
    } else {
      tag.style.display = 'none';
    }
  }

  // Referral link
  const botUser = tg?.initDataUnsafe?.receiver?.username || tg?.initDataUnsafe?.start_param || 'YourBot';
  const refInput = document.getElementById('refLink');
  if (refInput) refInput.value = `https://t.me/${botUser}?start=ref_${user.id}`;

  // Avatar — real Telegram photo or letter
  const img = document.getElementById('avatarImg');
  const ph = document.getElementById('avatarPlaceholder');
  if (user.photo_url) {
    ph.classList.add('loading');
    img.onload = () => {
      img.style.display = 'block';
      ph.style.display = 'none';
      ph.classList.remove('loading');
    };
    img.onerror = () => {
      ph.classList.remove('loading');
      ph.textContent = (user.first_name || user.username || 'U')[0].toUpperCase();
      ph.style.display = 'flex';
      img.style.display = 'none';
    };
    img.src = user.photo_url;
  } else {
    ph.classList.remove('loading');
    ph.textContent = (user.first_name || user.username || 'U')[0].toUpperCase();
    ph.style.display = 'flex';
    img.style.display = 'none';
  }
}

function connectSocket() {
  if (typeof io === 'undefined' || window.__noSocket) {
    console.warn('Socket.IO not available');
    return;
  }
  try {
    socket = io();
    socket.on('connect', () => {
      socket.emit('join', {
        telegramId: user?.id,
        username: user?.username || user?.first_name,
        photo: user?.photo_url
      });
    });
    socket.on('online_count', (c) => {
      const el = document.getElementById('onlineCount');
      if (el) el.textContent = c;
    });
    socket.on('chat_message', (msg) => appendChatMsg(msg));
    socket.on('big_win', (data) => {
      toast(`🎉 ${data.username} выиграл ${data.prize}!`, 'success');
      const list = document.getElementById('recentWins');
      if (list) {
        if (list.querySelector('.empty')) list.innerHTML = '';
        list.insertAdjacentHTML('afterbegin', `<div class="win-item"><span>${data.username}</span><strong>${data.prize}</strong></div>`);
      }
    });
    socket.on('raffle_winner', (data) => {
      toast(`🏆 Победитель «${data.title}»: ${data.winner}`, 'success');
      loadRaffles();
    });
    socket.on('balance_update', (data) => {
      if (data.userId === user?.id) refreshBalance();
    });
  } catch (e) {
    console.warn('Socket connect failed', e);
  }
}

async function refreshBalance() {
  if (!user) return;
  try {
    const res = await fetch(`${API}/api/me/${user.id}`);
    const data = await res.json();
    user.stars = data.stars;
    user.tickets = data.tickets;
    updateUI();
  } catch {}
}

function setupNavigation() {
  document.querySelectorAll('.nav-btn, .action-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (!page) return;
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.getElementById(`page-${page}`)?.classList.add('active');
      document.querySelector(`.nav-btn[data-page="${page}"]`)?.classList.add('active');
      if (page === 'profile') loadHistory();
      if (page === 'raffles') loadRaffles();
      if (page === 'chat') loadChat();
    });
  });
}

function setupLogoSecret() {
  document.getElementById('logoTap').addEventListener('click', () => {
    logoClicks++;
    if (logoTimer) clearTimeout(logoTimer);
    logoTimer = setTimeout(() => { logoClicks = 0; }, 1500);
    if (logoClicks >= 3) {
      logoClicks = 0;
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-admin').classList.add('active');
      toast('Админ-панель открыта', 'success');
    }
  });
}

const TASK_TYPE_LABELS = {
  link: 'Ссылка',
  subscribe: 'Подписка',
  like: 'Лайк',
  comment: 'Комментарий'
};

async function loadTasks() {
  const list = document.getElementById('tasksList');
  if (!list) return;
  try {
    const uid = user?.id || '';
    const res = await fetch(`${API}/api/tasks?telegramId=${encodeURIComponent(uid)}`);
    const tasks = await res.json();
    if (!Array.isArray(tasks) || !tasks.length) {
      list.innerHTML = '<div class="empty">Пока нет активных заданий</div>';
      return;
    }
    list.innerHTML = tasks.map(t => {
      const done = t.completed;
      const rewardIcon = t.reward_type === 'stars' ? '⭐' : '🎫';
      return `
        <div class="task-card ${done ? 'task-done' : ''}" data-id="${t.id}">
          <div class="task-card-top">
            <div>
              <h4>${escapeHtml(t.title)}</h4>
              <div class="task-meta">${escapeHtml(t.creator_username ? '@' + t.creator_username : (t.creator_name || 'Пользователь'))}</div>
            </div>
            <span class="task-type-badge">${done ? 'Выполнено' : TASK_TYPE_LABELS[t.type] || t.type}</span>
          </div>
          ${t.description ? `<div class="task-meta" style="margin-bottom:6px">${escapeHtml(t.description)}</div>` : ''}
          <div class="task-reward">+${t.reward_amount} ${rewardIcon}</div>
          <div class="task-progress">${t.current_completions} / ${t.max_completions} выполнений</div>
          <div class="task-actions">
            <button class="btn small secondary" onclick="openTaskLink('${escapeHtml(t.url)}')">Открыть</button>
            ${!done ? `<button class="btn small primary" onclick="completeTask('${t.id}')">Готово</button>` : ''}
            <button class="btn small" onclick="reportTask('${t.id}')">Жалоба</button>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty">Ошибка загрузки</div>';
  }
}

window.openTaskLink = function(url) {
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, '_blank');
};

window.completeTask = async function(id) {
  if (!user) return;
  try {
    const res = await fetch(`${API}/api/tasks/${id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId: user.id })
    });
    const data = await res.json();
    if (data.ok) {
      toast(`+${data.reward_amount} ${data.reward_type === 'stars' ? '⭐' : '🎫'}`, 'success');
      user.stars = data.balance.stars;
      user.tickets = data.balance.tickets;
      updateUI();
      loadTasks();
    } else {
      toast(data.error || 'Ошибка', 'error');
    }
  } catch {
    toast('Ошибка сети', 'error');
  }
};

window.reportTask = async function(id) {
  if (!user) return;
  const reason = prompt('Причина жалобы (нарушение, спам, обман):') || '';
  try {
    const res = await fetch(`${API}/api/tasks/${id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId: user.id, reason })
    });
    const data = await res.json();
    if (data.ok) toast('Жалоба отправлена в админку', 'success');
    else toast(data.error || 'Ошибка', 'error');
  } catch {
    toast('Ошибка сети', 'error');
  }
};

function setupTasksUI() {
  const modal = document.getElementById('taskModal');
  const openBtn = document.getElementById('openCreateTask');
  const closeBtn = document.getElementById('closeTaskModal');
  const submitBtn = document.getElementById('submitTask');
  const amountEl = document.getElementById('taskRewardAmount');
  const maxEl = document.getElementById('taskMaxCompletions');
  const typeEl = document.getElementById('taskRewardType');
  const hint = document.getElementById('taskCostHint');

  const updateCost = () => {
    const a = parseInt(amountEl?.value, 10) || 0;
    const m = parseInt(maxEl?.value, 10) || 0;
    const total = a * m;
    const cur = typeEl?.value === 'stars' ? '⭐' : '🎫';
    if (hint) {
      if (total > 0) {
        const have = typeEl?.value === 'stars' ? (user?.stars || 0) : (user?.tickets || 0);
        const ok = have >= total;
        hint.textContent = ok
          ? `Будет списано: ${total} ${cur}`
          : `Недостаточно средств: нужно ${total} ${cur}, у вас ${have}`;
        hint.style.color = ok ? 'var(--muted)' : '#f87171';
      } else hint.textContent = '';
    }
  };
  amountEl?.addEventListener('input', updateCost);
  maxEl?.addEventListener('input', updateCost);
  typeEl?.addEventListener('change', updateCost);

  openBtn?.addEventListener('click', () => {
    if (modal) modal.classList.add('show');
    updateCost();
  });
  closeBtn?.addEventListener('click', () => modal?.classList.remove('show'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('show'); });

  submitBtn?.addEventListener('click', async () => {
    if (!user) return;
    const body = {
      telegramId: user.id,
      title: document.getElementById('taskTitle')?.value.trim(),
      description: document.getElementById('taskDesc')?.value.trim(),
      type: document.getElementById('taskType')?.value,
      url: document.getElementById('taskUrl')?.value.trim(),
      reward_type: document.getElementById('taskRewardType')?.value,
      reward_amount: document.getElementById('taskRewardAmount')?.value,
      max_completions: document.getElementById('taskMaxCompletions')?.value
    };
    try {
      const res = await fetch(`${API}/api/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.ok) {
        toast('Задание создано', 'success');
        user.stars = data.balance.stars;
        user.tickets = data.balance.tickets;
        updateUI();
        modal?.classList.remove('show');
        ['taskTitle','taskDesc','taskUrl','taskRewardAmount','taskMaxCompletions'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        loadTasks();
      } else {
        const msg = data.detail || data.error || 'Ошибка';
        toast(msg, 'error');
      }
    } catch {
      toast('Ошибка сети', 'error');
    }
  });
}

const PACKAGES = [
  { id: '10', tickets: 10, stars: 15, label: '10 билетов' },
  { id: '50', tickets: 50, stars: 60, label: '50 билетов' },
  { id: '100', tickets: 100, stars: 100, label: '100 билетов' },
  { id: '500', tickets: 500, stars: 400, label: '500 билетов' },
  { id: '1000', tickets: 1000, stars: 700, label: '1000 билетов' }
];

function renderShop() {
  const grid = document.getElementById('shopGrid');
  grid.innerHTML = PACKAGES.map(p => `
    <div class="shop-card">
      <div class="shop-info"><h3>${p.label}</h3><p>${p.tickets} 🎫</p></div>
      <button class="shop-price" data-pack="${p.id}">${p.stars} ⭐</button>
    </div>
  `).join('');
  grid.querySelectorAll('.shop-price').forEach(btn => {
    btn.addEventListener('click', () => buyPackage(btn.dataset.pack));
  });
}

async function buyPackage(packageId) {
  if (!user) return;
  try {
    const res = await fetch(`${API}/api/shop/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId: user.id, packageId })
    });
    const data = await res.json();
    if (data.ok && data.invoiceLink) {
      if (tg?.openInvoice) {
        tg.openInvoice(data.invoiceLink, (status) => {
          if (status === 'paid') {
            toast('Оплата прошла! Билеты начислены', 'success');
            setTimeout(refreshBalance, 1500);
          }
        });
      } else {
        window.open(data.invoiceLink, '_blank');
        toast('Откройте ссылку для оплаты в Telegram', 'success');
      }
    } else toast(data.error || 'Ошибка создания счёта', 'error');
  } catch { toast('Ошибка сети', 'error'); }
}

async function loadRaffles() {
  try {
    const res = await fetch(`${API}/api/raffles`);
    const raffles = await res.json();
    const list = document.getElementById('rafflesList');
    if (!raffles.length) {
      list.innerHTML = '<div class="empty">Нет активных розыгрышей. Выстави свой подарок!</div>';
      return;
    }
    list.innerHTML = raffles.map(r => `
      <div class="raffle-card">
        ${r.image_url ? `<img src="${r.image_url}" alt="" />` : ''}
        <div class="raffle-body">
          <h3>${escapeHtml(r.title)}</h3>
          <p>${escapeHtml(r.description || '')}</p>
          <div class="raffle-meta">
            <span>🎫 ${r.total_tickets || 0} билетов</span>
            <span>👥 ${r.entries_count || 0} уч.</span>
          </div>
          <div class="raffle-enter">
            <input type="number" min="1" value="1" id="enter-${r.id}" placeholder="Билетов" />
            <button class="btn small primary" onclick="enterRaffle('${r.id}')">Участвовать</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch {
    document.getElementById('rafflesList').innerHTML = '<div class="empty">Ошибка загрузки</div>';
  }
}

window.enterRaffle = async function(raffleId) {
  const input = document.getElementById(`enter-${raffleId}`);
  const tickets = parseInt(input?.value || 1, 10);
  if (!user || tickets < 1) return;
  try {
    const res = await fetch(`${API}/api/raffles/${raffleId}/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId: user.id, tickets })
    });
    const data = await res.json();
    if (data.ok) {
      user.tickets = data.balance.tickets;
      updateUI();
      toast(`Вы участвуете (${tickets} билетов)`, 'success');
      loadRaffles();
    } else toast(data.error || 'Ошибка', 'error');
  } catch { toast('Ошибка сети', 'error'); }
};

document.getElementById('createRaffleBtn')?.addEventListener('click', () => {
  document.getElementById('raffleModal').classList.add('show');
});
document.getElementById('closeRaffleModal')?.addEventListener('click', () => {
  document.getElementById('raffleModal').classList.remove('show');
});
document.getElementById('submitRaffle')?.addEventListener('click', async () => {
  const title = document.getElementById('raffleTitle').value.trim();
  const desc = document.getElementById('raffleDesc').value.trim();
  const file = document.getElementById('raffleImage').files[0];
  if (!title) return toast('Введите название', 'error');
  const fd = new FormData();
  fd.append('title', title);
  fd.append('description', desc);
  fd.append('created_by', user.id);
  fd.append('gift_type', 'custom');
  if (file) fd.append('image', file);
  try {
    const res = await fetch(`${API}/api/raffles/create`, { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      toast('Розыгрыш создан!', 'success');
      document.getElementById('raffleModal').classList.remove('show');
      loadRaffles();
    } else toast(data.error || 'Ошибка', 'error');
  } catch { toast('Ошибка загрузки', 'error'); }
});

document.getElementById('copyRef')?.addEventListener('click', () => {
  const input = document.getElementById('refLink');
  input.select();
  navigator.clipboard.writeText(input.value);
  toast('Скопировано!', 'success');
});

document.getElementById('activatePromo')?.addEventListener('click', async () => {
  const code = document.getElementById('promoInput').value.trim();
  if (!code) return;
  try {
    const res = await fetch(`${API}/api/promo/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId: user.id, code })
    });
    const data = await res.json();
    if (data.ok) {
      user.stars = data.balance.stars;
      user.tickets = data.balance.tickets;
      updateUI();
      toast(`Промокод активирован: +${data.amount} ${data.type === 'stars' ? '⭐' : '🎫'}`, 'success');
      document.getElementById('promoInput').value = '';
    } else toast(data.error || 'Ошибка', 'error');
  } catch { toast('Ошибка сети', 'error'); }
});

document.getElementById('withdrawBtn')?.addEventListener('click', async () => {
  const amount = parseInt(document.getElementById('withdrawAmount').value, 10);
  if (!amount || amount < 10 || amount > 1000) return toast('Сумма от 10 до 1000', 'error');
  try {
    const res = await fetch(`${API}/api/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId: user.id, amount })
    });
    const data = await res.json();
    if (data.ok) {
      toast('Заявка на вывод создана', 'success');
      refreshBalance();
      document.getElementById('withdrawAmount').value = '';
    } else toast(data.error || 'Ошибка', 'error');
  } catch { toast('Ошибка сети', 'error'); }
});

async function loadHistory() {
  if (!user) return;
  try {
    const res = await fetch(`${API}/api/history/${user.id}`);
    const rows = await res.json();
    const list = document.getElementById('historyList');
    if (!rows.length) {
      list.innerHTML = '<div class="empty">История пуста</div>';
      return;
    }
    list.innerHTML = rows.slice(0, 30).map(r => `
      <div class="history-item">
        <span>${escapeHtml(r.description || r.type)}</span>
        <strong>${r.amount_stars ? (r.amount_stars > 0 ? '+' : '') + r.amount_stars + '⭐' : ''} ${r.amount_tickets ? (r.amount_tickets > 0 ? '+' : '') + r.amount_tickets + '🎫' : ''}</strong>
      </div>
    `).join('');
  } catch {}
}

async function loadChat() {
  try {
    const res = await fetch(`${API}/api/chat`);
    const msgs = await res.json();
    const box = document.getElementById('chatMessages');
    box.innerHTML = '';
    msgs.forEach(appendChatMsg);
    box.scrollTop = box.scrollHeight;
  } catch {}
}

function appendChatMsg(msg) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<div class="author">${escapeHtml(msg.username || 'User')}</div>${escapeHtml(msg.text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

document.getElementById('sendChat')?.addEventListener('click', sendChat);
document.getElementById('chatInput')?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !user || !socket) return;
  socket.emit('chat_message', {
    telegramId: user.id,
    username: user.username || user.first_name,
    text
  });
  input.value = '';
}

document.getElementById('adminLoginBtn')?.addEventListener('click', async () => {
  const login = document.getElementById('adminLogin').value;
  const password = document.getElementById('adminPass').value;
  try {
    const res = await fetch(`${API}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password })
    });
    const data = await res.json();
    if (data.ok) {
      adminToken = data.token;
      document.getElementById('adminLoginForm').style.display = 'none';
      document.getElementById('adminPanel').style.display = 'block';
      loadAdminStats();
      loadAdminTab('users');
      toast('Вход выполнен', 'success');
    } else toast(data.error || 'Ошибка', 'error');
  } catch { toast('Ошибка сети', 'error'); }
});

document.querySelectorAll('.admin-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.admin-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadAdminTab(tab.dataset.tab);
  });
});

async function loadAdminStats() {
  try {
    const res = await fetch(`${API}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const s = await res.json();
    document.getElementById('adminStats').innerHTML = `
      <div class="stat-card"><div class="val">${s.users}</div><div class="lbl">Пользователей</div></div>
      <div class="stat-card"><div class="val">${s.online}</div><div class="lbl">Онлайн</div></div>
      <div class="stat-card"><div class="val">${s.pendingWithdraws}</div><div class="lbl">Выводов</div></div>
      <div class="stat-card"><div class="val">${s.activeRaffles}</div><div class="lbl">Розыгрышей</div></div>
    `;
  } catch {}
}

async function loadAdminTab(tab) {
  const content = document.getElementById('adminContent');
  content.innerHTML = '<div class="empty">Загрузка...</div>';
  try {
    if (tab === 'users') {
      const res = await fetch(`${API}/api/admin/users`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const users = await res.json();
      content.innerHTML = users.map(u => `
        <div class="history-item" style="flex-wrap:wrap;gap:8px">
          <span>${u.username ? '@' + u.username : u.first_name || u.telegram_id}</span>
          <span>${u.stars}⭐ ${u.tickets}🎫</span>
          <button class="btn small" onclick="adminBan('${u.telegram_id}', ${u.is_banned ? 0 : 1})">${u.is_banned ? 'Разбан' : 'Бан'}</button>
          ${!u.is_admin ? `<button class="btn small" onclick="adminMakeAdmin('${u.telegram_id}')">Админ</button>` : '<span style="color:var(--primary)">Админ</span>'}
        </div>
      `).join('') || '<div class="empty">Нет пользователей</div>';
    } else if (tab === 'withdraws') {
      const res = await fetch(`${API}/api/admin/withdraws`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const rows = await res.json();
      content.innerHTML = rows.map(w => `
        <div class="history-item" style="flex-direction:column;align-items:flex-start;gap:8px">
          <div>@${w.username || w.user_id} — ${w.amount} ⭐ — <strong>${w.status}</strong></div>
          ${w.status === 'pending' ? `
            <div style="display:flex;gap:8px">
              <button class="btn small primary" onclick="processWithdraw('${w.id}','approved')">Одобрить</button>
              <button class="btn small secondary" onclick="processWithdraw('${w.id}','rejected')">Отклонить</button>
            </div>
          ` : ''}
        </div>
      `).join('') || '<div class="empty">Нет заявок</div>';
    } else if (tab === 'promos') {
      content.innerHTML = `
        <div class="section" style="margin-bottom:18px;padding:14px;background:var(--surface2);border-radius:14px;border:1px solid var(--border)">
          <h3 style="margin-bottom:12px;font-size:15px">Создать промокод</h3>
          <input type="text" id="newPromoCode" placeholder="Код (например SUMMER50)" style="width:100%;margin-bottom:8px;padding:11px;border-radius:10px;border:1px solid var(--border);background:var(--surface3);color:var(--text);font-weight:600;letter-spacing:0.5px" />
          <select id="newPromoType" style="width:100%;margin-bottom:8px;padding:11px;border-radius:10px;border:1px solid var(--border);background:var(--surface3);color:var(--text)">
            <option value="tickets">🎟 Билеты</option>
            <option value="stars">⭐ Stars</option>
          </select>
          <div style="display:flex;gap:8px;margin-bottom:8px">
            <input type="number" id="newPromoAmount" placeholder="Количество" min="1" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--border);background:var(--surface3);color:var(--text)" />
            <input type="number" id="newPromoUses" placeholder="Макс. юзов" value="10" min="1" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--border);background:var(--surface3);color:var(--text)" />
          </div>
          <button class="btn primary" style="width:100%" onclick="createPromo()">Создать промокод</button>
        </div>
        <h3 style="margin-bottom:10px;font-size:14px;color:var(--muted)">Активные промокоды</h3>
        <div id="promoList"></div>
      `;
      loadPromos();
    } else if (tab === 'reports') {
      const res = await fetch(`${API}/api/admin/task-reports`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const rows = await res.json();
      content.innerHTML = (Array.isArray(rows) ? rows : []).map(r => `
        <div class="history-item" style="flex-direction:column;align-items:flex-start;gap:8px">
          <strong>${escapeHtml(r.title || 'Задание')}</strong>
          <span style="font-size:12px;color:var(--muted)">Тип: ${r.type || '—'} · Жалоба: @${r.reporter_username || r.reporter_id}</span>
          <span style="font-size:12px;word-break:break-all">${escapeHtml(r.url || '')}</span>
          <span style="font-size:12px">${escapeHtml(r.reason || 'Без причины')}</span>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn small primary" onclick="resolveReport('${r.id}','delete_task')">Удалить задание</button>
            <button class="btn small secondary" onclick="resolveReport('${r.id}','dismiss')">Отклонить жалобу</button>
          </div>
        </div>
      `).join('') || '<div class="empty">Нет жалоб</div>';
    } else if (tab === 'raffles') {
      const res = await fetch(`${API}/api/raffles`);
      const raffles = await res.json();
      content.innerHTML = raffles.map(r => `
        <div class="history-item" style="flex-direction:column;align-items:flex-start;gap:8px">
          <strong>${escapeHtml(r.title)}</strong>
          <span>${r.total_tickets} билетов, ${r.entries_count} участников</span>
          <button class="btn small primary" onclick="drawRaffle('${r.id}')">Провести розыгрыш</button>
        </div>
      `).join('') || '<div class="empty">Нет активных</div>';
    }
  } catch {
    content.innerHTML = '<div class="empty">Ошибка</div>';
  }
}

window.resolveReport = async function(reportId, action) {
  const res = await fetch(`${API}/api/admin/tasks/resolve-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ reportId, action })
  });
  const data = await res.json();
  if (data.ok) {
    toast(action === 'delete_task' ? 'Задание удалено, эскроу возвращён' : 'Жалоба отклонена', 'success');
    loadAdminTab('reports');
  } else toast(data.error || 'Ошибка', 'error');
};

window.adminBan = async function(id, ban) {
  await fetch(`${API}/api/admin/ban`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ telegramId: id, ban })
  });
  toast(ban ? 'Забанен' : 'Разбанен', 'success');
  loadAdminTab('users');
};

window.adminMakeAdmin = async function(id) {
  await fetch(`${API}/api/admin/make-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ telegramId: id })
  });
  toast('Админ назначен', 'success');
  loadAdminTab('users');
};

window.processWithdraw = async function(id, status) {
  await fetch(`${API}/api/admin/withdraw/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ id, status })
  });
  toast(status === 'approved' ? 'Одобрено' : 'Отклонено', 'success');
  loadAdminTab('withdraws');
};

window.createPromo = async function() {
  const code = document.getElementById('newPromoCode').value.trim();
  const type = document.getElementById('newPromoType').value;
  const amount = document.getElementById('newPromoAmount').value;
  const max_uses = document.getElementById('newPromoUses').value;
  const res = await fetch(`${API}/api/admin/promo/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ code, type, amount, max_uses })
  });
  const data = await res.json();
  if (data.ok) {
    toast('Промокод создан', 'success');
    loadPromos();
  } else toast(data.error || 'Ошибка', 'error');
};

async function loadPromos() {
  const res = await fetch(`${API}/api/admin/promos`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const promos = await res.json();
  document.getElementById('promoList').innerHTML = promos.map(p => `
    <div class="history-item" style="flex-wrap:wrap;gap:8px">
      <span style="flex:1"><strong>${escapeHtml(p.code)}</strong> — ${p.amount} ${p.type === 'stars' ? '⭐' : '🎟'} (${p.used_count}/${p.max_uses})</span>
      <button class="btn small" onclick="togglePromo('${p.id}')">${p.is_active ? 'Выкл' : 'Вкл'}</button>
    </div>
  `).join('') || '<div class="empty">Нет промокодов</div>';
}

window.togglePromo = async function(id) {
  const res = await fetch(`${API}/api/admin/promo/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ id })
  });
  const data = await res.json();
  if (data.ok) {
    toast(data.is_active ? 'Промокод включён' : 'Промокод выключен', 'success');
    loadPromos();
  } else toast(data.error || 'Ошибка', 'error');
};

window.drawRaffle = async function(id) {
  const res = await fetch(`${API}/api/raffles/${id}/draw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }
  });
  const data = await res.json();
  if (data.ok) {
    toast(`Победитель: ${data.username || data.winner}`, 'success');
    loadAdminTab('raffles');
  } else toast(data.error || 'Ошибка', 'error');
};

function toast(msg, type = '') {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ==================== DAILY BONUS ====================
let dailyTimerInterval = null;
let dailyRemainingMs = 0;

function formatTime(ms) {
  if (ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function updateDailyUI(canClaim, remainingMs) {
  const btn = document.getElementById('dailyClaimBtn');
  const timer = document.getElementById('dailyTimer');
  if (!btn || !timer) return;

  dailyRemainingMs = remainingMs || 0;

  if (canClaim) {
    btn.disabled = false;
    btn.textContent = 'Забрать';
    btn.classList.add('claimable');
    timer.textContent = 'Доступно сейчас!';
    if (dailyTimerInterval) {
      clearInterval(dailyTimerInterval);
      dailyTimerInterval = null;
    }
  } else {
    btn.disabled = true;
    btn.textContent = 'Ждите';
    btn.classList.remove('claimable');
    timer.textContent = `Через ${formatTime(dailyRemainingMs)}`;
    if (!dailyTimerInterval) {
      dailyTimerInterval = setInterval(() => {
        dailyRemainingMs = Math.max(0, dailyRemainingMs - 1000);
        timer.textContent = `Через ${formatTime(dailyRemainingMs)}`;
        if (dailyRemainingMs <= 0) {
          clearInterval(dailyTimerInterval);
          dailyTimerInterval = null;
          setupDailyBonus(); // refresh
        }
      }, 1000);
    }
  }
}

async function setupDailyBonus() {
  if (!user) return;
  try {
    const res = await fetch(`${API}/api/daily-bonus/${user.id || user.telegram_id}`);
    const data = await res.json();
    updateDailyUI(data.canClaim, data.remainingMs || 0);
  } catch (e) {
    console.error('Daily bonus status error', e);
    updateDailyUI(false, 0);
  }

  const btn = document.getElementById('dailyClaimBtn');
  if (btn && !btn._bound) {
    btn._bound = true;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const res = await fetch(`${API}/api/daily-bonus/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telegramId: user.id || user.telegram_id })
        });
        const data = await res.json();
        if (data.ok) {
          toast(`+${data.amount} билетов! 🎉`, 'success');
          if (user) {
            user.tickets = data.balance.tickets;
            user.stars = data.balance.stars;
          }
          updateUI();
          updateDailyUI(false, 24 * 60 * 60 * 1000);
        } else {
          toast(data.error || 'Ошибка', 'error');
          if (data.remainingMs) updateDailyUI(false, data.remainingMs);
        }
      } catch (e) {
        toast('Ошибка сети', 'error');
        btn.disabled = false;
      }
    });
  }
}

init();
