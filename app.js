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
  suggestions: [],     // よく買う物（入力候補）
  stockSortMode: false,
  editingItemId: null,
  editingStockId: null,
  renamingCategory: null,
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

  // 前回のデータがあれば即表示し、GASの応答（数秒〜数十秒）を待たずに操作できるようにする
  const cached = loadCache();
  if (cached) {
    applyData(cached, false);
    showLoading(false);
  }

  try {
    await liff.init({ liffId: APP_CONFIG.LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return;
    }
    markLiffReady();
    loadProfile();
    await refresh(!cached);
  } catch (e) {
    console.error(e);
    showFatal('初期化に失敗しました: ' + (e.message || e));
  }

  // 他の人の更新を拾うため、画面に戻ってきたら再取得
  document.addEventListener('visibilitychange', () => {
    // アプリを閉じる・切り替えるときは、待機中の購入通知をすぐ送る
    if (document.visibilityState === 'hidden') flushPurchaseNotice();
    if (document.visibilityState === 'visible' && state.loaded && state.pending === 0) refresh(false);
  });
}

/** 表示名は ID トークンから取得（通信なし）。取れない場合のみ getProfile を裏で呼ぶ */
function loadProfile() {
  const show = (name) => {
    state.profile = { displayName: name };
    $('user-name').textContent = `${name} さん`;
  };
  try {
    const t = liff.getDecodedIDToken();
    if (t && t.name) return show(t.name);
  } catch (e) { /* noop */ }
  liff.getProfile().then((p) => show(p.displayName)).catch((e) => console.warn('プロフィール取得失敗', e));
}

// LIFF の初期化が終わるまで API 呼び出しを待たせる（キャッシュ表示中の操作対策）
let markLiffReady;
const liffReady = new Promise((resolve) => { markLiffReady = resolve; });

const CACHE_KEY = 'cache_v1';

function loadCache() {
  try {
    const data = JSON.parse(storageGet(CACHE_KEY) || 'null');
    return data && Array.isArray(data.shopping) && Array.isArray(data.stock) ? data : null;
  } catch (e) {
    return null;
  }
}

function saveCache(data) {
  storageSet(CACHE_KEY, JSON.stringify({
    shopping: data.shopping || [],
    stock: data.stock || [],
    suggestions: data.suggestions || [],
  }));
}

function bindEvents() {
  document.addEventListener('click', onClick);
  $('form-item').addEventListener('submit', submitItem);
  $('form-stock').addEventListener('submit', submitStock);
  $('form-edit-item').addEventListener('submit', submitEditItem);
  $('form-category').addEventListener('submit', submitCategory);
  $('item-text').addEventListener('input', renderSuggestions);
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
    case 'flush-notice':    flushPurchaseNotice(); break;
    case 'edit-item':       openEditItemModal(id); break;
    case 'suggest':         addSuggestion(el.dataset.name); break;
    case 'edit-stock':      openStockModal(id); break;
    case 'toggle-sort':     toggleSortMode(); break;
    case 'move-stock':      moveStock(id, Number(el.dataset.dir)); break;
    case 'rename-category': openCategoryModal(el.dataset.category); break;
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
      await liffReady;
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
      if (json.message) toast(json.message);
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

function applyData(data, persist = true) {
  state.shopping = data.shopping || [];
  state.stock = data.stock || [];
  state.suggestions = data.suggestions || [];
  state.loaded = true;
  if (persist) saveCache(data);
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

  const itemName = item.name;
  const restocked = toDone && state.stock.some((s) => sameName(s.name, itemName) && s.status !== '十分');

  setTimeout(() => {
    mutate('setPurchased', { id, purchased: toDone }, () => {
      item.status = toDone ? ITEM_DONE : ITEM_TODO;
      item.purchasedBy = toDone ? myName() : '';
      item.purchasedAt = toDone ? nowStr() : '';
      item.purchasedAtTs = toDone ? Date.now() : 0;
      if (toDone) {
        state.stock
          .filter((s) => sameName(s.name, itemName) && s.status !== '十分')
          .forEach((s) => { s.status = '十分'; s.updatedAt = nowStr(); });
      }
    }).then((ok) => {
      if (!ok) return;
      if (toDone) queuePurchaseNotice(id, itemName, restocked);
      else unqueuePurchaseNotice(id);
    });
    if (toDone) toast(`『${itemName}』を購入済みにしました`);
  }, toDone ? 220 : 0);
}

/**
 * 購入通知のまとめ送信
 * グループ（複数人トーク）から開いたときだけ、本人の発言として購入通知を投稿する。
 * liff.sendMessages() はLINEの通数にカウントされないため無料。
 * 続けてチェックした分は、最後のチェックから NOTIFY_DELAY_MS 待って1通にまとめる。
 * ※ 文面「🛒『…』を購入しました」は Code.gs 側で買物アイテムとして登録しないよう除外している
 */
const NOTIFY_DELAY_MS = 5000;
const noticeQueue = [];   // { id, name, restocked }
let noticeTimer = null;

function queuePurchaseNotice(id, name, restocked) {
  if (!canNotifyChat()) return;
  if (!noticeQueue.some((n) => n.id === id)) noticeQueue.push({ id, name, restocked });
  scheduleNotice();
}

function unqueuePurchaseNotice(id) {
  const i = noticeQueue.findIndex((n) => n.id === id);
  if (i < 0) return;
  noticeQueue.splice(i, 1);
  scheduleNotice();
}

function scheduleNotice() {
  clearTimeout(noticeTimer);
  updateNoticeBar();
  if (noticeQueue.length) noticeTimer = setTimeout(flushPurchaseNotice, NOTIFY_DELAY_MS);
}

async function flushPurchaseNotice() {
  clearTimeout(noticeTimer);
  if (!noticeQueue.length) return;
  const items = noticeQueue.splice(0);
  updateNoticeBar();

  const text = '🛒' + items.map((n) => `『${n.name}』`).join('') + 'を購入しました！' +
    (items.some((n) => n.restocked) ? '\n📦 ストックを「余裕あり」に更新しました' : '');
  try {
    await liff.sendMessages([{ type: 'text', text: text.slice(0, 4900) }]);
    toast(items.length > 1 ? `${items.length}件の購入をグループに通知しました` : 'グループに通知しました');
  } catch (e) {
    console.warn('sendMessages 失敗', e);
    toast('⚠️ グループへの通知を送れませんでした');
  }
}

function updateNoticeBar() {
  const bar = $('notice-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', noticeQueue.length === 0);
  bar.classList.toggle('flex', noticeQueue.length > 0);
  $('notice-count').textContent = noticeQueue.length;
}

function canNotifyChat() {
  try {
    if (!liff.isInClient() || !liff.isApiAvailable('sendMessages')) return false;
    const ctx = liff.getContext();
    return !!ctx && (ctx.type === 'group' || ctx.type === 'room');
  } catch (e) {
    return false;
  }
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
  renderSuggestions();
  openModal('modal-item');
}

/** よく買う物の候補（入力中の最終行で絞り込み、リストにある物は除外） */
function renderSuggestions() {
  const lines = $('item-text').value.split('\n');
  const q = normalizeName(lines[lines.length - 1]);
  const list = state.suggestions
    .filter((n) => !isInShoppingList(n) && (!q || normalizeName(n).includes(q)))
    .slice(0, 20);
  $('suggestions-wrap').classList.toggle('hidden', list.length === 0);
  $('suggestions').innerHTML = list.map((n) => `
    <button type="button" data-action="suggest" data-name="${esc(n)}"
      class="rounded-full border border-line/40 bg-line-light px-3 py-1.5 text-sm font-bold text-line active:scale-95">＋ ${esc(n)}</button>`).join('');
}

function addSuggestion(name) {
  if (!name) return;
  if (isInShoppingList(name)) {
    toast(`『${name}』はすでに買物リストにあります`);
    return;
  }
  mutate('addItem', { text: name }, () => {
    state.shopping.push(tempItem(name, ''));
  }).then((ok) => {
    if (ok) toast(`『${name}』を追加しました`);
  });
  renderSuggestions();
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

  const memo = $('item-memo').value.trim();
  let names;
  let skipped = [];
  if (img) {
    names = [text.replace(/\s*\n\s*/g, ' ').trim() || PHOTO_ITEM_NAME];
  } else {
    // 重複（リストにある物・入力内の重複）を除外
    names = [];
    text.split('\n').map((s) => s.trim()).filter(Boolean).forEach((n) => {
      if (isInShoppingList(n) || names.some((x) => sameName(x, n))) skipped.push(n);
      else names.push(n);
    });
  }
  const skippedMsg = skipped.length ? skipped.map((n) => `『${n}』`).join('') + 'はすでに買物リストにあります' : '';
  if (!names.length) {
    toast(skippedMsg);
    return;
  }

  closeModal($('modal-item'));
  mutate('addItem', {
    text: names.join('\n'),
    memo,
    imageBase64: img ? img.base64 : '',
    imageMime: img ? img.mime : '',
  }, () => {
    names.forEach((name) => state.shopping.push(tempItem(name, img ? img.dataUrl : '', memo)));
  }).then((ok) => {
    if (!ok) return;
    const msg = names.length > 1 ? `${names.length}件を追加しました` : `『${names[0]}』を追加しました`;
    toast(skippedMsg ? `${msg}（${skippedMsg}）` : msg);
  });
  clearPendingImage();
}

function openEditItemModal(id) {
  const item = state.shopping.find((i) => i.id === id);
  if (!item || item.pending) return;
  state.editingItemId = id;
  $('edit-item-name').value = item.name === PHOTO_ITEM_NAME ? '' : item.name;
  $('edit-item-memo').value = item.memo || '';
  $('edit-item-image-wrap').classList.toggle('hidden', !item.imageUrl);
  if (item.imageUrl) $('edit-item-image').src = item.imageUrl;
  openModal('modal-edit-item');
  if (item.name === PHOTO_ITEM_NAME) setTimeout(() => $('edit-item-name').focus(), 250);
}

function submitEditItem(e) {
  e.preventDefault();
  const item = state.shopping.find((i) => i.id === state.editingItemId);
  if (!item) return closeModal($('modal-edit-item'));
  const name = $('edit-item-name').value.trim();
  const memo = $('edit-item-memo').value.trim();
  if (!name) {
    toast('アイテム名を入力してください');
    return;
  }
  if (!sameName(name, item.name) && item.status !== ITEM_DONE && isInShoppingList(name)) {
    toast(`『${name}』はすでに買物リストにあります`);
    return;
  }
  closeModal($('modal-edit-item'));
  if (name === item.name && memo === (item.memo || '')) return;
  mutate('updateItem', { id: item.id, name, memo }, () => {
    item.name = name;
    item.memo = memo;
  });
}

function tempItem(name, imageUrl, memo = '') {
  return {
    id: 'tmp_' + Math.random().toString(36).slice(2),
    name,
    memo,
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
  closeModal($('modal-stock'));
  mutate('deleteStock', { id }, () => {
    state.stock = state.stock.filter((x) => x.id !== id);
  });
}

function toggleSortMode() {
  state.stockSortMode = !state.stockSortMode;
  renderStock();
}

/** 同じカテゴリ内で上（-1）/下（1）の項目と入れ替え */
function moveStock(id, dir) {
  const i = state.stock.findIndex((x) => x.id === id);
  if (i < 0 || state.stock[i].pending) return;
  const cat = state.stock[i].category || 'その他';
  let j = i + dir;
  while (j >= 0 && j < state.stock.length && (state.stock[j].category || 'その他') !== cat) j += dir;
  if (j < 0 || j >= state.stock.length) return;
  mutate('moveStock', { id, dir }, () => {
    [state.stock[i], state.stock[j]] = [state.stock[j], state.stock[i]];
  });
}

function openCategoryModal(category) {
  state.renamingCategory = category;
  $('category-name').value = category;
  openModal('modal-category');
}

function submitCategory(e) {
  e.preventDefault();
  const from = state.renamingCategory;
  const to = $('category-name').value.trim();
  closeModal($('modal-category'));
  if (!to || to === from) return;
  mutate('renameCategory', { from, to }, () => {
    state.stock.forEach((s) => { if ((s.category || 'その他') === from) s.category = to; });
  });
}

/** id を渡すと編集、省略すると新規追加 */
function openStockModal(id) {
  const editing = id ? state.stock.find((x) => x.id === id) : null;
  if (id && (!editing || editing.pending)) return;
  state.editingStockId = editing ? editing.id : null;

  $('form-stock').reset();
  const cats = [...new Set(state.stock.map((s) => s.category).filter(Boolean))];
  $('category-list').innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');
  $('stock-modal-title').textContent = editing ? 'ストックを編集' : 'ストックに追加';
  $('stock-submit').textContent = editing ? '保存する' : '追加する';
  $('stock-delete').classList.toggle('hidden', !editing);
  $('stock-delete').dataset.id = editing ? editing.id : '';
  if (editing) {
    $('stock-name').value = editing.name;
    $('stock-category').value = editing.category;
    $('stock-status').value = editing.status;
  }
  openModal('modal-stock');
}

function submitStock(e) {
  e.preventDefault();
  const name = $('stock-name').value.trim();
  const category = $('stock-category').value.trim() || 'その他';
  const status = $('stock-status').value;
  if (!name) return;
  const editId = state.editingStockId;
  if (state.stock.some((s) => s.id !== editId && sameName(s.name, name))) {
    toast(`『${name}』はすでに登録されています`);
    return;
  }
  closeModal($('modal-stock'));

  if (editId) {
    const s = state.stock.find((x) => x.id === editId);
    if (!s) return;
    mutate('updateStock', { id: editId, name, category, status }, () => {
      Object.assign(s, { name, category, status, updatedAt: nowStr() });
    });
    return;
  }
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
  return state.shopping.some((i) => i.status !== ITEM_DONE && sameName(i.name, name));
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
      <button type="button" data-action="edit-item" data-id="${id}" ${disabled} class="min-w-0 flex-1 text-left">
        <p class="break-words font-bold leading-snug ${done ? 'text-slate-400 line-through' : 'text-slate-800'}">${esc(item.name)}${
          item.name === PHOTO_ITEM_NAME && !done ? ' <span class="text-xs font-normal text-line">✏️ 名前を付ける</span>' : ''}</p>
        ${item.memo ? `<p class="mt-0.5 break-words text-sm text-slate-500">📝 ${esc(item.memo)}</p>` : ''}
        <p class="mt-0.5 truncate text-xs text-slate-400">${meta}</p>
      </button>
      <button type="button" data-action="delete-item" data-id="${id}" ${disabled} aria-label="削除"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-300 active:bg-slate-100 active:text-rose-500">
        <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      </button>
    </li>`;
}

function renderStock() {
  const needs = (s) => s.status !== '十分';
  const sortMode = state.stockSortMode;
  const list = !sortMode && state.stockFilter === 'need' ? state.stock.filter(needs) : state.stock;

  // フィルタ・並べ替えボタン
  document.querySelectorAll('.filter-btn').forEach((b) => {
    const on = !sortMode && b.dataset.filter === state.stockFilter;
    b.className = 'filter-btn rounded-full border px-4 py-1.5 text-sm font-bold ' +
      (on ? 'border-line bg-line text-white' : 'border-slate-300 bg-white text-slate-500') +
      (sortMode ? ' opacity-40 pointer-events-none' : '');
  });
  $('btn-sort').className = 'ml-auto rounded-full border px-4 py-1.5 text-sm font-bold ' +
    (sortMode ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-500');
  $('btn-sort').textContent = sortMode ? '✓ 完了' : '↕ 並べ替え';
  $('sort-hint').classList.toggle('hidden', !sortMode);

  // カテゴリごとにグループ化（シートの並び順を維持）
  const groups = new Map();
  list.forEach((s) => {
    const c = s.category || 'その他';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(s);
  });

  $('stock-groups').innerHTML = [...groups.entries()].map(([cat, items]) => `
    <div>
      <div class="mb-2 flex items-center gap-2 px-1">
        <h3 class="text-xs font-bold text-slate-500">${esc(cat)}</h3>
        ${sortMode ? `<button type="button" data-action="rename-category" data-category="${esc(cat)}"
          class="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-500 active:bg-slate-100">✏️ 名前変更</button>` : ''}
      </div>
      <ul class="space-y-2">${items.map(sortMode ? stockSortHtml : stockHtml).join('')}</ul>
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
        <button type="button" data-action="edit-stock" data-id="${id}" ${disabled} class="min-w-0 text-left">
          <p class="break-words font-bold leading-snug">${esc(s.name)}</p>
          <p class="mt-0.5 text-xs text-slate-400">更新: ${esc(shortDate(s.updatedAt))}</p>
        </button>
        <button type="button" data-action="edit-stock" data-id="${id}" ${disabled} aria-label="編集"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-300 active:bg-slate-100 active:text-slate-600">✏️</button>
      </div>
      <div class="mt-2 grid grid-cols-3 gap-1.5">${statusButtons}</div>
      ${action}
    </li>`;
}

/** 並べ替えモード用の行（▲▼で同じカテゴリ内を移動） */
function stockSortHtml(s) {
  const id = esc(s.id);
  const disabled = s.pending ? 'disabled' : '';
  const arrow = 'flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-600 active:scale-95 active:bg-slate-200';
  return `
    <li class="flex items-center gap-2 rounded-2xl bg-white p-2 pl-4 shadow-sm ${s.pending ? 'animate-pulse' : ''}">
      <p class="min-w-0 flex-1 break-words font-bold">${esc(s.name)}</p>
      <button type="button" data-action="move-stock" data-id="${id}" data-dir="-1" ${disabled} aria-label="上へ" class="${arrow}">▲</button>
      <button type="button" data-action="move-stock" data-id="${id}" data-dir="1" ${disabled} aria-label="下へ" class="${arrow}">▼</button>
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

/** 重複判定用の正規化（全角/半角・大文字/小文字・空白の違いを無視。Code.gs の normalize_ と同じ） */
function normalizeName(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function sameName(a, b) {
  return normalizeName(a) === normalizeName(b);
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
