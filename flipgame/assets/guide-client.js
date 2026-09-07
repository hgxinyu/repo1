import {authFetch, isStaticMockPreview} from './auth-session.js';
export const preview = isStaticMockPreview();
export const en = localStorage.getItem('flipgame_lang') === 'en';
export const t = (zh, english) => en ? english : zh;
export const titleOf = guide => en && guide.titleEn ? guide.titleEn : guide.title;
export const categoryName = value => ({weekly:t('周活动攻略','Weekly guides'),public:t('普通攻略','Public guides'),vip:t('VIP 攻略','VIP guides')})[value];
let database;
async function db() {
  if (!database) database = new Promise((resolve,reject) => {
    const req = indexedDB.open('shinegame-guide-preview',1);
    req.onupgradeneeded = () => req.result.createObjectStore('data');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  return database;
}
async function local(key, value) {
  const database = await db();
  return new Promise((resolve,reject) => {
    const tx = database.transaction('data',value === undefined ? 'readonly':'readwrite');
    const req = value === undefined ? tx.objectStore('data').get(key) : tx.objectStore('data').put(value,key);
    tx.oncomplete = () => resolve(req.result);tx.onerror = () => reject(tx.error);
  });
}
async function seed() {
  if (await local('guides')) return;
  let guides = [];
  try { const response = await fetch('/__guide-preview/manifest.json'); if (response.ok) guides = [await response.json()]; } catch {}
  await local('guides',guides);
}
export async function api(query = '', options = {}) {
  if (!preview) {
    const response = await authFetch(`/api/guides${query}`,options);
    if (!response.ok) {
      const error = new Error(response.status === 401 ? t('请先登录后查看。','Please sign in to continue.') : response.status === 403 ? t('需要 VIP 权限；发布攻略需要管理员权限。','VIP access is required; publishing requires admin access.') : response.status === 409 ? t('攻略已被更新，请重新打开编辑后再保存。','Guide changed. Reopen the editor before saving.') : t('操作失败，请重试。','Request failed. Please retry.'));
      error.status = response.status; throw error;
    }
    return response.json();
  }
  await seed();
  const params = new URLSearchParams(query.replace(/^\?/,''));
  const id = params.get('id');
  const guides = await local('guides');
  const guide = guides.find(g => g.id === id);
  if (options.method === 'POST') {
    if (params.get('upload')) { const asset = crypto.randomUUID();await local(`asset:${id}:${asset}`,options.body);return {asset}; }
    const body = JSON.parse(options.body);
    if (body.action === 'create') {
      const created = {id:crypto.randomUUID(),title:body.title,titleEn:body.titleEn,category:body.category,status:'draft',pages:[],pagesEn:[],revision:0,updatedAt:new Date().toISOString()};
      guides.unshift(created);await local('guides',guides);return {guide:created};
    }
    if (!guide) throw new Error('Guide not found');
    if (body.action === 'edit' && body.revision !== (guide.revision || 0)) throw new Error(t('攻略已被更新，请重新打开编辑。','Guide changed. Reopen the editor.'));
    if (body.action === 'publish' || body.action === 'edit') {
      if (body.action === 'edit') Object.assign(guide,{title:body.title,titleEn:body.titleEn,category:body.category});
      guide.pages = body.pages;guide.pagesEn=body.pagesEn ?? guide.pagesEn ?? [];guide.publishedAt=guide.status==='published'?(guide.publishedAt||guide.updatedAt):new Date().toISOString();guide.status='published';
    } else guide.status='draft';
    guide.revision=(guide.revision || 0)+1;
    guide.updatedAt=new Date().toISOString();await local('guides',guides);return {guide};
  }
  return id ? {guide} : {guides:guides.filter(g => params.has('admin') || g.status === 'published').map(g => ({...g,pageCount:g.pages.length,pageCountEn:(g.pagesEn||[]).length}))};
}
export async function pageBlob(guide, page, admin = false) {
  if (preview) {
    const stored = await local(`asset:${guide.id}:${page}`);
    if (stored) return stored;
    const result = await fetch(`/__guide-preview/${encodeURIComponent(page)}.jpg`);
    if (!result.ok) throw new Error(t('本地原图不可用，请运行攻略预览服务。','Local page unavailable. Start the guide preview server.'));
    return result.blob();
  }
  const result = await authFetch(`/api/guides?id=${encodeURIComponent(guide.id)}&asset=${encodeURIComponent(page)}${admin ? '&admin=1' : ''}`);
  if (!result.ok) throw new Error(t('无法读取页面，请检查登录与 VIP 权限后重试。','Page unavailable. Check your session and VIP access, then retry.'));
  return result.blob();
}
export const post = (query, body) => api(query,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
export function translate() {document.documentElement.lang=en?'en':'zh-CN';document.querySelectorAll('[data-zh]').forEach(el => el.textContent=t(el.dataset.zh,el.dataset.en));}

export function readingPages(guide) {
 const preferred = en ? guide.pagesEn : guide.pages;
 return preferred?.length ? preferred : (en ? guide.pages : guide.pagesEn) || [];
}
export function languageNotice(guide) {
 return en && !guide.pagesEn?.length ? 'Chinese edition only' : !en && !guide.pages?.length ? '仅英文版' : '';
}
