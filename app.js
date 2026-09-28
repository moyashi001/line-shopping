/**
 * LINE買物＆ストック管理アプリ - LIFF フロントエンド
 *
 * ▼ 以下の2つを必ず書き換えてください
 *   LIFF_ID : LINE Developers の LIFF タブに表示される LIFF ID
 *   GAS_URL : GAS を「ウェブアプリ」としてデプロイした URL（…/exec）
 */
'use strict';

const APP_CONFIG = {
  LIFF_ID: '2011771308-rG52IOeU',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzHblT-3qXs_EXR86-PSGuX44Nz-N31Jm0zT9C1blClWMmVK0M4ygy-nwSWw6GKyYFFEA/exec',
  IMAGE_MAX_SIZE: 1280,              // アップロード前に縮小する長辺(px)
  IMAGE_QUALITY: 0.8,                // JPEG 品質
};

const ITEM_TODO = '未購入';
const ITEM_DONE = '購入済み';
const PHOTO_ITEM_NAME = '📷 写真のアイテム';

const STOCK_STATUS = [
  { value: '十分',   label: '余裕あり',   dot: '🟢', active: 'bg-emerald-500 border-emerald-500 text-white' },
  { value: '少なめ', label: '残りわずか', dot: '🟡', active: 'bg-amber-400 border-amber-400 text-white' },
  { value: 'なし',   label: '切れた',     dot: '🔴', active: 'bg-rose-500 border-rose-500 text-white' },
];

const state = {
  tab: 'shopping',
  stockFilter: 'all',
  shopping: [],
  stock: [],
  profile: null,
  loaded: false,
  pending: 0,
  pendingImage: null, // { dataUrl, base64, mime }
};

const $ = (id) => document.getElementById(id);

// ============================================================
// 初期化
// ============================================================
document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  state.tab = storageGet('tab') === 'stock' ? 'stock' : 'shopping';
  state.stockFilter = storageGet('stockFilter') === 'need' ? 'need' : 'all';
  switchTab(state.tab);

  if (APP_CONFIG.LIFF_ID.startsWith('YOUR_') || APP_CONFIG.GAS_URL.startsWith('YOUR_')) {
    showFatal('app.js の LIFF_ID と GAS_URL を設定してください。');
    return;
  }

  try {
    await liff.init({ liffId: APP_CONFIG.LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return;
    }
    try {
      state.profile = await liff.getProfile();
      $('user-name').textContent = `${state.profile.displayName} さん`;
    } catch (e) {
      console.warn('プロフィール取得失敗', e);
    }
    await refresh(true);
  } catch (e) {
    console.error(e);
    showFatal('初期化に失敗しました: ' + (e.message || e));
  }

  // 他の人の更新を拾うため、画面に戻ってきたら再取得
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.loaded && state.pending === 0) refresh(false);
  });
}

function bindEvents() {
  document.addEventListener('click', onClick);
  $('form-item').addEventListener('submit', submitItem);
  $('form-stock').addEventListener('submit', submitStock);
  $('input-camera').addEventListener('change', onImageSelected);
  $('input-photo').addEventListener('change', onImageSelected);
}

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;

  switch (action) {
    case 'tab':             switchTab(el.dataset.tab); break;
    case 'refresh':         refresh(false, true); break;
    case 'fab':             state.tab === 'stock' ? openStockModal() : openItemModal(); break;
    case 'close-modal':     closeModal(el.closest('.modal')); break;
    case 'toggle':          toggleItem(id, el); break;
    case 'delete-item':     deleteItem(id); break;
    case 'view-image':      viewImage(el.dataset.src); break;
    case 'clear-purchased': clearPurchased(); break;
    case 'remove-image':    clearPendingImage(); break;
    case 'stock-filter':    setStockFilter(el.dataset.filter); break;
    case 'stock-status':    setStockStatus(id, el.dataset.status); break;
    case 'to-shopping':     stockToShopping(id); break;
    case 'delete-stock':    deleteStock(id); break;
  }
}

// ============================================================
// API 通信（リクエストは直列化して順番どおりに処理）
// ============================================================
let queue = Promise.resolve();

function api(action, payload = {}) {
  state.pending++;
  updateSyncIndicator();

  const run = async () => {
    try {
      const res = await fetch(APP_CONFIG.GAS_URL, {
        method: 'POST',
        // text/plain にすると CORS のプリフライトが発生せず GAS で受け取れる
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, payload, idToken: liff.getIDToken() }),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`通信エラー (${res.status})`);
      const json = await res.json();
      if (!json.ok) {
        const err = new Error(json.error || 'エラーが発生しました');
        err.code = json.code;
        throw err;
      }
      return json.data;
    } finally {
      state.pending--;
      updateSyncIndicator();
    }
  };

  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p.then((data) => {
    // 後続の操作が残っている間は、楽観的更新を上書きしないよう反映を待つ
    if (data && state.pending === 0) applyData(data);
    return data;
  });
}

async function refresh(initial = false, manual = false) {
  if (initial) showLoading(true);
  try {
    await api('getAll');
    storageRemove('reauth');
    if (manual) toast('最新の状態に更新しました');
  } catch (e) {
    handleError(e);
  } finally {
    if (initial) showLoading(false);
  }
}

/** 楽観的更新 → API → 失敗時はサーバーの状態に戻す */
async function mutate(action, payload, optimistic) {
  if (optimistic) {
    optimistic();
    render();
  }
  try {
    await api(action, payload);
    return true;
  } catch (e) {
    handleError(e);
    if (e.code !== 'AUTH') await api('getAll').catch(() => {});
    return false;
  }
}

function applyData(data) {
  state.shopping = data.shopping || [];
  state.stock = data.stock || [];
  state.loaded = true;
  render();
}

function handleError(e) {
  console.error(e);
  if (e.code === 'AUTH') return reauth();
  if (e.code === 'FORBIDDEN' || e.code === 'CONFIG') return showFatal(e.message);
  if (!state.loaded) return showFatal(e.message || '読み込みに失敗しました');
  toast('⚠️ ' + (e.message || 'エラーが発生しました'));
}

function reauth() {
  const count = Number(storageGet('reauth') || 0);
  if (count >= 2) {
    showFatal('ログインに失敗しました。LINEアプリからもう一度開いてください。');
    return;
  }
  storageSet('reauth', String(count + 1));
  if (liff.isInClient()) {
    location.reload(); // LINE 内ブラウザでは再読み込みで ID トークンが更新される
  } else {
    liff.logout();
    liff.login({ redirectUri: location.href });
  }
}

// ============================================================
// 買物リスト操作
// ============================================================
function toggleItem(id, btn) {
  const item = state.shopping.find((i) => i.id === id);
  if (!item || item.pending) return;
  const toDone = item.status !== ITEM_DONE;

  if (toDone && btn) {
    btn.classList.remove('border-slate-300', 'bg-white', 'text-transparent');
    btn.classList.add('border-line', 'bg-line', 'text-white', 'pop');
  }

  setTimeout(() => {
    mutate('setPurchased', { id, purchased: toDone }, () => {
      item.status = toDone ? ITEM_DONE : ITEM_TODO;
      item.purchasedBy = toDone ? myName() : '';
      item.purchasedAt = toDone ? nowStr() : '';
      item.purchasedAtTs = toDone ? Date.now() : 0;
      if (toDone) {
        state.stock
          .filter((s) => s.name === item.name && s.status !== '十分')
          .forEach((s) => { s.status = '十分'; s.updatedAt = nowStr(); });
      }
    });
    if (toDone) toast(`『${item.name}』を購入済みにしました`);
  }, toDone ? 220 : 0);
}

function deleteItem(id) {
  const item = state.shopping.find((i) => i.id === id);
  if (!item || item.pending) return;
  if (!confirm(`『${item.name}』を削除しますか？`)) return;
  mutate('deleteItem', { id }, () => {
    state.shopping = state.shopping.filter((i) => i.id !== id);
  });
}

function clearPurchased() {
  const count = state.shopping.filter((i) => i.status === ITEM_DONE).length;
  if (!count || !confirm(`購入済みの${count}件をすべて削除しますか？`)) return;
  mutate('clearPurchased', {}, () => {
    state.shopping = state.shopping.filter((i) => i.status !== ITEM_DONE);
  });
}

function openItemModal() {
  $('form-item').reset();
  clearPendingImage();
  openModal('modal-item');
  setTimeout(() => $('item-text').focus(), 250);
}

async function onImageSelected(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('item-image-status').classList.remove('hidden');
  try {
    state.pendingImage = await compressImage(file);
    $('item-preview').src = state.pendingImage.dataUrl;
    $('item-preview-wrap').classList.remove('hidden');
  } catch (err) {
    toast('⚠️ ' + err.message);
  } finally {
    $('item-image-status').classList.add('hidden');
  }
}

function clearPendingImage() {
  state.pendingImage = null;
  $('item-preview').removeAttribute('src');
  $('item-preview-wrap').classList.add('hidden');
}

function submitItem(e) {
  e.preventDefault();
  const text = $('item-text').value.trim();
  const img = state.pendingImage;
  if (!text && !img) {
    toast('アイテム名か写真を入力してください');
    return;
  }

  const names = img
    ? [text.replace(/\s*\n\s*/g, ' ').trim() || PHOTO_ITEM_NAME]
    : text.split('\n').map((s) => s.trim()).filter(Boolean);

  closeModal($('modal-item'));
  mutate('addItem', { text, imageBase64: img ? img.base64 : '', imageMime: img ? img.mime : '' }, () => {
    names.forEach((name) => state.shopping.push(tempItem(name, img ? img.dataUrl : '')));
  }).then((ok) => {
    if (ok) toast(names.length > 1 ? `${names.length}件を追加しました` : `『${names[0]}』を追加しました`);
  });
  clearPendingImage();
}

function tempItem(name, imageUrl) {
  return {
    id: 'tmp_' + Math.random().toString(36).slice(2),
    name,
    imageUrl,
    createdBy: myName(),
    status: ITEM_TODO,
    createdAt: nowStr(),
    createdAtTs: Date.now(),
    purchasedBy: '',
    purchasedAt: '',
    purchasedAtTs: 0,
    pending: true,
  };
}

/** 画像を縮小して JPEG の base64 に変換 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = APP_CONFIG.IMAGE_MAX_SIZE;
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/jpeg', APP_CONFIG.IMAGE_QUALITY);
      resolve({ dataUrl, base64: dataUrl.split(',')[1], mime: 'image/jpeg' });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした（非対応の形式の可能性があります）'));
    };
    img.src = url;
  });
}

function viewImage(src) {
  if (!src) return;
  $('viewer-img').src = src;
  openModal('modal-image');
}

// ============================================================
// ストック操作
// ============================================================
function setStockStatus(id, status) {
  const s = state.stock.find((x) => x.id === id);
  if (!s || s.pending || s.status === status) return;
  mutate('updateStockStatus', { id, status }, () => {
    s.status = status;
    s.updatedAt = nowStr();
  });
}

function stockToShopping(id) {
  const s = state.stock.find((x) => x.id === id);
  if (!s || s.pending) return;
  if (isInShoppingList(s.name)) {
    toast(`『${s.name}』はすでに買物リストにあります`);
    return;
  }
  mutate('stockToShopping', { id }, () => {
    state.shopping.push(tempItem(s.name, ''));
  }).then((ok) => {
    if (ok) toast(`🛒『${s.name}』を買物リストに追加しました`);
  });
}

function deleteStock(id) {
  const s = state.stock.find((x) => x.id === id);
  if (!s || s.pending) return;
  if (!confirm(`ストック『${s.name}』を削除しますか？`)) return;
  mutate('deleteStock', { id }, () => {
    state.stock = state.stock.filter((x) => x.id !== id);
  });
}

function openStockModal() {
  $('form-stock').reset();
  const cats = [...new Set(state.stock.map((s) => s.category).filter(Boolean))];
  $('category-list').innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');
  openModal('modal-stock');
  setTimeout(() => $('stock-name').focus(), 250);
}

function submitStock(e) {
  e.preventDefault();
  const name = $('stock-name').value.trim();
  const category = $('stock-category').value.trim() || 'その他';
  const status = $('stock-status').value;
  if (!name) return;
  if (state.stock.some((s) => s.name === name)) {
    toast(`『${name}』はすでに登録されています`);
    return;
  }
  closeModal($('modal-stock'));
  mutate('addStock', { name, category, status }, () => {
    state.stock.push({
      id: 'tmp_' + Math.random().toString(36).slice(2),
      name, category, status,
      updatedAt: nowStr(),
      pending: true,
    });
  }).then((ok) => {
    if (ok) toast(`『${name}』をストックに追加しました`);
  });
}

function setStockFilter(filter) {
  state.stockFilter = filter === 'need' ? 'need' : 'all';
  storageSet('stockFilter', state.stockFilter);
  renderStock();
}

function isInShoppingList(name) {
  return state.shopping.some((i) => i.status !== ITEM_DONE && i.name === name);
}

// ============================================================
// 描画
// ============================================================
function render() {
  renderShopping();
  renderStock();
}

function renderShopping() {
  const todo = state.shopping
    .filter((i) => i.status !== ITEM_DONE)
    .sort((a, b) => (b.createdAtTs || 0) - (a.createdAtTs || 0));
  const done = state.shopping
    .filter((i) => i.status === ITEM_DONE)
    .sort((a, b) => (b.purchasedAtTs || 0) - (a.purchasedAtTs || 0));

  $('shopping-list').innerHTML = todo.map(itemHtml).join('');
  $('shopping-empty').classList.toggle('hidden', todo.length > 0 || !state.loaded);
  $('purchased-section').classList.toggle('hidden', done.length === 0);
  $('purchased-count').textContent = done.length;
  $('purchased-list').innerHTML = done.map(itemHtml).join('');

  const badge = $('badge-shopping');
  badge.textContent = todo.length;
  badge.classList.toggle('hidden', todo.length === 0);
}

function itemHtml(item) {
  const done = item.status === ITEM_DONE;
  const id = esc(item.id);
  const disabled = item.pending ? 'disabled' : '';
  const checkClass = done
    ? 'border-line bg-line text-white'
    : 'border-slate-300 bg-white text-transparent';
  const meta = done
    ? `✓ ${esc(item.purchasedBy || '')}・${esc(shortDate(item.purchasedAt))}`
    : `👤 ${esc(item.createdBy || '')}・${esc(shortDate(item.createdAt))}`;

  const thumb = item.imageUrl
    ? `<button type="button" data-action="view-image" data-src="${esc(item.imageUrl)}" class="shrink-0">
         <img src="${esc(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"
              class="h-14 w-14 rounded-xl bg-slate-100 object-cover ${done ? 'grayscale' : ''}">
       </button>`
    : '';

  return `
    <li class="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-sm ${done ? 'opacity-70' : ''} ${item.pending ? 'animate-pulse' : ''}">
      <button type="button" data-action="toggle" data-id="${id}" ${disabled}
        aria-label="${done ? '未購入に戻す' : '購入済みにする'}"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition active:scale-90 ${checkClass}">
        <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      </button>
      ${thumb}
      <div class="min-w-0 flex-1">
        <p class="break-words font-bold leading-snug ${done ? 'text-slate-400 line-through' : 'text-slate-800'}">${esc(item.name)}</p>
        <p class="mt-0.5 truncate text-xs text-slate-400">${meta}</p>
      </div>
      <button type="button" data-action="delete-item" data-id="${id}" ${disabled} aria-label="削除"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-300 active:bg-slate-100 active:text-rose-500">
        <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      </button>
    </li>`;
}

function renderStock() {
  const needs = (s) => s.status !== '十分';
  const list = state.stockFilter === 'need' ? state.stock.filter(needs) : state.stock;

  // フィルタボタン
  document.querySelectorAll('.filter-btn').forEach((b) => {
    const on = b.dataset.filter === state.stockFilter;
    b.className = 'filter-btn rounded-full border px-4 py-1.5 text-sm font-bold ' +
      (on ? 'border-line bg-line text-white' : 'border-slate-300 bg-white text-slate-500');
  });

  // カテゴリごとにグループ化（シートの並び順を維持）
  const groups = new Map();
  list.forEach((s) => {
    const c = s.category || 'その他';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(s);
  });

  $('stock-groups').innerHTML = [...groups.entries()].map(([cat, items]) => `
    <div>
      <h3 class="mb-2 px-1 text-xs font-bold text-slate-500">${esc(cat)}</h3>
      <ul class="space-y-2">${items.map(stockHtml).join('')}</ul>
    </div>`).join('');

  const empty = list.length === 0 && state.loaded;
  $('stock-empty').classList.toggle('hidden', !empty);
  $('stock-empty-text').textContent = state.stockFilter === 'need'
    ? '補充が必要なストックはありません 👍'
    : 'ストックが登録されていません';

  const needCount = state.stock.filter(needs).length;
  const badge = $('badge-stock');
  badge.textContent = needCount;
  badge.classList.toggle('hidden', needCount === 0);
}

function stockHtml(s) {
  const id = esc(s.id);
  const disabled = s.pending ? 'disabled' : '';
  const statusButtons = STOCK_STATUS.map((st) => {
    const on = s.status === st.value;
    return `<button type="button" data-action="stock-status" data-id="${id}" data-status="${st.value}" ${disabled}
      class="rounded-xl border py-2 text-xs font-bold transition active:scale-95 ${on ? st.active : 'border-slate-200 bg-slate-50 text-slate-400'}">
      ${on ? st.dot + ' ' : ''}${st.label}</button>`;
  }).join('');

  let action = '';
  if (s.status !== '十分') {
    action = isInShoppingList(s.name)
      ? `<p class="mt-2 rounded-xl bg-line-light py-2 text-center text-xs font-bold text-line">✓ 買物リストに追加済み</p>`
      : `<button type="button" data-action="to-shopping" data-id="${id}" ${disabled}
           class="mt-2 w-full rounded-xl bg-line py-2.5 text-sm font-bold text-white shadow-sm active:bg-line-dark">
           🛒 買物リストに追加</button>`;
  }

  const border = s.status === 'なし' ? 'ring-2 ring-rose-200' : s.status === '少なめ' ? 'ring-2 ring-amber-200' : '';

  return `
    <li class="rounded-2xl bg-white p-3 shadow-sm ${border} ${s.pending ? 'animate-pulse' : ''}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="break-words font-bold leading-snug">${esc(s.name)}</p>
          <p class="mt-0.5 text-xs text-slate-400">更新: ${esc(shortDate(s.updatedAt))}</p>
        </div>
        <button type="button" data-action="delete-stock" data-id="${id}" ${disabled} aria-label="削除"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-300 active:bg-slate-100 active:text-rose-500">✕</button>
      </div>
      <div class="mt-2 grid grid-cols-3 gap-1.5">${statusButtons}</div>
      ${action}
    </li>`;
}

// ============================================================
// UI ヘルパー
// ============================================================
function switchTab(tab) {
  state.tab = tab === 'stock' ? 'stock' : 'shopping';
  storageSet('tab', state.tab);
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle('border-white', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('border-transparent', !on);
    b.classList.toggle('text-white/60', !on);
  });
  if (state.loaded || !$('fatal').classList.contains('hidden')) showViews();
  window.scrollTo({ top: 0 });
}

function showViews() {
  const fatal = !$('fatal').classList.contains('hidden');
  $('view-shopping').classList.toggle('hidden', fatal || state.tab !== 'shopping');
  $('view-stock').classList.toggle('hidden', fatal || state.tab !== 'stock');
}

function showLoading(on) {
  $('loading').classList.toggle('hidden', !on);
  if (!on) showViews();
}

function showFatal(msg) {
  $('fatal').textContent = msg;
  $('fatal').classList.remove('hidden');
  $('loading').classList.add('hidden');
  showViews();
}

function openModal(id) {
  const el = $(id);
  el.classList.remove('hidden');
  el.classList.add(el.dataset.display || 'block');
  document.body.style.overflow = 'hidden';
}

function closeModal(el) {
  if (!el) return;
  el.classList.add('hidden');
  el.classList.remove('block', 'flex');
  if (!document.querySelector('.modal:not(.hidden)')) document.body.style.overflow = '';
}

function updateSyncIndicator() {
  $('sync-indicator').classList.toggle('hidden', state.pending === 0);
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('opacity-0', 'translate-y-4');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('opacity-0', 'translate-y-4'), 2200);
}

function myName() {
  return (state.profile && state.profile.displayName) || 'あなた';
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 'yyyy/MM/dd HH:mm' → 'M/d HH:mm'（今年以外は年も表示） */
function shortDate(s) {
  const m = String(s || '').match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2})/);
  if (!m) return s || '';
  const md = `${Number(m[2])}/${Number(m[3])} ${m[4]}`;
  return Number(m[1]) === new Date().getFullYear() ? md : `${m[1]}/${md}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function storageGet(key) {
  try { return localStorage.getItem('shopapp_' + key); } catch (e) { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem('shopapp_' + key, value); } catch (e) { /* noop */ }
}
function storageRemove(key) {
  try { localStorage.removeItem('shopapp_' + key); } catch (e) { /* noop */ }
}
