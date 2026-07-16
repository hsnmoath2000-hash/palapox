const DEFAULT_PAGE_SIZE = 40;
const APP_NS = 'lms-v10pro';
function qs(sel, parent=document){ return parent.querySelector(sel); }
function qsa(sel, parent=document){ return [...parent.querySelectorAll(sel)]; }
function el(tag, html='', cls=''){ const node=document.createElement(tag); if(cls) node.className=cls; if(html!==null) node.innerHTML=html; return node; }
function toast(message, type='success'){
  let box = qs('#app-toast');

  if (!box) {
    box = el('div', '', 'app-toast');
    box.id = 'app-toast';
    document.body.appendChild(box);
  }

  box.textContent = message;
  box.dataset.type = type;
  box.classList.add('show');

  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.classList.remove('show'), 2200);
}
function escapeHtml(s=''){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function debounce(fn, delay=250){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), delay); }; }
function formatDate(value){ if(!value) return ''; try{ return new Date(value).toLocaleDateString('ar'); }catch{return '';} }
function formatTime(sec){ sec = Math.max(0, Math.floor(Number(sec||0))); const h = Math.floor(sec/3600); const m = Math.floor((sec%3600)/60); const s = sec%60; return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`; }
function yearFromDate(value){ try { return String(new Date(value).getFullYear()); } catch { return ''; } }
function initials(name=''){ return String(name).trim().slice(0,1) || 'U'; }

async function getJson(url, options){
  const res = await fetch(url, options);
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    let payload = null;
    if (ct.includes('application/json')) payload = await res.json().catch(()=>null);
    throw payload || new Error(res.statusText);
  }
  return ct.includes('application/json') ? res.json() : res.text();
}
function userStorageKey(auth, section){
  const user = auth?.user?.id || 'guest';
  return `${APP_NS}:${user}:${section}`;
}
function loadState(auth, section, defaults={}){
  try {
    const raw = localStorage.getItem(userStorageKey(auth, section));
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch { return { ...defaults }; }
}
function saveState(auth, section, data){ localStorage.setItem(userStorageKey(auth, section), JSON.stringify(data)); }
async function loadRemotePreferences(){
  try { return await getJson('/api/users/preferences'); } catch { return {}; }
}
const pushRemotePreferences = debounce(async (patch) => {
  try { await getJson('/api/users/preferences', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch || {}) }); } catch {}
}, 400);

function activePageNav(pageKey){
  qsa('.side-link').forEach(a => a.classList.toggle('active', a.dataset.nav === pageKey));
}
function bindTopbarAuth(){
  async function logout(){ await getJson('/api/auth/logout',{method:'POST'}).catch(()=>null); location.href='/login'; }
  const btn = qs('#logout-btn'); if(btn) btn.onclick = logout;
  const mobile = qs('#logout-mobile'); if(mobile) mobile.onclick = logout;
}
function bindMobileSidebar(){
  const sidebar = qs('.sidebar');
  const toggle = qs('#mobile-menu-toggle');
  const backdrop = qs('#mobile-sidebar-backdrop');

  if (!sidebar || !toggle || !backdrop) return;

  const setOpen = (open) => {
    sidebar.classList.toggle('open', open);
    backdrop.classList.toggle('show', open);
    document.body.classList.toggle('sidebar-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');

    if (open) {
      const firstLink = sidebar.querySelector('.side-link, button, a');
      if (firstLink) firstLink.focus({ preventScroll: true });
    }
  };

  toggle.setAttribute('aria-controls', 'app-sidebar');
  toggle.setAttribute('aria-expanded', 'false');

  if (!sidebar.id) sidebar.id = 'app-sidebar';

  toggle.onclick = () => setOpen(!sidebar.classList.contains('open'));
  backdrop.onclick = () => setOpen(false);

  qsa('.side-link', sidebar).forEach(link => {
    link.addEventListener('click', () => setOpen(false));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
}
function mediaHref(type, id, extraParams=null){
  const params = new URLSearchParams({ type: String(type || ''), id: String(id || '') });
  Object.entries(extraParams || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value));
  });
  return `/watch?${params.toString()}`;
}
function watchContextParams(item={}, contextType=''){
  const rawContext = String(contextType || item?.libraryType || '').toLowerCase();
  if (rawContext !== 'mixed') return {};
  return {
    from: 'mixed',
    libraryId: item?.libraryId || ''
  };
}
function buildItemWatchHref(item={}, fallbackType='movie', contextType=''){
  const rawType = String(item?.mediaType || item?.type || fallbackType || '').toLowerCase();
  const watchType = rawType === 'movies' ? 'movie' : rawType;
  return mediaHref(watchType, item?.id, watchContextParams(item, contextType));
}
document.addEventListener('click', e => { const link = e.target.closest('a[href]'); if (link) { try { sessionStorage.setItem(`${APP_NS}:last-scroll-path`, location.pathname); } catch {} } }, { capture:true });
function cardPoster(item, fallback='🎬'){
  return item.poster
    ? `<img class="poster" src="${item.poster}" alt="${escapeHtml(item.title || '')}" loading="lazy">`
    : `<div class="poster placeholder">${fallback}</div>`;
}
function movieCard(item, compact=false, favoriteHtml=''){
  return `<a class="card ${compact?'compact':''}" href="${item?.watchHref || mediaHref('movie', item.id)}">
    <div class="poster-wrap">
      ${favoriteHtml}
      ${cardPoster(item,'🎬')}
      <div class="poster-overlay">
        <span class="poster-badge">${yearFromDate(item.addedAt) || 'فيلم'}</span>
        ${item.mediaFolder ? `<span class="poster-badge">${escapeHtml(item.mediaFolder)}</span>` : ''}
      </div>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-meta">
        ${item.libraryName ? `<span>${escapeHtml(item.libraryName)}</span>` : ''}
        ${item.folderPath ? `<span>${escapeHtml(item.folderPath)}</span>` : ''}
      </div>
    </div>
  </a>`;
}
function seriesCard(item, compact=false, favoriteHtml=''){
  const seasons = Object.keys(item.seasons || {}).length;
  return `<a class="card ${compact?'compact':''}" href="${item?.watchHref || mediaHref('series', item.id)}">
    <div class="poster-wrap">
      ${favoriteHtml}
      ${cardPoster(item,'📺')}
      <div class="poster-overlay">
        <span class="poster-badge">${seasons} موسم</span>
        ${item.mediaFolder ? `<span class="poster-badge">${escapeHtml(item.mediaFolder)}</span>` : ''}
      </div>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-meta">
        ${item.libraryName ? `<span>${escapeHtml(item.libraryName)}</span>` : ''}
        ${item.folderPath ? `<span>${escapeHtml(item.folderPath)}</span>` : ''}
      </div>
    </div>
  </a>`;
}
function channelCard(item, compact=false, favoriteHtml=''){
  return `<a class="card ${compact?'compact':''}" href="${item?.watchHref || mediaHref('channel', item.id)}">
    <div class="poster-wrap">
      ${favoriteHtml}
      ${item.logo ? `<img class="poster" src="${item.logo}" alt="${escapeHtml(item.title || '')}" loading="lazy">` : `<div class="poster placeholder">📡</div>`}
      <div class="poster-overlay">
        <span class="poster-badge">${escapeHtml(item.sourceName || 'بث مباشر')}</span>
      </div>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-meta">${item.nowPlaying?.title ? `<span>${escapeHtml(item.nowPlaying.title)}</span>` : `<span>قناة مباشرة</span>`}</div>
    </div>
  </a>`;
}
function continueCard(item){
  return `<a class="card compact" href="${item.href || mediaHref(item.type, item.id)}">
    <div class="poster-wrap">
      ${item.poster ? `<img class="poster" src="${item.poster}" alt="" loading="lazy">` : `<div class="poster placeholder">▶</div>`}
      <div class="poster-overlay"><span class="poster-badge">${formatProgress(item.position, item.duration)}</span></div>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(item.title || '')}</div>
      <div class="card-meta">${item.subtitle ? `<span>${escapeHtml(item.subtitle)}</span>` : ''}</div>
    </div>
  </a>`;
}
function favoriteCard(item){
  return `<a class="card compact" href="${item.href || '#'}">
    <div class="poster-wrap">
      ${item.poster ? `<img class="poster" src="${item.poster}" alt="" loading="lazy">` : `<div class="poster placeholder">${String(item.type || '').startsWith('folder:') ? '📁' : '❤'}</div>`}
      <div class="poster-overlay"><span class="poster-badge">مفضلة</span></div>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(item.title || '')}</div>
      <div class="card-meta">${item.subtitle ? `<span>${escapeHtml(item.subtitle)}</span>` : ''}</div>
    </div>
  </a>`;
}
function formatProgress(position=0, duration=0){
  if (!duration) return `استكمال ${formatTime(position)}`;
  const p = Math.min(100, Math.max(0, Math.round((position / duration) * 100)));
  return `استكمال ${p}%`;
}
function makeFolderFavoriteId(type, libraryId='', folderPath=''){
  return `${type || 'media'}:${libraryId || 'all'}:${folderPath || ''}`;
}
function listingHref(type, paramsObj={}){
  const base = typePath(type);
  const params = new URLSearchParams();
  Object.entries(paramsObj || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
async function createFavoritesController(auth){
  const state = { map:new Map() };
  async function refresh(){
    if (!auth?.authenticated) return state.map;
    const list = await getJson('/api/users/favorites').catch(()=>[]);
    state.map = new Map((list || []).map(item => [`${item.type}:${item.id}`, item]));
    return state.map;
  }
  function key(type, id){ return `${type}:${id}`; }
  function has(type, id){ return state.map.has(key(type, id)); }
  async function toggle(payload){
    if (!auth?.authenticated) return { favorite:false };
    const result = await getJson('/api/users/favorites/toggle', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    if (result.favorite) state.map.set(key(payload.type, payload.id), { ...payload, updatedAt:new Date().toISOString() });
    else state.map.delete(key(payload.type, payload.id));
    return result;
  }
  await refresh();
  return { refresh, has, toggle, map:state.map };
}
function mediaFavoritePayload(item, fallbackType){
  const rawType = item?.mediaType || fallbackType || item?.type || '';
  const type = rawType === 'movies' ? 'movie' : rawType;
  return {
    type,
    id: item?.id,
    title: item?.title || item?.showTitle || '',
    poster: item?.poster || item?.logo || null,
    subtitle: item?.libraryName || item?.sourceName || item?.folderPath || typeLabel(rawType),
    href: item?.watchHref || mediaHref(type, item?.id)
  };
}
function folderFavoritePayload({ type, libraryId='', libraryName='', folderPath='', name='', itemCount=0, childCount=0, poster=null }){
  const folderType = `folder:${type}`;
  const id = makeFolderFavoriteId(type, libraryId, folderPath);
  const href = listingHref(type, { libraryId, folder:folderPath, browseMode:'folders' });
  return {
    type: folderType,
    id,
    title: name || folderPath || 'مجلد',
    poster: poster || null,
    subtitle: `${typeLabel(type)} • ${libraryName || 'كل المكتبات'} • ${itemCount || 0} عنصر${childCount ? ` • ${childCount} مجلد فرعي` : ''}`,
    href
  };
}
function folderFavoriteButton(payload, active=false){
  return `<button class="favorite-toggle ${active ? 'active' : ''}" type="button"
    data-favorite-folder="1"
    data-favorite-type="${escapeHtml(payload.type)}"
    data-favorite-id="${escapeHtml(payload.id)}"
    data-favorite-title="${escapeHtml(payload.title)}"
    data-favorite-subtitle="${escapeHtml(payload.subtitle || '')}"
    data-favorite-href="${escapeHtml(payload.href || '')}"
    data-favorite-poster="${escapeHtml(payload.poster || '')}"
    aria-label="${active ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}">${active ? '♥' : '♡'}</button>`;
}
function itemFavoriteButton(payload, active=false){
  return `<button class="favorite-toggle ${active ? 'active' : ''}" type="button"
    data-favorite-item="1"
    data-favorite-type="${escapeHtml(payload.type)}"
    data-favorite-id="${escapeHtml(payload.id)}"
    data-favorite-title="${escapeHtml(payload.title)}"
    data-favorite-subtitle="${escapeHtml(payload.subtitle || '')}"
    data-favorite-href="${escapeHtml(payload.href || '')}"
    data-favorite-poster="${escapeHtml(payload.poster || '')}"
    aria-label="${active ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}">${active ? '♥' : '♡'}</button>`;
}
function folderItemCard(node, favoritePayload=null, favoriteActive=false){
  const poster = node.poster
    ? `<img class="poster" src="${node.poster}" alt="${escapeHtml(node.name || '')}" loading="lazy">`
    : `<div class="poster placeholder">📁</div>`;
  return `<div class="folder-card-wrap"><button class="card folder-card" data-folder-open="${escapeHtml(node.path)}">
    <div class="poster-wrap">
      ${poster}
      <div class="poster-overlay">
        <span class="poster-badge">${node.childCount ? `${node.childCount} مجلد فرعي` : 'مجلد نهائي'}</span>
      </div>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(node.name || '')}</div>
      <div class="card-meta">
        <span>${node.itemCount || 0} عنصر</span>
        ${node.updatedAt ? `<span>${escapeHtml(formatDate(node.updatedAt))}</span>` : ''}
      </div>
    </div>
  </button>${favoritePayload ? folderFavoriteButton(favoritePayload, favoriteActive) : ''}</div>`;
}

function renderRowSection({title, items=[], renderCard, actionHref='', actionLabel='عرض الكل'}){
  const visibleItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!visibleItems.length) return '';
  return `<section class="section row-section">
    <div class="section-header">
      <div><h2 class="section-title">${escapeHtml(title)}</h2></div>
      ${actionHref ? `<a class="button secondary small" href="${actionHref}">${escapeHtml(actionLabel)}</a>` : ''}
    </div>
    <div class="row-scroller">${visibleItems.map(item => renderCard(item, true)).join('')}</div>
  </section>`;
}
function scanScheduleControlsMarkup(scan={}){
  const times = Array.isArray(scan?.scheduleTimes) && scan.scheduleTimes.length ? scan.scheduleTimes : ['06:00', '18:00'];
  const firstTime = times[0] || '06:00';
  const secondTime = times[1] || '18:00';
  return `<div><label>تتبع الروابط الرمزية</label><select class="select" id="scan-follow-symlinks"><option value="true" ${scan?.followSymlinks?'selected':''}>مفعّل</option><option value="false" ${!scan?.followSymlinks?'selected':''}>معطّل</option></select></div><div><label>الفحص المجدول مرتين يومياً</label><select class="select" id="scan-auto-daily"><option value="true" ${scan?.autoDailyTwice!==false?'selected':''}>مفعّل</option><option value="false" ${scan?.autoDailyTwice===false?'selected':''}>معطّل</option></select></div><div><label>وقت الفحص الأول</label><input class="input" id="scan-time-1" type="time" value="${escapeHtml(firstTime)}"></div><div><label>وقت الفحص الثاني</label><input class="input" id="scan-time-2" type="time" value="${escapeHtml(secondTime)}"></div>`;
}
function buildLibraryButtons(items, selected, allText){
  return [`<button class="filter-btn ${!selected ? 'active' : ''}" data-library="">${escapeHtml(allText)}</button>`]
    .concat(items.map(i => `<button class="filter-btn ${selected===i.id ? 'active' : ''}" data-library="${escapeHtml(i.id)}"><span>${escapeHtml(i.name)}</span></button>`)).join('');
}
function buildFolderBrowser(payload, current=''){
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const currentPath = String(current || '').trim();
  const parts = currentPath ? currentPath.split('/').filter(Boolean) : [];
  const crumbs = [{ label:'كل المجلدات', path:'' }];
  let acc = '';
  parts.forEach(part => { acc = acc ? `${acc}/${part}` : part; crumbs.push({ label:part, path:acc }); });
  const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const hasMore = !!payload?.hasMore;
  const total = Number(payload?.total || nodes.length || 0);
  return `
    <div class="folder-browser">
      <div class="folder-breadcrumbs">
        ${crumbs.map((crumb, idx) => `<button class="crumb ${idx === crumbs.length - 1 ? 'active' : ''}" data-folder-nav="${escapeHtml(crumb.path)}">${escapeHtml(crumb.label)}</button>`).join('<span class="crumb-sep">/</span>')}
      </div>
      <div class="folder-browser-head">
        <div>
          <div class="sidebar-label" style="margin:0 0 4px;padding:0">المجلد الحالي</div>
          <div class="folder-current">${escapeHtml(currentPath || 'كل المجلدات')}</div>
        </div>
        ${currentPath ? `<button class="button secondary small" data-folder-nav="${escapeHtml(parentPath)}">⬆ رجوع</button>` : `<span class="tag">${total} مجلد</span>`}
      </div>
      <div class="folder-browser-list">
        ${nodes.length ? nodes.map(node => `
          <button class="folder-tile ${currentPath === node.path ? 'active' : ''}" data-folder-nav="${escapeHtml(node.path)}">
            <div class="folder-icon">📁</div>
            <div class="folder-name">${escapeHtml(node.name)}</div>
            <div class="folder-path">${escapeHtml(node.path)}</div>
            <div class="card-meta"><span>${node.itemCount || 0} عنصر</span>${node.childCount ? `<span>${node.childCount} مجلد فرعي</span>` : ''}</div>
          </button>
        `).join('') : `<div class="empty compact">لا توجد مجلدات فرعية هنا.</div>`}
      </div>
      ${hasMore ? `<div class="folder-browser-more"><button class="button secondary small" data-folder-more="1">تحميل مجلدات إضافية</button></div>` : ''}
    </div>`;
}
function initScrollMemory(auth, section){
  const key = userStorageKey(auth, `${section}:scroll`);
  const save = debounce(()=>sessionStorage.setItem(key, String(window.scrollY || 0)), 80);
  window.addEventListener('scroll', save, { passive:true });
  window.addEventListener('beforeunload', save);
  return {
    restore(){
      const y = Number(sessionStorage.getItem(key) || 0);
      if (y > 0) requestAnimationFrame(()=>window.scrollTo({ top:y, behavior:'auto' }));
    },
    saveNow(){ save(); }
  };
}
function attachInfiniteScroll(sentinel, callback){
  const observer = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) callback();
  }, { rootMargin: '600px 0px' });
  observer.observe(sentinel);
  return observer;
}

/* Removed obsolete duplicate page initializer from legacy bundled app.js. */

async function baseInitListingPage(type){
  const auth = await getAuth();
  const meta = await getJson('/api/meta').catch(()=>({libraries:[],sources:[]}));
  const favorites = await createFavoritesController(auth);
  const labels = {
    movies:{ title:'الأفلام', subtitle:'استمتع بالرحلة', endpoint:'/api/movies', search:'ابحث عن فيلم...' },
    series:{ title:'المسلسلات', subtitle:'تصفح مستقل مع وضع مجلدات متدرج حتى الوصول للعناصر.', endpoint:'/api/series', search:'ابحث عن مسلسل...' },
    mixed:{ title:'محتوى متنوع', subtitle:'مكتبة تجمع الفيديو والصوت في صفحة واحدة مع فرز واقتراحات موحدة.', endpoint:'/api/mixed', search:'ابحث في الفيديو والصوت...' },
    live:{ title:'القنوات والبث المباشر', subtitle:'قنوات IPTV مع بحث وتحميل تدريجي.', endpoint:'/api/live', search:'ابحث عن قناة...' }
  }[type];
  const supportsFolderBrowsing = type !== 'live';
  const sourceItems = type === 'live' ? (meta.sources || []).map(x => ({ id:x.id, name:x.name })) : (meta.libraries || []).filter(x => x.type === type);
  const prefKey = `listing:${type}`;
  const urlState = Object.fromEntries(new URLSearchParams(location.search).entries());
  const hasInitialFilter = ['q','sort','libraryId','sourceId','folder','view','browseMode'].some(key => urlState[key] !== undefined);
  const saved = {
    q:'', sort:'new', libraryId:'', folder:'', view:'grid', browseMode: supportsFolderBrowsing ? 'folders' : 'all',
    ...urlState
  };
  if (saved.sourceId && !saved.libraryId) saved.libraryId = saved.sourceId;
  try { localStorage.removeItem(userStorageKey(auth, prefKey)); } catch {}
  if (!supportsFolderBrowsing) saved.browseMode = 'all';
  const scrollMemory = initScrollMemory(auth, prefKey);
  appShell({ auth, pageKey:type, title:labels.title, subtitle:labels.subtitle });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="page-layout emby-layout">
      <aside class="filters-panel emby-filters">
        <div class="panel-pad filters-bar">
          <div class="panel-group panel-group-main">
            <h3 class="panel-title">لوحة التصفية</h3>
            <input class="input searchbar" id="search-input" placeholder="${labels.search}" value="${escapeHtml(saved.q)}">
            <select class="select" id="sort-select">
              <option value="new" ${saved.sort==='new'?'selected':''}>آخر تحديث أولاً</option>
              <option value="old" ${saved.sort==='old'?'selected':''}>آخر تحديث الأقدم</option>
              <option value="created-desc" ${saved.sort==='created-desc'?'selected':''}>تاريخ الإنشاء الأحدث</option>
              <option value="created-asc" ${saved.sort==='created-asc'?'selected':''}>تاريخ الإنشاء الأقدم</option>
              <option value="name" ${saved.sort==='name'?'selected':''}>حسب الاسم</option>
              <option value="rating-desc" ${saved.sort==='rating-desc'?'selected':''}>التقييم العالمي الأعلى</option>
              <option value="rating-asc" ${saved.sort==='rating-asc'?'selected':''}>التقييم العالمي الأقل</option>
              <option value="popular-desc" ${saved.sort==='popular-desc'?'selected':''}>الأكثر شيوعًا</option>
              <option value="recommended-desc" ${saved.sort==='recommended-desc'?'selected':''}>اقتراحات ذكية</option>
              <option value="year-desc" ${saved.sort==='year-desc'?'selected':''}>السنة الأحدث</option>
              <option value="year-asc" ${saved.sort==='year-asc'?'selected':''}>السنة الأقدم</option>
            </select>
          </div>

          <div class="panel-group panel-group-chips">
            <div class="filter-cluster">
              <div class="sidebar-label">${type==='live' ? 'مصدر البث' : 'المكتبات'}</div>
              <div class="filter-list" id="library-filters">${buildLibraryButtons(sourceItems, saved.libraryId, type==='live' ? 'كل المصادر' : 'كل المكتبات')}</div>
            </div>

            ${supportsFolderBrowsing ? `<div class="filter-cluster"><div class="sidebar-label">طريقة العرض</div><div class="pill-toggle" id="browse-mode-toggle"><button class="button secondary small ${saved.browseMode==='all'?'active':''}" data-browse-mode="all">كافة العناصر</button><button class="button secondary small ${saved.browseMode==='folders'?'active':''}" data-browse-mode="folders">حسب المجلدات</button></div></div>` : ''}

            <div class="filter-cluster">
              <div class="sidebar-label">نمط العرض</div>
              <div class="pill-toggle">
                <button class="button secondary small ${saved.view==='grid'?'active':''}" data-view="grid">شبكة</button>
                <button class="button secondary small ${saved.view==='list'?'active':''}" data-view="list">قائمة</button>
              </div>
            </div>
          </div>
        </div>

        ${supportsFolderBrowsing ? `<div id="folder-tree-section" class="folder-tree-panel ${saved.browseMode==='folders'?'':'hidden'}" style="display:none;"><div class="folder-tree-head"><div><div class="sidebar-label">استعراض المجلدات</div><h4 class="folder-tree-title">تصفح متدرج حسب المجلدات</h4></div><span class="tag">عرض مجلدات فقط حتى الوصول للعناصر</span></div><div class="folder-tree" id="folder-tree"><div class="empty">سيتم تحميل المجلدات...</div></div></div>` : ''}
      </aside>
      <section class="content-panel listing-shell">
        <div class="panel-pad listing-head">
          <div class="toolbar">
            <div>
              <h2 class="section-title">${labels.title}</h2>
              <div class="section-subtitle">${type === 'live' ? 'عرض مباشر مع تمرير لا نهائي.' : supportsFolderBrowsing ? 'اختيار بين كافة العناصر أو تصفح متدرج حسب المجلدات.' : 'عرض موحد لعناصر الفيديو والصوت داخل المكتبات المتنوعة.'}</div>
            </div>
            <div class="toolbar-group">
              <span class="tag" id="results-tag">0 عنصر</span>
              <button class="button secondary small" id="reset-filters">تصفير الفلاتر</button>
            </div>
          </div>
          <div class="chips" id="active-chips"></div>
          ${supportsFolderBrowsing ? `<div id="folder-summary" class="hidden"></div>` : ''}
          <div id="listing-wrap" class="${saved.view==='list' ? 'list-view' : ''}">
            <div class="grid cards" id="listing-grid"></div>
          </div>
          ${supportsFolderBrowsing ? `<div id="folder-extra" class="hidden"></div>` : ''}
          <div class="loading hidden" id="listing-loading">جاري تحميل العناصر...</div>
          <div class="loading hidden" id="listing-end">تم الوصول إلى نهاية النتائج</div>
          <div id="listing-sentinel"></div>
        </div>
      </section>
    </section>`;
  const state = { ...saved, page:1, loading:false, hasMore:true, folderNodes:[], folderPage:1, folderHasMore:true, folderLoading:false, folderTotal:0 };
  const grid = qs('#listing-grid');
  const loading = qs('#listing-loading');
  const end = qs('#listing-end');
  const folderTree = qs('#folder-tree');
  const folderSummary = qs('#folder-summary');
  const folderExtra = qs('#folder-extra');
  const sentinel = qs('#listing-sentinel');
  if (hasInitialFilter && window.history?.replaceState) window.history.replaceState(window.history.state, document.title, location.pathname);
  function persist(){}
  function syncChips(){
    const chips = [];
    if (state.browseMode === 'folders' && supportsFolderBrowsing) chips.push('الوضع: حسب المجلدات');
    if (state.browseMode === 'all' || type === 'live') chips.push('الوضع: كافة العناصر');
    if (state.q) chips.push(`بحث: ${state.q}`);
    if (state.sort === 'old') chips.push('الترتيب:  الأقدم');
    if (state.sort === 'name') chips.push('الترتيب: الاسم');
    if (state.sort === 'created-desc') chips.push('الترتيب: الإنشاء الأحدث');
    if (state.sort === 'created-asc') chips.push('الترتيب: الإنشاء الأقدم');
    if (state.sort === 'rating-desc') chips.push('الترتيب: التقييم العالمي الأعلى');
    if (state.sort === 'rating-asc') chips.push('الترتيب: التقييم العالمي الأقل');
    if (state.sort === 'popular-desc') chips.push('الترتيب: الأكثر شيوعًا');
    if (state.sort === 'recommended-desc') chips.push('الترتيب: اقتراحات ذكية');
    if (state.sort === 'year-desc') chips.push('الترتيب: السنة الأحدث');
    if (state.sort === 'year-asc') chips.push('الترتيب: السنة الأقدم');
    if (state.libraryId) {
      const obj = sourceItems.find(x => x.id === state.libraryId);
      chips.push(`المصدر: ${obj?.name || state.libraryId}`);
    }
    if (state.folder) chips.push(`المجلد الحالي: ${state.folder}`);
    qs('#active-chips').innerHTML = chips.length ? chips.map(x => `<span class="tag">${escapeHtml(x)}</span>`).join('') : `<span class="tag">بدون فلاتر</span>`;
  }
  function itemRenderer(item){
    if (type === 'mixed') {
      const rawType = String(item?.mediaType || item?.type || '').toLowerCase();
      const withContext = { ...item, watchHref: buildItemWatchHref(item, rawType, 'mixed') };
      return rawType === 'audio' ? audioCard(withContext) : rawType === 'series' ? seriesCard(withContext) : movieCard(withContext);
    }
    return type === 'movies' ? movieCard(item) : type === 'series' ? seriesCard(item) : channelCard(item);
  }
  function renderFavoriteAwareItem(item){
    const mixedType = String(item?.mediaType || item?.type || '').toLowerCase();
    const watchItem = type === 'mixed' ? { ...item, watchHref: buildItemWatchHref(item, mixedType, 'mixed') } : item;
    const payload = mediaFavoritePayload(watchItem, type === 'live' ? 'channel' : (type === 'mixed' ? mixedType : type));
    const favoriteHtml = auth.authenticated ? itemFavoriteButton(payload, favorites.has(payload.type, payload.id)) : '';
    if (type === 'mixed') return mixedType === 'audio' ? audioCard(watchItem, false, favoriteHtml) : mixedType === 'series' ? seriesCard(watchItem, false, favoriteHtml) : movieCard(watchItem, false, favoriteHtml);
    return type === 'movies' ? movieCard(item, false, favoriteHtml) : type === 'series' ? seriesCard(item, false, favoriteHtml) : channelCard(item, false, favoriteHtml);
  }
  function makeNodeFavoritePayload(node){
    const library = sourceItems.find(x => x.id === state.libraryId);
    return folderFavoritePayload({
      type,
      libraryId: state.libraryId || '',
      libraryName: library?.name || '',
      folderPath: node.path || '',
      name: node.name || node.path || 'مجلد',
      itemCount: node.itemCount || 0,
      childCount: node.childCount || 0,
      poster: node.poster || null
    });
  }
  function updateView(){
    qs('#listing-wrap').classList.toggle('list-view', state.view === 'list');
    qsa('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view));
    if (supportsFolderBrowsing) {
      qsa('[data-browse-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.browseMode === state.browseMode));
      const sec = qs('#folder-tree-section');
      if (sec) sec.classList.toggle('hidden', state.browseMode !== 'folders');
    }
  }
  function renderFolderHeader(nodes, directTotal){
    if (!folderSummary) return;
    if (state.browseMode !== 'folders') { folderSummary.classList.add('hidden'); folderSummary.innerHTML = ''; return; }
    const crumbs = [{ label:'كل المجلدات', path:'' }];
    let acc = '';
    String(state.folder || '').split('/').filter(Boolean).forEach(part => { acc = acc ? `${acc}/${part}` : part; crumbs.push({ label: part, path: acc }); });
    folderSummary.classList.remove('hidden');
    folderSummary.innerHTML = `
      <div class="folder-summary-box">
        <div class="folder-summary-head">
          <div>
            <div class="sidebar-label" style="margin:0 0 4px;padding:0">التصفح بالمجلدات</div>
            <div class="folder-current">${escapeHtml(state.folder || 'كل المجلدات')}</div>
          </div>
          <div class="chips">
            <span class="tag">${nodes.length} مجلد</span>
            <span class="tag">${directTotal || 0} عنصر مباشر</span>
          </div>
        </div>
        <div class="folder-breadcrumbs">${crumbs.map((crumb, idx) => `<button class="crumb ${idx === crumbs.length - 1 ? 'active' : ''}" data-folder-open="${escapeHtml(crumb.path)}">${escapeHtml(crumb.label)}</button>`).join('<span class="crumb-sep">/</span>')}</div>
      </div>`;
    }
  async function loadFolderBrowser(reset=true, preserveTreeScroll=false){
    if (!folderTree || !supportsFolderBrowsing) return state.folderNodes || [];
    if (state.folderLoading) return state.folderNodes || [];
    const prevScroll = preserveTreeScroll ? folderTree.scrollTop : 0;
    if (reset) {
      state.folderPage = 1;
      state.folderHasMore = true;
      state.folderNodes = [];
      state.folderTotal = 0;
      folderTree.innerHTML = `<div class="loading">جاري تحميل المجلدات...</div>`;
    }
    if (!state.folderHasMore && !reset) return state.folderNodes || [];
    state.folderLoading = true;
    try {
      const params = new URLSearchParams({ page:String(state.folderPage), limit:'240' });
      if (state.libraryId) params.set('libraryId', state.libraryId);
      if (state.folder) params.set('parent', state.folder);
      if (state.q) params.set('q', state.q);
      const data = await getJson(`/api/folders/${type}?${params.toString()}`);
      const incoming = Array.isArray(data.nodes) ? data.nodes : [];
      state.folderNodes = reset ? incoming : state.folderNodes.concat(incoming);
      state.folderHasMore = !!data.hasMore;
      state.folderTotal = Number(data.total || state.folderNodes.length || 0);
      if (incoming.length) state.folderPage += 1;
      folderTree.innerHTML = buildFolderBrowser({ ...data, nodes: state.folderNodes, total: state.folderTotal, hasMore: state.folderHasMore }, state.folder);
      if (preserveTreeScroll) folderTree.scrollTop = prevScroll;
      return state.folderNodes;
    } catch (e) {
      if (reset) state.folderNodes = [];
      folderTree.innerHTML = `<div class="empty compact">${escapeHtml(e.error || e.message || 'تعذر تحميل المجلدات')}</div>`;
      return state.folderNodes || [];
    } finally {
      state.folderLoading = false;
    }
  }
  async function loadAllMode(reset=false, preserveScroll=false){
    if (state.loading) return;
    const restoreY = preserveScroll ? (window.scrollY || 0) : null;
    const keepHeight = reset ? grid.offsetHeight : 0;
    if (reset) {
      state.page = 1; state.hasMore = true;
      if (keepHeight > 0) grid.style.minHeight = keepHeight + 'px';
      grid.innerHTML=''; end.classList.add('hidden');
    }
    if (!state.hasMore) return;
    state.loading = true; loading.classList.remove('hidden');
    if (folderSummary) { folderSummary.classList.add('hidden'); folderSummary.innerHTML = ''; }
    if (folderExtra) { folderExtra.classList.add('hidden'); folderExtra.innerHTML = ''; }
    try {
      const params = new URLSearchParams({ page:String(state.page), limit:String(DEFAULT_PAGE_SIZE), sort:state.sort, q:state.q || '' });
      if (type === 'live') {
        if (state.libraryId) params.set('sourceId', state.libraryId);
      } else {
        if (state.libraryId) params.set('libraryId', state.libraryId);
        if (state.folder) params.set('folder', state.folder);
      }
      const data = await getJson(`${labels.endpoint}?${params.toString()}`);
      grid.insertAdjacentHTML('beforeend', (data.items || []).map(renderFavoriteAwareItem).join(''));
      state.hasMore = !!data.hasMore;
      state.page += 1;
      qs('#results-tag').textContent = `${data.total || grid.children.length} عنصر`;
      if (!state.hasMore) end.classList.remove('hidden');
    } catch (e) {
      if (!grid.children.length) grid.innerHTML = `<div class="empty">${escapeHtml(e.error || e.message || 'تعذر تحميل البيانات')}</div>`;
    } finally {
      syncChips();
      loading.classList.add('hidden');
      state.loading = false;
      if (reset) {
        requestAnimationFrame(() => {
          grid.style.minHeight = '';
          if (restoreY !== null) window.scrollTo({ top: restoreY, behavior:'auto' });
        });
      }
    }
  }
  async function loadFolderMode(reset=false, preserveScroll=false){
    if (state.loading) return;
    const restoreY = preserveScroll ? (window.scrollY || 0) : null;
    const keepHeight = reset ? grid.offsetHeight : 0;
    if (reset) {
      state.page = 1; state.hasMore = true;
      if (keepHeight > 0) grid.style.minHeight = keepHeight + 'px';
      grid.innerHTML=''; end.classList.add('hidden');
      if (folderExtra) { folderExtra.classList.add('hidden'); folderExtra.innerHTML = ''; }
      await loadFolderBrowser(true, true);
    }
    state.loading = true; loading.classList.remove('hidden');
    try {
      const nodes = state.folderNodes || [];
      const params = new URLSearchParams({ page:String(state.page), limit:String(DEFAULT_PAGE_SIZE), sort:state.sort, q:state.q || '', directOnly:'1' });
      if (state.libraryId) params.set(type === 'live' ? 'sourceId' : 'libraryId', state.libraryId);
      if (state.folder) params.set('folder', state.folder);
      const data = await getJson(`${labels.endpoint}?${params.toString()}`);
      if (reset) {
        const folderCards = nodes.length ? nodes.map(node => {
          const payload = makeNodeFavoritePayload(node);
          return folderItemCard(node, auth.authenticated ? payload : null, auth.authenticated ? favorites.has(payload.type, payload.id) : false);
        }).join('') : '';
        const itemCards = (data.items || []).map(renderFavoriteAwareItem).join('');
        if (nodes.length) {
          grid.innerHTML = folderCards;
          if (folderExtra) {
            folderExtra.classList.toggle('hidden', !itemCards);
            folderExtra.innerHTML = itemCards ? `<section class="section"><div class="section-header"><div><h3 class="section-title">عناصر هذا المجلد</h3><div class="section-subtitle">العناصر المباشرة داخل المسار الحالي فقط</div></div></div><div class="grid cards ${state.view==='list'?'list-view':''}" id="folder-direct-grid">${itemCards}</div></section>` : '';
          }
        } else {
          grid.innerHTML = itemCards || `<div class="empty">لا توجد عناصر داخل هذا المجلد.</div>`;
          if (folderExtra) { folderExtra.classList.add('hidden'); folderExtra.innerHTML = ''; }
        }
      } else {
        if (nodes.length && folderExtra && !folderExtra.classList.contains('hidden')) {
          const directGrid = qs('#folder-direct-grid', folderExtra);
          if (directGrid) directGrid.insertAdjacentHTML('beforeend', (data.items || []).map(renderFavoriteAwareItem).join(''));
        } else {
          grid.insertAdjacentHTML('beforeend', (data.items || []).map(renderFavoriteAwareItem).join(''));
        }
      }
      state.hasMore = !!data.hasMore;
      state.page += 1;
      const totalShown = (data.total || 0) + (state.folderTotal || nodes.length || 0);
      qs('#results-tag').textContent = `${totalShown} نتيجة`;
      renderFolderHeader(nodes, data.total || 0);
      if (!state.hasMore) end.classList.remove('hidden');
    } catch (e) {
      if (!grid.children.length) grid.innerHTML = `<div class="empty">${escapeHtml(e.error || e.message || 'تعذر تحميل بيانات هذا المجلد')}</div>`;
    } finally {
      syncChips();
      loading.classList.add('hidden');
      state.loading = false;
      requestAnimationFrame(() => {
        grid.style.minHeight = '';
        if (restoreY !== null) window.scrollTo({ top: restoreY, behavior:'auto' });
      });
    }
  }
  async function refresh(reset=true, preserveScroll=false){
    updateView();
    if (supportsFolderBrowsing && state.browseMode === 'folders') return loadFolderMode(reset, preserveScroll);
    return loadAllMode(reset, preserveScroll);
  }
  qs('#search-input').addEventListener('input', debounce(e => { state.q = e.target.value.trim(); persist(); refresh(true); }, 300));
  qs('#sort-select').addEventListener('change', e => { state.sort = e.target.value; persist(); refresh(true); });
  qs('#library-filters').addEventListener('click', async e => {
    const btn = e.target.closest('[data-library]'); if (!btn) return;
    state.libraryId = btn.dataset.library || ''; state.folder=''; persist(); state.page = 1;
    qsa('[data-library]', qs('#library-filters')).forEach(x => x.classList.toggle('active', x===btn));
    await refresh(true, true);
  });
  if (folderTree) folderTree.addEventListener('click', async e => {
    const moreBtn = e.target.closest('[data-folder-more]');
    if (moreBtn) { await loadFolderBrowser(false, true); return; }
    const btn = e.target.closest('[data-folder-nav]'); if (!btn) return;
    state.folder = btn.dataset.folderNav || ''; persist(); state.page = 1;
    await refresh(true, true);
  });
  if (folderSummary) folderSummary.addEventListener('click', async e => {
    const btn = e.target.closest('[data-folder-open]'); if (!btn) return;
    state.folder = btn.dataset.folderOpen || ''; persist(); state.page = 1;
    await refresh(true, true);
  });
  root.addEventListener('click', async e => {
    const favoriteItemBtn = e.target.closest('[data-favorite-item]');
    if (favoriteItemBtn) {
      e.preventDefault();
      e.stopPropagation();
      const payload = {
        type: favoriteItemBtn.dataset.favoriteType,
        id: favoriteItemBtn.dataset.favoriteId,
        title: favoriteItemBtn.dataset.favoriteTitle,
        subtitle: favoriteItemBtn.dataset.favoriteSubtitle,
        href: favoriteItemBtn.dataset.favoriteHref,
        poster: favoriteItemBtn.dataset.favoritePoster || null
      };
      const result = await favorites.toggle(payload).catch(()=>null);
      if (result) {
        favoriteItemBtn.classList.toggle('active', !!result.favorite);
        favoriteItemBtn.textContent = result.favorite ? '♥' : '♡';
        favoriteItemBtn.setAttribute('aria-label', result.favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة');
      }
      return;
    }
    const favoriteBtn = e.target.closest('[data-favorite-folder]');
    if (favoriteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const payload = {
        type: favoriteBtn.dataset.favoriteType,
        id: favoriteBtn.dataset.favoriteId,
        title: favoriteBtn.dataset.favoriteTitle,
        subtitle: favoriteBtn.dataset.favoriteSubtitle,
        href: favoriteBtn.dataset.favoriteHref,
        poster: favoriteBtn.dataset.favoritePoster || null
      };
      const result = await favorites.toggle(payload).catch(()=>null);
      if (result) {
        favoriteBtn.classList.toggle('active', !!result.favorite);
        favoriteBtn.textContent = result.favorite ? '♥' : '♡';
        favoriteBtn.setAttribute('aria-label', result.favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة');
      }
      return;
    }
    const folderBtn = e.target.closest('[data-folder-open]');
    if (folderBtn && !folderSummary?.contains(folderBtn)) {
      state.folder = folderBtn.dataset.folderOpen || '';
      persist(); state.page = 1;
      await refresh(true, true);
    }
  });
  qsa('[data-view]').forEach(btn => btn.addEventListener('click', ()=>{ state.view = btn.dataset.view; persist(); updateView(); refresh(true, true); }));
  qsa('[data-browse-mode]').forEach(btn => btn.addEventListener('click', async ()=>{
    state.browseMode = btn.dataset.browseMode;
    if (state.browseMode === 'all') state.folder = '';
    persist();
    await refresh(true, true);
  }));
  qs('#reset-filters').addEventListener('click', async ()=>{
    Object.assign(state, { q:'', sort:'new', libraryId:'', folder:'', view:'grid', browseMode: supportsFolderBrowsing ? 'folders' : 'all' });
    qs('#search-input').value=''; qs('#sort-select').value='new'; persist();
    await refresh(true, true);
  });
  updateView(); syncChips();
  if (supportsFolderBrowsing && folderTree && state.browseMode === 'folders') await loadFolderBrowser(true, false);
  await refresh(true);
  scrollMemory.restore();
  attachInfiniteScroll(sentinel, ()=> {
    if (supportsFolderBrowsing && state.browseMode === 'folders' && state.folderNodes.length && qs('#folder-direct-grid', folderExtra || document)) {
      if (state.hasMore) loadFolderMode(false);
      return;
    }
    if (state.hasMore) {
      if (supportsFolderBrowsing && state.browseMode === 'folders') loadFolderMode(false);
      else loadAllMode(false);
    }
  });
}

/* Removed obsolete duplicate page initializer from legacy bundled app.js. */

async function initUsersPage(){
  const auth = await getAuth(); if (!auth.authenticated || auth.user.role !== 'admin') { location.href='/login'; return; }
  appShell({ auth, pageKey:'users', title:'نظام المستخدمين', subtitle:'إدارة الحسابات، الأدوار، التفعيل، وتغيير كلمات المرور من لوحة واحدة.' });
  const root = qs('#page-root');
  async function render(){
    const users = await getJson('/api/admin/users');
    const activeCount = users.filter(u => u.active).length;
    const adminCount = users.filter(u => u.role === 'admin').length;
    root.innerHTML = `
      <section class="nexus-admin nexus-users">
        <div class="nexus-admin-head">
          <div>
            <div class="nexus-eyebrow">USER ACCESS CENTER</div>
            <h2 class="nexus-title">إدارة الحسابات والصلاحيات</h2>
            <p class="nexus-subtitle">إضافة المستخدمين، تعديل الأدوار، تعطيل الحسابات، وتغيير كلمات المرور من شاشة تشغيل مستقلة.</p>
          </div>
        </div>
        <div class="nexus-stats">
          <div class="nexus-stat"><span>كل الحسابات</span><strong>${users.length}</strong><em>Total Users</em></div>
          <div class="nexus-stat"><span>نشطة</span><strong>${activeCount}</strong><em>Enabled</em></div>
          <div class="nexus-stat"><span>مدراء</span><strong>${adminCount}</strong><em>Admins</em></div>
          <div class="nexus-stat"><span>مستخدمون</span><strong>${users.length - adminCount}</strong><em>Viewers</em></div>
        </div>
        <div class="nexus-workspace users-workspace">
          <aside class="nexus-create-card sticky">
            <div class="nexus-card-head"><span class="nexus-dot"></span><div><h3>حساب جديد</h3><p>أدخل البيانات ثم اضغط إضافة.</p></div></div>
            <div class="nexus-form-grid">
              <input class="input" id="new-username" placeholder="اسم المستخدم">
              <input class="input" id="new-display" placeholder="الاسم الظاهر">
              <input class="input" id="new-password" type="password" placeholder="كلمة المرور">
              <select class="select" id="new-role"><option value="user">مستخدم</option><option value="admin">مدير</option></select>
              <button class="button" id="create-user">إضافة المستخدم</button>
              <div class="muted" id="users-msg"></div>
            </div>
          </aside>
          <section class="nexus-main users-table-card">
            <div class="nexus-section-header"><div><h3>قائمة الحسابات</h3><p>${users.length} حساب داخل النظام</p></div></div>
            <div class="nexus-user-list">
              ${users.map(u => `<div class="nexus-user-row">
                <div class="nexus-avatar">${escapeHtml((u.displayName || u.username || '?').slice(0,1).toUpperCase())}</div>
                <div class="nexus-user-main">
                  <strong>${escapeHtml(u.displayName || u.username)}</strong>
                  <span>${escapeHtml(u.username)} • ${u.lastLoginAt ? formatDate(u.lastLoginAt) : 'لم يسجل دخول'}</span>
                </div>
                <div class="nexus-user-flags"><span class="nexus-chip ${u.active ? 'ok' : 'off'}">${u.active ? 'نشط' : 'معطل'}</span><span class="nexus-chip">${u.role === 'admin' ? 'مدير' : 'مستخدم'}</span></div>
                <div class="user-actions nexus-actions-inline">
                  <label class="tag">تفعيل <input type="checkbox" data-active="${u.id}" ${u.active ? 'checked' : ''}></label>
                  <select class="select" data-role="${u.id}"><option value="user" ${u.role==='user'?'selected':''}>مستخدم</option><option value="admin" ${u.role==='admin'?'selected':''}>مدير</option></select>
                  <button class="button secondary small" data-reset="${u.id}">كلمة مرور</button>
                  ${u.id !== auth.user.id ? `<button class="button danger small" data-delete="${u.id}">حذف</button>` : `<span class="tag">الحساب الحالي</span>`}
                </div>
              </div>`).join('')}
            </div>
          </section>
        </div>
      </section>`;
    qs('#create-user').onclick = async () => {
      try {
        await getJson('/api/admin/users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
          username: qs('#new-username').value,
          displayName: qs('#new-display').value,
          password: qs('#new-password').value,
          role: qs('#new-role').value
        })});
        await render();
      } catch (e) { qs('#users-msg').textContent = e.error || 'تعذر إضافة المستخدم'; }
    };
    root.addEventListener('change', async e => {
      const id = e.target.dataset.active || e.target.dataset.role; if (!id) return;
      const user = users.find(x => x.id === id); if (!user) return;
      await getJson(`/api/admin/users/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
        username:user.username, displayName:user.displayName,
        active: e.target.dataset.active ? e.target.checked : user.active,
        role: e.target.dataset.role ? e.target.value : user.role
      })});
    });
    root.addEventListener('click', async e => {
      const btn = e.target;
      if (btn.dataset.delete) {
        if (confirm('حذف المستخدم؟')) { await getJson(`/api/admin/users/${btn.dataset.delete}`, { method:'DELETE' }); await render(); }
      }
      if (btn.dataset.reset) {
        const password = prompt('أدخل كلمة المرور الجديدة');
        const user = users.find(x => x.id === btn.dataset.reset);
        if (password && user) {
          await getJson(`/api/admin/users/${btn.dataset.reset}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
            username:user.username, displayName:user.displayName, active:user.active, role:user.role, password
          })});
          alert('تم تحديث كلمة المرور');
        }
      }
    });
  }
  await render();
}

/* Removed obsolete duplicate page initializer from legacy bundled app.js. */

/* ===== v12 enhanced overrides ===== */
const __legacyInitListingPage = baseInitListingPage;
function typeLabel(type){ return ({movies:'أفلام',series:'مسلسلات',audio:'صوتيات',mixed:'محتوى متنوع',live:'بث مباشر',channel:'قناة'}[type] || type || 'ميديا'); }
function typePath(type){ return ({movies:'/movies',series:'/series',audio:'/audio',mixed:'/mixed',live:'/live'}[type] || '/'); }
function sourceTypeLabel(type){ return type === 'usb_capture' ? 'USB Capture' : 'M3U / IPTV'; }
function brandHtml(system={}){
  const text = escapeHtml(system.name || 'STARSNET');
  if(system.logoUrl) return `<span class="brand-media"><img class="brand-logo" src="${escapeHtml(system.logoUrl)}" alt="${text}"></span><span>${text}</span>`;
  return `<span class="brand-media"><span class="brand-badge brand-badge-text">${escapeHtml(system.iconText || '⭐')}</span></span><span>${text}</span>`;
}
function audioCard(item, compact=false, favoriteHtml=''){
  return `<a class="card ${compact?'compact':''}" href="${item?.watchHref || mediaHref('audio', item.id)}">
    <div class="poster-wrap">
      ${favoriteHtml}
      ${cardPoster(item,'🎵')}
      <div class="poster-overlay">
        <span class="poster-badge">صوتي</span>
        ${item.mediaFolder ? `<span class="poster-badge">${escapeHtml(item.mediaFolder)}</span>` : ''}
      </div>
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-meta">
        ${item.libraryName ? `<span>${escapeHtml(item.libraryName)}</span>` : ''}
        ${item.folderPath ? `<span>${escapeHtml(item.folderPath)}</span>` : ''}
      </div>
    </div>
  </a>`;
}
function buildDeviceId(){
  const key = `${APP_NS}:device-id`;
  let id = localStorage.getItem(key);
  if(!id){ id = (crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`); localStorage.setItem(key, id); }
  return id;
}
async function getAuth(){
  let status;
  try { status = await getJson('/api/auth/status'); }
  catch { status = { authenticated:false, user:null, requireLoginForViewing:false, allowSelfRegistration:false, autoRegisterDevices:false, system:{} }; }
  if (!status.authenticated && status.autoRegisterDevices) {
    try {
      const deviceId = buildDeviceId();
      const deviceName = [navigator.platform, navigator.userAgent.split(' ').slice(0,3).join(' ')].filter(Boolean).join(' • ');
      await getJson('/api/auth/device-auto', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ deviceId, deviceName }) });
      status = await getJson('/api/auth/status');
    } catch {}
  }
  return status;
}
function pageKeyName(pathname=location.pathname){
  const map={'/':'home','/movies':'movies','/series':'series','/audio':'audio','/mixed':'mixed','/live':'live','/sports':'sports','/matches':'sports','/football-news':'sports','/football-profiles':'sports','/football-standings':'sports','/teams':'sports','/settings':'settings','/users':'users','/watch':'watch','/login':'login'};
  return map[pathname] || 'home';
}
function appShell({auth, pageKey, title, subtitle='', heroImage='', heroMeta=[]}){
  const system = auth?.system || {};
  document.body.className = `page-${String(pageKey || pageKeyName()).replace(/[^\w-]/g, '')}`;
  const navItems = [
    ['home','/','الرئيسية','🏠'],
    ['movies','/movies','الأفلام','🎬'],
    ['series','/series','المسلسلات','📺'],
    ['audio','/audio','الصوتيات','🎵'],
    ['mixed','/mixed','محتوى متنوع','🎞'],
    ['live','/live','القنوات','📡'],
    ['sports','/sports','الرياضة','⚽']
  ];
  if (auth.user?.role === 'admin') {
    navItems.push(['settings','/settings','الإعدادات','⚙']);
    navItems.push(['users','/users','المستخدمون','👤']);
  }
  const userBox = auth.authenticated
    ? `<div class="sidebar-user"><div><div class="sidebar-user-name">${escapeHtml(auth.user.displayName || auth.user.username)}</div><div class="muted">${auth.user.role === 'admin' ? 'مدير النظام' : (auth.user.authType === 'device' ? 'حساب جهاز تلقائي' : 'مستخدم')}</div></div><div class="sidebar-actions"><a class="button secondary small" href="/login">الحساب</a><button class="button secondary small" id="logout-btn">خروج</button></div></div>`
    : `<div class="sidebar-user"><div class="sidebar-user-name">زائر</div><div class="muted">يمكنك التصفح أو تسجيل الدخول</div><div class="sidebar-actions"><a class="button secondary small" href="/login">تسجيل الدخول</a></div></div>`;
  const heroStyle = heroImage ? `style="background-image:linear-gradient(90deg,rgba(4,6,10,.96) 0%,rgba(7,10,16,.82) 38%,rgba(10,13,19,.18) 100%),url('${heroImage}');"` : '';
  const hideHeroOnMobileHome = pageKey === 'home' && window.matchMedia?.('(max-width: 960px)')?.matches;
  const heroMarkup = hideHeroOnMobileHome ? '' : `<section class="hero-banner ${heroImage ? 'has-image' : ''}" ${heroStyle}>
          <div class="hero-content">
            ${heroMeta.length ? `<div class="hero-kicker">${heroMeta.map(x => `<span>${escapeHtml(x)}</span>`).join('<span>•</span>')}</div>` : ''}
            <h1 class="hero-title">${escapeHtml(title)}</h1>
            <p class="hero-text">${escapeHtml(subtitle || system.homeMessage || '')}</p>
            <div class="hero-actions" id="hero-actions"></div>
          </div>
        </section>`;
  document.body.innerHTML = `
    <div class="mobile-topbar"><div class="brand"><button class="button secondary small" id="mobile-menu-toggle">☰</button>${brandHtml(system)}</div>${auth.authenticated ? `<button class="button secondary small" id="logout-mobile">خروج</button>` : `<a class="button secondary small" href="/login">دخول</a>`}</div>
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="/">${brandHtml(system)}</a>
        <div class="sidebar-section"><div class="sidebar-label">التصفح</div><nav class="side-nav">
          ${navItems.map(([key, href, label, icon]) => `<a class="side-link ${key===pageKey?'active':''}" data-nav="${key}" href="${href}"><span>${icon}</span><span>${label}</span></a>`).join('')}
        </nav></div>
        ${userBox}
      </aside>
      <main class="content">
        ${heroMarkup}
        <div id="page-root"></div>
      </main>
    </div>
    <div class="mobile-sidebar-backdrop" id="mobile-sidebar-backdrop"></div>`;
  bindTopbarAuth();
  bindMobileSidebar();
  activePageNav(pageKey);
}
function bindProfileEditor(selector='#profile-save-btn', inputSelector='#profile-display-name', messageSelector='#profile-msg'){
  const btn = qs(selector); if(!btn) return;
  btn.onclick = async () => {
    const input = qs(inputSelector); const msg = qs(messageSelector);
    try {
      const user = await getJson('/api/users/me', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ displayName: input.value }) });
      if (msg) msg.textContent = `تم حفظ الاسم: ${user.displayName}`;
    } catch (e) { if (msg) msg.textContent = e.error || 'تعذر حفظ الاسم'; }
  };
}
function renderProfileEditor(auth){
  if (!auth?.authenticated) return '';
 
}
function libraryShortcutIcon(type){
  return ({ movies:'🎬', series:'📺', audio:'🎵', live:'📡' }[type] || '📁');
}
function libraryListingHref(section){
  const base = typePath(section?.type || 'movies');
  const params = new URLSearchParams();
  if (section?.type === 'live') {
    if (section?.id) params.set('sourceId', section.id);
  } else {
    if (section?.id) params.set('libraryId', section.id);
    params.set('browseMode', ['audio', 'series'].includes(section?.type) ? 'folders' : 'all');
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
function renderLibraryShortcutSection(sections=[], options={}){
  if (!sections.length) return '';
  return `<section class="section pinned-library-shortcuts sticky">

    <div class="library-shortcuts">
      ${sections.map(section => `
        <a class="library-shortcut" href="${libraryListingHref(section)}">
          <div class="library-shortcut-body">
            <div class="library-shortcut-title">${escapeHtml(section.name || 'مكتبة')}</div>
            <div class="library-shortcut-meta">
              <span>${escapeHtml(typeLabel(section.type))}</span>
            </div>
          </div>
        </a>
      `).join('')}
    </div>
  </section>`;
}
/* Removed obsolete duplicate page initializer from legacy bundled app.js. */
async function initLiveGroupedPage(){
  const auth = await getAuth();
  const meta = await getJson('/api/meta').catch(()=>({sources:[],system:{}}));
  const favorites = await createFavoritesController(auth);
  auth.system = auth.system || meta.system || {};
  const urlState = Object.fromEntries(new URLSearchParams(location.search).entries());
  const hasInitialFilter = !!(urlState.q || urlState.sourceId || urlState.libraryId || urlState.group);
  const saved = { q:'', sourceId:'', group:'', ...urlState };
  if (saved.libraryId && !saved.sourceId) saved.sourceId = saved.libraryId;
  try { localStorage.removeItem(userStorageKey(auth, 'listing:live-grouped')); } catch {}
  const sourceItems = (meta.sources || []).map(x => ({ id:x.id, name:x.name }));
  appShell({ auth, pageKey:'live', title:'القنوات والبث المباشر', subtitle:'بث مباشر مقسم حسب الأقسام: رياضية، أخبارية، أطفال، وغيرها.' });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="page-layout emby-layout live-grouped-layout">
      <aside class="filters-panel emby-filters">
        <div class="panel-pad filters-bar">
          <div class="panel-group panel-group-main">
            <h3 class="panel-title">تصفية البث</h3>
            <input class="input searchbar" id="live-search-input" placeholder="ابحث عن قناة..." value="${escapeHtml(saved.q || '')}">
          </div>
          <div class="panel-group panel-group-chips">
            <div class="filter-cluster">
              <div class="sidebar-label">مصدر البث</div>
              <div class="filter-list" id="live-source-filters">${buildLibraryButtons(sourceItems, saved.sourceId, 'كل المصادر')}</div>
            </div>
            <div class="filter-cluster">
              <div class="sidebar-label">الأقسام</div>
              <div class="filter-list" id="live-group-filters"><button class="filter-btn active" data-live-group="">كل الأقسام</button></div>
            </div>
          </div>
        </div>
      </aside>
      <section class="content-panel listing-shell">
        <div class="panel-pad listing-head">
          <div class="toolbar">
            <div>
              <h2 class="section-title">البث المباشر</h2>
              <div class="section-subtitle">القنوات مرتبة في أقسام واضحة لتسهيل الوصول السريع.</div>
            </div>
            <div class="toolbar-group">
              <span class="tag" id="live-results-tag">0 قناة</span>
              <button class="button secondary small" id="live-reset-filters">تصفير الفلاتر</button>
            </div>
          </div>
          <div class="chips" id="live-active-chips"></div>
          <div id="live-grouped-sections"></div>
          <div class="loading hidden" id="live-loading">جاري تحميل القنوات...</div>
          <div class="loading hidden" id="live-end">تم الوصول إلى نهاية القنوات</div>
          <div id="live-sentinel"></div>
        </div>
      </section>
    </section>`;
  const state = { q:String(saved.q || ''), sourceId:String(saved.sourceId || ''), group:String(saved.group || ''), page:1, hasMore:true, loading:false, items:[], groups:[] };
  if (hasInitialFilter && window.history?.replaceState) {
    window.history.replaceState(window.history.state, document.title, '/live');
  }
  const sections = qs('#live-grouped-sections');
  const loading = qs('#live-loading');
  const end = qs('#live-end');
  const sentinel = qs('#live-sentinel');
  function persist(){}
  function renderGroupFilters(){
    const buttons = [`<button class="filter-btn ${!state.group ? 'active' : ''}" data-live-group="">كل الأقسام</button>`]
      .concat((state.groups || []).map(group => `<button class="filter-btn ${state.group === group.id ? 'active' : ''}" data-live-group="${escapeHtml(group.id || '')}"><span>${escapeHtml(group.label || 'قسم')}</span><small>${escapeHtml(String(group.count || 0))}</small></button>`));
    qs('#live-group-filters').innerHTML = buttons.join('');
  }
  function syncChips(){
    const chips = [];
    if (state.q) chips.push(`بحث: ${state.q}`);
    if (state.sourceId) chips.push(`المصدر: ${(sourceItems.find(x => x.id === state.sourceId)?.name || state.sourceId)}`);
    if (state.group) chips.push(`القسم: ${state.groups.find(x => x.id === state.group)?.label || state.group}`);
    qs('#live-active-chips').innerHTML = chips.length ? chips.map(x => `<span class="tag">${escapeHtml(x)}</span>`).join('') : `<span class="tag">كل القنوات والأقسام</span>`;
  }
  function renderFavoriteAwareChannel(item){
    const payload = mediaFavoritePayload(item, 'channel');
    const favoriteHtml = auth.authenticated ? itemFavoriteButton(payload, favorites.has(payload.type, payload.id)) : '';
    return channelCard(item, false, favoriteHtml);
  }
  function renderSections(){
    const map = new Map();
    for (const item of state.items) {
      const label = String(item?.groupTitle || '').trim() || 'غير مصنفة';
      if (!map.has(label)) map.set(label, []);
      map.get(label).push(item);
    }
    const ordered = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ar'));
    sections.innerHTML = ordered.length
      ? ordered.map(([title, items]) => `<section class="section row-section live-category-section"><div class="section-header"><div><h2 class="section-title">${escapeHtml(title)}</h2><div class="section-subtitle">${items.length} قناة محملة في هذا القسم</div></div></div><div class="grid cards">${items.map(renderFavoriteAwareChannel).join('')}</div></section>`).join('')
      : `<div class="empty">لا توجد قنوات مطابقة للفلاتر الحالية.</div>`;
    qs('#live-results-tag').textContent = `${state.items.length} قناة`;
  }
  async function loadLive(reset=false){
    if (state.loading) return;
    if (reset) {
      state.page = 1; state.hasMore = true; state.items = [];
      sections.innerHTML = `<div class="loading">جاري تحميل القنوات...</div>`;
      end.classList.add('hidden');
    }
    if (!state.hasMore) return;
    state.loading = true;
    loading.classList.remove('hidden');
    try {
      const params = new URLSearchParams({ page:String(state.page), limit:'80', q:state.q || '' });
      if (state.sourceId) params.set('sourceId', state.sourceId);
      if (state.group) params.set('group', state.group);
      const data = await getJson(`/api/live?${params.toString()}`);
      state.groups = Array.isArray(data.groups) ? data.groups : [];
      const incoming = Array.isArray(data.items) ? data.items : [];
      state.items = reset ? incoming : state.items.concat(incoming);
      state.hasMore = !!data.hasMore;
      state.page += 1;
      renderGroupFilters();
      renderSections();
      syncChips();
      if (!state.hasMore) end.classList.remove('hidden');
    } catch (e) {
      if (!state.items.length) sections.innerHTML = `<div class="empty">${escapeHtml(e.error || e.message || 'تعذر تحميل القنوات')}</div>`;
    } finally {
      loading.classList.add('hidden');
      state.loading = false;
    }
  }
  qs('#live-search-input').addEventListener('input', debounce(e => { state.q = e.target.value.trim(); persist(); loadLive(true); }, 300));
  qs('#live-source-filters').addEventListener('click', e => {
    const btn = e.target.closest('[data-library]');
    if (!btn) return;
    state.sourceId = btn.dataset.library || '';
    state.group = '';
    qsa('[data-library]', qs('#live-source-filters')).forEach(x => x.classList.toggle('active', x === btn));
    persist();
    loadLive(true);
  });
  qs('#live-group-filters').addEventListener('click', e => {
    const btn = e.target.closest('[data-live-group]');
    if (!btn) return;
    state.group = btn.dataset.liveGroup || '';
    persist();
    loadLive(true);
  });
  qs('#live-reset-filters').addEventListener('click', () => {
    Object.assign(state, { q:'', sourceId:'', group:'' });
    qs('#live-search-input').value = '';
    qsa('[data-library]', qs('#live-source-filters')).forEach(btn => btn.classList.toggle('active', !btn.dataset.library));
    persist();
    loadLive(true);
  });
  root.addEventListener('click', async e => {
    const favoriteItemBtn = e.target.closest('[data-favorite-item]');
    if (!favoriteItemBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const payload = { type: favoriteItemBtn.dataset.favoriteType, id: favoriteItemBtn.dataset.favoriteId, title: favoriteItemBtn.dataset.favoriteTitle, subtitle: favoriteItemBtn.dataset.favoriteSubtitle, href: favoriteItemBtn.dataset.favoriteHref, poster: favoriteItemBtn.dataset.favoritePoster || null };
    const result = await favorites.toggle(payload).catch(()=>null);
    if (result) {
      favoriteItemBtn.classList.toggle('active', !!result.favorite);
      favoriteItemBtn.textContent = result.favorite ? '♥' : '♡';
      favoriteItemBtn.setAttribute('aria-label', result.favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة');
    }
  });
  renderGroupFilters();
  syncChips();
  await loadLive(true);
  attachInfiniteScroll(sentinel, () => { if (state.hasMore) loadLive(false); });
}
function matchStatusLabel(status='scheduled'){
  return ({ scheduled:'قادمة', live:'مباشرة الآن', finished:'انتهت', postponed:'مؤجلة', cancelled:'ملغاة' }[status] || status || 'قادمة');
}
function matchStatusClass(status='scheduled'){
  return `match-status-${String(status || 'scheduled').replace(/[^\w-]/g, '')}`;
}
function formatMatchDate(value=''){
  if (!value) return 'لم يحدد الوقت';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('ar', { weekday:'short', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' });
  } catch { return value; }
}
function toDatetimeLocal(value=''){
  if (!value) return '';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch { return String(value).slice(0, 16); }
}
function matchScoreText(match={}){
  const hasHome = match.homeScore !== null && match.homeScore !== undefined && match.homeScore !== '';
  const hasAway = match.awayScore !== null && match.awayScore !== undefined && match.awayScore !== '';
  return hasHome || hasAway ? `${hasHome ? match.homeScore : '-'} - ${hasAway ? match.awayScore : '-'}` : 'VS';
}
function footballEntityBadge(meta={}, fallbackType='club'){
  const flag = String(meta?.flag || '').trim();
  if (flag) return `<span class="football-entity-badge flag" aria-hidden="true">${escapeHtml(flag)}</span>`;
  const image = String(meta?.image || '').trim();
  if (image) return `<img class="football-entity-badge" src="${escapeHtml(image)}" alt="" loading="lazy">`;
  const kind = String(meta?.kind || fallbackType || '').toLowerCase();
  return `<span class="football-entity-badge icon" aria-hidden="true">${kind === 'player' ? '👤' : '🏟'}</span>`;
}
function footballEntityName(name='', meta={}, fallbackType='club'){
  return `<span class="football-entity-name">${footballEntityBadge(meta, fallbackType)}<span>${escapeHtml(name || meta?.title || '')}</span></span>`;
}
function cleanFootballDetails(value=''){
  return String(value || '').split(/\r?\n/).filter(line => !/^\s*المصدر\s*:/i.test(line)).join('\n').trim();
}
function footballMatchCard(match={}, admin=false){
  const channel = match.linkedChannel;
  const news = Array.isArray(match.news) ? match.news.filter(Boolean).slice(0, 3) : [];
  const details = cleanFootballDetails(match.details || '');
  return `<article class="football-match-card ${matchStatusClass(match.status)}" data-match-id="${escapeHtml(match.id || '')}">
    <div class="match-card-top">
      <span class="tag">${escapeHtml(match.competition || 'كرة القدم العالمية')}</span>
      <span class="tag match-status-pill">${escapeHtml(matchStatusLabel(match.status))}</span>
    </div>
    <div class="match-teams">
      <strong>${footballEntityName(match.homeTeam || 'الفريق الأول', match.homeTeamMeta, 'club')}</strong>
      <span class="match-score">${escapeHtml(matchScoreText(match))}</span>
      <strong>${footballEntityName(match.awayTeam || 'الفريق الثاني', match.awayTeamMeta, 'club')}</strong>
    </div>
    <div class="match-meta-line">${escapeHtml(formatMatchDate(match.kickoffAt))}${match.round ? ` • ${escapeHtml(match.round)}` : ''}${match.venue ? ` • ${escapeHtml(match.venue)}` : ''}</div>
    ${match.headline ? `<h3 class="match-headline">${escapeHtml(match.headline)}</h3>` : ''}
    ${match.summary ? `<p class="match-summary">${escapeHtml(match.summary)}</p>` : ''}
    ${news.length ? `<div class="match-news-list">${news.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    <div class="match-actions">
      ${channel ? `<a class="button small" href="${escapeHtml(channel.watchHref)}">مشاهدة على ${escapeHtml(channel.title || 'القناة')}</a>` : `<span class="tag">لا توجد قناة مرتبطة</span>`}
      ${admin ? `<button class="button secondary small" type="button" data-edit-match="${escapeHtml(match.id || '')}">تعديل</button><button class="button danger small" type="button" data-delete-match="${escapeHtml(match.id || '')}">حذف</button>` : ''}
    </div>
    ${details ? `<details class="match-details"><summary>التفاصيل الكاملة</summary><div>${escapeHtml(details).replace(/\n/g, '<br>')}</div></details>` : ''}
  </article>`;
}
async function initMatchesPage(){
  const auth = await getAuth();
  const isAdmin = auth.authenticated && auth.user?.role === 'admin';
  auth.system = auth.system || {};
  appShell({ auth, pageKey:'matches', title:'مباريات كرة القدم العالمية', subtitle:'أخبار ونتائج وتفاصيل المباريات مع ربط مباشر بقنوات البث.' });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="matches-layout">
      <aside class="filters-panel sticky">
        <div class="panel-pad">
          <h3 class="panel-title">تصفية المباريات</h3>
          <input class="input searchbar" id="matches-q" placeholder="ابحث عن فريق أو بطولة">
          <div class="filter-list match-status-filters" id="matches-status">
            <button class="filter-btn active" data-match-status="all">الكل</button>
            <button class="filter-btn" data-match-status="live">مباشرة</button>
            <button class="filter-btn" data-match-status="scheduled">قادمة</button>
            <button class="filter-btn" data-match-status="finished">النتائج</button>
          </div>
          <div class="filter-cluster" style="margin-top:12px">
            <div class="sidebar-label">البطولات</div>
            <div class="filter-list" id="matches-competitions"><button class="filter-btn active" data-match-competition="">كل البطولات</button></div>
          </div>
        </div>
      </aside>
      <section class="content-panel">
        <div class="panel-pad">
          <div class="toolbar">
            <div>
              <h2 class="section-title">مركز المباريات</h2>
              <div class="section-subtitle">تابع الأخبار، النتائج، واربط المباراة بقناة البث المناسبة.</div>
            </div>
            <div class="toolbar-group">
              <span class="tag" id="matches-count">0 مباراة</span>
              ${isAdmin ? `<button class="button secondary small" id="football-import-btn">استيراد من الإنترنت الآن</button><button class="button secondary small" id="worldcup-import-btn">تضمين كأس العالم 2026</button><button class="button success small" id="new-match-btn">إضافة مباراة</button>` : ''}
            </div>
          </div>
          ${isAdmin ? `<section class="config-card match-admin-card" id="match-admin-card">
            <div class="section-header"><div><h3 class="panel-title">إدارة مباراة</h3><div class="section-subtitle">أضف الخبر والنتيجة واربط المباراة بأي قناة من قنواتك.</div></div><button class="button secondary small" type="button" id="clear-match-form">تفريغ النموذج</button></div>
            <input type="hidden" id="match-id">
            <div class="settings-grid settings-grid-3">
              <div><label>البطولة</label><input class="input" id="match-competition" placeholder="UEFA Champions League"></div>
              <div><label>الفريق الأول</label><input class="input" id="match-home" placeholder="Real Madrid"></div>
              <div><label>الفريق الثاني</label><input class="input" id="match-away" placeholder="Manchester City"></div>
              <div><label>وقت المباراة</label><input class="input" id="match-kickoff" type="datetime-local"></div>
              <div><label>الحالة</label><select class="select" id="match-status-field"><option value="scheduled">قادمة</option><option value="live">مباشرة الآن</option><option value="finished">انتهت</option><option value="postponed">مؤجلة</option><option value="cancelled">ملغاة</option></select></div>
              <div><label>القناة المرتبطة</label><select class="select" id="match-channel"><option value="">بدون قناة</option></select></div>
              <div><label>نتيجة الفريق الأول</label><input class="input" id="match-home-score" type="number" placeholder="0"></div>
              <div><label>نتيجة الفريق الثاني</label><input class="input" id="match-away-score" type="number" placeholder="0"></div>
              <div><label>الأولوية</label><input class="input" id="match-priority" type="number" value="0"></div>
              <div><label>الجولة</label><input class="input" id="match-round" placeholder="نصف النهائي"></div>
              <div><label>الملعب</label><input class="input" id="match-venue" placeholder="Santiago Bernabeu"></div>
              <div><label>إظهار</label><select class="select" id="match-visible"><option value="true">نعم</option><option value="false">لا</option></select></div>
              <div style="grid-column:1/-1"><label>عنوان الخبر</label><input class="input" id="match-headline" placeholder="قمة نارية الليلة"></div>
              <div style="grid-column:1/-1"><label>ملخص سريع</label><textarea class="textarea" id="match-summary" placeholder="ملخص المباراة أو أهم الأخبار"></textarea></div>
              <div style="grid-column:1/-1"><label>أخبار مختصرة، كل سطر خبر</label><textarea class="textarea" id="match-news" placeholder="غيابات الفريق&#10;التشكيلة المتوقعة&#10;آخر نتيجة بين الفريقين"></textarea></div>
              <div style="grid-column:1/-1"><label>تفاصيل كاملة</label><textarea class="textarea" id="match-details" placeholder="تفاصيل إضافية، تحليل، روابط، أو ملاحظات"></textarea></div>
            </div>
            <div class="toolbar" style="margin-top:14px"><div class="muted" id="match-admin-status"></div><div class="toolbar-group"><button class="button success" id="save-match-btn">حفظ المباراة</button></div></div>
          </section>` : ''}
          <section class="section football-news-section">
            <div class="section-header"><div><h2 class="section-title">أخبار كرة القدم العالمية</h2><div class="section-subtitle">يتم استيرادها تلقائيًا من RSS ومصادر مفتوحة.</div></div><span class="tag" id="football-import-status">جاهز</span></div>
            <div id="football-news-list" class="football-news-grid"><div class="empty">جاري تحميل الأخبار...</div></div>
          </section>
          <section class="section football-profiles-section">
            <div class="section-header"><div><h2 class="section-title">الأندية واللاعبون</h2><div class="section-subtitle">معلومات مختصرة مستوردة تلقائيًا للأندية واللاعبين المهمين.</div></div></div>
            <div id="football-profiles-list" class="football-profile-grid"><div class="empty">جاري تحميل المعلومات...</div></div>
          </section>
          <div id="matches-list" class="matches-grid"></div>
          <div class="loading hidden" id="matches-loading">جاري تحميل المباريات...</div>
        </div>
      </section>
    </section>`;
  const state = { q:'', status:'all', competition:'', items:[], competitions:[] };
  const list = qs('#matches-list');
  const loading = qs('#matches-loading');
  const count = qs('#matches-count');
  const newsList = qs('#football-news-list');
  const profilesList = qs('#football-profiles-list');
  const importStatus = qs('#football-import-status');
  let channelOptions = [];
  function renderCompetitions(){
    const html = [`<button class="filter-btn ${!state.competition ? 'active' : ''}" data-match-competition="">كل البطولات</button>`]
      .concat((state.competitions || []).filter(x => x.name).map(item => `<button class="filter-btn ${state.competition === item.name ? 'active' : ''}" data-match-competition="${escapeHtml(item.name)}"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(String(item.count || 0))}</small></button>`));
    qs('#matches-competitions').innerHTML = html.join('');
  }
  function renderMatches(){
    list.innerHTML = state.items.length ? state.items.map(item => footballMatchCard(item, isAdmin)).join('') : `<div class="empty">لا توجد مباريات مطابقة حاليًا.</div>`;
    count.textContent = `${state.items.length} مباراة`;
  }
  async function loadFootballInternetData(){
    if (!window.ArabCastMatchesInternet?.load) {
      await new Promise(resolve => {
        const existing = document.querySelector('script[data-page-module="matches-internet"]');
        if (existing) {
          existing.addEventListener('load', resolve, { once:true });
          existing.addEventListener('error', resolve, { once:true });
          return;
        }
        const script = document.createElement('script');
        script.src = '/assets/js/pages/matches-internet.js?v=20260617-professional-fix15';
        script.dataset.pageModule = 'matches-internet';
        script.onload = resolve;
        script.onerror = resolve;
        document.head.appendChild(script);
      });
    }
    if (window.ArabCastMatchesInternet?.load) {
      await window.ArabCastMatchesInternet.load({ newsList, profilesList, importStatus });
      return;
    }
    if (newsList) newsList.innerHTML = `<div class="empty">تعذر تحميل وحدة أخبار كرة القدم.</div>`;
    if (profilesList) profilesList.innerHTML = `<div class="empty">تعذر تحميل وحدة الأندية واللاعبين.</div>`;
  }
  async function loadMatches(){
    loading.classList.remove('hidden');
    try {
      const params = new URLSearchParams({ limit:'120', q:state.q || '' });
      if (state.status && state.status !== 'all') params.set('status', state.status);
      if (state.competition) params.set('competition', state.competition);
      const data = await getJson(`/api/matches?${params.toString()}`);
      state.items = Array.isArray(data.items) ? data.items : [];
      state.competitions = Array.isArray(data.competitions) ? data.competitions : [];
      renderCompetitions();
      renderMatches();
    } catch (e) {
      list.innerHTML = `<div class="empty">${escapeHtml(e.error || e.message || 'تعذر تحميل المباريات')}</div>`;
    } finally {
      loading.classList.add('hidden');
    }
  }
  function clearMatchForm(){
    if (!isAdmin) return;
    ['match-id','match-competition','match-home','match-away','match-kickoff','match-home-score','match-away-score','match-priority','match-round','match-venue','match-headline','match-summary','match-news','match-details'].forEach(id => { const node = qs(`#${id}`); if (node) node.value = id === 'match-priority' ? '0' : ''; });
    qs('#match-status-field').value = 'scheduled';
    qs('#match-channel').value = '';
    qs('#match-visible').value = 'true';
    qs('#match-admin-status').textContent = 'جاهز لإضافة مباراة جديدة.';
  }
  function fillMatchForm(match){
    qs('#match-id').value = match.id || '';
    qs('#match-competition').value = match.competition || '';
    qs('#match-home').value = match.homeTeam || '';
    qs('#match-away').value = match.awayTeam || '';
    qs('#match-kickoff').value = toDatetimeLocal(match.kickoffAt || '');
    qs('#match-status-field').value = match.status || 'scheduled';
    qs('#match-home-score').value = match.homeScore ?? '';
    qs('#match-away-score').value = match.awayScore ?? '';
    qs('#match-priority').value = match.priority ?? 0;
    qs('#match-round').value = match.round || '';
    qs('#match-venue').value = match.venue || '';
    qs('#match-headline').value = match.headline || '';
    qs('#match-summary').value = match.summary || '';
    qs('#match-news').value = (match.news || []).join('\n');
    qs('#match-details').value = match.details || '';
    qs('#match-visible').value = match.visible === false ? 'false' : 'true';
    qs('#match-channel').value = match.linkedChannelId || '';
    qs('#match-admin-status').textContent = `تعديل: ${match.homeTeam || ''} ضد ${match.awayTeam || ''}`;
    qs('#match-admin-card')?.scrollIntoView({ behavior:'smooth', block:'start' });
  }
  function collectMatchForm(){
    return {
      competition: qs('#match-competition').value,
      homeTeam: qs('#match-home').value,
      awayTeam: qs('#match-away').value,
      kickoffAt: qs('#match-kickoff').value,
      status: qs('#match-status-field').value,
      homeScore: qs('#match-home-score').value,
      awayScore: qs('#match-away-score').value,
      priority: qs('#match-priority').value,
      round: qs('#match-round').value,
      venue: qs('#match-venue').value,
      headline: qs('#match-headline').value,
      summary: qs('#match-summary').value,
      newsText: qs('#match-news').value,
      details: qs('#match-details').value,
      visible: qs('#match-visible').value === 'true',
      linkedChannelId: qs('#match-channel').value
    };
  }
  async function loadAdminChannels(){
    if (!isAdmin) return;
    const data = await getJson('/api/admin/channels?includeHidden=false&limit=500').catch(()=>({items:[]}));
    channelOptions = Array.isArray(data.items) ? data.items : [];
    const select = qs('#match-channel');
    if (!select) return;
    select.innerHTML = `<option value="">بدون قناة</option>` + channelOptions.map(channel => `<option value="${escapeHtml(channel.id || '')}">${escapeHtml(channel.title || 'قناة')} - ${escapeHtml(channel.sourceName || '')}</option>`).join('');
  }
  qs('#matches-q').addEventListener('input', debounce(e => { state.q = e.target.value.trim(); loadMatches(); }, 300));
  qs('#matches-status').addEventListener('click', e => {
    const btn = e.target.closest('[data-match-status]');
    if (!btn) return;
    state.status = btn.dataset.matchStatus || 'all';
    qsa('[data-match-status]', qs('#matches-status')).forEach(node => node.classList.toggle('active', node === btn));
    loadMatches();
  });
  qs('#matches-competitions').addEventListener('click', e => {
    const btn = e.target.closest('[data-match-competition]');
    if (!btn) return;
    state.competition = btn.dataset.matchCompetition || '';
    loadMatches();
  });
  if (isAdmin) {
    qs('#new-match-btn').addEventListener('click', clearMatchForm);
    qs('#football-import-btn').addEventListener('click', async () => {
      qs('#football-import-btn').disabled = true;
      if (importStatus) importStatus.textContent = 'جاري الاستيراد من الإنترنت...';
      await getJson('/api/admin/football/import', { method:'POST' }).catch(()=>null);
      qs('#football-import-btn').disabled = false;
      await loadFootballInternetData();
    });
    qs('#worldcup-import-btn').addEventListener('click', async () => {
      qs('#worldcup-import-btn').disabled = true;
      if (importStatus) importStatus.textContent = 'جاري تضمين كأس العالم 2026...';
      const result = await getJson('/api/admin/worldcup/import', { method:'POST' }).catch(error => ({ error: error.error || error.message }));
      qs('#worldcup-import-btn').disabled = false;
      if (importStatus) {
        const status = result?.status || {};
        importStatus.textContent = result?.error || `كأس العالم: ${status.matchesImported || 0} جديد، ${status.matchesUpdated || 0} تحديث، ${status.teamsImported || 0} منتخب`;
      }
      await loadMatches();
      await loadFootballInternetData();
    });
    qs('#clear-match-form').addEventListener('click', clearMatchForm);
    qs('#save-match-btn').addEventListener('click', async () => {
      const id = qs('#match-id').value.trim();
      const payload = collectMatchForm();
      qs('#match-admin-status').textContent = 'جاري الحفظ...';
      try {
        await getJson(id ? `/api/admin/matches/${encodeURIComponent(id)}` : '/api/admin/matches', { method:id ? 'PUT' : 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        qs('#match-admin-status').textContent = 'تم حفظ المباراة.';
        clearMatchForm();
        await loadMatches();
      } catch (e) {
        qs('#match-admin-status').textContent = e.error || 'تعذر حفظ المباراة.';
      }
    });
    root.addEventListener('click', async e => {
      const edit = e.target.closest('[data-edit-match]');
      if (edit) {
        const match = state.items.find(item => item.id === edit.dataset.editMatch);
        if (match) fillMatchForm(match);
        return;
      }
      const del = e.target.closest('[data-delete-match]');
      if (!del) return;
      if (!confirm('حذف هذه المباراة؟')) return;
      await getJson(`/api/admin/matches/${encodeURIComponent(del.dataset.deleteMatch)}`, { method:'DELETE' }).catch(()=>null);
      await loadMatches();
    });
    await loadAdminChannels();
    clearMatchForm();
  }
  await loadFootballInternetData();
  await loadMatches();
}
async function ensureFootballInternetModule(){
  if (window.ArabCastMatchesInternet?.newsCard || window.ArabCastMatchesInternet?.profileCard) return window.ArabCastMatchesInternet;
  await new Promise(resolve => {
    const existing = document.querySelector('script[data-page-module="matches-internet"]');
    if (existing) {
      existing.addEventListener('load', resolve, { once:true });
      existing.addEventListener('error', resolve, { once:true });
      if (window.ArabCastMatchesInternet) resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = '/assets/js/pages/matches-internet.js?v=20260617-professional-fix15';
    script.dataset.pageModule = 'matches-internet';
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });
  return window.ArabCastMatchesInternet || {};
}
function matchTimeNumber(match={}){
  const value = match.kickoffAt ? new Date(match.kickoffAt).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}
function sortMatchGroup(items=[], direction='asc'){
  return [...items].sort((a, b) => {
    if (Number(b.priority || 0) !== Number(a.priority || 0)) return Number(b.priority || 0) - Number(a.priority || 0);
    const diff = matchTimeNumber(a) - matchTimeNumber(b);
    return direction === 'desc' ? -diff : diff;
  });
}
function renderMatchSection(title, items, admin=false, emptyText='لا توجد مباريات في هذا القسم.'){
  if (!items.length) return `<section class="match-section"><div class="match-section-head"><h3>${escapeHtml(title)}</h3><span class="tag">0</span></div><div class="empty compact">${escapeHtml(emptyText)}</div></section>`;
  return `<section class="match-section">
    <div class="match-section-head"><h3>${escapeHtml(title)}</h3><span class="tag">${items.length} مباراة</span></div>
    <div class="matches-grid">${items.map(item => footballMatchCard(item, admin)).join('')}</div>
  </section>`;
}
function footballStandingsTable(group={}){
  const rows = Array.isArray(group.rows) ? group.rows : [];
  if (!rows.length) return '';
  return `<section class="standings-card">
    <div class="standings-card-head"><h3>${escapeHtml(group.competition || 'جدول الترتيب')}</h3><span class="tag">${rows.length} فريق</span></div>
    <div class="standings-table-wrap">
      <table class="standings-table">
        <thead><tr><th>#</th><th>الفريق</th><th>لعب</th><th>ف</th><th>ت</th><th>خ</th><th>له</th><th>عليه</th><th>فرق</th><th>نقاط</th><th>آخر النتائج</th></tr></thead>
        <tbody>${rows.map(row => `<tr>
          <td>${escapeHtml(row.rank)}</td>
          <td class="standings-team">${footballEntityName(row.team || '', row.teamMeta, 'team')}</td>
          <td>${escapeHtml(row.played || 0)}</td>
          <td>${escapeHtml(row.wins || 0)}</td>
          <td>${escapeHtml(row.draws || 0)}</td>
          <td>${escapeHtml(row.losses || 0)}</td>
          <td>${escapeHtml(row.goalsFor || 0)}</td>
          <td>${escapeHtml(row.goalsAgainst || 0)}</td>
          <td>${escapeHtml(row.goalDiff || 0)}</td>
          <td><strong>${escapeHtml(row.points || 0)}</strong></td>
          <td><div class="standings-form">${(row.results || []).map(result => `<span>${escapeHtml(result)}</span>`).join('') || '<span>--</span>'}</div></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}
async function initMatchesPage(){
  const auth = await getAuth();
  const isAdmin = auth.authenticated && auth.user?.role === 'admin';
  auth.system = auth.system || {};
  appShell({ auth, pageKey:'sports', title:'مركز المباريات', subtitle:'المباشرة أولاً، ثم القادمة، ثم النتائج السابقة مع جدول ترتيب ونقاط.' });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="matches-layout matches-page-layout">
      <aside class="filters-panel sticky">
        <div class="panel-pad">
          <h3 class="panel-title">تصفية المباريات</h3>
          <input class="input searchbar" id="matches-q" placeholder="ابحث عن فريق أو بطولة">
          <div class="filter-list match-status-filters" id="matches-status">
            <button class="filter-btn active" data-match-status="all">الكل</button>
            <button class="filter-btn" data-match-status="live">مباشرة</button>
            <button class="filter-btn" data-match-status="scheduled">قادمة</button>
            <button class="filter-btn" data-match-status="finished">سابقة</button>
          </div>
          <div class="filter-cluster" style="margin-top:12px">
            <div class="sidebar-label">البطولات</div>
            <div class="filter-list" id="matches-competitions"><button class="filter-btn active" data-match-competition="">كل البطولات</button></div>
          </div>
        </div>
      </aside>
      <section class="content-panel">
        <div class="panel-pad">
          <div class="toolbar">
            <div>
              <h2 class="section-title">المباريات</h2>
              <div class="section-subtitle">الترتيب يظهر المباشر في الأعلى، ثم القادم، ثم السابق.</div>
            </div>
            <div class="toolbar-group">
              <span class="tag" id="matches-count">0 مباراة</span>
              <span class="tag" id="matches-page-status">جاهز</span>
              ${isAdmin ? `<button class="button secondary small" id="worldcup-import-btn">تضمين كأس العالم 2026</button><button class="button success small" id="new-match-btn">إضافة مباراة</button>` : ''}
            </div>
          </div>
          ${isAdmin ? `<section class="config-card match-admin-card hidden" id="match-admin-card">
            <div class="section-header"><div><h3 class="panel-title">إدارة مباراة</h3><div class="section-subtitle">أضف النتيجة والوقت واربط المباراة بقناة بث.</div></div><button class="button secondary small" type="button" id="clear-match-form">تفريغ</button></div>
            <input type="hidden" id="match-id">
            <div class="settings-grid settings-grid-3">
              <div><label>البطولة</label><input class="input" id="match-competition" placeholder="كأس العالم 2026"></div>
              <div><label>الفريق الأول</label><input class="input" id="match-home" placeholder="الفريق الأول"></div>
              <div><label>الفريق الثاني</label><input class="input" id="match-away" placeholder="الفريق الثاني"></div>
              <div><label>وقت المباراة</label><input class="input" id="match-kickoff" type="datetime-local"></div>
              <div><label>الحالة</label><select class="select" id="match-status-field"><option value="scheduled">قادمة</option><option value="live">مباشرة الآن</option><option value="finished">انتهت</option><option value="postponed">مؤجلة</option><option value="cancelled">ملغاة</option></select></div>
              <div><label>القناة المرتبطة</label><select class="select" id="match-channel"><option value="">بدون قناة</option></select></div>
              <div><label>نتيجة الفريق الأول</label><input class="input" id="match-home-score" type="number" placeholder="0"></div>
              <div><label>نتيجة الفريق الثاني</label><input class="input" id="match-away-score" type="number" placeholder="0"></div>
              <div><label>الأولوية</label><input class="input" id="match-priority" type="number" value="0"></div>
              <div><label>الجولة</label><input class="input" id="match-round" placeholder="دور المجموعات"></div>
              <div><label>الملعب</label><input class="input" id="match-venue" placeholder="الملعب"></div>
              <div><label>إظهار</label><select class="select" id="match-visible"><option value="true">نعم</option><option value="false">لا</option></select></div>
              <div style="grid-column:1/-1"><label>عنوان مختصر</label><input class="input" id="match-headline" placeholder="قمة الليلة"></div>
              <div style="grid-column:1/-1"><label>ملخص</label><textarea class="textarea" id="match-summary" placeholder="ملخص المباراة"></textarea></div>
              <div style="grid-column:1/-1"><label>أخبار مختصرة، كل سطر خبر</label><textarea class="textarea" id="match-news"></textarea></div>
              <div style="grid-column:1/-1"><label>تفاصيل كاملة</label><textarea class="textarea" id="match-details"></textarea></div>
            </div>
            <div class="toolbar" style="margin-top:14px"><div class="muted" id="match-admin-status"></div><div class="toolbar-group"><button class="button success" id="save-match-btn">حفظ المباراة</button></div></div>
          </section>` : ''}
          <div id="matches-sections" class="match-sections"></div>
          <section class="section standings-section">
            <div class="section-header"><div><h2 class="section-title">جدول المتصدرين</h2><div class="section-subtitle">الترتيب والنقاط محسوبة من النتائج المسجلة.</div></div><a class="button secondary small" href="/football-standings">صفحة الترتيب</a></div>
            <div id="football-standings" class="standings-grid"><div class="empty">جاري تحميل جدول الترتيب...</div></div>
          </section>
          <div class="loading hidden" id="matches-loading">جاري تحميل المباريات...</div>
        </div>
      </section>
    </section>`;
  const state = { q:'', status:'all', competition:'', items:[], competitions:[], standings:[] };
  const sections = qs('#matches-sections');
  const loading = qs('#matches-loading');
  const count = qs('#matches-count');
  const statusTag = qs('#matches-page-status');
  let channelOptions = [];
  function renderCompetitions(){
    const html = [`<button class="filter-btn ${!state.competition ? 'active' : ''}" data-match-competition="">كل البطولات</button>`]
      .concat((state.competitions || []).filter(x => x.name).map(item => `<button class="filter-btn ${state.competition === item.name ? 'active' : ''}" data-match-competition="${escapeHtml(item.name)}"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(String(item.count || 0))}</small></button>`));
    qs('#matches-competitions').innerHTML = html.join('');
  }
  function renderMatches(){
    const visible = (state.items || []).filter(item => item.visible !== false);
    const live = sortMatchGroup(visible.filter(item => item.status === 'live'), 'asc');
    const upcoming = sortMatchGroup(visible.filter(item => ['scheduled', 'postponed', 'cancelled'].includes(item.status)), 'asc');
    const previous = sortMatchGroup(visible.filter(item => item.status === 'finished'), 'desc');
    const blocks = [];
    if (state.status === 'all' || state.status === 'live') {
      if (live.length || state.status === 'live') blocks.push(renderMatchSection('المباريات المباشرة', live, isAdmin, 'لا توجد مباريات مباشرة الآن.'));
    }
    if (state.status === 'all' || state.status === 'scheduled') {
      if (upcoming.length || state.status === 'scheduled') blocks.push(renderMatchSection('المباريات القادمة', upcoming, isAdmin, 'لا توجد مباريات قادمة حسب الفلتر.'));
    }
    if (state.status === 'all' || state.status === 'finished') {
      if (previous.length || state.status === 'finished') blocks.push(renderMatchSection('المباريات السابقة والنتائج', previous, isAdmin, 'لا توجد نتائج سابقة حسب الفلتر.'));
    }
    sections.innerHTML = blocks.length ? blocks.join('') : `<div class="empty">لا توجد مباريات مطابقة حاليًا.</div>`;
    count.textContent = `${visible.length} مباراة`;
  }
  function renderStandings(){
    const groups = state.standings || [];
    qs('#football-standings').innerHTML = groups.length ? groups.map(footballStandingsTable).join('') : `<div class="empty">لا توجد نتائج كافية لبناء جدول ترتيب بعد.</div>`;
  }
  async function loadMatches(){
    loading.classList.remove('hidden');
    try {
      const params = new URLSearchParams({ limit:'180', q:state.q || '' });
      if (state.status && state.status !== 'all') params.set('status', state.status);
      if (state.competition) params.set('competition', state.competition);
      const standingsParams = new URLSearchParams({ limitGroups:'18', q:state.q || '' });
      if (state.competition) standingsParams.set('competition', state.competition);
      const [data, standings] = await Promise.all([
        getJson(`/api/matches?${params.toString()}`),
        getJson(`/api/football/standings?${standingsParams.toString()}`).catch(()=>({ groups:[] }))
      ]);
      state.items = Array.isArray(data.items) ? data.items : [];
      state.competitions = Array.isArray(data.competitions) ? data.competitions : [];
      state.standings = Array.isArray(standings.groups) ? standings.groups : [];
      renderCompetitions();
      renderStandings();
      renderMatches();
      statusTag.textContent = data.generatedAt ? `تحديث: ${formatDate(data.generatedAt)}` : 'محدّث';
    } catch (e) {
      sections.innerHTML = `<div class="empty">${escapeHtml(e.error || e.message || 'تعذر تحميل المباريات')}</div>`;
      qs('#football-standings').innerHTML = `<div class="empty">تعذر تحميل جدول الترتيب.</div>`;
    } finally {
      loading.classList.add('hidden');
    }
  }
  function clearMatchForm(){
    if (!isAdmin) return;
    qs('#match-admin-card')?.classList.remove('hidden');
    ['match-id','match-competition','match-home','match-away','match-kickoff','match-home-score','match-away-score','match-priority','match-round','match-venue','match-headline','match-summary','match-news','match-details'].forEach(id => { const node = qs(`#${id}`); if (node) node.value = id === 'match-priority' ? '0' : ''; });
    qs('#match-status-field').value = 'scheduled';
    qs('#match-channel').value = '';
    qs('#match-visible').value = 'true';
    qs('#match-admin-status').textContent = 'جاهز لإضافة مباراة جديدة.';
    qs('#match-admin-card')?.scrollIntoView({ behavior:'smooth', block:'start' });
  }
  function fillMatchForm(match){
    qs('#match-admin-card')?.classList.remove('hidden');
    qs('#match-id').value = match.id || '';
    qs('#match-competition').value = match.competition || '';
    qs('#match-home').value = match.homeTeam || '';
    qs('#match-away').value = match.awayTeam || '';
    qs('#match-kickoff').value = toDatetimeLocal(match.kickoffAt || '');
    qs('#match-status-field').value = match.status || 'scheduled';
    qs('#match-home-score').value = match.homeScore ?? '';
    qs('#match-away-score').value = match.awayScore ?? '';
    qs('#match-priority').value = match.priority ?? 0;
    qs('#match-round').value = match.round || '';
    qs('#match-venue').value = match.venue || '';
    qs('#match-headline').value = match.headline || '';
    qs('#match-summary').value = match.summary || '';
    qs('#match-news').value = (match.news || []).join('\n');
    qs('#match-details').value = match.details || '';
    qs('#match-visible').value = match.visible === false ? 'false' : 'true';
    qs('#match-channel').value = match.linkedChannelId || '';
    qs('#match-admin-status').textContent = `تعديل: ${match.homeTeam || ''} ضد ${match.awayTeam || ''}`;
    qs('#match-admin-card')?.scrollIntoView({ behavior:'smooth', block:'start' });
  }
  function collectMatchForm(){
    return {
      competition: qs('#match-competition').value,
      homeTeam: qs('#match-home').value,
      awayTeam: qs('#match-away').value,
      kickoffAt: qs('#match-kickoff').value,
      status: qs('#match-status-field').value,
      homeScore: qs('#match-home-score').value,
      awayScore: qs('#match-away-score').value,
      priority: qs('#match-priority').value,
      round: qs('#match-round').value,
      venue: qs('#match-venue').value,
      headline: qs('#match-headline').value,
      summary: qs('#match-summary').value,
      newsText: qs('#match-news').value,
      details: qs('#match-details').value,
      visible: qs('#match-visible').value === 'true',
      linkedChannelId: qs('#match-channel').value
    };
  }
  async function loadAdminChannels(){
    if (!isAdmin) return;
    const data = await getJson('/api/admin/channels?includeHidden=false&limit=500').catch(()=>({items:[]}));
    channelOptions = Array.isArray(data.items) ? data.items : [];
    const select = qs('#match-channel');
    if (!select) return;
    select.innerHTML = `<option value="">بدون قناة</option>` + channelOptions.map(channel => `<option value="${escapeHtml(channel.id || '')}">${escapeHtml(channel.title || 'قناة')} - ${escapeHtml(channel.sourceName || '')}</option>`).join('');
  }
  qs('#matches-q').addEventListener('input', debounce(e => { state.q = e.target.value.trim(); loadMatches(); }, 300));
  qs('#matches-status').addEventListener('click', e => {
    const btn = e.target.closest('[data-match-status]');
    if (!btn) return;
    state.status = btn.dataset.matchStatus || 'all';
    qsa('[data-match-status]', qs('#matches-status')).forEach(node => node.classList.toggle('active', node === btn));
    loadMatches();
  });
  qs('#matches-competitions').addEventListener('click', e => {
    const btn = e.target.closest('[data-match-competition]');
    if (!btn) return;
    state.competition = btn.dataset.matchCompetition || '';
    loadMatches();
  });
  if (isAdmin) {
    qs('#new-match-btn').addEventListener('click', clearMatchForm);
    qs('#worldcup-import-btn').addEventListener('click', async () => {
      qs('#worldcup-import-btn').disabled = true;
      statusTag.textContent = 'جاري تضمين كأس العالم 2026...';
      const result = await getJson('/api/admin/worldcup/import', { method:'POST' }).catch(error => ({ error: error.error || error.message }));
      qs('#worldcup-import-btn').disabled = false;
      const status = result?.status || {};
      statusTag.textContent = result?.error || `كأس العالم: ${status.matchesImported || 0} جديد، ${status.matchesUpdated || 0} تحديث`;
      await loadMatches();
    });
    qs('#clear-match-form').addEventListener('click', clearMatchForm);
    qs('#save-match-btn').addEventListener('click', async () => {
      const id = qs('#match-id').value.trim();
      const payload = collectMatchForm();
      qs('#match-admin-status').textContent = 'جاري الحفظ...';
      try {
        await getJson(id ? `/api/admin/matches/${encodeURIComponent(id)}` : '/api/admin/matches', { method:id ? 'PUT' : 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        qs('#match-admin-status').textContent = 'تم حفظ المباراة.';
        qs('#match-admin-card')?.classList.add('hidden');
        await loadMatches();
      } catch (e) {
        qs('#match-admin-status').textContent = e.error || 'تعذر حفظ المباراة.';
      }
    });
    root.addEventListener('click', async e => {
      const edit = e.target.closest('[data-edit-match]');
      if (edit) {
        const match = state.items.find(item => item.id === edit.dataset.editMatch);
        if (match) fillMatchForm(match);
        return;
      }
      const del = e.target.closest('[data-delete-match]');
      if (!del) return;
      if (!confirm('حذف هذه المباراة؟')) return;
      await getJson(`/api/admin/matches/${encodeURIComponent(del.dataset.deleteMatch)}`, { method:'DELETE' }).catch(()=>null);
      await loadMatches();
    });
    await loadAdminChannels();
  }
  await loadMatches();
}
function sportBranchCard(href, icon, title, meta){
  return `<a class="sport-branch-card" href="${escapeHtml(href)}">
    <span class="sport-branch-icon">${escapeHtml(icon)}</span>
    <strong>${escapeHtml(title)}</strong>
    <small>${escapeHtml(meta || '')}</small>
  </a>`;
}
async function loadSportsChannels(){
  const terms = ['رياض', 'sport', 'bein', 'ssc', 'الكأس'];
  const responses = await Promise.all(terms.map(q => getJson(`/api/live?limit=14&q=${encodeURIComponent(q)}`).catch(()=>({ items:[] }))));
  const map = new Map();
  for (const response of responses) {
    for (const item of (Array.isArray(response.items) ? response.items : [])) {
      if (item?.id && !map.has(item.id)) map.set(item.id, item);
    }
  }
  return [...map.values()].slice(0, 12);
}
async function initSportsPage(){
  const auth = await getAuth();
  auth.system = auth.system || {};
  appShell({ auth, pageKey:'sports', title:'الرياضة', subtitle:'مركز واحد للمباريات، النتائج، الترتيب، الأخبار، المنتخبات والقنوات.' });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="sports-hub">
      <div class="sport-branches">
        ${sportBranchCard('/matches', '⚽', 'المباريات', 'مباشرة، قادمة، وسابقة')}
        ${sportBranchCard('/football-standings', '🏆', 'جدول الترتيب', 'النقاط والنتائج')}
        ${sportBranchCard('/football-news', '📰', 'الأخبار العربية', 'آخر أخبار كرة القدم')}
        ${sportBranchCard('/football-profiles', '👥', 'الأندية واللاعبون', 'منتخبات وأندية ولاعبون')}
        ${sportBranchCard('/teams', '🏳', 'المنتخبات', 'منتخبات كأس العالم')}
        ${sportBranchCard('/live', '📺', 'القنوات', 'قنوات رياضية مباشرة')}
      </div>
      <section class="section sport-preview-section">
        <div class="section-header"><div><h2 class="section-title">المباريات والنتائج</h2><div class="section-subtitle">ملخص سريع من مركز المباريات.</div></div><a class="button secondary small" href="/matches">كل المباريات</a></div>
        <div id="sports-matches-preview" class="match-sections"><div class="empty">جاري تحميل المباريات...</div></div>
      </section>
      <section class="section sport-preview-section">
        <div class="section-header"><div><h2 class="section-title">جدول المتصدرين</h2><div class="section-subtitle">أول المجموعات حسب النتائج المتوفرة.</div></div><a class="button secondary small" href="/football-standings">كل الترتيب</a></div>
        <div id="sports-standings-preview" class="standings-grid"><div class="empty">جاري تحميل الترتيب...</div></div>
      </section>
      <section class="section sport-preview-section">
        <div class="section-header"><div><h2 class="section-title">القنوات الرياضية</h2><div class="section-subtitle">قنوات مرتبطة بالمشاهدة المباشرة.</div></div><a class="button secondary small" href="/live">كل القنوات</a></div>
        <div id="sports-channels-preview" class="grid cards"><div class="empty">جاري تحميل القنوات...</div></div>
      </section>
    </section>`;
  const [matchesData, standingsData, sportsChannels] = await Promise.all([
    getJson('/api/matches?limit=60').catch(()=>({ items:[] })),
    getJson('/api/football/standings?limitGroups=2').catch(()=>({ groups:[] })),
    loadSportsChannels()
  ]);
  const matches = Array.isArray(matchesData.items) ? matchesData.items : [];
  const live = sortMatchGroup(matches.filter(item => item.status === 'live'), 'asc').slice(0, 3);
  const upcoming = sortMatchGroup(matches.filter(item => ['scheduled', 'postponed'].includes(item.status)), 'asc').slice(0, 3);
  const previous = sortMatchGroup(matches.filter(item => item.status === 'finished'), 'desc').slice(0, 3);
  qs('#sports-matches-preview').innerHTML = [
    renderMatchSection('مباشرة الآن', live, false, 'لا توجد مباريات مباشرة الآن.'),
    renderMatchSection('القادمة', upcoming, false, 'لا توجد مباريات قادمة.'),
    renderMatchSection('النتائج', previous, false, 'لا توجد نتائج مسجلة بعد.')
  ].join('');
  const standingsGroups = Array.isArray(standingsData.groups) ? standingsData.groups : [];
  qs('#sports-standings-preview').innerHTML = standingsGroups.length ? standingsGroups.map(footballStandingsTable).join('') : `<div class="empty">لا توجد نتائج كافية لبناء ترتيب بعد.</div>`;
  qs('#sports-channels-preview').innerHTML = sportsChannels.length ? sportsChannels.map(item => channelCard(item, true)).join('') : `<div class="empty">لا توجد قنوات رياضية مطابقة حاليًا.</div>`;
}
async function initFootballStandingsPage(){
  const auth = await getAuth();
  auth.system = auth.system || {};
  appShell({ auth, pageKey:'sports', title:'جدول الترتيب', subtitle:'ترتيب الفرق، النقاط، الأهداف وآخر النتائج.' });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="matches-layout football-standings-page">
      <aside class="filters-panel sticky"><div class="panel-pad">
        <h3 class="panel-title">تصفية الترتيب</h3>
        <input class="input searchbar" id="standings-q" placeholder="ابحث عن فريق أو بطولة">
        <div class="filter-cluster" style="margin-top:12px">
          <div class="sidebar-label">البطولات</div>
          <div class="filter-list" id="standings-competitions"><button class="filter-btn active" data-standing-competition="">كل البطولات</button></div>
        </div>
      </div></aside>
      <section class="content-panel"><div class="panel-pad">
        <div class="section-header"><div><h2 class="section-title">جدول الترتيب</h2><div class="section-subtitle">النقاط والترتيب حسب النتائج المسجلة.</div></div><a class="button secondary small" href="/matches">المباريات</a></div>
        <div id="standings-list" class="standings-grid"><div class="empty">جاري تحميل جدول الترتيب...</div></div>
      </div></section>
    </section>`;
  const state = { q:'', competition:'', competitions:[] };
  function renderCompetitions(){
    const html = [`<button class="filter-btn ${!state.competition ? 'active' : ''}" data-standing-competition="">كل البطولات</button>`]
      .concat((state.competitions || []).filter(x => x.name).map(item => `<button class="filter-btn ${state.competition === item.name ? 'active' : ''}" data-standing-competition="${escapeHtml(item.name)}"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(String(item.count || 0))}</small></button>`));
    qs('#standings-competitions').innerHTML = html.join('');
  }
  async function loadStandings(){
    const params = new URLSearchParams({ limitGroups:'36', q:state.q || '' });
    if (state.competition) params.set('competition', state.competition);
    const [standings, matches] = await Promise.all([
      getJson(`/api/football/standings?${params.toString()}`).catch(()=>({ groups:[] })),
      getJson('/api/matches?limit=1').catch(()=>({ competitions:[] }))
    ]);
    state.competitions = Array.isArray(matches.competitions) ? matches.competitions : [];
    renderCompetitions();
    const groups = Array.isArray(standings.groups) ? standings.groups : [];
    qs('#standings-list').innerHTML = groups.length ? groups.map(footballStandingsTable).join('') : `<div class="empty">لا توجد نتائج كافية لبناء جدول ترتيب بعد.</div>`;
  }
  qs('#standings-q').addEventListener('input', debounce(e => { state.q = e.target.value.trim(); loadStandings(); }, 300));
  qs('#standings-competitions').addEventListener('click', e => {
    const btn = e.target.closest('[data-standing-competition]');
    if (!btn) return;
    state.competition = btn.dataset.standingCompetition || '';
    loadStandings();
  });
  await loadStandings();
}
async function initFootballNewsPage(){
  const auth = await getAuth();
  const isAdmin = auth.authenticated && auth.user?.role === 'admin';
  auth.system = auth.system || {};
  appShell({ auth, pageKey:'sports', title:'الأخبار العربية', subtitle:'أخبار كرة القدم العربية المستوردة من مصادر RSS.' });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="matches-layout football-news-page">
      <aside class="filters-panel sticky"><div class="panel-pad">
        <h3 class="panel-title">تصفية الأخبار</h3>
        <input class="input searchbar" id="football-news-q" placeholder="ابحث في الأخبار العربية">
        <div class="toolbar-group vertical-actions">
          <span class="tag" id="football-news-count">0 خبر</span>
          <span class="tag" id="football-news-status">جاهز</span>
          ${isAdmin ? `<button class="button secondary small" id="football-import-btn">استيراد الأخبار الآن</button>` : ''}
        </div>
      </div></aside>
      <section class="content-panel"><div class="panel-pad">
        <div class="section-header"><div><h2 class="section-title">الأخبار بالعربية</h2><div class="section-subtitle">تعرض الأخبار التي تحتوي نصًا عربيًا فقط.</div></div></div>
        <div id="football-news-list" class="football-news-grid"><div class="empty">جاري تحميل الأخبار...</div></div>
      </div></section>
    </section>`;
  const mod = await ensureFootballInternetModule();
  const newsList = qs('#football-news-list');
  const count = qs('#football-news-count');
  const status = qs('#football-news-status');
  const state = { q:'' };
  function renderNews(items=[]){
    newsList.innerHTML = items.length ? items.map(item => mod.newsCard ? mod.newsCard(item) : `<a class="football-news-card" href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener"><div class="football-news-fallback">⚽</div><div><h3>${escapeHtml(item.title || 'خبر')}</h3><p>${escapeHtml(item.summary || '')}</p></div></a>`).join('') : `<div class="empty">لا توجد أخبار عربية مستوردة حاليًا.</div>`;
    count.textContent = `${items.length} خبر`;
  }
  async function loadNews(){
    const params = new URLSearchParams({ limit:'80', lang:'ar', topic:'football', q:state.q || '' });
    const data = await getJson(`/api/football/news?${params.toString()}`).catch(e => ({ items:[], error:e.error || e.message }));
    renderNews(Array.isArray(data.items) ? data.items : []);
    const importStatus = data.importStatus || {};
    status.textContent = data.error || (importStatus.running ? 'جاري الاستيراد...' : (importStatus.lastFinishedAt ? `آخر استيراد: ${formatDate(importStatus.lastFinishedAt)}` : 'جاهز'));
  }
  qs('#football-news-q').addEventListener('input', debounce(e => { state.q = e.target.value.trim(); loadNews(); }, 300));
  if (isAdmin) {
    qs('#football-import-btn').addEventListener('click', async () => {
      const btn = qs('#football-import-btn');
      btn.disabled = true;
      status.textContent = 'جاري الاستيراد...';
      await getJson('/api/admin/football/import', { method:'POST' }).catch(()=>null);
      btn.disabled = false;
      await loadNews();
    });
  }
  await loadNews();
}
async function initFootballProfilesPage(initialKind='all'){
  const auth = await getAuth();
  auth.system = auth.system || {};
  const startingKind = ['all', 'team', 'club', 'player'].includes(initialKind) ? initialKind : 'all';
  appShell({ auth, pageKey:'sports', title:'الأندية واللاعبون', subtitle:'صفحة مستقلة للمنتخبات والأندية واللاعبين بعيدًا عن جدول المباريات.' });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="matches-layout football-profiles-page">
      <aside class="filters-panel sticky"><div class="panel-pad">
        <h3 class="panel-title">تصفية القائمة</h3>
        <input class="input searchbar" id="football-profiles-q" placeholder="ابحث عن منتخب أو نادي أو لاعب">
        <div class="filter-list" id="football-profile-kind">
          <button class="filter-btn ${startingKind === 'all' ? 'active' : ''}" data-profile-kind="all">الكل</button>
          <button class="filter-btn ${startingKind === 'team' ? 'active' : ''}" data-profile-kind="team">المنتخبات</button>
          <button class="filter-btn ${startingKind === 'club' ? 'active' : ''}" data-profile-kind="club">الأندية</button>
          <button class="filter-btn ${startingKind === 'player' ? 'active' : ''}" data-profile-kind="player">اللاعبون</button>
        </div>
        <span class="tag" id="football-profiles-count">0 عنصر</span>
      </div></aside>
      <section class="content-panel"><div class="panel-pad">
        <div class="section-header"><div><h2 class="section-title">الأندية واللاعبون</h2><div class="section-subtitle">كل عنصر في بطاقة منفصلة وسهلة القراءة.</div></div></div>
        <div id="football-profiles-list" class="football-profile-grid"><div class="empty">جاري تحميل القائمة...</div></div>
      </div></section>
    </section>`;
  const mod = await ensureFootballInternetModule();
  const list = qs('#football-profiles-list');
  const count = qs('#football-profiles-count');
  const state = { q:'', kind:startingKind };
  function renderProfiles(items=[]){
    list.innerHTML = items.length ? items.map(item => mod.profileCard ? mod.profileCard(item) : `<article class="football-profile-card"><div class="football-profile-fallback">${item.type === 'player' ? '👤' : '🏟'}</div><div><h3>${escapeHtml(item.title || item.name || '')}</h3><p>${escapeHtml(item.summary || '')}</p></div></article>`).join('') : `<div class="empty">لا توجد عناصر مطابقة حاليًا.</div>`;
    count.textContent = `${items.length} عنصر`;
  }
  async function loadProfiles(){
    const params = new URLSearchParams({ limit:'120', q:state.q || '' });
    if (state.kind !== 'all') params.set('kind', state.kind);
    const data = await getJson(`/api/football/profiles?${params.toString()}`).catch(()=>({ items:[] }));
    renderProfiles(Array.isArray(data.items) ? data.items : []);
  }
  qs('#football-profiles-q').addEventListener('input', debounce(e => { state.q = e.target.value.trim(); loadProfiles(); }, 300));
  qs('#football-profile-kind').addEventListener('click', e => {
    const btn = e.target.closest('[data-profile-kind]');
    if (!btn) return;
    state.kind = btn.dataset.profileKind || 'all';
    qsa('[data-profile-kind]', qs('#football-profile-kind')).forEach(node => node.classList.toggle('active', node === btn));
    loadProfiles();
  });
  await loadProfiles();
}
async function initWorldCupTeamsPage(){
  return initFootballProfilesPage('team');
}
async function initListingPage(type){
  if (type === 'live') return initLiveGroupedPage();
  if (type !== 'audio') return __legacyInitListingPage(type);
  const auth = await getAuth();
  const meta = await getJson('/api/meta').catch(()=>({libraries:[],sources:[],system:{}}));
  const favorites = await createFavoritesController(auth);
  auth.system = auth.system || meta.system || {};
  const labels = { title:'الصوتيات', subtitle:'مكتبات صوتية مع تصفح حسب المجلدات وتحكم بالتنزيل لكل مكتبة.', endpoint:'/api/audio', search:'ابحث عن ملف صوتي...' };
  const sourceItems = (meta.libraries || []).filter(x => x.type === 'audio');
  const prefKey = `listing:${type}`;
  const urlState = Object.fromEntries(new URLSearchParams(location.search).entries());
  const hasInitialFilter = ['q','sort','libraryId','folder','view','browseMode'].some(key => urlState[key] !== undefined);
  const saved = { q:'', sort:'new', libraryId:'', folder:'', view:'grid', browseMode:'folders', ...urlState };
  try { localStorage.removeItem(userStorageKey(auth, prefKey)); } catch {}
  const scrollMemory = initScrollMemory(auth, prefKey);
  appShell({ auth, pageKey:type, title:labels.title, subtitle:labels.subtitle });
  const root = qs('#page-root');
  root.innerHTML = `
    <section class="page-layout emby-layout">
      <aside class="filters-panel emby-filters">
        <div class="panel-pad filters-bar">
          <div class="panel-group panel-group-main">
            <h3 class="panel-title">لوحة التصفية</h3>
            <input class="input searchbar" id="search-input" placeholder="${labels.search}" value="${escapeHtml(saved.q)}">
            <select class="select" id="sort-select">
              <option value="new" ${saved.sort==='new'?'selected':''}>آخر تحديث أولاً</option>
              <option value="old" ${saved.sort==='old'?'selected':''}>آخر تحديث الأقدم</option>
              <option value="created-desc" ${saved.sort==='created-desc'?'selected':''}>تاريخ الإنشاء الأحدث</option>
              <option value="created-asc" ${saved.sort==='created-asc'?'selected':''}>تاريخ الإنشاء الأقدم</option>
              <option value="name" ${saved.sort==='name'?'selected':''}>حسب الاسم</option>
              <option value="rating-desc" ${saved.sort==='rating-desc'?'selected':''}>التقييم العالمي الأعلى</option>
              <option value="rating-asc" ${saved.sort==='rating-asc'?'selected':''}>التقييم العالمي الأقل</option>
              <option value="popular-desc" ${saved.sort==='popular-desc'?'selected':''}>الأكثر شيوعًا</option>
              <option value="recommended-desc" ${saved.sort==='recommended-desc'?'selected':''}>اقتراحات ذكية</option>
              <option value="year-desc" ${saved.sort==='year-desc'?'selected':''}>السنة الأحدث</option>
              <option value="year-asc" ${saved.sort==='year-asc'?'selected':''}>السنة الأقدم</option>
            </select>
          </div>
          <div class="panel-group panel-group-chips">
            <div class="filter-cluster"><div class="sidebar-label">المكتبات</div><div class="filter-list" id="library-filters">${buildLibraryButtons(sourceItems, saved.libraryId, 'كل المكتبات')}</div></div>
            <div class="filter-cluster"><div class="sidebar-label">طريقة العرض</div><div class="pill-toggle" id="browse-mode-toggle"><button class="button secondary small ${saved.browseMode==='all'?'active':''}" data-browse-mode="all">كافة العناصر</button><button class="button secondary small ${saved.browseMode==='folders'?'active':''}" data-browse-mode="folders">حسب المجلدات</button></div></div>
            <div class="filter-cluster"><div class="sidebar-label">نمط العرض</div><div class="pill-toggle"><button class="button secondary small ${saved.view==='grid'?'active':''}" data-view="grid">شبكة</button><button class="button secondary small ${saved.view==='list'?'active':''}" data-view="list">قائمة</button></div></div>
          </div>
        </div>
        <div id="folder-tree-section" class="folder-tree-panel ${saved.browseMode==='folders'?'':'hidden'}"><div class="folder-tree-head"><div><div class="sidebar-label">استعراض المجلدات</div><h4 class="folder-tree-title">تصفح متدرج حسب المجلدات</h4></div><span class="tag">صوتيات ومجلدات</span></div><div class="folder-tree" id="folder-tree"><div class="empty">سيتم تحميل المجلدات...</div></div></div>
      </aside>
      <section class="content-panel listing-shell"><div class="panel-pad listing-head"><div class="toolbar"><div><h2 class="section-title">${labels.title}</h2><div class="section-subtitle">${labels.subtitle}</div></div><div class="toolbar-group"><span class="tag" id="results-tag">0 عنصر</span><button class="button secondary small" id="reset-filters">تصفير الفلاتر</button></div></div><div class="chips" id="active-chips"></div><div id="folder-summary" class="hidden"></div><div id="listing-wrap" class="${saved.view==='list' ? 'list-view' : ''}"><div class="grid cards" id="listing-grid"></div></div><div id="folder-extra" class="hidden"></div><div class="loading hidden" id="listing-loading">جاري تحميل العناصر...</div><div class="loading hidden" id="listing-end">تم الوصول إلى نهاية النتائج</div><div id="listing-sentinel"></div></div></section>
    </section>`;
  const state = { ...saved, page:1, loading:false, hasMore:true, folderNodes:[], folderPage:1, folderHasMore:true, folderLoading:false, folderTotal:0 };
  const grid = qs('#listing-grid'); const loading = qs('#listing-loading'); const end = qs('#listing-end'); const folderTree = qs('#folder-tree'); const folderSummary = qs('#folder-summary'); const folderExtra = qs('#folder-extra'); const sentinel = qs('#listing-sentinel');
  if (hasInitialFilter && window.history?.replaceState) window.history.replaceState(window.history.state, document.title, location.pathname);
  function persist(){}
  function syncChips(){ const chips = []; if (state.browseMode === 'folders') chips.push('الوضع: حسب المجلدات'); else chips.push('الوضع: كافة العناصر'); if (state.q) chips.push(`بحث: ${state.q}`); if (state.sort === 'old') chips.push('الترتيب: الأقدم'); if (state.sort === 'name') chips.push('الترتيب: الاسم'); if (state.sort === 'created-desc') chips.push('الترتيب: الإنشاء الأحدث'); if (state.sort === 'created-asc') chips.push('الترتيب: الإنشاء الأقدم'); if (state.sort === 'rating-desc') chips.push('الترتيب: التقييم العالمي الأعلى'); if (state.sort === 'rating-asc') chips.push('الترتيب: التقييم العالمي الأقل'); if (state.sort === 'popular-desc') chips.push('الترتيب: الأكثر شيوعًا'); if (state.sort === 'recommended-desc') chips.push('الترتيب: اقتراحات ذكية'); if (state.sort === 'year-desc') chips.push('الترتيب: السنة الأحدث'); if (state.sort === 'year-asc') chips.push('الترتيب: السنة الأقدم'); if (state.libraryId) { const obj = sourceItems.find(x => x.id === state.libraryId); chips.push(`المكتبة: ${obj?.name || state.libraryId}`); } if (state.folder) chips.push(`المجلد الحالي: ${state.folder}`); qs('#active-chips').innerHTML = chips.length ? chips.map(x => `<span class="tag">${escapeHtml(x)}</span>`).join('') : `<span class="tag">بدون فلاتر</span>`; }
  function itemRenderer(item){ return audioCard(item); }
  function renderFavoriteAwareItem(item){
    const payload = mediaFavoritePayload(item, 'audio');
    const favoriteHtml = auth.authenticated ? itemFavoriteButton(payload, favorites.has(payload.type, payload.id)) : '';
    return audioCard(item, false, favoriteHtml);
  }
  function makeNodeFavoritePayload(node){
    const library = sourceItems.find(x => x.id === state.libraryId);
    return folderFavoritePayload({
      type,
      libraryId: state.libraryId || '',
      libraryName: library?.name || '',
      folderPath: node.path || '',
      name: node.name || node.path || 'مجلد',
      itemCount: node.itemCount || 0,
      childCount: node.childCount || 0,
      poster: node.poster || null
    });
  }
  function updateView(){ qs('#listing-wrap').classList.toggle('list-view', state.view === 'list'); qsa('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view)); qsa('[data-browse-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.browseMode === state.browseMode)); const sec = qs('#folder-tree-section'); if (sec) sec.classList.toggle('hidden', state.browseMode !== 'folders'); }
  function renderFolderHeader(nodes, directTotal){ if (state.browseMode !== 'folders') { folderSummary.classList.add('hidden'); folderSummary.innerHTML = ''; return; } const crumbs = [{ label:'كل المجلدات', path:'' }]; let acc = ''; String(state.folder || '').split('/').filter(Boolean).forEach(part => { acc = acc ? `${acc}/${part}` : part; crumbs.push({ label: part, path: acc }); }); folderSummary.classList.remove('hidden'); folderSummary.innerHTML = `<div class="folder-summary-box"><div class="folder-summary-head"><div><div class="sidebar-label" style="margin:0 0 4px;padding:0">التصفح بالمجلدات</div><div class="folder-current">${escapeHtml(state.folder || 'كل المجلدات')}</div></div><div class="chips"><span class="tag">${nodes.length} مجلد</span><span class="tag">${directTotal || 0} عنصر مباشر</span></div></div><div class="folder-breadcrumbs">${crumbs.map((crumb, idx) => `<button class="crumb ${idx === crumbs.length - 1 ? 'active' : ''}" data-folder-open="${escapeHtml(crumb.path)}">${escapeHtml(crumb.label)}</button>`).join('<span class="crumb-sep">/</span>')}</div></div>`; }
  async function loadFolderBrowser(reset=true, preserveTreeScroll=false){ if (state.folderLoading) return state.folderNodes || []; const prevScroll = preserveTreeScroll ? folderTree.scrollTop : 0; if (reset) { state.folderPage = 1; state.folderHasMore = true; state.folderNodes = []; state.folderTotal = 0; folderTree.innerHTML = `<div class="loading">جاري تحميل المجلدات...</div>`; } if (!state.folderHasMore && !reset) return state.folderNodes || []; state.folderLoading = true; try { const params = new URLSearchParams({ page:String(state.folderPage), limit:'240' }); if (state.libraryId) params.set('libraryId', state.libraryId); if (state.folder) params.set('parent', state.folder); if (state.q) params.set('q', state.q); const data = await getJson(`/api/folders/audio?${params.toString()}`); const incoming = Array.isArray(data.nodes) ? data.nodes : []; state.folderNodes = reset ? incoming : state.folderNodes.concat(incoming); state.folderHasMore = !!data.hasMore; state.folderTotal = Number(data.total || state.folderNodes.length || 0); if (incoming.length) state.folderPage += 1; folderTree.innerHTML = buildFolderBrowser({ ...data, nodes: state.folderNodes, total: state.folderTotal, hasMore: state.folderHasMore }, state.folder); if (preserveTreeScroll) folderTree.scrollTop = prevScroll; return state.folderNodes; } catch (e) { if (reset) state.folderNodes = []; folderTree.innerHTML = `<div class="empty compact">${escapeHtml(e.error || e.message || 'تعذر تحميل المجلدات')}</div>`; return state.folderNodes || []; } finally { state.folderLoading = false; } }
  async function loadAllMode(reset=false, preserveScroll=false){ if (state.loading) return; const restoreY = preserveScroll ? (window.scrollY || 0) : null; const keepHeight = reset ? grid.offsetHeight : 0; if (reset) { state.page = 1; state.hasMore = true; if (keepHeight > 0) grid.style.minHeight = keepHeight + 'px'; grid.innerHTML=''; end.classList.add('hidden'); } if (!state.hasMore) return; state.loading = true; loading.classList.remove('hidden'); if (folderSummary) { folderSummary.classList.add('hidden'); folderSummary.innerHTML = ''; } if (folderExtra) { folderExtra.classList.add('hidden'); folderExtra.innerHTML = ''; } try { const params = new URLSearchParams({ page:String(state.page), limit:String(DEFAULT_PAGE_SIZE), sort:state.sort, q:state.q || '' }); if (state.libraryId) params.set('libraryId', state.libraryId); if (state.folder) params.set('folder', state.folder); const data = await getJson(`/api/audio?${params.toString()}`); grid.insertAdjacentHTML('beforeend', (data.items || []).map(renderFavoriteAwareItem).join('')); state.hasMore = !!data.hasMore; state.page += 1; qs('#results-tag').textContent = `${data.total || grid.children.length} عنصر`; if (!state.hasMore) end.classList.remove('hidden'); } catch (e) { if (!grid.children.length) grid.innerHTML = `<div class="empty">${escapeHtml(e.error || e.message || 'تعذر تحميل البيانات')}</div>`; } finally { syncChips(); loading.classList.add('hidden'); state.loading = false; if (reset) requestAnimationFrame(() => { grid.style.minHeight = ''; if (restoreY !== null) window.scrollTo({ top: restoreY, behavior:'auto' }); }); } }
  async function loadFolderMode(reset=false, preserveScroll=false){ if (state.loading) return; const restoreY = preserveScroll ? (window.scrollY || 0) : null; const keepHeight = reset ? grid.offsetHeight : 0; if (reset) { state.page = 1; state.hasMore = true; if (keepHeight > 0) grid.style.minHeight = keepHeight + 'px'; grid.innerHTML=''; end.classList.add('hidden'); if (folderExtra) { folderExtra.classList.add('hidden'); folderExtra.innerHTML = ''; } await loadFolderBrowser(true, true); } state.loading = true; loading.classList.remove('hidden'); try { const nodes = state.folderNodes || []; const params = new URLSearchParams({ page:String(state.page), limit:String(DEFAULT_PAGE_SIZE), sort:state.sort, q:state.q || '', directOnly:'1' }); if (state.libraryId) params.set('libraryId', state.libraryId); if (state.folder) params.set('folder', state.folder); const data = await getJson(`/api/audio?${params.toString()}`); if (reset) { const folderCards = nodes.length ? nodes.map(node => { const payload = makeNodeFavoritePayload(node); return folderItemCard(node, auth.authenticated ? payload : null, auth.authenticated ? favorites.has(payload.type, payload.id) : false); }).join('') : ''; const itemCards = (data.items || []).map(renderFavoriteAwareItem).join(''); if (nodes.length) { grid.innerHTML = folderCards; if (folderExtra) { folderExtra.classList.toggle('hidden', !itemCards); folderExtra.innerHTML = itemCards ? `<section class="section"><div class="section-header"><div><h3 class="section-title">عناصر هذا المجلد</h3><div class="section-subtitle">العناصر المباشرة داخل المسار الحالي فقط</div></div></div><div class="grid cards ${state.view==='list'?'list-view':''}" id="folder-direct-grid">${itemCards}</div></section>` : ''; } } else { grid.innerHTML = itemCards || `<div class="empty">لا توجد عناصر داخل هذا المجلد.</div>`; if (folderExtra) { folderExtra.classList.add('hidden'); folderExtra.innerHTML = ''; } } } else { if (nodes.length && folderExtra && !folderExtra.classList.contains('hidden')) { const directGrid = qs('#folder-direct-grid', folderExtra); if (directGrid) directGrid.insertAdjacentHTML('beforeend', (data.items || []).map(renderFavoriteAwareItem).join('')); } else { grid.insertAdjacentHTML('beforeend', (data.items || []).map(renderFavoriteAwareItem).join('')); } } state.hasMore = !!data.hasMore; state.page += 1; const totalShown = (data.total || 0) + (state.folderTotal || nodes.length || 0); qs('#results-tag').textContent = `${totalShown} نتيجة`; renderFolderHeader(nodes, data.total || 0); if (!state.hasMore) end.classList.remove('hidden'); } catch (e) { if (!grid.children.length) grid.innerHTML = `<div class="empty">${escapeHtml(e.error || e.message || 'تعذر تحميل بيانات هذا المجلد')}</div>`; } finally { syncChips(); loading.classList.add('hidden'); state.loading = false; requestAnimationFrame(() => { grid.style.minHeight = ''; if (restoreY !== null) window.scrollTo({ top: restoreY, behavior:'auto' }); }); } }
  async function refresh(reset=true, preserveScroll=false){ updateView(); if (state.browseMode === 'folders') return loadFolderMode(reset, preserveScroll); return loadAllMode(reset, preserveScroll); }
  qs('#search-input').addEventListener('input', debounce(e => { state.q = e.target.value.trim(); persist(); refresh(true); }, 300));
  qs('#sort-select').addEventListener('change', e => { state.sort = e.target.value; persist(); refresh(true); });
  qs('#library-filters').addEventListener('click', async e => { const btn = e.target.closest('[data-library]'); if (!btn) return; state.libraryId = btn.dataset.library || ''; state.folder=''; persist(); state.page = 1; qsa('[data-library]', qs('#library-filters')).forEach(x => x.classList.toggle('active', x===btn)); await refresh(true, true); });
  folderTree.addEventListener('click', async e => { const moreBtn = e.target.closest('[data-folder-more]'); if (moreBtn) { await loadFolderBrowser(false, true); return; } const btn = e.target.closest('[data-folder-nav]'); if (!btn) return; state.folder = btn.dataset.folderNav || ''; persist(); state.page = 1; await refresh(true, true); });
  folderSummary.addEventListener('click', async e => { const btn = e.target.closest('[data-folder-open]'); if (!btn) return; state.folder = btn.dataset.folderOpen || ''; persist(); state.page = 1; await refresh(true, true); });
  root.addEventListener('click', async e => { const favoriteItemBtn = e.target.closest('[data-favorite-item]'); if (favoriteItemBtn) { e.preventDefault(); e.stopPropagation(); const payload = { type: favoriteItemBtn.dataset.favoriteType, id: favoriteItemBtn.dataset.favoriteId, title: favoriteItemBtn.dataset.favoriteTitle, subtitle: favoriteItemBtn.dataset.favoriteSubtitle, href: favoriteItemBtn.dataset.favoriteHref, poster: favoriteItemBtn.dataset.favoritePoster || null }; const result = await favorites.toggle(payload).catch(()=>null); if (result) { favoriteItemBtn.classList.toggle('active', !!result.favorite); favoriteItemBtn.textContent = result.favorite ? '♥' : '♡'; favoriteItemBtn.setAttribute('aria-label', result.favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'); } return; } const favoriteBtn = e.target.closest('[data-favorite-folder]'); if (favoriteBtn) { e.preventDefault(); e.stopPropagation(); const payload = { type: favoriteBtn.dataset.favoriteType, id: favoriteBtn.dataset.favoriteId, title: favoriteBtn.dataset.favoriteTitle, subtitle: favoriteBtn.dataset.favoriteSubtitle, href: favoriteBtn.dataset.favoriteHref, poster: favoriteBtn.dataset.favoritePoster || null }; const result = await favorites.toggle(payload).catch(()=>null); if (result) { favoriteBtn.classList.toggle('active', !!result.favorite); favoriteBtn.textContent = result.favorite ? '♥' : '♡'; favoriteBtn.setAttribute('aria-label', result.favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'); } return; } const folderBtn = e.target.closest('[data-folder-open]'); if (folderBtn && !folderSummary.contains(folderBtn)) { state.folder = folderBtn.dataset.folderOpen || ''; persist(); state.page = 1; await refresh(true, true); } });
  qsa('[data-view]').forEach(btn => btn.addEventListener('click', ()=>{ state.view = btn.dataset.view; persist(); updateView(); refresh(true, true); }));
  qsa('[data-browse-mode]').forEach(btn => btn.addEventListener('click', async ()=>{ state.browseMode = btn.dataset.browseMode; if (state.browseMode === 'all') state.folder = ''; persist(); await refresh(true, true); }));
  qs('#reset-filters').addEventListener('click', async ()=>{ Object.assign(state, { q:'', sort:'new', libraryId:'', folder:'', view:'grid', browseMode:'folders' }); qs('#search-input').value=''; qs('#sort-select').value='new'; persist(); await refresh(true, true); });
  updateView(); syncChips(); await loadFolderBrowser(true, false); await refresh(true); scrollMemory.restore(); attachInfiniteScroll(sentinel, ()=> { if (state.browseMode === 'folders' && state.folderNodes.length && qs('#folder-direct-grid', folderExtra || document)) { if (state.hasMore) loadFolderMode(false); return; } if (state.hasMore) { if (state.browseMode === 'folders') loadFolderMode(false); else loadAllMode(false); } });
}
function buildSettingsNav(current='system'){
  const items = [
    ['all','☰','كل الإعدادات','عرض كامل'],
    ['assistant','✦','المساعد','تشخيص وتوصيات'],
    ['system','🎬','هوية النظام','الشعار والمظهر'],
    ['libraries','🗂','المكتبات','إضافة وتنظيم'],
    ['live','📡','البث المباشر','مصادر وقنوات'],
    ['access','🔐','الوصول','الحسابات والصلاحيات'],
    ['scan','⚡','الفحص','الحالة والجدولة']
  ];
  return items.map(([k, icon, label, meta]) => `
    <button class="filter-btn settings-nav-btn ${current===k?'active':''}" data-section="${k}">
      <span class="settings-nav-btn-icon">${icon}</span>
      <span class="settings-nav-btn-copy">
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(meta)}</small>
      </span>
    </button>
  `).join('');
}
async function initSettingsPage(){
  const auth = await getAuth(); if (!auth.authenticated || auth.user.role !== 'admin') { location.href='/login'; return; }
  const cfg = await getJson('/api/settings?includeDiagnostics=0&includeDevices=0');
  cfg.deviceCatalog = {
    video: Array.isArray(cfg.deviceCatalog?.video) ? cfg.deviceCatalog.video : [],
    audio: Array.isArray(cfg.deviceCatalog?.audio) ? cfg.deviceCatalog.audio : [],
    ffmpegPath: cfg.deviceCatalog?.ffmpegPath || '',
    loaded: !!cfg.deviceCatalog?.loaded,
    error: cfg.deviceCatalog?.error || ''
  };
  cfg.liveStatus = cfg.liveStatus || [];
  cfg.yacineTv = { enabled:false, refreshOnStartup:true, scanAfterRefresh:true, refreshIntervalHours:2, ...(cfg.yacineTv || {}) };
  cfg.yacineTvStatus = cfg.yacineTvStatus || { enabled: cfg.yacineTv.enabled === true, running:false, source:null, status:null };
  cfg.libraryConvertJobs = Array.isArray(cfg.libraryConvertJobs) ? cfg.libraryConvertJobs : [];
  cfg.diagnostics = cfg.diagnostics || { recommendations:[], libraries:[], sources:[], storage:[], profiles:[], counts:{}, readinessScore:0, generatedAt:null };
  cfg.sourceTestResults = cfg.sourceTestResults && typeof cfg.sourceTestResults === 'object' ? cfg.sourceTestResults : {};
  auth.system = auth.system || cfg.system || {};
  const saved = loadState(auth, 'settings-ui-v13', { section:'all' });
  appShell({ auth, pageKey:'settings', title:'لوحة إدارة النظام', subtitle:'إدارة هوية النظام، المكتبات، الصوتيات، التحكم بالتنزيل، ومصادر USB Video Capture.' });
  const root = qs('#page-root');
  root.innerHTML = `<section class="settings-layout settings-layout-pro"><aside class="settings-sidebar sticky"><div class="panel-pad settings-side-panel"><div class="settings-side-brand"><span class="brand-badge"></span><div class="settings-side-brand-copy"><strong>Control Studio</strong><span>وضع سينمائي لإدارة النظام بالكامل</span></div></div><h3 class="panel-title">الأقسام</h3><div class="settings-nav" id="settings-nav">${buildSettingsNav(saved.section)}</div><div class="notice settings-side-note" style="margin-top:14px">واجهة تحكم أسهل: حفظ واضح، إضافة أسرع، ومتابعة مباشرة لحالة النظام والمكتبات والبث.</div></div></aside><section class="settings-main"><div class="panel-pad settings-main-pad"><div class="settings-page-head"><div class="settings-page-copy"><div class="settings-page-kicker">LIGHT MEDIA CONTROL</div><h2 class="section-title">مركز تحكم سينمائي</h2><div class="section-subtitle">طابع داكن احترافي مع عمليات إضافة وتعديل أوضح، وشريط أوامر ثابت، وبطاقات تنظيم أسهل أثناء إدارة المكتبات والمصادر.</div><div class="settings-head-chips"><span class="tag">Dark Navy</span><span class="tag">Cinematic Orange</span><span class="tag">Electric Purple</span></div></div><div class="settings-head-visual" aria-hidden="true"><div class="cinema-film-strip"></div><div class="cinema-poster-stack"><span>Movies</span><span>Series</span><span>Live</span></div></div><div class="settings-top-actions"><button class="button success" id="save-btn">حفظ التغييرات</button><button class="button warning" id="scan-all-btn">فحص الكل</button><button class="button secondary" id="refresh-diagnostics">تحديث الحالة</button><button class="button danger hidden" id="scan-cancel-btn">إيقاف الفحص</button></div></div><div class="settings-summary-row" id="settings-summary-row"></div><div id="settings-status" class="notice hidden"></div><div id="scan-status-box" class="library-card settings-scan-box" style="margin-bottom:16px"></div><div id="settings-sections"></div><div class="settings-action-dock" id="settings-action-dock"><div class="settings-action-dock-meta"><strong>الإعدادات</strong><span class="muted" data-dirty-indicator>كل التغييرات محفوظة</span></div><div class="toolbar-group"><button class="button success" data-save-settings>حفظ الآن</button><button class="button warning" data-scan-all>فحص الكل</button><button class="button danger hidden" data-cancel-scan>إيقاف الفحص</button></div></div></div></section></section>`;
  let hasUnsavedChanges = false;
  let selectedLibraryIndex = clampIndex(saved.selectedLibraryIndex, cfg.libraries?.length || 0);
  let selectedSourceIndex = clampIndex(saved.selectedSourceIndex, cfg.iptv?.sources?.length || 0);
  let libraryManagerState = { q:'', type:'all', sort:'name', ...(saved.libraryManager || {}) };
  let sourceManagerState = { q:'', type:'all', status:'all', sort:'name', ...(saved.sourceManager || {}) };
  const savedChannelManager = saved.channelManager || {};
  const channelManager = {
    sourceId: saved.channelSourceId || savedChannelManager.sourceId || '',
    group: savedChannelManager.group || '',
    q: savedChannelManager.q || '',
    includeHidden: savedChannelManager.includeHidden ?? true,
    sort: savedChannelManager.sort || 'default',
    page: 1,
    limit: 100,
    total: 0,
    hasMore: false,
    items: [],
    groups: [],
    loading: false,
    loaded: false,
    error: ''
  };
  let channelSearchTimer = null;
  function clampIndex(value, length){
    const count = Number(length || 0);
    const index = Number(value || 0);
    if (!Number.isFinite(index) || count <= 0) return 0;
    return Math.max(0, Math.min(Math.floor(index), count - 1));
  }
  function saveSettingsUiSelection(){
    saved.selectedLibraryIndex = selectedLibraryIndex;
    saved.selectedSourceIndex = selectedSourceIndex;
    saved.libraryManager = libraryManagerState;
    saved.sourceManager = sourceManagerState;
    saved.channelSourceId = channelManager.sourceId || '';
    saved.channelManager = {
      sourceId: channelManager.sourceId || '',
      group: channelManager.group || '',
      q: channelManager.q || '',
      includeHidden: channelManager.includeHidden !== false,
      sort: channelManager.sort || 'default'
    };
    saveState(auth, 'settings-ui-v12', saved);
  }
  function renderSettingsSummary(){
    const diag = cfg.diagnostics || {};
    const counts = diag.counts || {};
    const score = diag.readinessScore ?? 0;
    return [
      `<span class="tag">جاهزية النظام: ${escapeHtml(String(score))}%</span>`,
      `<span class="tag">المكتبات: ${escapeHtml(String(cfg.libraries?.length || 0))}</span>`,
      `<span class="tag">المصادر: ${escapeHtml(String(cfg.iptv?.sources?.length || 0))}</span>`,
      `<span class="tag">العناصر المفهرسة: ${escapeHtml(String(counts.total || 0))}</span>`,
      `<span class="tag">البروفايل: ${escapeHtml(cfg.system?.setupProfile || 'recommended')}</span>`
    ].join('');
  }
  function syncSettingsSummary(){
    const row = qs('#settings-summary-row');
    if (row) row.innerHTML = renderSettingsSummary();
  }
  function syncDirtyIndicators(){
    qsa('[data-dirty-indicator]').forEach(node => {
      node.textContent = hasUnsavedChanges ? 'هناك تغييرات غير محفوظة' : 'كل التغييرات محفوظة';
      node.classList.toggle('settings-dirty-text', hasUnsavedChanges);
    });
    qsa('[data-save-settings], #save-btn').forEach(node => {
      node.classList.toggle('pulse-save', hasUnsavedChanges);
    });
  }
  function markDirty(value=true){
    hasUnsavedChanges = !!value;
    syncDirtyIndicators();
  }
  function libraryTypeLabel(type='movies'){ return ({ movies:'أفلام', series:'مسلسلات', audio:'صوتيات', mixed:'محتوى متنوع' }[type] || type || 'مكتبة'); }
  function createLibraryDraft(type='movies'){
    const id = `library-${Date.now()}`;
    const names = {
      movies: 'مكتبة أفلام',
      series: 'مكتبة مسلسلات',
      audio: 'مكتبة صوتيات',
      mixed: 'مكتبة محتوى متنوع'
    };
    return {
      id,
      name: names[type] || 'مكتبة جديدة',
      type,
      paths: [''],
      scanMode: 'recursive',
      maxDepth: 9999,
      allowDownload: true,
      showOnHome: true
    };
  }
  function defaultSourceInputUrl(type='', streamKey=''){
    const rtmpCfg = cfg.rtmpServer || {};
    const rtmpPort = Number(rtmpCfg.port || 1936);
    const rtmpApp = String(rtmpCfg.appName || 'live').replace(/[^a-zA-Z0-9_-]/g, '-') || 'live';
    const rtmpName = String(streamKey || rtmpCfg.streamKey || 'rtmp-ingest-main').replace(/[^a-zA-Z0-9_-]/g, '-') || 'rtmp-ingest-main';
    return ({
      rtmp:`rtmp://127.0.0.1:${rtmpPort}/${rtmpApp}/${rtmpName}`,
      srt:'srt://0.0.0.0:8085?mode=listener&latency=120',
      hls:'http://ENCODER-IP:PORT/live/index.m3u8',
      udp:'udp://0.0.0.0:8086?listen=1&fifo_size=1000000&overrun_nonfatal=1',
      rtp:'rtp://0.0.0.0:5004?listen=1',
      mpegts_file:'D:/streams/output.ts',
      network_push:'',
      resi_modulator:''
    }[type] || '');
  }
  function sanitizeStreamKey(value='', fallback='rtmp-stream'){
    return String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || fallback;
  }
  function rtmpIngestUrl(streamKey=''){
    const rtmpCfg = cfg.rtmpServer || {};
    const rtmpPort = Number(rtmpCfg.port || 1936);
    const rtmpApp = sanitizeStreamKey(rtmpCfg.appName || 'live', 'live');
    const key = sanitizeStreamKey(streamKey || rtmpCfg.streamKey || 'rtmp-ingest-main', 'rtmp-ingest-main');
    return `rtmp://127.0.0.1:${rtmpPort}/${rtmpApp}/${key}`;
  }
  function syncRtmpIngestDraft(src={}){
    if ((src.sourceType || '') !== 'rtmp' || src.rtmpIngest !== true) return src;
    const key = sanitizeStreamKey(src.rtmpStreamKey || src.id || 'rtmp-stream', 'rtmp-stream');
    src.rtmpStreamKey = key;
    src.inputUrl = rtmpIngestUrl(key);
    src.autoStart = false;
    return src;
  }
  function createRtmpIngestBatch(){
    cfg.iptv = cfg.iptv || { sources: [] };
    if (!Array.isArray(cfg.iptv.sources)) cfg.iptv.sources = [];
    const count = Math.max(1, Math.min(50, Number(qs('#rtmp-batch-count')?.value || 1)));
    const namePrefix = (qs('#rtmp-batch-name')?.value || 'RTMP Channel').trim() || 'RTMP Channel';
    const keyPrefix = sanitizeStreamKey(qs('#rtmp-batch-key')?.value || 'rtmp-channel', 'rtmp-channel');
    const existingKeys = new Set(cfg.iptv.sources.map(source => String(source.rtmpStreamKey || source.id || '').toLowerCase()));
    let firstIndex = -1;
    for (let i = 1; i <= count; i += 1) {
      let n = i;
      let key = sanitizeStreamKey(`${keyPrefix}-${String(n).padStart(2, '0')}`, `${keyPrefix}-${n}`);
      while (existingKeys.has(key.toLowerCase())) {
        n += 1;
        key = sanitizeStreamKey(`${keyPrefix}-${String(n).padStart(2, '0')}`, `${keyPrefix}-${n}`);
      }
      existingKeys.add(key.toLowerCase());
      const draft = syncRtmpIngestDraft({
        ...createSourceDraft('rtmp'),
        id: `rtmp-${key}`,
        name: `${namePrefix} ${String(n).padStart(2, '0')}`,
        channelName: `${namePrefix} ${String(n).padStart(2, '0')}`,
        rtmpStreamKey: key,
        groupTitle: 'بث مباشر'
      });
      cfg.iptv.sources.push(draft);
      if (firstIndex < 0) firstIndex = cfg.iptv.sources.length - 1;
    }
    selectedSourceIndex = clampIndex(firstIndex, cfg.iptv.sources.length);
    sourceManagerState.type = 'rtmp';
    saved.section = 'live';
    markDirty(true);
    renderAll();
    openSourceModal(selectedSourceIndex);
  }
  function createSourceDraft(type='usb_capture'){
    const id = `source-${Date.now()}`;
    const common = {
      id,
      name: 'مصدر جديد',
      sourceType: type,
      m3uPath: '',
      epgPath: '',
      groupTitle: '',
      channelName: '',
      deviceName: '',
      audioDeviceName: '',
      deliveryMode: 'hls',
      streamUrl: '',
      inputUrl: defaultSourceInputUrl(type, id),
      webrtcEmbedUrl: '',
      logo: '',
      description: '',
      autoStart: true,
      showOnHome: true,
      resolutionPreset: 'source',
      outputWidth: 0,
      outputHeight: 0,
      hlsTime: 2,
      hlsListSize: 6,
      videoBitrate: '1800k',
      maxRate: '2200k',
      bufSize: '4000k',
      audioBitrate: '96k',
      frameRate: 25,
      hwAccel: (cfg.usbCapture?.hwAccel || 'auto'),
      ffmpegPath: '',
      ffmpegInput: '',
      ffmpegCommand: '',
      rtmpIngest: false,
      rtmpStreamKey: '',
      skipStartupProbe: true,
      egressEnabled: false,
      egressType: 'srt',
      egressUrl: '',
      egressVideoMode: 'same',
      egressHwAccel: 'same',
      egressResolutionPreset: 'same',
      egressOutputWidth: 0,
      egressOutputHeight: 0,
      egressVideoBitrate: '',
      egressMaxRate: '',
      egressBufSize: '',
      egressAudioBitrate: '',
      egressFrameRate: 0,
      egressLowLatency: true,
      egressFifo: true,
      egressFifoQueue: 600,
      egressHlsTime: 1,
      egressHlsListSize: 4
    };
    if (type === 'm3u') return { ...common, name: 'قائمة IPTV', sourceType: 'm3u' };
    if (type === 'hls') return { ...common, name: 'مصدر HTTP مباشر', sourceType: 'hls' };
    if (type === 'rtsp') return { ...common, name: 'مصدر RTSP', sourceType: 'rtsp' };
    if (type === 'rtmp') return syncRtmpIngestDraft({ ...common, name: 'استقبال RTMP داخلي', sourceType: 'rtmp', channelName: 'استقبال RTMP داخلي', inputUrl: defaultSourceInputUrl('rtmp', id), rtmpIngest: true, rtmpStreamKey: id, autoStart: false });
    if (type === 'srt') return { ...common, name: 'مصدر SRT', sourceType: 'srt' };
    if (type === 'udp') return { ...common, name: 'UDP Source', sourceType: 'udp' };
    if (type === 'rtp') return { ...common, name: 'RTP Source', sourceType: 'rtp' };
    if (type === 'mpegts_file') return { ...common, name: 'MPEG-TS File', sourceType: 'mpegts_file' };
    if (type === 'network_push') return { ...common, name: 'NetworkPush Source', sourceType: 'network_push', autoStart: false };
    if (type === 'resi_modulator') return { ...common, name: 'RESI Modulator', sourceType: 'resi_modulator', autoStart: false };
    if (type === 'webrtc') return { ...common, name: 'مصدر WebRTC', sourceType: 'webrtc', deliveryMode: 'webrtc' };
    return { ...common, name: 'جهاز بث مباشر', sourceType: 'usb_capture' };
  }
  function spotlightEditor(selector){
    requestAnimationFrame(() => {
      const node = qs(selector);
      if (!node) return;
      node.classList.add('editor-spotlight');
      try { node.scrollIntoView({ behavior:'smooth', block:'start' }); } catch {}
      setTimeout(() => node.classList.remove('editor-spotlight'), 1800);
    });
  }
  function diagnosticsLevelLabel(level='info'){ return ({ critical:'حرج', warning:'تنبيه', info:'معلومة' }[level] || level); }
  function readinessLabel(score=0){ return score >= 85 ? 'جاهزية ممتازة' : score >= 65 ? 'جاهزية جيدة' : score >= 40 ? 'جاهزية متوسطة' : 'تحتاج ضبط'; }
  function findLibraryDiagnostic(libraryId=''){ return (cfg.diagnostics?.libraries || []).find(entry => entry.id === libraryId) || null; }
  function findLibraryConvertJob(libraryId=''){ return (cfg.libraryConvertJobs || []).find(entry => entry.libraryId === libraryId) || null; }
  function libraryPathStatusLabel(entry){
    if (!entry?.path) return 'المسار فارغ';
    if (entry.exists && entry.readable) return `متاح • ${entry.indexedItems || 0} عنصر مفهرس`;
    if (entry.exists && !entry.readable) return 'موجود لكن يحتاج صلاحية قراءة';
    return 'غير موجود';
  }
  function libraryIcon(type='movies'){
    return ({ movies:'🎬', series:'📺', audio:'🎵', mixed:'✨' }[type] || '🗂');
  }
  function managerSearchText(value=''){ return String(value || '').toLowerCase().trim(); }
  function librarySearchBlob(lib={}){
    return [lib.name, lib.id, lib.type, ...(Array.isArray(lib.paths) ? lib.paths : [])].map(x => String(x || '')).join(' ').toLowerCase();
  }
  function sourceSearchBlob(src={}){
    return [src.name, src.id, src.sourceType, src.channelName, src.deviceName, src.inputUrl, src.streamUrl, src.m3uPath, src.epgPath, src.webrtcEmbedUrl, src.groupTitle].map(x => String(x || '')).join(' ').toLowerCase();
  }
  function visibleLibraries(){
    const q = managerSearchText(libraryManagerState.q);
    const type = String(libraryManagerState.type || 'all');
    const rows = (cfg.libraries || []).map((lib, index) => ({ lib, index }))
      .filter(({ lib }) => (type === 'all' || lib.type === type) && (!q || librarySearchBlob(lib).includes(q)));
    rows.sort((a, b) => {
      if (libraryManagerState.sort === 'type') return libraryTypeLabel(a.lib.type).localeCompare(libraryTypeLabel(b.lib.type), 'ar') || String(a.lib.name || '').localeCompare(String(b.lib.name || ''), 'ar');
      if (libraryManagerState.sort === 'paths') return ((b.lib.paths || []).filter(Boolean).length - (a.lib.paths || []).filter(Boolean).length) || String(a.lib.name || '').localeCompare(String(b.lib.name || ''), 'ar');
      return String(a.lib.name || '').localeCompare(String(b.lib.name || ''), 'ar');
    });
    return rows;
  }
  function libraryMiniCard(lib, index){
    const diag = findLibraryDiagnostic(lib.id);
    const paths = Array.isArray(lib.paths) ? lib.paths : [];
    const pathCount = paths.filter(Boolean).length;
    const selected = index === selectedLibraryIndex;
    const reachable = diag ? `${diag.reachablePaths || 0}/${diag.totalPaths || pathCount || 0} مسار متاح` : `${pathCount} مسار`;
    const itemCount = diag ? `${diag.itemCount || 0} عنصر` : 'اضغط للتعديل';
    const firstPath = paths.find(Boolean) || 'لم يتم تحديد مسار بعد';
    const health = diag?.missingPaths ? 'warn' : 'ok';
    return `<button class="channel-list-row library-list-row ${selected ? 'active' : ''}" type="button" data-library-edit="${index}" aria-pressed="${selected ? 'true' : 'false'}">
      <span class="channel-list-logo">${libraryIcon(lib.type)}</span>
      <span class="channel-list-main">
        <strong>${escapeHtml(lib.name || `مكتبة ${index + 1}`)}</strong>
        <small>${escapeHtml(firstPath)}</small>
      </span>
      <span class="channel-list-meta">
        <span class="status-dot ${health}"></span>
        <span class="tag">${escapeHtml(libraryTypeLabel(lib.type))}</span>
        <span class="tag">${escapeHtml(reachable)}</span>
        <span>${escapeHtml(itemCount)}</span>
        <span>${lib.showOnHome !== false ? 'الرئيسية' : 'مخفية'}</span>
        <span class="button secondary small channel-list-action">إعدادات المكتبة</span>
      </span>
    </button>`;
  }
  function libraryModalMarkup(lib, index){
    const diag = findLibraryDiagnostic(lib.id);
    const convertJob = findLibraryConvertJob(lib.id);
    const paths = Array.isArray(lib.paths) ? lib.paths : [];
    const diagMarkup = diag ? `<div class="channel-info-list">${channelInfoRow('العناصر', String(diag.itemCount || 0))}${channelInfoRow('المسارات المتاحة', `${diag.reachablePaths || 0}/${diag.totalPaths || paths.length || 0}`)}${channelInfoRow('مسارات مفقودة', String(diag.missingPaths || 0))}</div><div class="config-stack" style="margin-top:12px">${(diag.paths || []).map(entry => `<div class="notice" style="margin:0"><code>${escapeHtml(entry.path || '')}</code><div class="muted" style="margin-top:5px">${escapeHtml(libraryPathStatusLabel(entry))}</div></div>`).join('')}</div>` : `<div class="notice" style="margin:0">لم يتم تحديث التشخيص بعد.</div>`;
    return `<div class="channel-modal-backdrop" data-library-modal-backdrop><div class="channel-modal library-modal" role="dialog" aria-modal="true" aria-label="إعدادات المكتبة" data-library-editor="${index}"><div class="channel-modal-head"><div><div class="editor-card-eyebrow">مكتبة ${index+1} • ${escapeHtml(libraryTypeLabel(lib.type))}</div><h3>${escapeHtml(lib.name || `مكتبة ${index+1}`)}</h3><div class="section-subtitle">ID: ${escapeHtml(lib.id || '')}</div></div><div class="channel-modal-actions"><button class="button success small" type="button" data-save-library-settings="${index}">حفظ</button><button class="button secondary small" type="button" data-scan-lib="${escapeHtml(lib.id || '')}">فحص المكتبة</button><button class="button warning small" type="button" data-convert-lib="${escapeHtml(lib.id || '')}" ${convertJob?.running ? 'disabled' : ''}>${convertJob?.running ? 'جاري التحويل...' : 'تحويل'}</button><button class="button danger small" type="button" data-remove-lib="${index}">حذف</button><button class="button secondary small" type="button" data-library-modal-close>إغلاق</button></div></div><div class="channel-modal-body channel-modal-split"><div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">إعدادات المكتبة</h4><div class="section-subtitle">تعريف المكتبة ومساراتها وصلاحيات ظهورها.</div></div></div><div class="settings-grid settings-grid-2"><div><label>الاسم</label><input class="input" data-lib="${index}" data-key="name" value="${escapeHtml(lib.name || '')}"></div><div><label>المعرف</label><input class="input" data-lib="${index}" data-key="id" value="${escapeHtml(lib.id || '')}"></div><div><label>النوع</label><select class="select" data-lib="${index}" data-key="type"><option value="movies" ${lib.type==='movies'?'selected':''}>أفلام</option><option value="series" ${lib.type==='series'?'selected':''}>مسلسلات</option><option value="audio" ${lib.type==='audio'?'selected':''}>صوتيات</option><option value="mixed" ${lib.type==='mixed'?'selected':''}>محتوى متنوع</option></select></div><div><label>التنزيل</label><select class="select" data-lib="${index}" data-key="allowDownload"><option value="true" ${lib.allowDownload!==false?'selected':''}>مسموح</option><option value="false" ${lib.allowDownload===false?'selected':''}>معطل</option></select></div><div><label>إظهار في الرئيسية</label><select class="select" data-lib="${index}" data-key="showOnHome"><option value="true" ${lib.showOnHome!==false?'selected':''}>نعم</option><option value="false" ${lib.showOnHome===false?'selected':''}>لا</option></select></div><div><label>الفحص</label><div class="notice" style="margin:0">شامل تلقائيًا لكل المجلدات والملفات داخل المسارات المحددة.</div></div></div><div class="config-group library-paths-inline"><div class="section-header"><div><h4 class="editor-group-title">مسارات المكتبة</h4><div class="section-subtitle">أضف كل المجلدات التابعة لهذه المكتبة.</div></div><button class="button secondary small" type="button" data-add-path="${index}">إضافة مسار</button></div><div class="config-stack">${paths.map((p, pathIndex) => `<div class="path-row"><input class="input" data-lib-path="${index}" data-path-index="${pathIndex}" value="${escapeHtml(p || '')}" placeholder="C:/Media/... أو /mnt/media/... "><button class="button danger small" type="button" data-remove-path="${index}" data-path-index="${pathIndex}">حذف المسار</button></div>`).join('') || `<div class="empty">لا توجد مسارات بعد.</div>`}</div></div>${libraryConvertStatusMarkup(lib.id)}</div><aside class="config-group channel-info-panel"><div class="section-header"><div><h4 class="editor-group-title">حالة المكتبة</h4><div class="section-subtitle">تشخيص سريع للمسارات والعناصر.</div></div></div>${diagMarkup}</aside></div></div></div>`;
  }
  function openLibraryModal(index){
    selectedLibraryIndex = clampIndex(index, cfg.libraries?.length || 0);
    const rootNode = qs('#library-admin-modal-root');
    const lib = cfg.libraries?.[selectedLibraryIndex];
    if (!rootNode || !lib) return;
    rootNode.innerHTML = libraryModalMarkup(lib, selectedLibraryIndex);
    document.body.classList.add('channel-modal-open');
    rootNode.querySelector('[data-key="name"]')?.focus();
  }
  function closeLibraryModal(){
    const rootNode = qs('#library-admin-modal-root');
    if (rootNode) rootNode.innerHTML = '';
    document.body.classList.remove('channel-modal-open');
  }
  function libraryConvertStatusMarkup(libraryId=''){
    const job = findLibraryConvertJob(libraryId);
    if (!job) return '';
    const label = job.running ? 'جاري التحويل المسبق' : 'آخر حالة تحويل';
    const chips = [
      `<span class="tag">${escapeHtml(String(job.percent || 0))}%</span>`,
      `<span class="tag">المعالج: ${escapeHtml(String(job.processed || 0))}/${escapeHtml(String(job.total || 0))}</span>`,
      `<span class="tag">تم التحويل: ${escapeHtml(String(job.converted || 0))}</span>`,
      `<span class="tag">تم التخطي: ${escapeHtml(String(job.skipped || 0))}</span>`
    ];
    if (job.failed) chips.push(`<span class="tag">فشل: ${escapeHtml(String(job.failed || 0))}</span>`);
    return `<div class="notice" style="margin-bottom:12px"><strong>${label}</strong><div class="chips" style="margin-top:8px">${chips.join('')}</div>${job.currentTitle ? `<div class="muted" style="margin-top:8px">العنصر الحالي: ${escapeHtml(job.currentTitle)}</div>` : ''}${job.message ? `<div class="muted" style="margin-top:6px">${escapeHtml(job.message)}</div>` : ''}</div>`;
  }
  function recommendationCard(item){
    return `<div class="notice" style="margin:0"><strong>${escapeHtml(diagnosticsLevelLabel(item?.level || 'info'))}: ${escapeHtml(item?.title || 'ملاحظة')}</strong><div class="muted" style="margin-top:6px">${escapeHtml(item?.detail || '')}</div></div>`;
  }
  function renderAssistant(){
    const diag = cfg.diagnostics || {};
    const counts = diag.counts || {};
    const recs = Array.isArray(diag.recommendations) ? diag.recommendations : [];
    const storage = Array.isArray(diag.storage) ? diag.storage : [];
    const profiles = Array.isArray(diag.profiles) ? diag.profiles : [];
    const libraryRows = Array.isArray(diag.libraries) ? diag.libraries : [];
    const liveRows = Array.isArray(diag.sources) ? diag.sources : [];
    return `<div class="settings-section" data-section-content="assistant">
      <div class="settings-grid settings-grid-2">
        <div class="config-card">
          <h3>جاهزية النظام</h3>
          <div class="stats-bar compact-stats">
            <div class="stat"><div class="stat-label">التقييم</div><strong>${escapeHtml(String(diag.readinessScore ?? 0))}%</strong></div>
            <div class="stat"><div class="stat-label">الحالة</div><strong>${escapeHtml(readinessLabel(diag.readinessScore || 0))}</strong></div>
            <div class="stat"><div class="stat-label">العناصر</div><strong>${escapeHtml(String(counts.total || 0))}</strong></div>
            <div class="stat"><div class="stat-label">القنوات</div><strong>${escapeHtml(String(counts.channels || 0))}</strong></div>
          </div>
          <div class="notice" style="margin-top:14px">الرابط الحالي: <code>${escapeHtml(diag.server?.appBaseUrl || location.origin)}</code>${diag.server?.publicBaseUrl ? `<div style="margin-top:8px">الرابط الخارجي: <code>${escapeHtml(diag.server.publicBaseUrl)}</code></div>` : ''}</div>
        </div>
        <div class="config-card">
          <h3>أدوات سريعة</h3>
          <div class="config-stack">
            <div class="toolbar-group"><button class="button secondary" type="button" id="refresh-diagnostics">تحديث التشخيص</button><button class="button secondary" type="button" id="export-admin-backup">تصدير نسخة إعدادات</button></div>
            <div class="muted">تساعدك هذه الأدوات على معرفة سبب المشاكل بسرعة ونقل إعدادات النظام إلى جهاز آخر بسهولة.</div>
          </div>
        </div>
      </div>
      <div class="config-card" style="margin-top:16px">
        <div class="section-header"><div><h3>بروفايلات جاهزة</h3><div class="section-subtitle">تطبيق ضبط جاهز على النظام كاملًا بضغطة واحدة.</div></div></div>
        <div class="library-shortcuts">
          ${profiles.map(profile => `<button class="library-shortcut" type="button" data-apply-system-profile="${escapeHtml(profile.id)}"><div class="library-shortcut-icon">⚙</div><div class="library-shortcut-body"><div class="library-shortcut-title">${escapeHtml(profile.title)}</div><div class="library-shortcut-meta"><span>${escapeHtml(profile.description || '')}</span></div></div></button>`).join('') || `<div class="empty">لا توجد بروفايلات متاحة.</div>`}
        </div>
      </div>
      <div class="settings-grid settings-grid-2" style="margin-top:16px">
        <div class="config-card">
          <h3>التوصيات الذكية</h3>
          <div class="config-stack">${recs.length ? recs.map(recommendationCard).join('') : `<div class="notice" style="margin:0">لا توجد تحذيرات حالية. الجاهزية جيدة الآن.</div>`}</div>
        </div>
        <div class="config-card">
          <h3>الخدمات والملفات</h3>
          <div class="config-stack">
            <div class="notice" style="margin:0"><strong>FFmpeg:</strong> ${escapeHtml(diag.binaries?.ffmpeg?.ok ? (diag.binaries.ffmpeg.version || 'جاهز') : (diag.binaries?.ffmpeg?.error || 'غير جاهز'))}</div>
            <div class="notice" style="margin:0"><strong>FFprobe:</strong> ${escapeHtml(diag.binaries?.ffprobe?.ok ? (diag.binaries.ffprobe.version || 'جاهز') : (diag.binaries?.ffprobe?.error || 'غير جاهز'))}</div>
            <div class="notice" style="margin:0"><strong>تحويل المكتبات:</strong> ${escapeHtml(diag.mediaTranscode?.encoder || 'CPU / libx264')} • ${escapeHtml(diag.mediaTranscode?.qualityProfile || 'balanced')} • ${escapeHtml(String(diag.mediaTranscode?.cpuCores || 0))} نواة</div>
            ${storage.map(entry => `<div class="notice" style="margin:0"><strong>${escapeHtml(entry.id)}</strong> • ${escapeHtml(entry.exists ? 'موجود' : 'غير موجود')}${entry.sizeLabel ? ` • ${escapeHtml(entry.sizeLabel)}` : ''}<div class="muted" style="margin-top:4px">${escapeHtml(entry.path || '')}</div></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="config-card" style="margin-top:16px">
        <h3>المكتبات الحالية</h3>
        <div class="config-stack">
          ${libraryRows.length ? libraryRows.map(library => `<div class="notice" style="margin:0"><strong>${escapeHtml(library.name)}</strong> • ${escapeHtml(libraryTypeLabel(library.type))}<div class="muted" style="margin-top:6px">العناصر المفهرسة: ${escapeHtml(String(library.itemCount || 0))} • المسارات المتاحة: ${escapeHtml(String(library.reachablePaths || 0))}/${escapeHtml(String(library.totalPaths || 0))}</div></div>`).join('') : `<div class="empty">لا توجد مكتبات بعد.</div>`}
        </div>
      </div>
      <div class="config-card" style="margin-top:16px">
        <h3>البث والخدمات المباشرة</h3>
        <div class="config-stack">
          ${liveRows.length ? liveRows.map(source => `<div class="notice" style="margin:0"><strong>${escapeHtml(source.name || source.id || 'مصدر')}</strong> • ${escapeHtml(source.type || '')}${source.deliveryMode ? ` • ${escapeHtml(source.deliveryMode)}` : ''}<div class="muted" style="margin-top:6px">الحالة: ${escapeHtml(source.state || 'idle')} • الدقة: ${escapeHtml(source.resolution || 'source')} • المرمّز: ${escapeHtml(source.encoder || '')}</div>${source.message ? `<div class="muted" style="margin-top:4px">${escapeHtml(source.message)}</div>` : ''}</div>`).join('') : `<div class="empty">لا توجد مصادر بث بعد.</div>`}
        </div>
      </div>
    </div>`;
  }
  function renderSystem(){ return `<div class="settings-section" data-section-content="system"><div class="settings-grid settings-grid-3"><div class="config-card"><h3>هوية النظام</h3><div class="config-stack"><div><label>اسم النظام</label><input class="input" id="system-name" value="${escapeHtml(cfg.system?.name || 'STARSNET')}"></div><div><label>أيقونة نصية / إيموجي</label><input class="input" id="system-icon" value="${escapeHtml(cfg.system?.iconText || '⭐')}"></div><div><label>رابط صورة الشعار</label><input class="input" id="system-logo" value="${escapeHtml(cfg.system?.logoUrl || '')}" placeholder="https://..."></div><div><label>رسالة الصفحة الرئيسية</label><textarea class="textarea" id="system-home-message">${escapeHtml(cfg.system?.homeMessage || '')}</textarea></div><div><label>تشغيل ناشر WebRTC تلقائيًا عند فتحه</label><select class="select" id="system-webrtc-autostart"><option value="true" ${cfg.system?.webrtcPublisherAutoStart ? 'selected' : ''}>مفعّل</option><option value="false" ${!cfg.system?.webrtcPublisherAutoStart ? 'selected' : ''}>معطّل</option></select></div></div></div><div class="config-card"><h3>الخادم والأداء</h3><div class="config-stack"><div><label>المنفذ</label><input class="input" id="server-port" type="number" value="${escapeHtml(cfg.server.port)}"></div><div><label>العنوان المضيف</label><input class="input" id="server-host" value="${escapeHtml(cfg.server.host || '0.0.0.0')}"></div><div><label>الرابط الخارجي للنظام</label><input class="input" id="server-public-base-url" value="${escapeHtml(cfg.server.publicBaseUrl || '')}" placeholder="http://192.168.1.10:80"></div><div><label>عدد العناصر في الصفحة</label><input class="input" id="page-size" type="number" value="${escapeHtml(cfg.performance.pageSize || 48)}"></div><div><label>عدد عناصر الرئيسية</label><input class="input" id="newest-limit" type="number" value="${escapeHtml(cfg.performance.newestLimit || 24)}"></div><div><label>تحديد سرعة كل متصل</label><select class="select" id="bandwidth-enabled"><option value="false" ${!cfg.bandwidth?.enabled ? 'selected' : ''}>معطّل</option><option value="true" ${cfg.bandwidth?.enabled ? 'selected' : ''}>مفعّل</option></select></div><div><label>السرعة لكل متصل (KB/s)</label><input class="input" id="bandwidth-limit-kbps" type="number" min="0" value="${escapeHtml(cfg.bandwidth?.limitKBps || cfg.bandwidth?.limitKbps || 0)}" placeholder="0 = بدون حد"></div><div><label>مرونة السرعة بالثواني</label><input class="input" id="bandwidth-burst-seconds" type="number" min="1" max="20" value="${escapeHtml(cfg.bandwidth?.burstSeconds || 3)}"></div><div><label>تطبيق على المكتبات</label><select class="select" id="bandwidth-media"><option value="true" ${cfg.bandwidth?.applyToMedia !== false ? 'selected' : ''}>نعم</option><option value="false" ${cfg.bandwidth?.applyToMedia === false ? 'selected' : ''}>لا</option></select></div><div><label>تطبيق على البث المباشر</label><select class="select" id="bandwidth-live"><option value="true" ${cfg.bandwidth?.applyToLive !== false ? 'selected' : ''}>نعم</option><option value="false" ${cfg.bandwidth?.applyToLive === false ? 'selected' : ''}>لا</option></select></div><div><label>تطبيق على التحويل</label><select class="select" id="bandwidth-transcode"><option value="true" ${cfg.bandwidth?.applyToTranscode !== false ? 'selected' : ''}>نعم</option><option value="false" ${cfg.bandwidth?.applyToTranscode === false ? 'selected' : ''}>لا</option></select></div><div><label>البروفايل الحالي</label><div class="notice" style="margin:0">${escapeHtml(cfg.system?.setupProfile || 'recommended')}</div></div></div></div><div class="config-card"><h3>تحويل الصيغ</h3><div class="config-stack"><div class="notice" style="margin:0">في الوضع التلقائي سيختار النظام أفضل مسرّع متاح، أو يضبط <code>libx264</code> حسب عدد أنوية المعالج إذا لم يتوفر GPU مناسب.</div><div><label>معالج تحويل الفيديو</label><select class="select" id="transcode-hwaccel">${hwAccelOptions(cfg.mediaTranscode?.hwAccel || 'auto')}</select></div><div><label>بروفايل الجودة</label><select class="select" id="transcode-quality-profile">${transcodeQualityOptions(cfg.mediaTranscode?.qualityProfile || 'balanced')}</select></div><div><label>معدل صوت التحويل</label><input class="input" id="transcode-audio-bitrate" value="${escapeHtml(cfg.mediaTranscode?.audioBitrate || '160k')}" placeholder="128k"></div><div><label>زمن مقطع HLS</label><input class="input" id="transcode-hls-time" type="number" min="2" value="${escapeHtml(cfg.mediaTranscode?.hlsTime || 4)}"></div><div><label>عدد عناصر قائمة HLS</label><input class="input" id="transcode-hls-list-size" type="number" min="6" value="${escapeHtml(cfg.mediaTranscode?.hlsListSize || 10)}"></div><div><label>الحالة الحالية</label><div class="notice" style="margin:0">${escapeHtml(cfg.diagnostics?.mediaTranscode?.encoder || 'CPU / libx264')} • ${escapeHtml(cfg.diagnostics?.mediaTranscode?.qualityProfile || cfg.mediaTranscode?.qualityProfile || 'balanced')} • ${escapeHtml(String(cfg.diagnostics?.mediaTranscode?.cpuCores || ''))} نواة</div></div></div></div></div></div>`; }
  function renderRtmpServer(){
    const rtmp = cfg.rtmpServer || {};
    const status = cfg.rtmpIngestStatus || {};
    const appName = rtmp.appName || 'live';
    const streamKey = rtmp.streamKey || 'rtmp-ingest-main';
    const port = Number(rtmp.port || 1936);
    const localUrl = status.localPublishUrl || `rtmp://127.0.0.1:${port}/${appName}/${streamKey}`;
    const publicHost = rtmp.publicHost || '';
    const publishUrl = publicHost ? `rtmp://${publicHost}:${port}/${appName}/${streamKey}` : `rtmp://SERVER-IP:${port}/${appName}/${streamKey}`;
    return `<div class="settings-section" data-section-content="system"><div class="config-card"><div class="section-header"><div><h3>خادم RTMP الداخلي</h3><div class="section-subtitle">استقبال RTMP ثم تحويله إلى HLS داخل النظام.</div></div><span class="tag">${status.running ? 'يعمل' : (rtmp.enabled === false ? 'معطّل' : 'غير متصل')}</span></div><div class="settings-grid settings-grid-3"><div><label>تفعيل RTMP</label><select class="select" id="rtmp-server-enabled"><option value="true" ${rtmp.enabled !== false ? 'selected' : ''}>مفعّل</option><option value="false" ${rtmp.enabled === false ? 'selected' : ''}>معطّل</option></select></div><div><label>العنوان</label><input class="input" id="rtmp-server-host" value="${escapeHtml(rtmp.host || '0.0.0.0')}"></div><div><label>المنفذ</label><input class="input" id="rtmp-server-port" type="number" min="1" max="65535" value="${escapeHtml(port)}"></div><div><label>اسم التطبيق</label><input class="input" id="rtmp-server-app" value="${escapeHtml(appName)}"></div><div><label>مفتاح البث الافتراضي</label><input class="input" id="rtmp-server-key" value="${escapeHtml(streamKey)}"></div><div><label>IP للناشر الخارجي</label><input class="input" id="rtmp-server-public-host" value="${escapeHtml(publicHost)}" placeholder="192.168.1.10"></div></div><div class="notice" style="margin-top:12px"><strong>رابط الدفع المحلي:</strong> <code>${escapeHtml(localUrl)}</code><br><strong>رابط الدفع من جهاز آخر:</strong> <code>${escapeHtml(publishUrl)}</code>${status.error ? `<div class="muted" style="margin-top:8px">${escapeHtml(status.error)}</div>` : ''}</div><div class="config-group" style="margin-top:16px"><div class="section-header"><div><h4 class="editor-group-title">إنشاء قنوات استقبال</h4><div class="section-subtitle">كل قناة تستخدم Stream Key مستقل، ويمكن إرسال خروجها إلى سيرفر خارجي من إعداد القناة.</div></div><button class="button secondary small" type="button" data-create-rtmp-ingest-batch>إنشاء</button></div><div class="settings-grid settings-grid-3"><div><label>عدد القنوات</label><input class="input" id="rtmp-batch-count" type="number" min="1" max="50" value="4"></div><div><label>بادئة الاسم</label><input class="input" id="rtmp-batch-name" value="RTMP Channel"></div><div><label>بادئة Stream Key</label><input class="input" id="rtmp-batch-key" value="rtmp-channel"></div></div></div></div></div>`;
  }
  function renderYacineTvAuto(){
    const yacine = cfg.yacineTv || {};
    const wrapper = cfg.yacineTvStatus || {};
    const status = wrapper.status || {};
    const source = wrapper.source || (cfg.iptv?.sources || []).find(source => String(source?.id || '') === 'yacine-tv-auto') || {};
    const enabled = yacine.enabled === true;
    const statusText = wrapper.running ? 'جاري التحديث' : (enabled ? 'مفعّل' : 'معطّل');
    const lastUpdate = status.finishedAt ? formatDate(status.finishedAt) : 'لم يتم بعد';
    const countText = status.ok
      ? `${Number(status.hlsEntries || 0)} رابط HLS من ${Number(status.channels || 0)} قناة`
      : (status.error ? `خطأ: ${status.error}` : 'لا توجد حالة محفوظة بعد.');
    const interval = Number(yacine.refreshIntervalHours ?? 2);
    return `<div class="settings-section" data-section-content="live"><div class="config-card"><div class="section-header"><div><h3>Yacine TV Auto</h3><div class="section-subtitle">تحديث قائمة القنوات تلقائيًا وتشغيلها عبر بروكسي السيرفر المحلي.</div></div><span class="tag">${escapeHtml(statusText)}</span></div><div class="settings-grid settings-grid-3"><div><label>تشغيل Yacine TV Auto</label><select class="select" id="yacine-tv-enabled"><option value="true" ${enabled ? 'selected' : ''}>نعم</option><option value="false" ${!enabled ? 'selected' : ''}>لا</option></select></div><div><label>تحديث عند تشغيل السيرفر</label><select class="select" id="yacine-tv-startup"><option value="true" ${yacine.refreshOnStartup !== false ? 'selected' : ''}>نعم</option><option value="false" ${yacine.refreshOnStartup === false ? 'selected' : ''}>لا</option></select></div><div><label>فحص القنوات بعد التحديث</label><select class="select" id="yacine-tv-scan-after-refresh"><option value="true" ${yacine.scanAfterRefresh !== false ? 'selected' : ''}>نعم</option><option value="false" ${yacine.scanAfterRefresh === false ? 'selected' : ''}>لا</option></select></div><div><label>كل كم ساعة يحدث</label><input class="input" id="yacine-tv-interval" type="number" min="0" max="24" value="${escapeHtml(interval)}"></div><div><label>ملف القائمة</label><div class="notice" style="margin:0"><code>${escapeHtml(source.m3uPath || 'data/yacine-tv-auto.m3u')}</code></div></div><div><label>آخر تحديث</label><div class="notice" style="margin:0">${escapeHtml(lastUpdate)}</div></div></div><div class="notice" style="margin-top:12px"><strong>الحالة:</strong> ${escapeHtml(countText)}<div class="toolbar" style="margin-top:12px"><button class="button secondary small" type="button" data-yacine-refresh ${enabled ? '' : 'disabled'}>تحديث الآن</button><span class="muted">ضع الفاصل 0 لإيقاف الجدولة مع بقاء التحديث اليدوي متاحًا.</span></div></div></div></div>`;
  }
  function libraryCard(lib, index){
    const diag = findLibraryDiagnostic(lib.id);
    const convertJob = findLibraryConvertJob(lib.id);
    const diagMarkup = diag ? `<div class="editor-card-status"><span class="tag">العناصر: ${escapeHtml(String(diag.itemCount || 0))}</span><span class="tag">المسارات المتاحة: ${escapeHtml(String(diag.reachablePaths || 0))}/${escapeHtml(String(diag.totalPaths || 0))}</span>${diag.missingPaths ? `<span class="tag">غير موجود: ${escapeHtml(String(diag.missingPaths || 0))}</span>` : ''}</div><div class="notice" style="margin-bottom:12px"><strong>حالة المكتبة:</strong><div style="margin-top:8px;display:grid;gap:6px">${(diag.paths || []).map(entry => `<div class="muted"><code>${escapeHtml(entry.path || '')}</code> • ${escapeHtml(libraryPathStatusLabel(entry))}</div>`).join('')}</div></div>` : '';
    return `<div class="config-card editor-card library-editor"><div class="editor-card-head"><div><div class="editor-card-eyebrow">مكتبة ${index+1} • ${escapeHtml(libraryTypeLabel(lib.type))}</div><h3>${escapeHtml(lib.name || `مكتبة ${index+1}`)}</h3><div class="section-subtitle">ID: ${escapeHtml(lib.id || '')}</div></div><div class="editor-card-actions"><button class="button secondary small" data-scan-lib="${escapeHtml(lib.id)}">فحص المكتبة</button><button class="button warning small" data-convert-lib="${escapeHtml(lib.id)}" ${convertJob?.running ? 'disabled' : ''}>${convertJob?.running ? 'جاري التحويل...' : 'تحويل إلى mp3/mp4'}</button><button class="button danger small" data-remove-lib="${index}">حذف</button></div></div>${diagMarkup}${libraryConvertStatusMarkup(lib.id)}<div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">تعريف المكتبة</h4><div class="section-subtitle">الاسم، النوع، الصلاحيات، وطريقة ظهورها للمستخدم.</div></div></div><div class="settings-grid settings-grid-3"><div><label>الاسم</label><input class="input" data-lib="${index}" data-key="name" value="${escapeHtml(lib.name || '')}"></div><div><label>المعرف</label><input class="input" data-lib="${index}" data-key="id" value="${escapeHtml(lib.id || '')}"></div><div><label>النوع</label><select class="select" data-lib="${index}" data-key="type"><option value="movies" ${lib.type==='movies'?'selected':''}>أفلام</option><option value="series" ${lib.type==='series'?'selected':''}>مسلسلات</option><option value="audio" ${lib.type==='audio'?'selected':''}>صوتيات</option><option value="mixed" ${lib.type==='mixed'?'selected':''}>محتوى متنوع</option></select></div><div><label>التنزيل</label><select class="select" data-lib="${index}" data-key="allowDownload"><option value="true" ${lib.allowDownload!==false?'selected':''}>مسموح</option><option value="false" ${lib.allowDownload===false?'selected':''}>معطل</option></select></div><div><label>إظهار في الرئيسية</label><select class="select" data-lib="${index}" data-key="showOnHome"><option value="true" ${lib.showOnHome!==false?'selected':''}>نعم</option><option value="false" ${lib.showOnHome===false?'selected':''}>لا</option></select></div><div><label>الفحص</label><div class="notice" style="margin:0">شامل تلقائيًا لكل المجلدات والملفات داخل المسارات المحددة حسب نوع المكتبة.</div></div></div></div><div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">مسارات المكتبة</h4><div class="section-subtitle">يمكنك إضافة أكثر من مسار لهذه المكتبة.</div></div><button class="button secondary small" data-add-path="${index}">إضافة مسار</button></div><div class="config-stack">${(lib.paths || []).map((p, pathIndex) => `<div class="path-row"><input class="input" data-lib-path="${index}" data-path-index="${pathIndex}" value="${escapeHtml(p || '')}" placeholder="C:/Media/... أو /mnt/media/... "><button class="button danger small" data-remove-path="${index}" data-path-index="${pathIndex}">حذف المسار</button></div>`).join('')}</div></div></div>`;
  }
  function renderLibraries(){
    const libraries = cfg.libraries || [];
    selectedLibraryIndex = clampIndex(selectedLibraryIndex, libraries.length);
    const visible = visibleLibraries();
    return `<div class="settings-section" data-section-content="libraries">
      <div class="section-header">
        <div>
          <h2 class="section-title">المكتبات</h2>
          <div class="section-subtitle">فلترة أفقية وقائمة واضحة، ثم إعدادات مكتبة كاملة في نافذة منفصلة.</div>
        </div>
        <button class="button secondary" id="add-library">إضافة مكتبة</button>
      </div>
      <div class="config-card library-manager-card">
        <div class="section-header"><div><h3 class="panel-title">إدارة المكتبات</h3><div class="section-subtitle">الفلاتر بالأعلى، والمكتبات المضافة تحتها مباشرة.</div></div><span class="tag" id="libraries-mini-count">${escapeHtml(String(visible.length))}/${escapeHtml(String(libraries.length))} مكتبة</span></div>
        <div class="channel-filter-bar library-filter-bar">
          <div class="channel-filter-field channel-filter-search"><label>بحث</label><input class="input" id="libraries-filter" value="${escapeHtml(libraryManagerState.q || '')}" placeholder="بحث بالاسم أو المسار أو المعرف"></div>
          <div class="channel-filter-field"><label>النوع</label><select class="select" id="library-type-filter"><option value="all" ${libraryManagerState.type === 'all' ? 'selected' : ''}>كل الأنواع</option><option value="movies" ${libraryManagerState.type === 'movies' ? 'selected' : ''}>أفلام</option><option value="series" ${libraryManagerState.type === 'series' ? 'selected' : ''}>مسلسلات</option><option value="audio" ${libraryManagerState.type === 'audio' ? 'selected' : ''}>صوتيات</option><option value="mixed" ${libraryManagerState.type === 'mixed' ? 'selected' : ''}>محتوى متنوع</option></select></div>
          <div class="channel-filter-field"><label>الترتيب</label><select class="select" id="library-sort"><option value="name" ${libraryManagerState.sort === 'name' ? 'selected' : ''}>ترتيب بالاسم</option><option value="type" ${libraryManagerState.sort === 'type' ? 'selected' : ''}>ترتيب بالنوع</option><option value="paths" ${libraryManagerState.sort === 'paths' ? 'selected' : ''}>الأكثر مسارات</option></select></div>
        </div>
        <div class="channel-list library-list" id="libraries-mini-wrap">${visible.map(({ lib, index }) => libraryMiniCard(lib, index)).join('') || `<div class="empty">لا توجد نتيجة مطابقة.</div>`}</div>
        <div id="library-admin-modal-root"></div>
      </div>
      <div class="quick-create-grid compact-create-grid">
        <button class="quick-create-card" type="button" data-add-library-type="movies"><span class="quick-create-icon">🎬</span><div class="quick-create-title">مكتبة أفلام</div><div class="quick-create-meta">جاهزة لصيغ الفيديو والعرض السينمائي</div></button>
        <button class="quick-create-card" type="button" data-add-library-type="series"><span class="quick-create-icon">📺</span><div class="quick-create-title">مكتبة مسلسلات</div><div class="quick-create-meta">تنظيم حلقات ومجلدات بشكل أوضح</div></button>
        <button class="quick-create-card" type="button" data-add-library-type="audio"><span class="quick-create-icon">🎵</span><div class="quick-create-title">مكتبة صوتيات</div><div class="quick-create-meta">ملفات صوت وموسيقى بكل الصيغ المدعومة</div></button>
        <button class="quick-create-card" type="button" data-add-library-type="mixed"><span class="quick-create-icon">✨</span><div class="quick-create-title">محتوى متنوع</div><div class="quick-create-meta">فيديو وصوت داخل نفس المكتبة</div></button>
      </div>
    </div>`;
  }
  function usbStatusMarkup(src){
    const st = (cfg.liveStatus || []).find(x => x.id === src.id);
    if (!st) return '';
    const label = st.state === 'running' ? 'قيد التشغيل'
      : st.state === 'starting' ? 'جاري البدء'
      : st.state === 'disabled' ? 'معطّل'
      : st.state === 'error' ? 'خطأ'
      : st.state === 'waiting-publisher' ? 'بانتظار الناشر'
      : 'متوقف';
    const tags = [
      st.requestedVideoEncoder ? `المطلوب: ${st.requestedVideoEncoder}` : '',
      st.appliedVideoEncoder ? `الفعلي: ${st.appliedVideoEncoder}` : '',
      st.appliedResolution ? `الدقة: ${st.appliedResolution}` : '',
      st.relayMode ? `الوضع: ${st.relayMode === 'copy' ? 'copy relay' : st.relayMode}` : ''
    ].filter(Boolean);
    return `<div class="notice" style="margin-top:12px">الحالة: ${escapeHtml(label)}${st.streamUrl ? ` • <code>${escapeHtml(st.streamUrl)}</code>` : ''}${tags.length ? `<div class="editor-card-status" style="margin-top:10px">${tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}${st.probeSummary ? `<div class="muted" style="margin-top:8px">المسارات المكتشفة: ${escapeHtml(st.probeSummary)}</div>` : ''}${st.message ? `<div style="margin-top:8px">${escapeHtml(st.message)}</div>` : ''}</div>`;
  }
  function sourceTestStatusMarkup(src, index){
    const result = cfg.sourceTestResults?.[src.id] || null;
    const tags = [];
    if (result?.playlistReachable !== undefined) tags.push(`playlist: ${result.playlistReachable ? 'يعمل' : 'متعذر'}`);
    if (result?.segmentReachable !== undefined) tags.push(`segment: ${result.segmentReachable ? 'يعمل' : 'متعذر'}`);
    if (result?.probe?.streamSummary) tags.push(result.probe.streamSummary);
    if (result?.probe?.formatName) tags.push(`format: ${result.probe.formatName}`);
    const description = result?.loading
      ? 'جاري اختبار هذا الرابط من نفس جهاز السيرفر...'
      : (result?.message || 'إذا كان الرابط يعمل في VLC فقط، فهذا الاختبار يوضح هل السيرفر يرى ملف m3u8 وأول ملف ts أم أن المشكلة من توافق المتصفح.');
    return `<div class="notice" style="margin-top:12px"><div class="toolbar"><div><strong>اختبار رابط الإدخال</strong><div class="muted" style="margin-top:6px">${escapeHtml(description)}</div></div><button class="button secondary small" type="button" data-test-source="${index}" ${result?.loading ? 'disabled' : ''}>${result?.loading ? 'جاري الاختبار...' : 'اختبار الرابط من هذا الجهاز'}</button></div>${src.inputUrl ? `<div class="muted" style="margin-top:8px"><code>${escapeHtml(src.inputUrl)}</code></div>` : ''}${tags.length ? `<div class="editor-card-status" style="margin-top:10px">${tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}${result?.playlist?.finalUrl ? `<div class="muted" style="margin-top:8px">playlist: <code>${escapeHtml(result.playlist.finalUrl)}</code></div>` : ''}${result?.segment?.finalUrl ? `<div class="muted" style="margin-top:6px">segment: <code>${escapeHtml(result.segment.finalUrl)}</code></div>` : ''}</div>`;
  }
  function normalizeDeviceEntry(entry){
    if (typeof entry === 'string') return { input: entry, label: entry, displayName: entry, active: false, runningNow: false, activeState: 'available', activeSourceName: '' };
    return {
      input: entry?.input || entry?.label || '',
      label: entry?.label || entry?.input || '',
      displayName: entry?.displayName || entry?.label || entry?.input || '',
      active: !!entry?.active,
      runningNow: !!entry?.runningNow,
      activeState: entry?.activeState || 'available',
      activeSourceName: entry?.activeSourceName || '',
      kind: entry?.kind || ''
    };
  }
  function usbDeviceStatusLabel(device){
    if (device.runningNow) return `مستخدم الآن${device.activeSourceName ? ` - ${device.activeSourceName}` : ''}`;
    if (device.active) return `مربوط بمصدر${device.activeSourceName ? ` - ${device.activeSourceName}` : ''}`;
    return 'متاح';
  }
  function usbOptionLabel(device){
    return `${device.displayName} [${usbDeviceStatusLabel(device)}]`;
  }
  function usbDeviceOptions(selected=''){ const items = (cfg.deviceCatalog?.video || []).map(normalizeDeviceEntry); return [`<option value="">اختر جهاز تصوير...</option>`, ...items.map(device => `<option value="${escapeHtml(device.input)}" ${device.input===selected?'selected':''}>${escapeHtml(usbOptionLabel(device))}</option>`)].join(''); }
  function usbAudioOptions(selected=''){ const items = (cfg.deviceCatalog?.audio || []).map(normalizeDeviceEntry); return [`<option value="">بدون جهاز صوت</option>`, ...items.map(device => `<option value="${escapeHtml(device.input)}" ${device.input===selected?'selected':''}>${escapeHtml(usbOptionLabel(device))}</option>`)].join(''); }
  function usbDiscoveryList(title, items, emptyLabel){
    if (!items.length) return `<div><strong>${escapeHtml(title)}</strong><div class="muted" style="margin-top:6px">${escapeHtml(emptyLabel)}</div></div>`;
    return `<div><strong>${escapeHtml(title)}</strong><div style="margin-top:8px;display:grid;gap:8px">${items.map(device => `<div class="notice" style="margin:0"><strong>${escapeHtml(device.displayName)}</strong><div class="muted" style="margin-top:4px">${escapeHtml(usbDeviceStatusLabel(device))}</div></div>`).join('')}</div></div>`;
  }
  function usbDiscoveryNotice(){
    const cat = cfg.deviceCatalog || {};
    if (cat.error) return `<div class="notice" style="margin-bottom:12px">تعذر قراءة الأجهزة: ${escapeHtml(cat.error)}</div>`;
    if (!cat.loaded) return `<div class="notice" style="margin-bottom:12px">اضغط "اكتشاف أجهزة الفيديو والصوت" لعرض كل أجهزة الالتقاط المتصلة.</div>`;
    const video = (cat.video || []).map(normalizeDeviceEntry);
    const audio = (cat.audio || []).map(normalizeDeviceEntry);
    return `<div class="notice" style="margin-bottom:12px">تم العثور على ${video.length || 0} جهاز فيديو و ${audio.length || 0} جهاز صوت${cat.ffmpegPath ? ` باستخدام <code>${escapeHtml(cat.ffmpegPath)}</code>` : ''}.<div style="margin-top:12px;display:grid;gap:12px">${usbDiscoveryList('أجهزة الفيديو', video, 'لا توجد أجهزة فيديو مكتشفة.')}${usbDiscoveryList('أجهزة الصوت', audio, 'لا توجد أجهزة صوت مكتشفة.')}</div></div>`;
  }
  function sourceTypeLabel(type){ return ({ m3u:'M3U / IPTV', usb_capture:'USB Capture', rtmp:'RTMP', srt:'SRT', rtsp:'RTSP', hls:'HTTP / HLS / MPEG-TS', udp:'UDP', rtp:'RTP', mpegts_file:'MPEG-TS Files', network_push:'NetworkPush', resi_modulator:'RESI Modulator', webrtc:'WebRTC' }[type] || type); }
  function sourceIcon(type='m3u'){
    return ({ m3u:'📋', usb_capture:'📷', rtmp:'📺', srt:'⚡', rtsp:'🔗', hls:'📡', webrtc:'⚡' }[type] || '📡');
  }
  function sourceLiveStatus(src){
    const status = (cfg.liveStatus || []).find(entry => entry.id === src.id);
    const map = {
      running: 'يعمل الآن',
      starting: 'جاري البدء',
      disabled: 'معطّل',
      error: 'خطأ',
      'waiting-publisher': 'بانتظار الناشر',
      stopped: 'متوقف'
    };
    return map[status?.state] || (src.autoStart === false ? 'تشغيل يدوي' : 'جاهز');
  }
  function visibleSources(){
    const q = managerSearchText(sourceManagerState.q);
    const type = String(sourceManagerState.type || 'all');
    const status = String(sourceManagerState.status || 'all');
    const rows = (cfg.iptv?.sources || []).map((src, index) => ({ src, index }))
      .filter(({ src }) => {
        const srcType = src.sourceType || 'm3u';
        const liveState = sourceLiveStatus(src);
        const statusOk = status === 'all'
          || (status === 'running' && /يعمل|جاري/.test(liveState))
          || (status === 'manual' && src.autoStart === false)
          || (status === 'error' && /خطأ|متعذر/.test(liveState));
        return (type === 'all' || srcType === type) && statusOk && (!q || sourceSearchBlob(src).includes(q));
      });
    rows.sort((a, b) => {
      if (sourceManagerState.sort === 'type') return sourceTypeLabel(a.src.sourceType || 'm3u').localeCompare(sourceTypeLabel(b.src.sourceType || 'm3u'), 'ar') || String(a.src.name || '').localeCompare(String(b.src.name || ''), 'ar');
      if (sourceManagerState.sort === 'status') return sourceLiveStatus(a.src).localeCompare(sourceLiveStatus(b.src), 'ar') || String(a.src.name || '').localeCompare(String(b.src.name || ''), 'ar');
      return String(a.src.name || a.src.channelName || '').localeCompare(String(b.src.name || b.src.channelName || ''), 'ar');
    });
    return rows;
  }
  function sourceMiniCard(src, index){
    const type = src.sourceType || 'm3u';
    const selected = index === selectedSourceIndex;
    const target = src.deviceName || src.inputUrl || src.streamUrl || src.m3uPath || src.webrtcEmbedUrl || 'لم يتم ضبط الإدخال بعد';
    const delivery = src.deliveryMode || (type === 'webrtc' ? 'webrtc' : 'hls');
    const state = sourceLiveStatus(src);
    const health = /خطأ|متعذر/.test(state) ? 'bad' : (/يعمل|جاري/.test(state) ? 'ok' : 'idle');
    return `<button class="settings-manager-row source-mini-card ${selected ? 'active' : ''}" type="button" data-select-source="${index}" aria-pressed="${selected ? 'true' : 'false'}">
      <span class="settings-row-icon">${sourceIcon(type)}</span>
      <span class="settings-row-main">
        <strong>${escapeHtml(src.name || src.channelName || `مصدر ${index + 1}`)}</strong>
        <small>${escapeHtml(target)}</small>
      </span>
      <span class="settings-row-meta">
        <span>${escapeHtml(sourceTypeLabel(type))}</span>
        <span>${escapeHtml(state)}</span>
      </span>
      <span class="settings-row-tags">
        <span class="status-dot ${health}"></span>
        <span>${escapeHtml(String(delivery).toUpperCase())}</span>
        <span>${src.showOnHome !== false ? 'الرئيسية' : 'مخفي'}</span>
        <span class="button secondary small channel-list-action">إعدادات القناة</span>
      </span>
    </button>`;
  }
  function resolutionPresetOptions(current='source'){
    return [
      ['source', 'المصدر الأصلي'],
      ['360p', '360p'],
      ['480p', '480p'],
      ['720p', '720p'],
      ['1080p', '1080p'],
      ['custom', 'مخصص']
    ].map(([value, label]) => `<option value="${value}" ${String(current || 'source')===value?'selected':''}>${label}</option>`).join('');
  }
  function hwAccelOptions(current='auto'){
    return [
      ['auto', 'تلقائي - أفضل أداء'],
      ['cpu', 'CPU / libx264 - احتياطي'],
      ['nvenc', 'NVIDIA NVENC - أخف على المعالج'],
      ['qsv', 'Intel QSV - أخف على المعالج'],
      ['amf', 'AMD AMF']
    ].map(([value, label]) => `<option value="${value}" ${String(current || 'auto')===value?'selected':''}>${label}</option>`).join('');
  }
  function transcodeQualityOptions(current='balanced'){
    return [
      ['mobile', 'خفيف / هاتف'],
      ['balanced', 'متوسط / متوازن'],
      ['high', 'عالي / أفضل جودة']
    ].map(([value, label]) => `<option value="${value}" ${String(current || 'balanced')===value?'selected':''}>${label}</option>`).join('');
  }
  function liveProfileButtons(index){
    return `<div class="toolbar-group" style="grid-column:1/-1"><button class="button secondary small" type="button" data-apply-live-profile="${index}" data-profile="source">المصدر الأصلي</button><button class="button secondary small" type="button" data-apply-live-profile="${index}" data-profile="mobile">جودة هاتف</button><button class="button secondary small" type="button" data-apply-live-profile="${index}" data-profile="balanced">متوسطة</button><button class="button secondary small" type="button" data-apply-live-profile="${index}" data-profile="high">عالية</button></div>`;
  }
  function getLiveProfileSettings(profile='balanced'){
    return {
      source: {
        resolutionPreset: 'source',
        outputWidth: 0,
        outputHeight: 0,
        hlsTime: 2,
        hlsListSize: 6,
        videoBitrate: '',
        maxRate: '',
        bufSize: '',
        audioBitrate: '96k',
        frameRate: 25,
        hwAccel: 'auto'
      },
      mobile: {
        resolutionPreset: '480p',
        outputWidth: 0,
        outputHeight: 0,
        hlsTime: 2,
        hlsListSize: 6,
        videoBitrate: '1200k',
        maxRate: '1500k',
        bufSize: '2500k',
        audioBitrate: '96k',
        frameRate: 24
      },
      balanced: {
        resolutionPreset: '720p',
        outputWidth: 0,
        outputHeight: 0,
        hlsTime: 2,
        hlsListSize: 6,
        videoBitrate: '1800k',
        maxRate: '2200k',
        bufSize: '4000k',
        audioBitrate: '96k',
        frameRate: 25
      },
      high: {
        resolutionPreset: '1080p',
        outputWidth: 0,
        outputHeight: 0,
        hlsTime: 3,
        hlsListSize: 8,
        videoBitrate: '3500k',
        maxRate: '4500k',
        bufSize: '7000k',
        audioBitrate: '128k',
        frameRate: 30
      }
    }[profile] || {
      resolutionPreset: '720p',
      outputWidth: 0,
      outputHeight: 0,
      hlsTime: 2,
      hlsListSize: 6,
      videoBitrate: '1800k',
      maxRate: '2200k',
      bufSize: '4000k',
      audioBitrate: '96k',
      frameRate: 25
    };
  }
  function liveAvSummary(src = {}){
    const resolution = ({ source:'المصدر الأصلي', custom:'مخصص' }[src.resolutionPreset || 'source'] || src.resolutionPreset || 'المصدر الأصلي');
    const encoder = ({ auto:'تلقائي', cpu:'CPU', nvenc:'NVIDIA', qsv:'Intel', intel:'Intel', amf:'AMD', amd:'AMD' }[String(src.hwAccel || 'auto').toLowerCase()] || src.hwAccel || 'تلقائي');
    const video = src.videoBitrate ? `فيديو ${src.videoBitrate}` : 'فيديو تلقائي';
    return `${resolution} • ${encoder} • ${video}`;
  }
  function isolateLiveAvSettings(holder, src = {}, index = 0){
    const editor = holder?.querySelector?.('.source-editor');
    if (!editor || editor.querySelector('[data-live-av-settings]')) return;
    const keys = ['resolutionPreset','outputWidth','outputHeight','hlsTime','hlsListSize','videoBitrate','maxRate','bufSize','audioBitrate','frameRate','hwAccel'];
    const moved = [];
    for (const key of keys) {
      const control = editor.querySelector(`[data-src="${index}"][data-key="${key}"]`);
      const field = control?.closest('div');
      if (field && !moved.includes(field)) moved.push(field);
    }
    if (!moved.length) return;
    const details = document.createElement('details');
    details.className = 'config-group live-av-settings';
    details.dataset.liveAvSettings = 'true';
    const summary = document.createElement('summary');
    summary.className = 'button secondary';
    summary.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;list-style:none;width:100%;margin:0 0 12px 0';
    summary.innerHTML = `<span>إعداد الفيديو والصوت</span><span class="tag">${escapeHtml(liveAvSummary(src))}</span>`;
    const grid = document.createElement('div');
    grid.className = 'settings-grid settings-grid-2';
    for (const field of moved) grid.appendChild(field);
    const note = document.createElement('div');
    note.className = 'notice';
    note.style.marginTop = '12px';
    note.textContent = 'اترك الجودة على المصدر الأصلي ومعالج الترميز على تلقائي للحصول على أقل ضغط على المعالج. افتح هذه اللوحة فقط عند الحاجة لتغيير الدقة أو معدل الفيديو والصوت.';
    details.appendChild(summary);
    details.appendChild(grid);
    details.appendChild(note);
    const before = editor.querySelector('[data-live-category-settings]') || editor.querySelector('[data-live-av-settings] + *') || editor.lastElementChild;
    editor.insertBefore(details, before);
  }
  function decorateRtmpIngestSettings(holder, src = {}, index = 0){
    if ((src.sourceType || '') !== 'rtmp') return;
    const editor = holder?.querySelector?.('.source-editor');
    if (!editor || editor.querySelector('[data-rtmp-ingest-settings]')) return;
    const rtmp = cfg.rtmpServer || {};
    const appName = rtmp.appName || 'live';
    const port = Number(rtmp.port || 1936);
    const key = src.rtmpStreamKey || src.id || rtmp.streamKey || 'rtmp-ingest-main';
    const localUrl = src.inputUrl || `rtmp://127.0.0.1:${port}/${appName}/${key}`;
    const group = document.createElement('div');
    group.className = 'config-group';
    group.dataset.rtmpIngestSettings = 'true';
    group.innerHTML = `<div class="section-header"><div><h4 class="editor-group-title">استقبال RTMP الداخلي</h4><div class="section-subtitle">فعّل هذا الخيار عندما تريد أن يدفع OBS أو Encoder البث إلى السيرفر.</div></div></div><div class="settings-grid settings-grid-2"><div><label>نوع RTMP</label><select class="select" data-src="${index}" data-key="rtmpIngest"><option value="true" ${src.rtmpIngest === true ? 'selected' : ''}>استقبال داخلي</option><option value="false" ${src.rtmpIngest !== true ? 'selected' : ''}>رابط RTMP خارجي</option></select></div><div><label>Stream Key</label><input class="input" data-src="${index}" data-key="rtmpStreamKey" value="${escapeHtml(key)}"></div></div><div class="notice" style="margin-top:12px"><strong>رابط الدفع المحلي:</strong> <code>${escapeHtml(localUrl)}</code></div>`;
    const firstNetworkGroup = editor.querySelector('.config-group:nth-of-type(2)') || editor.lastElementChild;
    editor.insertBefore(group, firstNetworkGroup);
  }
  function sourceInputPlaceholder(type='hls'){
    return ({
      rtsp:'rtsp://USER:PASS@IP:554/stream1',
      rtmp: defaultSourceInputUrl('rtmp'),
      srt:'srt://0.0.0.0:8085?mode=listener&latency=120',
      hls:'http://IP:PORT/live/index.m3u8 أو Xtream: http://IP:PORT/user/pass/channel',
      udp:'udp://0.0.0.0:8086?listen=1&fifo_size=1000000&overrun_nonfatal=1',
      rtp:'rtp://0.0.0.0:5004?listen=1',
      mpegts_file:'D:/streams/output.ts',
      network_push:'http://IP:PORT/path or udp://0.0.0.0:PORT',
      resi_modulator:'URL/SDP or custom FFmpeg command'
    }[type] || 'https://...m3u8');
  }
  function sourceTypeOptions(current='m3u'){ return ['m3u','usb_capture','rtmp','srt','rtsp','hls','udp','rtp','mpegts_file','network_push','resi_modulator','webrtc'].map(type => `<option value="${type}" ${current===type?'selected':''}>${sourceTypeLabel(type)}</option>`).join(''); }
  function egressTypeOptions(current='srt'){
    return ['srt','udp','rtp','mpegts_file','hls','rtmp'].map(type => `<option value="${type}" ${current===type?'selected':''}>${sourceTypeLabel(type)}</option>`).join('');
  }
  function egressUrlPlaceholder(type='srt'){
    return ({
      srt:'srt://RECEIVER-IP:8085?mode=caller&latency=120',
      udp:'udp://RECEIVER-IP:8086?pkt_size=1316',
      rtp:'rtp://RECEIVER-IP:5004',
      mpegts_file:'D:/streams/output.ts',
      hls:'D:/streams/hls/index.m3u8',
      rtmp:'rtmp://SERVER/live/stream'
    }[type] || 'srt://RECEIVER-IP:8085?mode=caller&latency=120');
  }
  function egressVideoModeOptions(current='same'){
    return [
      `<option value="same" ${current === 'same' ? 'selected' : ''}>مثل البث الداخلي</option>`,
      `<option value="copy" ${current === 'copy' ? 'selected' : ''}>نسخ الفيديو بدون ترميز</option>`,
      `<option value="transcode" ${current === 'transcode' ? 'selected' : ''}>ترميز مستقل للخروج</option>`
    ].join('');
  }
  function egressHwAccelOptions(current='same'){
    return [
      `<option value="same" ${current === 'same' ? 'selected' : ''}>مثل البث الداخلي</option>`,
      hwAccelOptions(current).replace('<option value="auto"', '<option value="auto"')
    ].join('');
  }
  function egressResolutionOptions(current='same'){
    return [
      `<option value="same" ${current === 'same' ? 'selected' : ''}>مثل البث الداخلي</option>`,
      resolutionPresetOptions(current)
    ].join('');
  }
  function egressSettingsMarkup(src, index){
    const enabled = src.egressEnabled === true;
    const type = src.egressType || 'srt';
    const status = (cfg.liveStatus || []).find(x => x.id === src.id)?.egress || null;
    return `<div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">خروج البث</h4><div class="section-subtitle">إرسال نسخة إلى سيرفر خارجي بإعداد ترميز مستقل عن البث الداخلي.</div></div></div><div class="settings-grid settings-grid-3"><div><label>تفعيل الخروج</label><select class="select" data-src="${index}" data-key="egressEnabled"><option value="false" ${!enabled?'selected':''}>معطّل</option><option value="true" ${enabled?'selected':''}>مفعّل</option></select></div><div><label>نوع الخروج</label><select class="select" data-src="${index}" data-key="egressType">${egressTypeOptions(type)}</select></div><div><label>رابط/مسار الوجهة</label><input class="input" data-src="${index}" data-key="egressUrl" value="${escapeHtml(src.egressUrl || '')}" placeholder="${escapeHtml(egressUrlPlaceholder(type))}"></div><div><label>إرسال سريع</label><select class="select" data-src="${index}" data-key="egressLowLatency"><option value="true" ${src.egressLowLatency !== false ? 'selected' : ''}>مفعّل</option><option value="false" ${src.egressLowLatency === false ? 'selected' : ''}>معطّل</option></select></div><div><label>حماية من تقطع السيرفر الخارجي</label><select class="select" data-src="${index}" data-key="egressFifo"><option value="true" ${src.egressFifo !== false ? 'selected' : ''}>مفعّل</option><option value="false" ${src.egressFifo === false ? 'selected' : ''}>معطّل</option></select></div><div><label>حجم بافر الإرسال</label><input class="input" type="number" min="60" data-src="${index}" data-key="egressFifoQueue" value="${escapeHtml(src.egressFifoQueue || 600)}"></div><div><label>وضع فيديو الخروج</label><select class="select" data-src="${index}" data-key="egressVideoMode">${egressVideoModeOptions(src.egressVideoMode || 'same')}</select></div><div><label>معالج ترميز الخروج</label><select class="select" data-src="${index}" data-key="egressHwAccel">${egressHwAccelOptions(src.egressHwAccel || 'same')}</select></div><div><label>دقة الخروج</label><select class="select" data-src="${index}" data-key="egressResolutionPreset">${egressResolutionOptions(src.egressResolutionPreset || 'same')}</select></div><div><label>عرض الخروج المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="egressOutputWidth" value="${escapeHtml(src.egressOutputWidth || 0)}"></div><div><label>ارتفاع الخروج المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="egressOutputHeight" value="${escapeHtml(src.egressOutputHeight || 0)}"></div><div><label>إطارات الخروج</label><input class="input" type="number" min="0" data-src="${index}" data-key="egressFrameRate" value="${escapeHtml(src.egressFrameRate || 0)}" placeholder="0 = مثل الداخلي"></div><div><label>معدل فيديو الخروج</label><input class="input" data-src="${index}" data-key="egressVideoBitrate" value="${escapeHtml(src.egressVideoBitrate || '')}" placeholder="مثال 2500k"></div><div><label>Maxrate الخروج</label><input class="input" data-src="${index}" data-key="egressMaxRate" value="${escapeHtml(src.egressMaxRate || '')}" placeholder="مثال 3000k"></div><div><label>Buffer الخروج</label><input class="input" data-src="${index}" data-key="egressBufSize" value="${escapeHtml(src.egressBufSize || '')}" placeholder="مثال 5000k"></div><div><label>معدل صوت الخروج</label><input class="input" data-src="${index}" data-key="egressAudioBitrate" value="${escapeHtml(src.egressAudioBitrate || '')}" placeholder="مثال 128k"></div><div><label>زمن HLS للخروج</label><input class="input" type="number" min="1" data-src="${index}" data-key="egressHlsTime" value="${escapeHtml(src.egressHlsTime || 1)}"></div><div><label>عدد قوائم HLS للخروج</label><input class="input" type="number" min="3" data-src="${index}" data-key="egressHlsListSize" value="${escapeHtml(src.egressHlsListSize || 4)}"></div></div><div class="notice" style="margin-top:12px">لـ RTMP يتم ترميز الخروج دائمًا إلى H.264/AAC. خيار الحماية يستخدم FIFO حتى لا يوقف السيرفر الخارجي البث الداخلي عند التذبذب.${status?.url ? ` <div style="margin-top:8px"><code>${escapeHtml(status.url)}</code></div>` : ''}${status?.encoder ? ` <div class="muted" style="margin-top:8px">الخروج الحالي: ${escapeHtml(status.videoMode || '')} • ${escapeHtml(status.encoder || '')} • ${escapeHtml(status.resolution || '')}${status?.fifo ? ' • FIFO' : ''}</div>` : ''}</div></div>`;
  }
  function m3uSourceSettingsMarkup(src, index){
    return `<div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">قائمة IPTV</h4><div class="section-subtitle">يدعم ملف M3U محلي، رابط M3U عبر الشبكة، أو رابط HLS/MPEG-TS مباشر. إعدادات التحويل هنا تطبق على قنوات هذه القائمة عند المشاهدة.</div></div></div><div class="settings-grid settings-grid-2">${liveProfileButtons(index)}<div><label>تفعيل المصدر</label><select class="select" data-src="${index}" data-key="enabled"><option value="true" ${src.enabled!==false?'selected':''}>مفعّل</option><option value="false" ${src.enabled===false?'selected':''}>معطّل</option></select></div><div><label>إظهار في الصفحة الرئيسية</label><select class="select" data-src="${index}" data-key="showOnHome"><option value="true" ${src.showOnHome!==false?'selected':''}>نعم</option><option value="false" ${src.showOnHome===false?'selected':''}>لا</option></select></div><div><label>مسار أو رابط ملف M3U/M3U8</label><input class="input" data-src="${index}" data-key="m3uPath" value="${escapeHtml(src.m3uPath || '')}" placeholder="D:/IPTV/list.m3u أو http://.../playlist.m3u8"></div><div><label>مسار أو رابط EPG/XMLTV</label><input class="input" data-src="${index}" data-key="epgPath" value="${escapeHtml(src.epgPath || '')}"></div><div><label>مقاس التحويل</label><select class="select" data-src="${index}" data-key="resolutionPreset">${resolutionPresetOptions(src.resolutionPreset || 'source')}</select></div><div><label>العرض المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="outputWidth" value="${escapeHtml(src.outputWidth || 0)}"></div><div><label>الارتفاع المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="outputHeight" value="${escapeHtml(src.outputHeight || 0)}"></div><div><label>مقطع HLS بالثواني</label><input class="input" type="number" min="1" data-src="${index}" data-key="hlsTime" value="${escapeHtml(src.hlsTime || 2)}"></div><div><label>عدد عناصر قائمة HLS</label><input class="input" type="number" min="3" data-src="${index}" data-key="hlsListSize" value="${escapeHtml(src.hlsListSize || 6)}"></div><div><label>معدل الفيديو</label><input class="input" data-src="${index}" data-key="videoBitrate" value="${escapeHtml(src.videoBitrate || '')}" placeholder="1800k"></div><div><label>الحد الأعلى للفيديو</label><input class="input" data-src="${index}" data-key="maxRate" value="${escapeHtml(src.maxRate || '')}" placeholder="2200k"></div><div><label>حجم البافر</label><input class="input" data-src="${index}" data-key="bufSize" value="${escapeHtml(src.bufSize || '')}" placeholder="4000k"></div><div><label>معدل الصوت</label><input class="input" data-src="${index}" data-key="audioBitrate" value="${escapeHtml(src.audioBitrate || '')}" placeholder="96k"></div><div><label>عدد الإطارات</label><input class="input" type="number" min="24" data-src="${index}" data-key="frameRate" value="${escapeHtml(src.frameRate || 25)}"></div><div><label>معالج الترميز للقنوات</label><select class="select" data-src="${index}" data-key="hwAccel">${hwAccelOptions(src.hwAccel || 'auto')}</select></div><div><label>رابط الشعار</label><input class="input" data-src="${index}" data-key="logo" value="${escapeHtml(src.logo || '')}"></div><div style="grid-column:1/-1"><label>وصف</label><textarea class="textarea" data-src="${index}" data-key="description">${escapeHtml(src.description || '')}</textarea></div></div><div class="notice" style="margin-top:12px">إذا كان الرابط مباشرًا وليس قائمة قنوات، سيضيفه النظام كقناة واحدة ويحوّله إلى HLS متوافق عند المشاهدة.</div></div>`;
  }
  function m3uSourceAdvancedMarkup(src, index){
    return `<div class="config-group" data-m3u-convert-settings><div class="section-header"><div><h4 class="editor-group-title">تحويل قنوات M3U</h4><div class="section-subtitle">هذه الخيارات تطبق على القنوات المستوردة من هذه القائمة عند تشغيلها عبر Relay.</div></div></div><div class="settings-grid settings-grid-2">${liveProfileButtons(index)}<div><label>مقاس التحويل</label><select class="select" data-src="${index}" data-key="resolutionPreset">${resolutionPresetOptions(src.resolutionPreset || 'source')}</select></div><div><label>معالج الترميز للقنوات</label><select class="select" data-src="${index}" data-key="hwAccel">${hwAccelOptions(src.hwAccel || 'auto')}</select></div><div><label>معدل الفيديو</label><input class="input" data-src="${index}" data-key="videoBitrate" value="${escapeHtml(src.videoBitrate || '')}" placeholder="1800k"></div><div><label>معدل الصوت</label><input class="input" data-src="${index}" data-key="audioBitrate" value="${escapeHtml(src.audioBitrate || '')}" placeholder="96k"></div><div><label>مقطع HLS بالثواني</label><input class="input" type="number" min="1" data-src="${index}" data-key="hlsTime" value="${escapeHtml(src.hlsTime || 2)}"></div><div><label>عدد عناصر قائمة HLS</label><input class="input" type="number" min="3" data-src="${index}" data-key="hlsListSize" value="${escapeHtml(src.hlsListSize || 6)}"></div></div><div class="notice" style="margin-top:12px">إذا كان رابط M3U هو بث HLS مباشر، سيضاف كقناة واحدة بدل اعتباره قائمة مقاطع.</div></div>`;
  }
  function m3uInputModeOptions(current='auto'){
    return [
      `<option value="auto" ${current === 'auto' ? 'selected' : ''}>تلقائي: قائمة أو HLS مباشر</option>`,
      `<option value="playlist" ${current === 'playlist' ? 'selected' : ''}>قائمة M3U / IPTV كاملة</option>`,
      `<option value="direct_hls" ${current === 'direct_hls' ? 'selected' : ''}>رابط HLS مباشر: قناة واحدة</option>`
    ].join('');
  }
  function m3uSourceRuntimeMarkup(src, index){
    return `<div class="config-group" data-m3u-runtime-settings><div class="section-header"><div><h4 class="editor-group-title">نوع وتشغيل قائمة IPTV</h4><div class="section-subtitle">هذه الإعدادات ترثها كل قنوات هذه القائمة. يمكن لإعداد قناة منفردة تجاوزها عند الحاجة.</div></div></div><div class="settings-grid settings-grid-3"><div><label>نوع إدخال المصدر</label><select class="select" data-src="${index}" data-key="m3uInputMode">${m3uInputModeOptions(src.m3uInputMode || 'auto')}</select></div><div><label>تفعيل القائمة</label><select class="select" data-src="${index}" data-key="enabled"><option value="true" ${src.enabled !== false ? 'selected' : ''}>مفعّل</option><option value="false" ${src.enabled === false ? 'selected' : ''}>معطّل</option></select></div><div><label>وضع Relay والترميز</label><select class="select" data-src="${index}" data-key="relayMode">${channelRelayModeOptions(src.relayMode || 'auto')}</select></div><div><label>تجاوز فحص بدء المصدر</label><select class="select" data-src="${index}" data-key="skipStartupProbe"><option value="true" ${src.skipStartupProbe !== false ? 'selected' : ''}>مفعّل</option><option value="false" ${src.skipStartupProbe === false ? 'selected' : ''}>معطّل</option></select></div><div><label>مقاس التحويل</label><select class="select" data-src="${index}" data-key="resolutionPreset">${resolutionPresetOptions(src.resolutionPreset || 'source')}</select></div><div><label>معالج الترميز للقنوات</label><select class="select" data-src="${index}" data-key="hwAccel">${hwAccelOptions(src.hwAccel || 'auto')}</select></div><div><label>العرض المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="outputWidth" value="${escapeHtml(src.outputWidth || 0)}"></div><div><label>الارتفاع المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="outputHeight" value="${escapeHtml(src.outputHeight || 0)}"></div><div><label>عدد الإطارات</label><input class="input" type="number" min="0" data-src="${index}" data-key="frameRate" value="${escapeHtml(src.frameRate || 25)}"></div><div><label>مقطع HLS بالثواني</label><input class="input" type="number" min="1" data-src="${index}" data-key="hlsTime" value="${escapeHtml(src.hlsTime || 2)}"></div><div><label>عدد عناصر قائمة HLS</label><input class="input" type="number" min="3" data-src="${index}" data-key="hlsListSize" value="${escapeHtml(src.hlsListSize || 6)}"></div><div><label>معدل الفيديو</label><input class="input" data-src="${index}" data-key="videoBitrate" value="${escapeHtml(src.videoBitrate || '')}" placeholder="مثال 2500k"></div><div><label>الحد الأعلى للفيديو</label><input class="input" data-src="${index}" data-key="maxRate" value="${escapeHtml(src.maxRate || '')}" placeholder="مثال 3000k"></div><div><label>حجم بافر الفيديو</label><input class="input" data-src="${index}" data-key="bufSize" value="${escapeHtml(src.bufSize || '')}" placeholder="مثال 5000k"></div><div><label>معدل الصوت</label><input class="input" data-src="${index}" data-key="audioBitrate" value="${escapeHtml(src.audioBitrate || '')}" placeholder="مثال 128k"></div><div><label>وكيل المستخدم للقائمة</label><input class="input" data-src="${index}" data-key="userAgent" value="${escapeHtml(src.userAgent || '')}" placeholder="اختياري"></div><div><label>Referer للقائمة</label><input class="input" data-src="${index}" data-key="referer" value="${escapeHtml(src.referer || '')}" placeholder="https://..."></div></div><div class="notice" style="margin-top:12px"><strong>تلقائي:</strong> ينسخ المصدر المتوافق بدون ترميز. <strong>نسخ مباشر:</strong> Relay Copy دون إعادة ترميز. <strong>إعادة ترميز:</strong> يحول جميع قنوات القائمة إلى الإعدادات أعلاه. هذه الاختيارات لا تغير إعدادات القنوات التي لها تجاوز مستقل.</div></div>`;
  }
  function liveCategorySettingsMarkup(src, index){
    return `<div class="config-group" data-live-category-settings><div class="section-header"><div><h4 class="editor-group-title">تصنيف البث</h4><div class="section-subtitle">اكتب القسم الافتراضي لهذا المصدر مثل: رياضية، أخبارية، أطفال. ويمكنك تعديل كل قناة من تحكم قنوات M3U بالأسفل.</div></div></div><div class="settings-grid settings-grid-2"><div><label>القسم الافتراضي</label><input class="input" data-src="${index}" data-key="groupTitle" value="${escapeHtml(src.groupTitle || '')}" placeholder="رياضية / أخبارية / أطفال"></div><div><label>ملاحظة</label><div class="notice" style="margin:0">التصنيف يظهر في الصفحة الرئيسية وصفحة البث المباشر كأقسام منفصلة.</div></div></div></div>`;
  }
  function channelManagerShell(){
    const sources = cfg.iptv?.sources || [];
    const options = [`<option value="">كل مصادر القنوات</option>`].concat(sources.map(src => `<option value="${escapeHtml(src.id || '')}" ${channelManager.sourceId === src.id ? 'selected' : ''}>${escapeHtml(src.name || src.id || 'مصدر')}</option>`)).join('');
    return `<div class="config-card channel-manager-card" id="channel-manager-card"><div class="section-header"><div><h3 class="panel-title">إدارة القنوات</h3><div class="section-subtitle">نفس فكرة المكتبات: الفلاتر بالأعلى، والقنوات المضافة تحتها، وإعداد القناة كامل داخل نافذة منفصلة.</div></div><span class="tag" id="channels-mini-count">${escapeHtml(String(channelManager.items.length || 0))}/${escapeHtml(String(channelManager.total || 0))} قناة</span></div><div class="channel-filter-bar channel-management-filter"><div class="channel-filter-field channel-filter-search"><label>بحث</label><input class="input" id="channels-admin-q" value="${escapeHtml(channelManager.q || '')}" placeholder="اسم قناة أو رابط أو مجموعة"></div><div class="channel-filter-field"><label>المصدر</label><select class="select" id="channels-admin-source">${options}</select></div><div class="channel-filter-field"><label>المجموعة</label><select class="select" id="channels-admin-group">${channelGroupOptions()}</select></div><div class="channel-filter-field"><label>الحالة</label><select class="select" id="channels-admin-hidden"><option value="true" ${channelManager.includeHidden ? 'selected' : ''}>كل القنوات</option><option value="false" ${!channelManager.includeHidden ? 'selected' : ''}>الظاهرة فقط</option></select></div><div class="channel-filter-field"><label>الترتيب</label><select class="select" id="channels-admin-sort"><option value="default" ${channelManager.sort === 'default' ? 'selected' : ''}>الترتيب المخصص</option><option value="name" ${channelManager.sort === 'name' ? 'selected' : ''}>بالاسم</option><option value="group" ${channelManager.sort === 'group' ? 'selected' : ''}>بالمجموعة</option><option value="source" ${channelManager.sort === 'source' ? 'selected' : ''}>بالمصدر</option><option value="hidden" ${channelManager.sort === 'hidden' ? 'selected' : ''}>الحالة</option></select></div><button class="button secondary" type="button" id="channels-admin-refresh">تحديث</button></div><div id="channels-admin-status" class="notice channel-admin-status">جاري تجهيز إدارة القنوات...</div><div id="channel-groups-admin-list" class="config-stack" style="margin-bottom:14px"></div><div id="channels-admin-list" class="channel-list channel-management-list"></div><div id="channel-admin-modal-root"></div></div>`;
  }
  function channelGroupOptions(){
    const groups = Array.isArray(channelManager.groups) ? channelManager.groups : [];
    return [`<option value="" ${!channelManager.group ? 'selected' : ''}>كل المجموعات</option>`].concat(groups.map(group => {
      const value = group.id || group.value || '';
      const label = `${group.label || group.value || 'غير مصنفة'}${group.count ? ` (${group.count})` : ''}`;
      return `<option value="${escapeHtml(value)}" ${channelManager.group === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    })).join('');
  }
  function channelAdminRow(channel){
    const id = escapeHtml(channel.id || '');
    const hidden = !!channel.hidden;
    const logo = String(channel.logo || '').trim();
    const title = channel.title || channel.originalTitle || 'قناة';
    const originalChanged = channel.originalTitle && channel.originalTitle !== channel.title;
    return `<button class="channel-list-row channel-admin-row ${hidden ? 'is-hidden-channel' : ''}" type="button" data-channel-edit="${id}"><span class="channel-list-logo">${logo ? `<img src="${escapeHtml(logo)}" alt="">` : 'TV'}</span><span class="channel-list-main"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(channel.url || '')}</small></span><span class="channel-list-meta"><span class="status-dot ${hidden ? 'warn' : 'ok'}"></span><span class="tag">${escapeHtml(channel.groupTitle || 'بدون مجموعة')}</span><span class="tag">${escapeHtml(channel.sourceName || channel.sourceId || 'M3U')}</span>${originalChanged ? `<span class="tag">معدل</span>` : ''}<span>${hidden ? 'مخفية' : 'ظاهرة'}</span><span class="button secondary small channel-list-action">إعدادات القناة</span></span></button>`;
  }
  function channelGroupAdminRow(group){
    const value = group.value || '';
    const label = group.label || value || 'غير مصنفة';
    const visibleCount = Number(group.visibleCount ?? Math.max(0, Number(group.count || 0) - Number(group.hiddenCount || 0)));
    const hiddenCount = Number(group.hiddenCount || 0);
    const hidden = !!group.hidden || (!!group.override?.hidden && visibleCount === 0);
    return `<div class="notice" style="margin:0"><div class="toolbar"><div><strong>${escapeHtml(label)}</strong><div class="muted">ظاهرة: ${escapeHtml(String(visibleCount))} • مخفية: ${escapeHtml(String(hiddenCount))} • الإجمالي: ${escapeHtml(String(group.count || 0))}</div></div><div class="toolbar-group"><button class="button ${hidden ? 'success' : 'warning'} small" type="button" data-channel-group-toggle="${escapeHtml(value)}" data-hidden="${hidden ? 'false' : 'true'}">${hidden ? 'إظهار المجموعة' : 'إخفاء المجموعة'}</button><button class="button secondary small" type="button" data-channel-group-reset="${escapeHtml(value)}">إعادة الأصل</button></div></div></div>`;
  }
  function channelGroupsAdminMarkup(){
    const groups = Array.isArray(channelManager.groups) ? channelManager.groups : [];
    if (!groups.length) return '';
    const selectedLabel = channelManager.sourceId
      ? ((cfg.iptv?.sources || []).find(src => src.id === channelManager.sourceId)?.name || channelManager.sourceId)
      : 'كل المصادر';
    return `<div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">إدارة المجموعات</h4><div class="section-subtitle">إخفاء أو إظهار قسم كامل بدون حذف القنوات. النطاق الحالي: ${escapeHtml(selectedLabel)}.</div></div></div><div class="config-stack">${groups.slice(0, 12).map(channelGroupAdminRow).join('')}${groups.length > 12 ? `<div class="muted">استخدم فلتر المجموعة للوصول لبقية المجموعات.</div>` : ''}</div></div>`;
  }
  function findChannelAdminItem(channelId){
    return (channelManager.items || []).find(channel => String(channel.id || '') === String(channelId || ''));
  }
  function channelInfoRow(label, value = '', direction = 'rtl'){
    return `<div class="channel-info-row"><span>${escapeHtml(label)}</span><strong dir="${direction}">${escapeHtml(value || 'غير محدد')}</strong></div>`;
  }
  function channelAdminModalMarkup(channel){
    const id = escapeHtml(channel.id || '');
    const hidden = !!channel.hidden;
    const logo = String(channel.logo || '').trim();
    return `<div class="channel-modal-backdrop" data-channel-modal-backdrop><div class="channel-modal channel-management-modal" role="dialog" aria-modal="true" aria-label="إعدادات القناة" data-channel-editor="${id}"><div class="channel-modal-head"><div class="channel-modal-title-wrap"><span class="channel-list-logo channel-modal-logo">${logo ? `<img src="${escapeHtml(logo)}" alt="">` : 'TV'}</span><div><div class="editor-card-eyebrow">${escapeHtml(channel.sourceName || channel.sourceId || 'M3U')}</div><h3>${escapeHtml(channel.title || channel.originalTitle || 'قناة')}</h3><div class="section-subtitle truncate">${escapeHtml(channel.url || '')}</div></div></div><div class="channel-modal-actions"><button class="button success small" type="button" data-channel-save="${id}">حفظ القناة</button><button class="button danger small" type="button" data-channel-reset="${id}">إعادة الأصل</button><button class="button secondary small" type="button" data-channel-modal-close>إغلاق</button></div></div><div class="channel-modal-body channel-modal-split"><div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">إعدادات القناة</h4><div class="section-subtitle">كل ما يحتاجه المستخدم لإدارة قناة واحدة بدون البحث داخل القائمة.</div></div></div><div class="settings-grid settings-grid-2"><div><label>اسم القناة</label><input class="input" data-channel-field="title" value="${escapeHtml(channel.title || '')}" placeholder="${escapeHtml(channel.originalTitle || '')}"></div><div><label>الشعار</label><input class="input" data-channel-field="logo" value="${escapeHtml(channel.logo || '')}" placeholder="http://..."></div><div><label>المجموعة</label><input class="input" data-channel-field="groupTitle" value="${escapeHtml(channel.groupTitle || '')}" placeholder="رياضة / أخبار"></div><div><label>الترتيب</label><input class="input" type="number" data-channel-field="sortOrder" value="${channel.sortOrder ?? ''}" placeholder="اختياري"></div><div><label>إظهار القناة</label><select class="select" data-channel-field="hidden"><option value="false" ${!hidden ? 'selected' : ''}>نعم، ظاهرة</option><option value="true" ${hidden ? 'selected' : ''}>لا، إخفاء</option></select></div><div><label>ملاحظات</label><input class="input" data-channel-field="notes" value="${escapeHtml(channel.override?.notes || '')}" placeholder="اختياري"></div></div><div class="notice channel-modal-summary">الحفظ هنا يغيّر بيانات العرض والتصنيف فقط، أما رابط البث الأصلي فيبقى كما هو من ملف أو مصدر القنوات.</div></div><aside class="config-group channel-info-panel"><div class="section-header"><div><h4 class="editor-group-title">بيانات القناة</h4><div class="section-subtitle">معلومات المصدر والرابط الأصلي للرجوع السريع.</div></div></div><div class="channel-info-list">${channelInfoRow('المعرف', channel.id, 'ltr')}${channelInfoRow('الاسم الأصلي', channel.originalTitle || channel.title || '')}${channelInfoRow('المصدر', channel.sourceName || channel.sourceId || 'M3U')}${channelInfoRow('المجموعة الحالية', channel.groupTitle || '')}${channelInfoRow('الحالة', hidden ? 'مخفية' : 'ظاهرة')}${channelInfoRow('آخر تعديل', channel.override?.updatedAt || channel.overrideUpdatedAt || '')}${channelInfoRow('الرابط', channel.url || '', 'ltr')}</div><div class="toolbar-group channel-modal-side-actions"><a class="button secondary small" href="${escapeHtml(mediaHref('channel', channel.id))}" target="_blank" rel="noopener">فتح القناة</a></div></aside></div></div></div>`;
  }
  function channelEffectiveStreamSettings(channel = {}){
    const source = (cfg.iptv?.sources || []).find(entry => String(entry?.id || '') === String(channel.sourceId || '')) || {};
    const override = channel.streamSettings || channel.override?.streamSettings || {};
    return {
      ...source,
      ...override,
      relayMode: override.relayMode || source.relayMode || 'auto',
      requestHeaders: { ...(source.requestHeaders || {}), ...(override.requestHeaders || {}) }
    };
  }
  function channelRelayModeOptions(current='auto'){
    return [
      `<option value="auto" ${current === 'auto' ? 'selected' : ''}>تلقائي: نسخ عند توافق المصدر</option>`,
      `<option value="copy" ${current === 'copy' ? 'selected' : ''}>نسخ مباشر بدون إعادة ترميز</option>`,
      `<option value="transcode" ${current === 'transcode' ? 'selected' : ''}>إعادة ترميز دائماً</option>`
    ].join('');
  }
  function channelStreamSettingsMarkup(channel = {}){
    const st = channelEffectiveStreamSettings(channel);
    const headers = escapeHtml(JSON.stringify(st.requestHeaders || {}, null, 2));
    const boolOptions = (value, yes='مفعّل', no='معطّل') => `<option value="true" ${value ? 'selected' : ''}>${yes}</option><option value="false" ${!value ? 'selected' : ''}>${no}</option>`;
    return `<div class="config-group channel-stream-settings"><div class="section-header"><div><h4 class="editor-group-title">تشغيل وترميز القناة</h4><div class="section-subtitle">هذه الإعدادات تخص هذه القناة فقط، وتبقى محفوظة حتى بعد تحديث ملف M3U.</div></div></div><div class="settings-grid settings-grid-3"><div><label>طريقة تشغيل المصدر</label><select class="select" data-channel-stream-field="relayMode">${channelRelayModeOptions(st.relayMode || 'auto')}</select></div><div><label>مقاس التحويل</label><select class="select" data-channel-stream-field="resolutionPreset">${resolutionPresetOptions(st.resolutionPreset || 'source')}</select></div><div><label>معالج الترميز</label><select class="select" data-channel-stream-field="hwAccel">${hwAccelOptions(st.hwAccel || 'auto')}</select></div><div><label>العرض المخصص</label><input class="input" type="number" min="0" data-channel-stream-field="outputWidth" value="${escapeHtml(st.outputWidth || 0)}"></div><div><label>الارتفاع المخصص</label><input class="input" type="number" min="0" data-channel-stream-field="outputHeight" value="${escapeHtml(st.outputHeight || 0)}"></div><div><label>عدد الإطارات</label><input class="input" type="number" min="0" data-channel-stream-field="frameRate" value="${escapeHtml(st.frameRate || 25)}"></div><div><label>مقطع HLS بالثواني</label><input class="input" type="number" min="1" data-channel-stream-field="hlsTime" value="${escapeHtml(st.hlsTime || 2)}"></div><div><label>عدد عناصر قائمة HLS</label><input class="input" type="number" min="3" data-channel-stream-field="hlsListSize" value="${escapeHtml(st.hlsListSize || 6)}"></div><div><label>تجاوز فحص بدء المصدر</label><select class="select" data-channel-stream-field="skipStartupProbe">${boolOptions(st.skipStartupProbe !== false)}</select></div><div><label>معدل الفيديو</label><input class="input" data-channel-stream-field="videoBitrate" value="${escapeHtml(st.videoBitrate || '')}" placeholder="مثال 2500k"></div><div><label>الحد الأعلى للفيديو</label><input class="input" data-channel-stream-field="maxRate" value="${escapeHtml(st.maxRate || '')}" placeholder="مثال 3000k"></div><div><label>حجم بافر الفيديو</label><input class="input" data-channel-stream-field="bufSize" value="${escapeHtml(st.bufSize || '')}" placeholder="مثال 5000k"></div><div><label>معدل الصوت</label><input class="input" data-channel-stream-field="audioBitrate" value="${escapeHtml(st.audioBitrate || '')}" placeholder="مثال 128k"></div><div><label>وكيل المستخدم</label><input class="input" data-channel-stream-field="userAgent" value="${escapeHtml(st.userAgent || '')}" placeholder="اختياري"></div><div><label>Referer</label><input class="input" data-channel-stream-field="referer" value="${escapeHtml(st.referer || '')}" placeholder="https://..."></div><div style="grid-column:1/-1"><label>ترويسات HTTP إضافية بصيغة JSON</label><textarea class="textarea" data-channel-stream-field="requestHeaders">${headers}</textarea></div></div><div class="notice" style="margin-top:12px">في وضع التلقائي ينسخ النظام H.264/AAC المتوافق مباشرة بدون ترميز. اختر النسخ المباشر فقط عندما يكون المصدر يعمل بصيغ مناسبة للمشغل.</div></div><div class="config-group channel-stream-settings"><div class="section-header"><div><h4 class="editor-group-title">خروج القناة إلى سيرفر آخر</h4><div class="section-subtitle">نسخة مستقلة لهذه القناة فقط، بنفس خيارات القنوات اليدوية.</div></div></div><div class="settings-grid settings-grid-3"><div><label>تفعيل الخروج</label><select class="select" data-channel-stream-field="egressEnabled">${boolOptions(st.egressEnabled === true)}</select></div><div><label>نوع الخروج</label><select class="select" data-channel-stream-field="egressType">${egressTypeOptions(st.egressType || 'srt')}</select></div><div><label>رابط أو مسار الوجهة</label><input class="input" data-channel-stream-field="egressUrl" value="${escapeHtml(st.egressUrl || '')}" placeholder="${escapeHtml(egressUrlPlaceholder(st.egressType || 'srt'))}"></div><div><label>وضع فيديو الخروج</label><select class="select" data-channel-stream-field="egressVideoMode">${egressVideoModeOptions(st.egressVideoMode || 'same')}</select></div><div><label>معالج ترميز الخروج</label><select class="select" data-channel-stream-field="egressHwAccel">${egressHwAccelOptions(st.egressHwAccel || 'same')}</select></div><div><label>دقة الخروج</label><select class="select" data-channel-stream-field="egressResolutionPreset">${egressResolutionOptions(st.egressResolutionPreset || 'same')}</select></div><div><label>عرض الخروج المخصص</label><input class="input" type="number" min="0" data-channel-stream-field="egressOutputWidth" value="${escapeHtml(st.egressOutputWidth || 0)}"></div><div><label>ارتفاع الخروج المخصص</label><input class="input" type="number" min="0" data-channel-stream-field="egressOutputHeight" value="${escapeHtml(st.egressOutputHeight || 0)}"></div><div><label>إطارات الخروج</label><input class="input" type="number" min="0" data-channel-stream-field="egressFrameRate" value="${escapeHtml(st.egressFrameRate || 0)}" placeholder="0 = مثل الداخلي"></div><div><label>معدل فيديو الخروج</label><input class="input" data-channel-stream-field="egressVideoBitrate" value="${escapeHtml(st.egressVideoBitrate || '')}" placeholder="مثال 2500k"></div><div><label>Maxrate الخروج</label><input class="input" data-channel-stream-field="egressMaxRate" value="${escapeHtml(st.egressMaxRate || '')}" placeholder="مثال 3000k"></div><div><label>Buffer الخروج</label><input class="input" data-channel-stream-field="egressBufSize" value="${escapeHtml(st.egressBufSize || '')}" placeholder="مثال 5000k"></div><div><label>معدل صوت الخروج</label><input class="input" data-channel-stream-field="egressAudioBitrate" value="${escapeHtml(st.egressAudioBitrate || '')}" placeholder="مثال 128k"></div><div><label>إرسال سريع</label><select class="select" data-channel-stream-field="egressLowLatency">${boolOptions(st.egressLowLatency !== false)}</select></div><div><label>حماية FIFO</label><select class="select" data-channel-stream-field="egressFifo">${boolOptions(st.egressFifo !== false)}</select></div><div><label>حجم بافر FIFO</label><input class="input" type="number" min="60" data-channel-stream-field="egressFifoQueue" value="${escapeHtml(st.egressFifoQueue || 600)}"></div><div><label>زمن HLS للخروج</label><input class="input" type="number" min="1" data-channel-stream-field="egressHlsTime" value="${escapeHtml(st.egressHlsTime || 1)}"></div><div><label>عدد قوائم HLS للخروج</label><input class="input" type="number" min="3" data-channel-stream-field="egressHlsListSize" value="${escapeHtml(st.egressHlsListSize || 4)}"></div></div></div>`;
  }
  function openChannelModal(channelId){
    const rootNode = qs('#channel-admin-modal-root');
    const channel = findChannelAdminItem(channelId);
    if (!rootNode || !channel) return;
    rootNode.innerHTML = channelAdminModalMarkup(channel);
    const editor = rootNode.querySelector(`[data-channel-editor="${CSS.escape(channelId)}"]`);
    const basicSettings = editor?.querySelector('.config-group');
    if (basicSettings) basicSettings.insertAdjacentHTML('beforeend', channelStreamSettingsMarkup(channel));
    const summary = editor?.querySelector('.channel-modal-summary');
    if (summary) {
      summary.textContent = 'بيانات العرض وإعدادات التشغيل محفوظة لكل قناة. تحديث قائمة M3U يحدّث الرابط الأصلي فقط ولا يزيل إعدادات هذه القناة.';
      summary.insertAdjacentHTML('afterend', '<div class="notice hidden" data-channel-save-status></div>');
    }
    document.body.classList.add('channel-modal-open');
    rootNode.querySelector('[data-channel-field="title"]')?.focus();
  }
  function closeChannelModal(){
    const rootNode = qs('#channel-admin-modal-root');
    if (rootNode) rootNode.innerHTML = '';
    document.body.classList.remove('channel-modal-open');
  }
  function renderChannelManagerDynamic(){
    const count = qs('#channels-mini-count');
    const status = qs('#channels-admin-status');
    const list = qs('#channels-admin-list');
    const groupList = qs('#channel-groups-admin-list');
    const groupSelect = qs('#channels-admin-group');
    if (count) count.textContent = `${channelManager.items.length}/${channelManager.total || 0} قناة`;
    if (groupSelect && document.activeElement !== groupSelect) groupSelect.innerHTML = channelGroupOptions();
    if (groupList) groupList.innerHTML = channelManager.loaded ? channelGroupsAdminMarkup() : '';
    if (!status || !list) return;
    if (channelManager.error) {
      status.textContent = channelManager.error;
      list.innerHTML = channelManager.items.length ? channelManager.items.map(channelAdminRow).join('') : `<div class="empty">تعذر تحميل القنوات. جرّب تحديث القائمة.</div>`;
      return;
    }
    if (channelManager.loading) {
      status.textContent = channelManager.items.length ? 'جاري تحميل المزيد من القنوات...' : 'جاري تحميل القنوات...';
      if (!channelManager.items.length) list.innerHTML = '';
      return;
    }
    const activeFilters = [
      channelManager.sourceId ? 'مصدر محدد' : '',
      channelManager.group ? 'مجموعة محددة' : '',
      channelManager.q ? 'بحث نشط' : '',
      !channelManager.includeHidden ? 'الظاهرة فقط' : ''
    ].filter(Boolean);
    status.textContent = channelManager.loaded ? `تم العثور على ${channelManager.total || 0} قناة${activeFilters.length ? ` • ${activeFilters.join(' • ')}` : ''}.` : 'اضغط تحديث القنوات لعرض القنوات المستوردة.';
    const footer = channelManager.loaded && channelManager.items.length ? `<div class="channel-list-footer"><span class="muted">المعروض الآن ${escapeHtml(String(channelManager.items.length))} من ${escapeHtml(String(channelManager.total || 0))}</span>${channelManager.hasMore ? `<button class="button secondary small" type="button" data-channels-load-more>تحميل المزيد</button>` : ''}</div>` : '';
    list.innerHTML = channelManager.items?.length ? `${channelManager.items.map(channelAdminRow).join('')}${footer}` : (channelManager.loaded ? `<div class="empty">لا توجد قنوات مطابقة. شغّل فحص القنوات أولاً إذا كانت القائمة جديدة.</div>` : '');
  }
  async function loadAdminChannels(options = {}){
    const append = !!options.append;
    if (!append) {
      channelManager.page = 1;
      channelManager.items = [];
    }
    channelManager.loading = true;
    channelManager.error = '';
    renderChannelManagerDynamic();
    const params = new URLSearchParams({ page:String(channelManager.page || 1), limit:String(channelManager.limit || 80), includeHidden:String(!!channelManager.includeHidden) });
    if (channelManager.sourceId) params.set('sourceId', channelManager.sourceId);
    if (channelManager.group) params.set('group', channelManager.group);
    if (channelManager.q) params.set('q', channelManager.q);
    if (channelManager.sort) params.set('sort', channelManager.sort);
    try {
      const result = await getJson(`/api/admin/channels?${params.toString()}`);
      const incoming = Array.isArray(result.items) ? result.items : [];
      channelManager.items = append ? channelManager.items.concat(incoming) : incoming;
      channelManager.groups = Array.isArray(result.groups) ? result.groups : channelManager.groups;
      channelManager.total = Number(result.total || channelManager.items.length || 0);
      channelManager.page = Number(result.page || channelManager.page || 1);
      channelManager.hasMore = !!result.hasMore;
      channelManager.loaded = true;
      channelManager.error = '';
    } catch (error) {
      channelManager.loaded = true;
      channelManager.error = error?.error || error?.message || 'تعذر تحميل القنوات.';
    } finally {
      channelManager.loading = false;
      saveSettingsUiSelection();
      renderChannelManagerDynamic();
    }
  }
  function collectChannelPatch(channelId){
    const row = qs(`[data-channel-editor="${CSS.escape(channelId)}"]`);
    if (!row) return null;
    const value = key => row.querySelector(`[data-channel-field="${key}"]`)?.value || '';
    const streamSettings = {};
    const booleanKeys = new Set(['skipStartupProbe', 'egressEnabled', 'egressLowLatency', 'egressFifo']);
    row.querySelectorAll('[data-channel-stream-field]').forEach(field => {
      const key = field.dataset.channelStreamField || '';
      if (!key) return;
      if (key === 'requestHeaders') {
        const raw = String(field.value || '').trim();
        if (!raw) return;
        try {
          const headers = JSON.parse(raw);
          if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error();
          streamSettings.requestHeaders = headers;
        } catch {
          throw new Error('ترويسات HTTP يجب أن تكون JSON صالحاً، مثل {"Referer":"https://example.com/"}.');
        }
        return;
      }
      streamSettings[key] = booleanKeys.has(key) ? field.value === 'true' : field.value;
    });
    return { title:value('title'), logo:value('logo'), groupTitle:value('groupTitle'), sortOrder:value('sortOrder'), hidden:value('hidden') === 'true', notes:value('notes'), streamSettings };
  }
  async function saveChannelPatch(channelId){
    const editor = qs(`[data-channel-editor="${CSS.escape(channelId)}"]`);
    const status = editor?.querySelector('[data-channel-save-status]');
    try {
      const patch = collectChannelPatch(channelId);
      if (!patch) return;
      const result = await getJson(`/api/admin/channels/${encodeURIComponent(channelId)}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch) });
      const index = (channelManager.items || []).findIndex(channel => String(channel.id || '') === String(channelId));
      if (index >= 0) {
        const current = channelManager.items[index] || {};
        const updated = result?.item || {};
        channelManager.items[index] = {
          ...current,
          ...updated,
          streamSettings: updated.streamSettings || patch.streamSettings,
          override: { ...(current.override || {}), streamSettings: updated.streamSettings || patch.streamSettings, updatedAt: updated.overrideUpdatedAt || new Date().toISOString() }
        };
      }
      renderChannelManagerDynamic();
      if (status) {
        status.textContent = 'تم الحفظ. تبقى نافذة الإعدادات مفتوحة، وتطبق إعدادات البث عند تشغيل Relay جديد بدون قطع المشاهدات الحالية.';
        status.classList.remove('hidden');
      }
    } catch (error) {
      if (status) {
        status.textContent = error?.error || error?.message || 'تعذر حفظ إعدادات القناة.';
        status.classList.remove('hidden');
      }
    }
  }
  async function resetChannelPatch(channelId){
    await getJson(`/api/admin/channels/${encodeURIComponent(channelId)}`, { method:'DELETE' });
    closeChannelModal();
    await loadAdminChannels();
  }
  async function saveChannelGroupPatch(groupTitle='', hidden=false){
    await getJson('/api/admin/channel-groups', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ sourceId: channelManager.sourceId || '', groupTitle: groupTitle || '', hidden: !!hidden })
    });
    await loadAdminChannels();
  }
  async function resetChannelGroupPatch(groupTitle=''){
    const params = new URLSearchParams({ sourceId: channelManager.sourceId || '', groupTitle: groupTitle || '' });
    await getJson(`/api/admin/channel-groups?${params.toString()}`, { method:'DELETE' });
    await loadAdminChannels();
  }
  function deliveryModeOptions(current='hls'){
    return [
      `<option value="hls" ${current !== 'webrtc' ? 'selected' : ''}>HLS داخل النظام</option>`,
      `<option value="webrtc" ${current === 'webrtc' ? 'selected' : ''}>WebRTC مباشر</option>`
    ].join('');
  }
  function appAbsoluteUrl(path=''){
    const value = String(path || '');
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `${location.origin}${value.startsWith('/') ? value : `/${value}`}`;
  }
  function localPublisherUrl(src){ return appAbsoluteUrl(`/webrtc-publisher?sourceId=${encodeURIComponent(src.id || '')}`); }
  function localViewerUrl(src){ return appAbsoluteUrl(src.webrtcEmbedUrl || `/webrtc-viewer?sourceId=${encodeURIComponent(src.id || '')}`); }
  function sourceModalMarkup(src, index){
    const type = src.sourceType || 'm3u';
    const title = src.name || src.channelName || `مصدر ${index + 1}`;
    const target = src.deviceName || src.inputUrl || src.streamUrl || src.m3uPath || src.webrtcEmbedUrl || src.id || '';
    return `<div class="channel-modal-backdrop" data-source-modal-backdrop><div class="channel-modal source-modal" role="dialog" aria-modal="true" aria-label="إعدادات مصدر البث" data-source-editor="${index}"><div class="channel-modal-head"><div class="channel-modal-title-wrap"><span class="channel-list-logo channel-modal-logo">${sourceIcon(type)}</span><div><div class="editor-card-eyebrow">${escapeHtml(sourceTypeLabel(type))} • ${escapeHtml(sourceLiveStatus(src))}</div><h3>${escapeHtml(title)}</h3><div class="section-subtitle truncate">${escapeHtml(target)}</div></div></div><div class="channel-modal-actions"><button class="button success small" type="button" data-save-source-settings="${index}">حفظ القناة</button>${['srt','hls','udp','rtp','mpegts_file','network_push','resi_modulator','rtmp','rtsp'].includes(type) ? `<button class="button secondary small" type="button" data-test-source="${index}">اختبار المصدر</button>` : ''}<button class="button danger small" type="button" data-remove-source="${index}">حذف</button><button class="button secondary small" type="button" data-source-modal-close>إغلاق</button></div></div><div class="channel-modal-body source-modal-body">${sourceCard(src, index)}${type === 'm3u' ? m3uSourceRuntimeMarkup(src, index) : ''}${liveCategorySettingsMarkup(src, index)}</div></div></div>`;
  }
  function openSourceModal(index){
    selectedSourceIndex = clampIndex(index, cfg.iptv?.sources?.length || 0);
    const rootNode = qs('#source-admin-modal-root');
    const src = cfg.iptv?.sources?.[selectedSourceIndex];
    if (!rootNode || !src) return;
    rootNode.innerHTML = sourceModalMarkup(src, selectedSourceIndex);
    isolateLiveAvSettings(rootNode, src, selectedSourceIndex);
    decorateRtmpIngestSettings(rootNode, src, selectedSourceIndex);
    document.body.classList.add('channel-modal-open');
    rootNode.querySelector('[data-key="name"]')?.focus();
  }
  function closeSourceModal(){
    const rootNode = qs('#source-admin-modal-root');
    if (rootNode) rootNode.innerHTML = '';
    document.body.classList.remove('channel-modal-open');
  }
  function sourceCard(src, index){
    const type = src.sourceType || 'm3u';
    const usb = type === 'usb_capture';
    const network = ['rtmp','srt','rtsp','hls','udp','rtp','mpegts_file','network_push','resi_modulator'].includes(type);
    const webrtc = type === 'webrtc';
    return `<div class="config-card editor-card source-editor"><div class="editor-card-head"><div><div class="editor-card-eyebrow">مصدر ${index+1} • ${escapeHtml(sourceTypeLabel(type))}</div><h3>${escapeHtml(src.name || `مصدر ${index+1}`)}</h3><div class="section-subtitle">${escapeHtml(src.id || '')}</div></div><div class="editor-card-actions"><button class="button danger small" data-remove-source="${index}">حذف</button></div></div><div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">بيانات المصدر</h4><div class="section-subtitle">الاسم، المعرّف، ونوع المصدر قبل ضبط التفاصيل الفنية.</div></div></div><div class="settings-grid settings-grid-3"><div><label>الاسم</label><input class="input" data-src="${index}" data-key="name" value="${escapeHtml(src.name || '')}"></div><div><label>المعرف</label><input class="input" data-src="${index}" data-key="id" value="${escapeHtml(src.id || '')}"></div><div><label>النوع</label><select class="select" data-src="${index}" data-key="sourceType">${sourceTypeOptions(type)}</select></div></div></div>${usb ? `<div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">إعدادات الجهاز والبث</h4><div class="section-subtitle">تحكم بالدقة والترميز وأجهزة الصوت والصورة من مكان واحد.</div></div></div><div class="settings-grid settings-grid-2">${liveProfileButtons(index)}<div><label>اسم القناة المعروض</label><input class="input" data-src="${index}" data-key="channelName" value="${escapeHtml(src.channelName || '')}"></div><div><label>وضع البث</label><select class="select" data-src="${index}" data-key="deliveryMode">${deliveryModeOptions(src.deliveryMode || 'hls')}</select></div><div><label>إظهار في الصفحة الرئيسية</label><select class="select" data-src="${index}" data-key="showOnHome"><option value="true" ${src.showOnHome!==false?'selected':''}>نعم</option><option value="false" ${src.showOnHome===false?'selected':''}>لا</option></select></div><div><label>اسم جهاز الفيديو</label><input class="input" data-src="${index}" data-key="deviceName" value="${escapeHtml(src.deviceName || '')}" placeholder="أو اختر من القائمة"></div><div><label>أجهزة الفيديو</label><select class="select" data-device-picker="${index}">${usbDeviceOptions(src.deviceName || '')}</select></div><div><label>أجهزة الصوت</label><select class="select" data-audio-device-picker="${index}">${usbAudioOptions(src.audioDeviceName || '')}</select></div><div><label>جهاز الصوت المختار</label><input class="input" data-src="${index}" data-key="audioDeviceName" value="${escapeHtml(src.audioDeviceName || '')}" placeholder="اختياري"></div><div><label>التشغيل التلقائي</label><select class="select" data-src="${index}" data-key="autoStart"><option value="true" ${src.autoStart!==false?'selected':''}>مفعّل</option><option value="false" ${src.autoStart===false?'selected':''}>معطّل</option></select></div><div><label>مقاس البث</label><select class="select" data-src="${index}" data-key="resolutionPreset">${resolutionPresetOptions(src.resolutionPreset || 'source')}</select></div><div><label>العرض المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="outputWidth" value="${escapeHtml(src.outputWidth || 0)}" placeholder="مثال 1280"></div><div><label>الارتفاع المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="outputHeight" value="${escapeHtml(src.outputHeight || 0)}" placeholder="مثال 720"></div><div><label>مقطع HLS بالثواني</label><input class="input" type="number" min="1" data-src="${index}" data-key="hlsTime" value="${escapeHtml(src.hlsTime || 2)}" placeholder="2"></div><div><label>عدد عناصر قائمة HLS</label><input class="input" type="number" min="3" data-src="${index}" data-key="hlsListSize" value="${escapeHtml(src.hlsListSize || 6)}" placeholder="6"></div><div><label>معدل الفيديو</label><input class="input" data-src="${index}" data-key="videoBitrate" value="${escapeHtml(src.videoBitrate || '')}" placeholder="1800k"></div><div><label>الحد الأعلى للفيديو</label><input class="input" data-src="${index}" data-key="maxRate" value="${escapeHtml(src.maxRate || '')}" placeholder="2200k"></div><div><label>حجم البافر</label><input class="input" data-src="${index}" data-key="bufSize" value="${escapeHtml(src.bufSize || '')}" placeholder="4000k"></div><div><label>معدل الصوت</label><input class="input" data-src="${index}" data-key="audioBitrate" value="${escapeHtml(src.audioBitrate || '')}" placeholder="96k"></div><div><label>عدد الإطارات</label><input class="input" type="number" min="24" data-src="${index}" data-key="frameRate" value="${escapeHtml(src.frameRate || 25)}" placeholder="25"></div><div><label>معالج الترميز</label><select class="select" data-src="${index}" data-key="hwAccel">${hwAccelOptions(src.hwAccel || 'auto')}</select></div><div><label>مسار FFmpeg</label><input class="input" data-src="${index}" data-key="ffmpegPath" value="${escapeHtml(src.ffmpegPath || '')}" placeholder="اتركه فارغًا لاستخدام الإعداد العام"></div><div><label>رابط HLS الناتج</label><input class="input" data-src="${index}" data-key="streamUrl" value="${escapeHtml(src.streamUrl || '')}" placeholder="/live-streams/source-id/index.m3u8"></div><div><label>رابط WebRTC للمشاهدة</label><input class="input" data-src="${index}" data-key="webrtcEmbedUrl" value="${escapeHtml(src.webrtcEmbedUrl || '')}" placeholder="${escapeHtml(localViewerUrl(src))}"></div><div><label>رابط الشعار</label><input class="input" data-src="${index}" data-key="logo" value="${escapeHtml(src.logo || '')}"></div><div><label>وصف / ملاحظات</label><textarea class="textarea" data-src="${index}" data-key="description">${escapeHtml(src.description || '')}</textarea></div><div><label>FFmpeg Input</label><input class="input" data-src="${index}" data-key="ffmpegInput" value="${escapeHtml(src.ffmpegInput || '')}" placeholder="إذا تُرك فارغًا سيُركّب النظام الإدخال تلقائيًا من أجهزة الفيديو والصوت"></div><div style="grid-column:1/-1"><label>أمر FFmpeg اختياري</label><textarea class="textarea" data-src="${index}" data-key="ffmpegCommand" placeholder="اختياري لتخصيص التشغيل">${escapeHtml(src.ffmpegCommand || '')}</textarea></div></div><div class="notice" style="margin-top:12px">${src.deliveryMode === 'webrtc' ? `وضع الجهاز الآن WebRTC مباشر. الناشر لا يفتح إلا من لوحة المسؤول. <button class="button secondary small" type="button" data-open-publisher="${index}">فتح الناشر</button> <span style="display:block;margin-top:8px">رابط المشاهدة: <code>${escapeHtml(localViewerUrl(src))}</code></span>` : 'وضع الجهاز الآن HLS داخلي عبر FFmpeg مع تحكم بالدقة والمعدل ومعالج الترميز.'}</div>${usbStatusMarkup(src)}</div>` : network ? `<div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">إدخال الشبكة والإخراج</h4><div class="section-subtitle">إعداد رابط المصدر والجودة والترميز في مجموعة واحدة أوضح.</div></div></div><div class="settings-grid settings-grid-2">${liveProfileButtons(index)}<div><label>اسم القناة المعروض</label><input class="input" data-src="${index}" data-key="channelName" value="${escapeHtml(src.channelName || '')}"></div><div><label>إظهار في الصفحة الرئيسية</label><select class="select" data-src="${index}" data-key="showOnHome"><option value="true" ${src.showOnHome!==false?'selected':''}>نعم</option><option value="false" ${src.showOnHome===false?'selected':''}>لا</option></select></div><div><label>رابط الإدخال ${escapeHtml(type.toUpperCase())}</label><input class="input" data-src="${index}" data-key="inputUrl" value="${escapeHtml(src.inputUrl || '')}" placeholder="${escapeHtml(sourceInputPlaceholder(type))}"></div><div><label>التشغيل التلقائي</label><select class="select" data-src="${index}" data-key="autoStart"><option value="true" ${src.autoStart!==false?'selected':''}>مفعّل</option><option value="false" ${src.autoStart===false?'selected':''}>معطّل</option></select></div><div><label>مقاس البث</label><select class="select" data-src="${index}" data-key="resolutionPreset">${resolutionPresetOptions(src.resolutionPreset || 'source')}</select></div><div><label>العرض المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="outputWidth" value="${escapeHtml(src.outputWidth || 0)}"></div><div><label>الارتفاع المخصص</label><input class="input" type="number" min="0" data-src="${index}" data-key="outputHeight" value="${escapeHtml(src.outputHeight || 0)}"></div><div><label>مقطع HLS بالثواني</label><input class="input" type="number" min="1" data-src="${index}" data-key="hlsTime" value="${escapeHtml(src.hlsTime || 2)}"></div><div><label>عدد عناصر قائمة HLS</label><input class="input" type="number" min="3" data-src="${index}" data-key="hlsListSize" value="${escapeHtml(src.hlsListSize || 6)}"></div><div><label>معدل الفيديو</label><input class="input" data-src="${index}" data-key="videoBitrate" value="${escapeHtml(src.videoBitrate || '')}" placeholder="1800k"></div><div><label>الحد الأعلى للفيديو</label><input class="input" data-src="${index}" data-key="maxRate" value="${escapeHtml(src.maxRate || '')}" placeholder="2200k"></div><div><label>حجم البافر</label><input class="input" data-src="${index}" data-key="bufSize" value="${escapeHtml(src.bufSize || '')}" placeholder="4000k"></div><div><label>معدل الصوت</label><input class="input" data-src="${index}" data-key="audioBitrate" value="${escapeHtml(src.audioBitrate || '')}" placeholder="96k"></div><div><label>عدد الإطارات</label><input class="input" type="number" min="24" data-src="${index}" data-key="frameRate" value="${escapeHtml(src.frameRate || 25)}"></div><div><label>معالج الترميز</label><select class="select" data-src="${index}" data-key="hwAccel">${hwAccelOptions(src.hwAccel || 'auto')}</select></div><div><label>رابط HLS الناتج</label><input class="input" data-src="${index}" data-key="streamUrl" value="${escapeHtml(src.streamUrl || '')}" placeholder="/live-streams/source-id/index.m3u8"></div><div><label>رابط الشعار</label><input class="input" data-src="${index}" data-key="logo" value="${escapeHtml(src.logo || '')}"></div><div><label>وصف</label><textarea class="textarea" data-src="${index}" data-key="description">${escapeHtml(src.description || '')}</textarea></div><div><label>مسار FFmpeg</label><input class="input" data-src="${index}" data-key="ffmpegPath" value="${escapeHtml(src.ffmpegPath || '')}"></div><div style="grid-column:1/-1"><label>أمر FFmpeg اختياري</label><textarea class="textarea" data-src="${index}" data-key="ffmpegCommand">${escapeHtml(src.ffmpegCommand || '')}</textarea></div></div>${usbStatusMarkup(src)}</div>` : webrtc ? `<div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">إعدادات WebRTC</h4><div class="section-subtitle">روابط العرض والظهور في الصفحة الرئيسية بشكل أوضح.</div></div></div><div class="settings-grid settings-grid-2"><div><label>اسم القناة المعروض</label><input class="input" data-src="${index}" data-key="channelName" value="${escapeHtml(src.channelName || '')}"></div><div><label>إظهار في الصفحة الرئيسية</label><select class="select" data-src="${index}" data-key="showOnHome"><option value="true" ${src.showOnHome!==false?'selected':''}>نعم</option><option value="false" ${src.showOnHome===false?'selected':''}>لا</option></select></div><div><label>رابط مشغل / Embed WebRTC</label><input class="input" data-src="${index}" data-key="webrtcEmbedUrl" value="${escapeHtml(src.webrtcEmbedUrl || '')}" placeholder="https://... أو /webrtc/player"></div><div><label>رابط مباشر احتياطي</label><input class="input" data-src="${index}" data-key="streamUrl" value="${escapeHtml(src.streamUrl || '')}" placeholder="اختياري"></div><div><label>رابط الشعار</label><input class="input" data-src="${index}" data-key="logo" value="${escapeHtml(src.logo || '')}"></div><div style="grid-column:1/-1"><label>وصف</label><textarea class="textarea" data-src="${index}" data-key="description">${escapeHtml(src.description || '')}</textarea></div></div><div class="notice" style="margin-top:12px">وضع WebRTC مباشر. هذا مناسب عندما يكون لديك صفحة أو بوابة WebRTC جاهزة لأجهزة البث.</div></div>` : `<div class="config-group"><div class="section-header"><div><h4 class="editor-group-title">قائمة IPTV</h4><div class="section-subtitle">ضع ملف القنوات وملف الدليل الإلكتروني في مكان واضح ومباشر.</div></div></div><div class="settings-grid settings-grid-2"><div><label>إظهار في الصفحة الرئيسية</label><select class="select" data-src="${index}" data-key="showOnHome"><option value="true" ${src.showOnHome!==false?'selected':''}>نعم</option><option value="false" ${src.showOnHome===false?'selected':''}>لا</option></select></div><div><label>مسار ملف M3U</label><input class="input" data-src="${index}" data-key="m3uPath" value="${escapeHtml(src.m3uPath || '')}"></div><div><label>مسار ملف EPG/XMLTV</label><input class="input" data-src="${index}" data-key="epgPath" value="${escapeHtml(src.epgPath || '')}"></div></div></div>`}${(usb || network) ? egressSettingsMarkup(src, index) : ''}${network ? sourceTestStatusMarkup(src, index) : ''}</div>`;
  }
  function renderLive(){
    const sources = cfg.iptv?.sources || [];
    selectedSourceIndex = clampIndex(selectedSourceIndex, sources.length);
    const visible = visibleSources();
    return `<div class="settings-section" data-section-content="live">
      <div class="section-header">
        <div>
          <h2 class="section-title">البث المباشر</h2>
          <div class="section-subtitle">إدارة كثيفة لمصادر البث: بحث، فلترة حسب النوع والحالة، ثم تعديل المصدر المختار.</div>
        </div>
        <div class="toolbar-group"><button class="button secondary" id="discover-usb-devices">اكتشاف أجهزة الفيديو والصوت</button><button class="button secondary" id="add-source">إضافة مصدر</button></div>
      </div>
      ${usbDiscoveryNotice()}
      <div class="settings-manager source-manager-modalized">
        <div class="settings-mini-panel">
          <div class="settings-mini-panel-head"><strong>مصادر البث</strong><span id="sources-mini-count">${escapeHtml(String(visible.length))}/${escapeHtml(String(sources.length))} مصدر</span></div>
          <div class="settings-manager-tools">
            <input class="input" id="sources-filter" value="${escapeHtml(sourceManagerState.q || '')}" placeholder="بحث بالاسم أو الرابط أو الجهاز">
            <select class="select" id="source-type-filter">
              <option value="all" ${sourceManagerState.type === 'all' ? 'selected' : ''}>كل الأنواع</option>
              <option value="usb_capture" ${sourceManagerState.type === 'usb_capture' ? 'selected' : ''}>USB</option>
              <option value="m3u" ${sourceManagerState.type === 'm3u' ? 'selected' : ''}>M3U / IPTV</option>
              <option value="hls" ${sourceManagerState.type === 'hls' ? 'selected' : ''}>HLS</option>
              <option value="udp" ${sourceManagerState.type === 'udp' ? 'selected' : ''}>UDP</option>
              <option value="rtp" ${sourceManagerState.type === 'rtp' ? 'selected' : ''}>RTP</option>
              <option value="mpegts_file" ${sourceManagerState.type === 'mpegts_file' ? 'selected' : ''}>MPEG-TS Files</option>
              <option value="network_push" ${sourceManagerState.type === 'network_push' ? 'selected' : ''}>NetworkPush</option>
              <option value="resi_modulator" ${sourceManagerState.type === 'resi_modulator' ? 'selected' : ''}>RESI Modulator</option>
              <option value="rtsp" ${sourceManagerState.type === 'rtsp' ? 'selected' : ''}>RTSP</option>
              <option value="rtmp" ${sourceManagerState.type === 'rtmp' ? 'selected' : ''}>RTMP</option>
              <option value="srt" ${sourceManagerState.type === 'srt' ? 'selected' : ''}>SRT</option>
              <option value="webrtc" ${sourceManagerState.type === 'webrtc' ? 'selected' : ''}>WebRTC</option>
            </select>
            <select class="select" id="source-status-filter">
              <option value="all" ${sourceManagerState.status === 'all' ? 'selected' : ''}>كل الحالات</option>
              <option value="running" ${sourceManagerState.status === 'running' ? 'selected' : ''}>يعمل أو يبدأ</option>
              <option value="manual" ${sourceManagerState.status === 'manual' ? 'selected' : ''}>تشغيل يدوي</option>
              <option value="error" ${sourceManagerState.status === 'error' ? 'selected' : ''}>أخطاء</option>
            </select>
            <select class="select" id="source-sort">
              <option value="name" ${sourceManagerState.sort === 'name' ? 'selected' : ''}>ترتيب بالاسم</option>
              <option value="type" ${sourceManagerState.sort === 'type' ? 'selected' : ''}>ترتيب بالنوع</option>
              <option value="status" ${sourceManagerState.sort === 'status' ? 'selected' : ''}>ترتيب بالحالة</option>
            </select>
          </div>
          <div class="settings-mini-grid settings-table-list" id="sources-mini-wrap">${visible.map(({ src, index }) => sourceMiniCard(src, index)).join('') || `<div class="empty">لا توجد نتيجة مطابقة.</div>`}</div>
        </div>
        <div id="source-admin-modal-root"></div>
      </div>
      <div class="quick-create-grid compact-create-grid">
        <button class="quick-create-card" type="button" data-add-source-type="usb_capture"><span class="quick-create-icon">📷</span><div class="quick-create-title">جهاز USB</div><div class="quick-create-meta">كاميرا أو كرت التقاط مع تشغيل محلي</div></button>
        <button class="quick-create-card" type="button" data-add-source-type="hls"><span class="quick-create-icon">📡</span><div class="quick-create-title">مصدر HTTP مباشر</div><div class="quick-create-meta">m3u8 أو رابط Xtream خام</div></button>
        <button class="quick-create-card" type="button" data-add-source-type="rtmp"><span class="quick-create-icon">RTMP</span><div class="quick-create-title">استقبال RTMP</div><div class="quick-create-meta">يدفع OBS أو Encoder إلى النظام</div></button>
        <button class="quick-create-card" type="button" data-add-source-type="srt"><span class="quick-create-icon">SRT</span><div class="quick-create-title">SRT Listener</div><div class="quick-create-meta">Caller devices to UDP 8085</div></button>
        <button class="quick-create-card" type="button" data-add-source-type="udp"><span class="quick-create-icon">UDP</span><div class="quick-create-title">UDP TS</div><div class="quick-create-meta">MPEG-TS over UDP 8086</div></button>
        <button class="quick-create-card" type="button" data-add-source-type="rtp"><span class="quick-create-icon">RTP</span><div class="quick-create-title">RTP</div><div class="quick-create-meta">RTP listener on 5004</div></button>
        <button class="quick-create-card" type="button" data-add-source-type="rtsp"><span class="quick-create-icon">🔗</span><div class="quick-create-title">مصدر RTSP</div><div class="quick-create-meta">كاميرات وشبكات مراقبة</div></button>
        <button class="quick-create-card" type="button" data-add-source-type="webrtc"><span class="quick-create-icon">⚡</span><div class="quick-create-title">مصدر WebRTC</div><div class="quick-create-meta">بث مباشر فوري بزمن تأخير منخفض</div></button>
      </div>

      <div class="config-card" style="margin-top:20px">
        <div class="section-header">
          <div>
            <h3>خيارات البث العامة</h3>
            <div class="section-subtitle">التحم في المجموعات وطريقة تشغيل بث القنوات.</div>
          </div>
        </div>
        <div class="settings-grid settings-grid-2">
          <div>
            <label>تعطيل تصنيفات/مجموعات القنوات</label>
            <select class="select" id="iptv-disable-groups">
              <option value="true" ${cfg.iptv?.disableGroups === true ? 'selected' : ''}>تعطيل المجموعات (عرض كقائمة موحدة)</option>
              <option value="false" ${cfg.iptv?.disableGroups !== true ? 'selected' : ''}>تمكين المجموعات (تقسيم القنوات لأقسام)</option>
            </select>
          </div>
          <div>
            <label>استمرارية البث المباشر (Relays)</label>
            <select class="select" id="iptv-keep-relays-alive">
              <option value="true" ${cfg.iptv?.keepRelaysAlive === true ? 'selected' : ''}>تشغيل دائم في الخلفية (جاهز فوري)</option>
              <option value="false" ${cfg.iptv?.keepRelaysAlive !== true ? 'selected' : ''}>إيقاف مؤقت عند الخمول (توفير المعالجة)</option>
            </select>
          </div>
        </div>
      </div>
      <div class="config-card" style="margin-top:20px" id="iptv-groups-config-card"></div>
      ${channelManagerShell()}
    </div>`;
  }
  function renderAccess(){ return `<div class="settings-section" data-section-content="access"><div class="settings-grid settings-grid-2"><div class="config-card"><h3>الوصول والحسابات</h3><div class="config-stack"><div><label>التسجيل الذاتي</label><select class="select" id="allow-register"><option value="true" ${cfg.auth?.allowSelfRegistration?'selected':''}>مفعّل</option><option value="false" ${!cfg.auth?.allowSelfRegistration?'selected':''}>معطّل</option></select></div><div><label>الدخول التلقائي حسب الجهاز</label><select class="select" id="auto-register-devices"><option value="true" ${cfg.auth?.autoRegisterDevices!==false?'selected':''}>مفعّل</option><option value="false" ${cfg.auth?.autoRegisterDevices===false?'selected':''}>معطّل</option></select></div><div><label>طلب تسجيل الدخول للمشاهدة</label><select class="select" id="require-login"><option value="true" ${cfg.auth?.requireLoginForViewing?'selected':''}>مفعّل</option><option value="false" ${!cfg.auth?.requireLoginForViewing?'selected':''}>معطّل</option></select></div></div></div><div class="config-card"><h3>حساب الإدارة</h3><div class="config-stack"><div><label>اسم مستخدم المدير</label><input class="input" id="admin-user" value="${escapeHtml(cfg.admin?.username || 'admin')}"></div><div><label>كلمة مرور المدير</label><input class="input" id="admin-pass" type="password" value="${escapeHtml(cfg.admin?.password || 'admin123')}"></div></div></div></div></div>`; }
  function renderScan(){ return `<div class="settings-section" data-section-content="scan"><div class="settings-grid settings-grid-2"><div class="config-card"><h3>محرك الفحص</h3><div class="config-stack"><div><label>فحص تلقائي عند خلو الفهرس</label><select class="select" id="scan-autostart"><option value="true" ${(cfg.scan?.autoStartOnEmptyIndex ?? true)?'selected':''}>مفعّل</option><option value="false" ${!(cfg.scan?.autoStartOnEmptyIndex ?? true)?'selected':''}>معطّل</option></select></div><div><label>تحديث حالة الفحص كل N عنصر</label><input class="input" id="scan-status-every" type="number" min="10" value="${escapeHtml(cfg.scan?.statusUpdateEvery || 100)}"></div><div><label>إعطاء أولوية للتجاوب كل N عنصر</label><input class="input" id="scan-yield-every" type="number" min="10" value="${escapeHtml(cfg.scan?.yieldEvery || 200)}"></div>${scanScheduleControlsMarkup(cfg.scan || {})}</div></div><div class="config-card"><h3>ملخص سريع</h3><div class="stats-bar compact-stats"><div class="stat"><div class="stat-label">المكتبات</div><strong>${cfg.libraries?.length || 0}</strong></div><div class="stat"><div class="stat-label">مصادر البث</div><strong>${cfg.iptv?.sources?.length || 0}</strong></div><div class="stat"><div class="stat-label">صوتيات</div><strong>${(cfg.libraries || []).filter(x => x.type === 'audio').length}</strong></div><div class="stat"><div class="stat-label">USB Capture</div><strong>${(cfg.iptv?.sources || []).filter(x => x.sourceType === 'usb_capture').length}</strong></div></div></div></div></div>`; }
  function renderAll(){ const wrap = qs('#settings-sections'); wrap.innerHTML = `${renderAssistant()}${renderSystem()}${renderRtmpServer()}${renderYacineTvAuto()}${renderLibraries()}${renderLive()}${renderAccess()}${renderScan()}`; showSection(saved.section || 'assistant'); renderSourcesDynamic(); renderChannelManagerDynamic(); renderIptvGroupsDynamic(); syncSettingsSummary(); syncDirtyIndicators(); }
  function showSection(section){
    const knownSections = new Set(['all','assistant','system','libraries','live','access','scan']);
    section = knownSections.has(section) ? section : 'all';
    saved.section = section;
    saveSettingsUiSelection();
    const showAll = section === 'all';
    qsa('[data-section]', qs('#settings-nav')).forEach(btn => btn.classList.toggle('active', btn.dataset.section === section));
    qsa('[data-section-content]').forEach(block => block.classList.toggle('hidden', !showAll && block.dataset.sectionContent !== section));
    const scanBox = qs('#scan-status-box');
    if (scanBox) scanBox.classList.toggle('hidden', !(showAll || section === 'scan'));
    if (showAll || section === 'live') {
      renderChannelManagerDynamic();
      renderIptvGroupsDynamic();
      if (!channelManager.loaded && !channelManager.loading) loadAdminChannels().catch(()=>{ channelManager.loading = false; renderChannelManagerDynamic(); });
    }
  }
  function toBoolSelect(val){ return String(val) === 'true'; }
  async function refreshDiagnostics(silent=false){
    const msg = qs('#settings-status');
    if (!silent && msg) {
      msg.textContent = 'جاري تحديث تشخيص النظام...';
      msg.classList.remove('hidden');
    }
    try {
      cfg.diagnostics = await getJson('/api/admin/diagnostics');
      renderAll();
      await pollScanStatus();
      if (!silent && msg) msg.textContent = 'تم تحديث تشخيص النظام.';
      return cfg.diagnostics;
    } catch (e) {
      if (msg) {
        msg.textContent = e?.error || e?.message || 'تعذر تحديث التشخيص.';
        msg.classList.remove('hidden');
      }
      return cfg.diagnostics;
    }
  }
  let libraryConvertTimer = null;
  async function pollLibraryConvertJobs(silent=true){
    const data = await getJson('/api/admin/library-convert/status').catch(()=>null);
    if (!data) return cfg.libraryConvertJobs || [];
    cfg.libraryConvertJobs = Array.isArray(data.items) ? data.items : [];
    renderLibrariesDynamic();
    const hasRunning = (cfg.libraryConvertJobs || []).some(job => job.running);
    if (hasRunning) {
      if (libraryConvertTimer) clearTimeout(libraryConvertTimer);
      libraryConvertTimer = setTimeout(async ()=>{ libraryConvertTimer = null; await pollLibraryConvertJobs(true); }, 1800);
    } else if (libraryConvertTimer) {
      clearTimeout(libraryConvertTimer);
      libraryConvertTimer = null;
    }
    if (!silent) {
      const msg = qs('#settings-status');
      if (msg) {
        msg.textContent = hasRunning ? 'جاري متابعة تقدم تحويل المكتبات...' : 'تم تحديث حالة تحويل المكتبات.';
        msg.classList.remove('hidden');
      }
    }
    return cfg.libraryConvertJobs;
  }
  async function startLibraryConvert(libraryId=''){
    const msg = qs('#settings-status');
    if (msg) {
      msg.textContent = 'تم إرسال طلب التحويل المسبق للمكتبة...';
      msg.classList.remove('hidden');
    }
    const result = await getJson(`/api/admin/library-convert/${encodeURIComponent(libraryId)}/start`, { method:'POST' });
    cfg.libraryConvertJobs = Array.isArray(result?.items) ? result.items : (cfg.libraryConvertJobs || []);
    renderLibrariesDynamic();
    await pollLibraryConvertJobs(true);
    if (msg) {
      msg.textContent = result?.job?.running ? 'بدأ تحويل المكتبة في الخلفية. ستتحدث البطاقة تلقائيًا.' : (result?.job?.message || 'تم تحديث حالة تحويل المكتبة.');
      msg.classList.remove('hidden');
    }
    return result;
  }
  async function saveSettingsAndMaybeRestartSource(sourceId=''){
    const result = await getJson('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(cfg) });
    cfg.diagnostics = result?.diagnostics || cfg.diagnostics || {};
    cfg.liveStatus = result?.liveStatus || cfg.liveStatus || [];
    cfg.libraryConvertJobs = Array.isArray(result?.libraryConvertJobs) ? result.libraryConvertJobs : (cfg.libraryConvertJobs || []);
    cfg.system = result?.config?.system || cfg.system;
    cfg.server = result?.config?.server || cfg.server;
    cfg.rtmpServer = result?.config?.rtmpServer || cfg.rtmpServer;
    cfg.rtmpIngestStatus = result?.rtmpIngestStatus || cfg.rtmpIngestStatus || {};
    cfg.yacineTv = result?.config?.yacineTv || cfg.yacineTv;
    cfg.yacineTvStatus = result?.yacineTvStatus || cfg.yacineTvStatus || {};
    cfg.iptv = result?.config?.iptv || cfg.iptv;
    cfg.performance = result?.config?.performance || cfg.performance;
    cfg.bandwidth = result?.config?.bandwidth || cfg.bandwidth;
    cfg.scan = result?.config?.scan || cfg.scan;
    auth.system = cfg.system;
    if (sourceId) {
      await getJson(`/api/live/restart/${encodeURIComponent(sourceId)}`, { method:'POST' }).catch(()=>null);
    }
    renderSourcesDynamic();
    const msg = qs('#settings-status');
    if (msg) {
      msg.textContent = sourceId ? 'تم حفظ الإعدادات وإعادة تشغيل المصدر تلقائيًا.' : 'تم حفظ الإعدادات بنجاح.';
      msg.classList.remove('hidden');
    }
    markDirty(false);
    syncSettingsSummary();
    return result;
  }
  async function runSourceInputTest(index){
    const src = cfg.iptv?.sources?.[index];
    if (!src) return;
    cfg.sourceTestResults = cfg.sourceTestResults || {};
    cfg.sourceTestResults[src.id] = { loading: true, message: 'جاري اختبار الرابط من هذا الجهاز...' };
    renderSourcesDynamic();
    const msg = qs('#settings-status');
    if (msg) {
      msg.textContent = `جاري اختبار رابط المصدر: ${src.name || src.id || 'مصدر'}`;
      msg.classList.remove('hidden');
    }
    const payload = {
      id: src.id,
      sourceType: src.sourceType,
      inputUrl: src.inputUrl || '',
      streamUrl: src.streamUrl || '',
      ffmpegPath: src.ffmpegPath || '',
      ffmpegCommand: src.ffmpegCommand || ''
    };
    try {
      const response = await getJson(`/api/admin/source-test/${encodeURIComponent(src.id || `source-${index}`)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      cfg.sourceTestResults[src.id] = { ...(response?.result || {}), loading: false };
      if (msg) msg.textContent = response?.result?.message || 'تم اختبار الرابط بنجاح.';
    } catch (error) {
      const result = error?.result || {};
      cfg.sourceTestResults[src.id] = {
        ...result,
        ok: false,
        loading: false,
        message: result?.message || error?.error || 'فشل اختبار هذا الرابط من جهاز السيرفر.'
      };
      if (msg) msg.textContent = cfg.sourceTestResults[src.id].message;
    }
    renderSourcesDynamic();
    if (msg) msg.classList.remove('hidden');
  }
  async function discoverUsbDevices(){
    const msg = qs('#settings-status');
    if (msg) { msg.textContent = 'جاري اكتشاف أجهزة التصوير من FFmpeg...'; msg.classList.remove('hidden'); }
    try {
      const result = await getJson('/api/live/devices');
      cfg.deviceCatalog = { video: result.video || [], audio: result.audio || [], ffmpegPath: result.ffmpegPath || '', loaded: true, error: '' };
      renderAll();
      if (msg) msg.textContent = `تم العثور على ${cfg.deviceCatalog.video.length} جهاز فيديو و ${cfg.deviceCatalog.audio.length} جهاز صوت. تم تحديث القائمة بكل الأجهزة المتاحة.`;
    } catch (e) {
      cfg.deviceCatalog = { video: [], audio: [], ffmpegPath: '', loaded: false, error: e?.error || 'فشل اكتشاف الأجهزة.' };
      renderAll();
      if (msg) msg.textContent = cfg.deviceCatalog.error;
    }
  }
  renderAll();
  const initialStatus = qs('#settings-status');
  if (initialStatus) initialStatus.classList.add('hidden');
  async function renderIptvGroupsDynamic() {
    const card = qs('#iptv-groups-config-card');
    if (!card) return;
    try {
      const data = await getJson('/api/live/all-groups');
      const groups = Array.isArray(data.groups) ? data.groups : [];
      const disabledGroups = Array.isArray(data.disabledGroups) ? data.disabledGroups : [];
      
      if (!groups.length) {
        card.innerHTML = `
          <div class="section-header" style="margin-bottom: 0;">
            <div>
              <h3>إدارة مجموعات القنوات</h3>
              <div class="section-subtitle">لا توجد قنوات IPTV مسجلة حالياً لجلب المجموعات منها.</div>
            </div>
          </div>
        `;
        return;
      }

      const gridHtml = groups.map(g => {
        const isCurrentlyDisabled = disabledGroups.includes(g);
        return `
          <div class="group-toggle-item" style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:rgba(255,255,255,0.025); border:1px solid var(--line); border-radius:14px; transition: all 0.2s;">
            <div style="display:grid; gap:4px;">
              <strong style="font-size:14px; color:#cbd5e1;">${escapeHtml(g)}</strong>
              <div class="group-toggle-status" style="font-size:11px; color:var(--muted);">${isCurrentlyDisabled ? 'معطلة (مخفية)' : 'مفعلة (تظهر للمستخدمين)'}</div>
            </div>
            <label class="switch-wrap" style="position:relative; display:inline-block; width:44px; height:24px; margin:0;">
              <input type="checkbox" class="iptv-group-toggle" data-group-name="${escapeHtml(g)}" ${!isCurrentlyDisabled ? 'checked' : ''} style="opacity:0; width:0; height:0;">
              <span class="slider" style="position:absolute; cursor:pointer; inset:0; background-color:#374151; border-radius:34px; transition:.3s; border:1px solid rgba(255,255,255,0.1);"></span>
            </label>
          </div>
        `;
      }).join('');

      card.innerHTML = `
        <div class="section-header">
          <div>
            <h3>إدارة مجموعات القنوات</h3>
            <div class="section-subtitle">قم بتعطيل أو تفعيل المجموعات والأقسام بالكامل لتسريع التحكم بالمحتوى وتسهيل إدارتها.</div>
          </div>
        </div>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:12px; margin-top:16px;">
          ${gridHtml}
        </div>
      `;

      if (!document.getElementById('switch-slider-custom-css')) {
        const style = document.createElement('style');
        style.id = 'switch-slider-custom-css';
        style.innerHTML = `
          .switch-wrap input:checked + .slider {
            background-color: var(--cinema-orange, #ff7a18) !important;
            box-shadow: 0 0 10px rgba(255, 122, 24, 0.4);
          }
          .switch-wrap .slider:before {
            position: absolute;
            content: "";
            height: 16px;
            width: 16px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            border-radius: 50%;
            transition: .3s;
          }
          .switch-wrap input:checked + .slider:before {
            transform: translateX(20px);
          }
        `;
        document.head.appendChild(style);
      }

      card.querySelectorAll('.iptv-group-toggle').forEach(chk => {
        chk.addEventListener('change', e => {
          const gName = e.target.dataset.groupName;
          const isEnabled = e.target.checked;
          
          cfg.iptv = cfg.iptv || {};
          cfg.iptv.disabledGroups = Array.isArray(cfg.iptv.disabledGroups) ? cfg.iptv.disabledGroups : [];
          
          if (isEnabled) {
            cfg.iptv.disabledGroups = cfg.iptv.disabledGroups.filter(x => x !== gName);
          } else {
            if (!cfg.iptv.disabledGroups.includes(gName)) {
              cfg.iptv.disabledGroups.push(gName);
            }
          }
          markDirty(true);
          
          const textDiv = e.target.closest('.group-toggle-item').querySelector('.group-toggle-status');
          if (textDiv) {
            textDiv.textContent = isEnabled ? 'مفعلة (تظهر للمستخدمين)' : 'معطلة (مخفية)';
          }
        });
      });

    } catch (err) {
      card.innerHTML = `<div class="empty">فشل جلب مجموعات القنوات: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderLibrariesDynamic(){
    const libraries = cfg.libraries || [];
    selectedLibraryIndex = clampIndex(selectedLibraryIndex, libraries.length);
    saveSettingsUiSelection();
    const visible = visibleLibraries();
    const count = qs('#libraries-mini-count');
    if (count) count.textContent = `${visible.length}/${libraries.length} مكتبة`;
    const mini = qs('#libraries-mini-wrap');
    if (mini) mini.innerHTML = visible.map(({ lib, index }) => libraryMiniCard(lib, index)).join('') || `<div class="empty">لا توجد نتيجة مطابقة.</div>`;
    const holder = qs('#libraries-wrap');
    if (holder) holder.innerHTML = libraries.length ? libraryCard(libraries[selectedLibraryIndex], selectedLibraryIndex) : `<div class="empty">اختر إضافة مكتبة جديدة للبدء.</div>`;
  }
  function renderSourcesDynamic(){
    const sources = cfg.iptv?.sources || [];
    selectedSourceIndex = clampIndex(selectedSourceIndex, sources.length);
    saveSettingsUiSelection();
    const visible = visibleSources();
    const count = qs('#sources-mini-count');
    if (count) count.textContent = `${visible.length}/${sources.length} مصدر`;
    const mini = qs('#sources-mini-wrap');
    if (mini) mini.innerHTML = visible.map(({ src, index }) => sourceMiniCard(src, index)).join('') || `<div class="empty">لا توجد نتيجة مطابقة.</div>`;
    const modalRoot = qs('#source-admin-modal-root');
    const openEditor = modalRoot?.querySelector('[data-source-editor]');
    if (modalRoot && openEditor) {
      const modalIndex = clampIndex(openEditor.dataset.sourceEditor, sources.length);
      const selectedSource = sources[modalIndex];
      if (selectedSource) {
        modalRoot.innerHTML = sourceModalMarkup(selectedSource, modalIndex);
        isolateLiveAvSettings(modalRoot, selectedSource, modalIndex);
        decorateRtmpIngestSettings(modalRoot, selectedSource, modalIndex);
      }
    }
  }
  qs('#settings-nav').addEventListener('click', e => { const btn = e.target.closest('[data-section]'); if (!btn) return; showSection(btn.dataset.section); });
  root.addEventListener('input', e => { const t = e.target; if (t.id === 'libraries-filter') { libraryManagerState.q = t.value; saveSettingsUiSelection(); renderLibrariesDynamic(); return; } if (t.id === 'sources-filter') { sourceManagerState.q = t.value; saveSettingsUiSelection(); renderSourcesDynamic(); return; } if (['system-name','system-icon','system-logo','system-home-message','server-port','server-host','server-public-base-url','rtmp-server-host','rtmp-server-port','rtmp-server-app','rtmp-server-key','rtmp-server-public-host','rtmp-batch-count','rtmp-batch-name','rtmp-batch-key','yacine-tv-interval','page-size','newest-limit','bandwidth-limit-kbps','bandwidth-burst-seconds','admin-user','admin-pass','scan-status-every','scan-yield-every','scan-time-1','scan-time-2','transcode-audio-bitrate','transcode-hls-time','transcode-hls-list-size'].includes(t.id)) markDirty(true); if (t.dataset.lib !== undefined) { const idx = +t.dataset.lib; const key = t.dataset.key; cfg.libraries[idx][key] = ['maxDepth'].includes(key) ? Number(t.value || 0) : (['allowDownload','showOnHome'].includes(key) ? toBoolSelect(t.value) : t.value); markDirty(true); syncSettingsSummary(); } if (t.dataset.libPath !== undefined) { cfg.libraries[+t.dataset.libPath].paths[+t.dataset.pathIndex] = t.value; markDirty(true); } if (t.dataset.src !== undefined) { const idx = +t.dataset.src; const key = t.dataset.key; cfg.iptv.sources[idx][key] = ['enabled','autoStart','showOnHome','skipStartupProbe','egressEnabled','rtmpIngest','egressLowLatency','egressFifo'].includes(key) ? toBoolSelect(t.value) : t.value; if (['id','rtmpStreamKey','rtmpIngest'].includes(key)) syncRtmpIngestDraft(cfg.iptv.sources[idx]); markDirty(true); } });
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'library-type-filter') { libraryManagerState.type = t.value || 'all'; saveSettingsUiSelection(); renderLibrariesDynamic(); return; }
    if (t.id === 'library-sort') { libraryManagerState.sort = t.value || 'name'; saveSettingsUiSelection(); renderLibrariesDynamic(); return; }
    if (t.id === 'source-type-filter') { sourceManagerState.type = t.value || 'all'; saveSettingsUiSelection(); renderSourcesDynamic(); return; }
    if (t.id === 'source-status-filter') { sourceManagerState.status = t.value || 'all'; saveSettingsUiSelection(); renderSourcesDynamic(); return; }
    if (t.id === 'source-sort') { sourceManagerState.sort = t.value || 'name'; saveSettingsUiSelection(); renderSourcesDynamic(); return; }
    if (['system-webrtc-autostart','rtmp-server-enabled','yacine-tv-enabled','yacine-tv-startup','yacine-tv-scan-after-refresh','allow-register','auto-register-devices','require-login','scan-autostart','scan-follow-symlinks','scan-auto-daily','bandwidth-enabled','bandwidth-media','bandwidth-live','bandwidth-transcode','transcode-hwaccel','transcode-quality-profile','iptv-disable-groups','iptv-keep-relays-alive'].includes(t.id)) markDirty(true);
    if (t.dataset.lib !== undefined) {
      const idx = +t.dataset.lib;
      const key = t.dataset.key;
      cfg.libraries[idx][key] = ['maxDepth'].includes(key) ? Number(t.value || 0) : (['allowDownload','showOnHome'].includes(key) ? toBoolSelect(t.value) : t.value);
      markDirty(true);
      syncSettingsSummary();
    }
    if (t.dataset.src !== undefined) {
      const idx = +t.dataset.src;
      const key = t.dataset.key;
      cfg.iptv.sources[idx][key] = ['enabled','autoStart','showOnHome','skipStartupProbe','egressEnabled','rtmpIngest','egressLowLatency','egressFifo'].includes(key) ? toBoolSelect(t.value) : t.value;
      if (['id','rtmpStreamKey','rtmpIngest'].includes(key)) syncRtmpIngestDraft(cfg.iptv.sources[idx]);
      markDirty(true);
      if (key === 'sourceType') {
        cfg.iptv.sources[idx] = {
          ...cfg.iptv.sources[idx],
          channelName: cfg.iptv.sources[idx].channelName || cfg.iptv.sources[idx].name || '',
          deviceName: cfg.iptv.sources[idx].deviceName || '',
          audioDeviceName: cfg.iptv.sources[idx].audioDeviceName || '',
          deliveryMode: cfg.iptv.sources[idx].deliveryMode || 'hls',
          streamUrl: cfg.iptv.sources[idx].streamUrl || '',
          inputUrl: cfg.iptv.sources[idx].inputUrl || defaultSourceInputUrl(cfg.iptv.sources[idx].sourceType, cfg.iptv.sources[idx].id),
          webrtcEmbedUrl: cfg.iptv.sources[idx].webrtcEmbedUrl || '',
          logo: cfg.iptv.sources[idx].logo || '',
          description: cfg.iptv.sources[idx].description || '',
          autoStart: cfg.iptv.sources[idx].autoStart !== false,
          showOnHome: cfg.iptv.sources[idx].showOnHome !== false,
          egressEnabled: cfg.iptv.sources[idx].egressEnabled === true,
          egressType: cfg.iptv.sources[idx].egressType || 'srt',
          egressUrl: cfg.iptv.sources[idx].egressUrl || '',
          egressVideoMode: cfg.iptv.sources[idx].egressVideoMode || 'same',
          egressHwAccel: cfg.iptv.sources[idx].egressHwAccel || 'same',
          egressResolutionPreset: cfg.iptv.sources[idx].egressResolutionPreset || 'same',
          egressOutputWidth: Number(cfg.iptv.sources[idx].egressOutputWidth || 0),
          egressOutputHeight: Number(cfg.iptv.sources[idx].egressOutputHeight || 0),
          egressVideoBitrate: cfg.iptv.sources[idx].egressVideoBitrate || '',
          egressMaxRate: cfg.iptv.sources[idx].egressMaxRate || '',
          egressBufSize: cfg.iptv.sources[idx].egressBufSize || '',
          egressAudioBitrate: cfg.iptv.sources[idx].egressAudioBitrate || '',
          egressFrameRate: Number(cfg.iptv.sources[idx].egressFrameRate || 0),
          egressLowLatency: cfg.iptv.sources[idx].egressLowLatency !== false,
          egressFifo: cfg.iptv.sources[idx].egressFifo !== false,
          egressFifoQueue: Number(cfg.iptv.sources[idx].egressFifoQueue || 600),
          egressHlsTime: Number(cfg.iptv.sources[idx].egressHlsTime || 1),
          egressHlsListSize: Number(cfg.iptv.sources[idx].egressHlsListSize || 4),
          groupTitle: cfg.iptv.sources[idx].groupTitle || '',
          resolutionPreset: cfg.iptv.sources[idx].resolutionPreset || 'source',
          outputWidth: Number(cfg.iptv.sources[idx].outputWidth || 0),
          outputHeight: Number(cfg.iptv.sources[idx].outputHeight || 0),
          hlsTime: Number(cfg.iptv.sources[idx].hlsTime || 2),
          hlsListSize: Number(cfg.iptv.sources[idx].hlsListSize || 6),
          videoBitrate: cfg.iptv.sources[idx].videoBitrate || '',
          maxRate: cfg.iptv.sources[idx].maxRate || '',
          bufSize: cfg.iptv.sources[idx].bufSize || '',
          audioBitrate: cfg.iptv.sources[idx].audioBitrate || '',
          frameRate: Number(cfg.iptv.sources[idx].frameRate || 25),
          hwAccel: cfg.iptv.sources[idx].hwAccel || 'auto',
          ffmpegPath: cfg.iptv.sources[idx].ffmpegPath || '',
          ffmpegInput: cfg.iptv.sources[idx].ffmpegInput || '',
          ffmpegCommand: cfg.iptv.sources[idx].ffmpegCommand || '',
          rtmpIngest: cfg.iptv.sources[idx].sourceType === 'rtmp' ? (cfg.iptv.sources[idx].rtmpIngest === true) : false,
          rtmpStreamKey: cfg.iptv.sources[idx].rtmpStreamKey || (cfg.iptv.sources[idx].sourceType === 'rtmp' ? cfg.iptv.sources[idx].id : ''),
          skipStartupProbe: cfg.iptv.sources[idx].skipStartupProbe !== false
        };
      }
      if (key === 'sourceType') renderSourcesDynamic();
      return;
    }
    if (t.dataset.devicePicker !== undefined) {
      const idx = +t.dataset.devicePicker;
      const selected = t.value || '';
      cfg.iptv.sources[idx].deviceName = selected;
      const audio = cfg.iptv.sources[idx].audioDeviceName || '';
      cfg.iptv.sources[idx].ffmpegInput = selected ? (`video=${selected}${audio ? `:audio=${audio}` : ''}`) : '';
      markDirty(true);
      renderSourcesDynamic();
      return;
    }
    if (t.dataset.audioDevicePicker !== undefined) {
      const idx = +t.dataset.audioDevicePicker;
      const selected = t.value || '';
      cfg.iptv.sources[idx].audioDeviceName = selected;
      const video = cfg.iptv.sources[idx].deviceName || '';
      cfg.iptv.sources[idx].ffmpegInput = video ? (`video=${video}${selected ? `:audio=${selected}` : ''}`) : '';
      markDirty(true);
      renderSourcesDynamic();
      return;
    }
    if (t.dataset.lib !== undefined && ['type','scanMode','allowDownload','showOnHome'].includes(t.dataset.key)) {
      cfg.libraries[+t.dataset.lib][t.dataset.key] = ['allowDownload','showOnHome'].includes(t.dataset.key) ? toBoolSelect(t.value) : t.value;
      markDirty(true);
      renderLibrariesDynamic();
    }
  });
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'channels-admin-q') {
      channelManager.q = t.value || '';
      channelManager.page = 1;
      channelManager.loaded = false;
      saveSettingsUiSelection();
      if (channelSearchTimer) clearTimeout(channelSearchTimer);
      channelSearchTimer = setTimeout(() => loadAdminChannels().catch(()=>null), 450);
    }
  });
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'channels-admin-source') {
      channelManager.sourceId = t.value || '';
      channelManager.group = '';
      saveSettingsUiSelection();
      channelManager.page = 1;
      loadAdminChannels().catch(()=>null);
    }
    if (t.id === 'channels-admin-group') {
      channelManager.group = t.value || '';
      saveSettingsUiSelection();
      channelManager.page = 1;
      loadAdminChannels().catch(()=>null);
    }
    if (t.id === 'channels-admin-hidden') {
      channelManager.includeHidden = t.value === 'true';
      channelManager.page = 1;
      saveSettingsUiSelection();
      loadAdminChannels().catch(()=>null);
    }
    if (t.id === 'channels-admin-sort') {
      channelManager.sort = t.value || 'default';
      channelManager.page = 1;
      saveSettingsUiSelection();
      loadAdminChannels().catch(()=>null);
    }
  });
root.addEventListener('click', async e => {
    if (e.target?.dataset?.channelModalBackdrop !== undefined) { closeChannelModal(); return; }
    if (e.target?.dataset?.libraryModalBackdrop !== undefined) { closeLibraryModal(); return; }
    if (e.target?.dataset?.sourceModalBackdrop !== undefined) { closeSourceModal(); return; }
    const t = e.target.closest('button,[data-select-library],[data-select-source]') || e.target;
    if (t.dataset.saveSettings !== undefined){ await handleSaveSettings(); return; }
    if (t.dataset.scanAll !== undefined){ await startScan(''); return; }
    if (t.dataset.cancelScan !== undefined){ await getJson('/api/scan/cancel',{method:'POST'}).catch(()=>null); await pollScanStatus(); return; }
    if (t.id === 'refresh-diagnostics') { await refreshDiagnostics(false); return; }
    if (t.dataset.yacineRefresh !== undefined) {
      const msg = qs('#settings-status');
      if (msg) {
        msg.textContent = 'جاري تحديث قائمة Yacine TV...';
        msg.classList.remove('hidden');
      }
      try {
        const result = await getJson('/api/admin/yacine-tv/refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ scan:true }) });
        cfg.yacineTvStatus = { ...(cfg.yacineTvStatus || {}), enabled:true, running:false, status:result?.status || null };
        if (msg) msg.textContent = `تم تحديث Yacine TV: ${Number(result?.status?.hlsEntries || 0)} رابط HLS.`;
        renderAll();
        await pollScanStatus();
      } catch (error) {
        if (msg) msg.textContent = error?.error || error?.message || 'تعذر تحديث Yacine TV.';
      }
      return;
    }
    if (t.id === 'export-admin-backup') {
      const payload = await getJson('/api/admin/export').catch(()=>null);
      if (payload) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `light-media-server-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }
      return;
    }
    if (t.dataset.applySystemProfile !== undefined) {
      const result = await getJson('/api/admin/apply-profile', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ profile: t.dataset.applySystemProfile }) });
      cfg.diagnostics = result?.diagnostics || cfg.diagnostics;
      cfg.liveStatus = result?.liveStatus || cfg.liveStatus;
      if (result?.config) {
        Object.assign(cfg, result.config);
      }
      markDirty(false);
      renderAll();
      await pollScanStatus();
      const msg = qs('#settings-status');
      if (msg) {
        msg.textContent = `تم تطبيق بروفايل ${result?.profile?.title || t.dataset.applySystemProfile}.`;
        msg.classList.remove('hidden');
      }
      return;
    }
    if (t.id === 'discover-usb-devices'){ discoverUsbDevices(); return; }
    if (t.id === 'channels-admin-refresh'){ channelManager.q = qs('#channels-admin-q')?.value || ''; channelManager.page = 1; await loadAdminChannels(); return; }
    if (t.dataset.channelsLoadMore !== undefined){ if (!channelManager.loading && channelManager.hasMore) { channelManager.page += 1; await loadAdminChannels({ append:true }); } return; }
    if (t.dataset.channelEdit !== undefined){ openChannelModal(t.dataset.channelEdit); return; }
    if (t.dataset.channelModalClose !== undefined){ closeChannelModal(); return; }
    if (t.dataset.channelSave !== undefined){ await saveChannelPatch(t.dataset.channelSave); return; }
    if (t.dataset.channelReset !== undefined){ await resetChannelPatch(t.dataset.channelReset); return; }
    if (t.dataset.channelGroupToggle !== undefined){ await saveChannelGroupPatch(t.dataset.channelGroupToggle || '', t.dataset.hidden === 'true'); return; }
    if (t.dataset.channelGroupReset !== undefined){ await resetChannelGroupPatch(t.dataset.channelGroupReset || ''); return; }
    if (t.dataset.libraryEdit !== undefined){ selectedLibraryIndex = clampIndex(t.dataset.libraryEdit, cfg.libraries?.length || 0); renderLibrariesDynamic(); openLibraryModal(selectedLibraryIndex); return; }
    if (t.dataset.libraryModalClose !== undefined){ closeLibraryModal(); return; }
    if (t.dataset.sourceModalClose !== undefined){ closeSourceModal(); return; }
    if (t.dataset.saveLibrarySettings !== undefined){ await handleSaveSettings(); return; }
    if (t.dataset.saveSourceSettings !== undefined){ const idx = clampIndex(t.dataset.saveSourceSettings, cfg.iptv?.sources?.length || 0); const src = cfg.iptv?.sources?.[idx]; await saveSettingsAndMaybeRestartSource(src?.id || ''); openSourceModal(idx); return; }
    if (t.dataset.selectLibrary !== undefined){ selectedLibraryIndex = clampIndex(t.dataset.selectLibrary, cfg.libraries?.length || 0); renderLibrariesDynamic(); openLibraryModal(selectedLibraryIndex); return; }
    if (t.dataset.selectSource !== undefined){ selectedSourceIndex = clampIndex(t.dataset.selectSource, cfg.iptv?.sources?.length || 0); renderSourcesDynamic(); openSourceModal(selectedSourceIndex); return; }
    if (t.dataset.createRtmpIngestBatch !== undefined){ createRtmpIngestBatch(); return; }
    if (t.dataset.addLibraryType !== undefined){ cfg.libraries.push(createLibraryDraft(t.dataset.addLibraryType || 'movies')); selectedLibraryIndex = cfg.libraries.length - 1; markDirty(true); syncSettingsSummary(); renderLibrariesDynamic(); openLibraryModal(selectedLibraryIndex); return; }
    if (t.id === 'add-library'){ cfg.libraries.push(createLibraryDraft('movies')); selectedLibraryIndex = cfg.libraries.length - 1; markDirty(true); syncSettingsSummary(); renderLibrariesDynamic(); openLibraryModal(selectedLibraryIndex); return; }
    if (t.dataset.addSourceType !== undefined){ cfg.iptv.sources.push(createSourceDraft(t.dataset.addSourceType || 'usb_capture')); selectedSourceIndex = cfg.iptv.sources.length - 1; markDirty(true); syncSettingsSummary(); renderSourcesDynamic(); openSourceModal(selectedSourceIndex); return; }
    if (t.id === 'add-source'){ cfg.iptv.sources.push(createSourceDraft('usb_capture')); selectedSourceIndex = cfg.iptv.sources.length - 1; markDirty(true); syncSettingsSummary(); renderSourcesDynamic(); openSourceModal(selectedSourceIndex); return; }
    if (t.dataset.applyLiveProfile !== undefined){ const idx = +t.dataset.applyLiveProfile; const src = cfg.iptv.sources[idx]; if (!src) return; cfg.iptv.sources[idx] = { ...src, ...getLiveProfileSettings(t.dataset.profile || 'balanced') }; renderSourcesDynamic(); await saveSettingsAndMaybeRestartSource(cfg.iptv.sources[idx].id || ''); await refreshDiagnostics(true); return; }
    if (t.dataset.testSource !== undefined){ await runSourceInputTest(+t.dataset.testSource); return; }
    if (t.dataset.openPublisher !== undefined){ const src = cfg.iptv.sources[+t.dataset.openPublisher]; if (src?.id) window.open(localPublisherUrl(src), '_blank', 'noopener'); return; }
    if (t.dataset.addPath !== undefined){ selectedLibraryIndex = clampIndex(t.dataset.addPath, cfg.libraries?.length || 0); cfg.libraries[+t.dataset.addPath].paths.push(''); markDirty(true); renderLibrariesDynamic(); openLibraryModal(selectedLibraryIndex); return; }
    if (t.dataset.removePath !== undefined){ const idx = +t.dataset.removePath; cfg.libraries[idx].paths.splice(+t.dataset.pathIndex, 1); selectedLibraryIndex = clampIndex(idx, cfg.libraries.length); markDirty(true); renderLibrariesDynamic(); openLibraryModal(selectedLibraryIndex); return; }
    if (t.dataset.removeLib !== undefined){ cfg.libraries.splice(+t.dataset.removeLib, 1); selectedLibraryIndex = clampIndex(selectedLibraryIndex, cfg.libraries.length); closeLibraryModal(); markDirty(true); syncSettingsSummary(); renderLibrariesDynamic(); return; }
    if (t.dataset.removeSource !== undefined){ cfg.iptv.sources.splice(+t.dataset.removeSource, 1); selectedSourceIndex = clampIndex(selectedSourceIndex, cfg.iptv.sources.length); closeSourceModal(); markDirty(true); syncSettingsSummary(); renderSourcesDynamic(); return; }
    if (t.dataset.convertLib !== undefined){ await startLibraryConvert(t.dataset.convertLib); return; }
    if (t.dataset.scanLib !== undefined){ startScan(t.dataset.scanLib); }
  });
  async function startScan(libraryId=''){ const msg = qs('#settings-status'); msg.textContent = libraryId ? 'تم إرسال طلب تحديث المكتبة في الخلفية.' : 'تم إرسال طلب فحص كل المكتبات في الخلفية.'; msg.classList.remove('hidden'); await getJson('/api/scan/start', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ libraryId: libraryId || undefined }) }); await pollScanStatus(); }
  async function handleSaveSettings(){ cfg.system = cfg.system || {}; cfg.iptv = cfg.iptv || {}; if (qs('#iptv-disable-groups')) { cfg.iptv.disableGroups = qs('#iptv-disable-groups').value === 'true'; } if (qs('#iptv-keep-relays-alive')) { cfg.iptv.keepRelaysAlive = qs('#iptv-keep-relays-alive').value === 'true'; } cfg.server.port = Number(qs('#server-port').value || 8090); cfg.server.host = qs('#server-host').value || '0.0.0.0'; cfg.server.publicBaseUrl = qs('#server-public-base-url').value || ''; cfg.rtmpServer = cfg.rtmpServer || {}; if (qs('#rtmp-server-enabled')) { cfg.rtmpServer.enabled = qs('#rtmp-server-enabled').value === 'true'; cfg.rtmpServer.host = qs('#rtmp-server-host').value || '0.0.0.0'; cfg.rtmpServer.port = Number(qs('#rtmp-server-port').value || 1936); cfg.rtmpServer.appName = qs('#rtmp-server-app').value || 'live'; cfg.rtmpServer.streamKey = qs('#rtmp-server-key').value || 'rtmp-ingest-main'; cfg.rtmpServer.publicHost = qs('#rtmp-server-public-host').value || ''; } cfg.yacineTv = cfg.yacineTv || {}; if (qs('#yacine-tv-enabled')) { cfg.yacineTv.enabled = qs('#yacine-tv-enabled').value === 'true'; cfg.yacineTv.refreshOnStartup = qs('#yacine-tv-startup').value === 'true'; cfg.yacineTv.scanAfterRefresh = qs('#yacine-tv-scan-after-refresh').value === 'true'; cfg.yacineTv.refreshIntervalHours = Number(qs('#yacine-tv-interval').value || 0); } cfg.system.name = qs('#system-name').value || 'STARSNET'; cfg.system.iconText = qs('#system-icon').value || '⭐'; cfg.system.logoUrl = qs('#system-logo').value || ''; cfg.system.homeMessage = qs('#system-home-message').value || ''; cfg.system.webrtcPublisherAutoStart = qs('#system-webrtc-autostart').value === 'true'; cfg.performance.pageSize = Number(qs('#page-size').value || 48); cfg.performance.newestLimit = Number(qs('#newest-limit').value || 24); cfg.bandwidth = cfg.bandwidth || {}; cfg.bandwidth.enabled = qs('#bandwidth-enabled').value === 'true'; cfg.bandwidth.limitKBps = Number(qs('#bandwidth-limit-kbps').value || 0); cfg.bandwidth.burstSeconds = Number(qs('#bandwidth-burst-seconds').value || 3); cfg.bandwidth.applyToMedia = qs('#bandwidth-media').value === 'true'; cfg.bandwidth.applyToLive = qs('#bandwidth-live').value === 'true'; cfg.bandwidth.applyToTranscode = qs('#bandwidth-transcode').value === 'true'; cfg.auth.allowSelfRegistration = qs('#allow-register').value === 'true'; cfg.auth.autoRegisterDevices = qs('#auto-register-devices').value === 'true'; cfg.auth.requireLoginForViewing = qs('#require-login').value === 'true'; cfg.admin.username = qs('#admin-user').value || 'admin'; cfg.admin.password = qs('#admin-pass').value || 'admin123'; cfg.scan = cfg.scan || {}; cfg.scan.autoStartOnEmptyIndex = qs('#scan-autostart').value === 'true'; cfg.scan.statusUpdateEvery = Number(qs('#scan-status-every').value || 100); cfg.scan.yieldEvery = Number(qs('#scan-yield-every').value || 200); cfg.scan.followSymlinks = qs('#scan-follow-symlinks').value === 'true'; cfg.scan.autoDailyTwice = qs('#scan-auto-daily').value === 'true'; cfg.scan.scheduleTimes = [qs('#scan-time-1').value || '06:00', qs('#scan-time-2').value || '18:00'].filter(Boolean); cfg.mediaTranscode = cfg.mediaTranscode || {}; cfg.mediaTranscode.hwAccel = qs('#transcode-hwaccel').value || 'auto'; cfg.mediaTranscode.qualityProfile = qs('#transcode-quality-profile').value || 'balanced'; cfg.mediaTranscode.audioBitrate = qs('#transcode-audio-bitrate').value || '160k'; cfg.mediaTranscode.hlsTime = Number(qs('#transcode-hls-time').value || 4); cfg.mediaTranscode.hlsListSize = Number(qs('#transcode-hls-list-size').value || 10); await saveSettingsAndMaybeRestartSource(''); await refreshDiagnostics(true); }
  qs('#save-btn').onclick = handleSaveSettings;
  qsa('[data-save-settings]').forEach(btn => { btn.onclick = handleSaveSettings; });
  const cancelBtn = qs('#scan-cancel-btn'); let scanTimer = null;
  function renderScanStatus(st){ const running = !!st?.running; const statusBox = qs('#scan-status-box'); const liveCancelBtn = qs('#scan-cancel-btn') || cancelBtn; if (liveCancelBtn) liveCancelBtn.classList.toggle('hidden', !running); qsa('[data-cancel-scan]').forEach(node => node.classList.toggle('hidden', !running)); if (!statusBox) return; const progress = st?.progress?.percent ?? 0; const libraryName = st?.libraryName || 'كل المكتبات'; const stage = st?.stage || (running ? 'جاري الفحص' : 'جاهز'); const processed = st?.progress?.processedDirs ?? 0; const discovered = st?.progress?.discovered ?? 0; const errors = st?.progress?.errors ?? 0; const startedAt = st?.startedAt ? formatDate(st.startedAt) : '—'; const endedAt = st?.endedAt ? formatDate(st.endedAt) : '—'; statusBox.innerHTML = `<div class="toolbar"><div><h3 class="panel-title">حالة الفهرسة</h3><div class="section-subtitle">${escapeHtml(stage)} • ${escapeHtml(libraryName)}</div></div><div class="toolbar-group"><span class="tag">مجلدات مفحوصة: ${processed}</span><span class="tag">عناصر مكتشفة: ${discovered}</span><span class="tag">أخطاء: ${errors}</span></div></div><div style="height:12px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden"><div style="height:100%;width:${Math.max(2,progress)}%;background:linear-gradient(90deg,var(--accent),var(--accent-2))"></div></div><div class="toolbar" style="margin-top:12px"><div class="muted">آخر بدء: ${startedAt} • آخر انتهاء: ${endedAt}</div><div class="muted">${st?.message ? escapeHtml(st.message) : 'لا يوجد فحص نشط الآن.'}</div></div>`; }
  async function pollScanStatus(){ const st = await getJson('/api/scan/status').catch(()=>null); if (!st) return; renderScanStatus(st); const scanBox = qs('#scan-status-box'); if (scanBox) scanBox.classList.toggle('hidden', !(saved.section === 'scan' || saved.section === 'all')); if (st.running && !scanTimer) scanTimer = setTimeout(async ()=>{ scanTimer = null; await pollScanStatus(); }, 1200); if (!st.running && scanTimer) { clearTimeout(scanTimer); scanTimer = null; } }
  qs('#scan-all-btn').onclick = ()=>startScan('');
  qsa('[data-scan-all]').forEach(btn => { btn.onclick = ()=>startScan(''); });
  cancelBtn.onclick = async ()=>{ await getJson('/api/scan/cancel',{method:'POST'}).catch(()=>null); await pollScanStatus(); };
  qsa('[data-cancel-scan]').forEach(btn => { btn.onclick = async ()=>{ await getJson('/api/scan/cancel',{method:'POST'}).catch(()=>null); await pollScanStatus(); }; });
  await pollScanStatus();
  syncSettingsSummary();
  syncDirtyIndicators();
  pollLibraryConvertJobs(true).catch(() => null);
}
async function initWatchPage(){
  const auth = await getAuth();
  const favorites = await createFavoritesController(auth);
  const params = new URLSearchParams(location.search);
  const type = params.get('type'); const id = params.get('id');
  const sourceContext = String(params.get('from') || '').toLowerCase();
  const sourceLibraryId = String(params.get('libraryId') || '');
  if (!type || !id) { location.href='/'; return; }
  const item = await getJson(`/api/item/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
  const heroImage = item.poster || item.logo || '';
  const subtitle = type === 'movie'
    ? `فيلم • ${item.libraryName || ''}`
    : (type === 'series' || type === 'episode')
      ? `مسلسل • ${item.libraryName || item.showTitle || ''}`
      : type === 'audio'
        ? `صوتي • ${item.libraryName || ''}`
        : type === 'channel'
          ? `${item.sourceType === 'usb_capture' ? 'USB Capture' : 'قناة'} • ${item.sourceName || ''}`
          : `${item.showTitle || ''}`;
  const pageKey = sourceContext === 'mixed'
    ? 'mixed'
    : (type === 'channel'
        ? 'live'
        : ((type === 'series' || type === 'episode')
            ? 'series'
            : (type === 'audio' ? 'audio' : 'movies')));
  const backHref = sourceContext === 'mixed' ? listingHref('mixed', { libraryId: sourceLibraryId || item.libraryId || '', browseMode:'all' }) : 'javascript:history.back()';
  const mixedSourceBadge = sourceContext === 'mixed'
    ? `<div class="notice" style="margin-top:14px"><strong>المصدر: محتوى متنوع</strong>${item.libraryName ? ` • ${escapeHtml(item.libraryName)}` : ''}<div style="margin-top:10px"><a class="button secondary small" href="${escapeHtml(backHref)}">العودة إلى محتوى متنوع</a></div></div>`
    : '';
  appShell({ auth, pageKey, title:item.title || item.showTitle || 'المشغل', subtitle, heroImage });
  const root = qs('#page-root');
  const streamUrl = item.preferredStreamUrl || item.streamUrl || item.url || '';
  const downloadUrl = item.directStreamUrl || item.streamUrl || item.url || '';
  const webrtcEmbedUrl = item.webrtcEmbedUrl || '';
  const isWebrtcChannel = type === 'channel' && (item.sourceType === 'webrtc' || (item.sourceType === 'usb_capture' && item.deliveryMode === 'webrtc'));
  const isLiveWatch = type === 'channel';
  const ratioStorageKey = `${APP_NS}:live-ratio`;
  const viewModeStorageKey = `${APP_NS}:live-view-mode`;
  const zoomStorageKey = `${APP_NS}:live-zoom`;
  const inferredDefaultRatio = isLiveWatch
    ? ((item.sourceType === 'usb_capture' || item.sourceType === 'webrtc' || item.deliveryMode === 'webrtc') ? '16-9' : '4-3')
    : '16-9';
  let liveRatio = inferredDefaultRatio;
  let liveViewMode = 'contain';
  let liveZoom = 1;
  try {
    const savedRatio = localStorage.getItem(ratioStorageKey);
    if (savedRatio === '4-3' || savedRatio === '16-9') liveRatio = savedRatio;
  } catch {}
  try {
    const savedViewMode = localStorage.getItem(viewModeStorageKey);
    if (savedViewMode === 'cover' || savedViewMode === 'contain') liveViewMode = savedViewMode;
  } catch {}
  try {
    const savedZoom = Number(localStorage.getItem(zoomStorageKey) || '1');
    if (savedZoom >= 1 && savedZoom <= 1.8) liveZoom = savedZoom;
  } catch {}
  const allowDownload = item.allowDownload !== false && !!downloadUrl && type !== 'channel';
  const playerTag = type === 'audio'
    ? `<div class="audio-cover-wrap">${item.poster ? `<img class="audio-cover" src="${item.poster}" alt="${escapeHtml(item.title || '')}">` : `<div class="audio-cover audio-cover-empty">🎵</div>`}</div><audio id="player" controls preload="metadata" ${allowDownload ? '' : 'controlsList="nodownload noplaybackrate"'}></audio>`
    : (isWebrtcChannel && webrtcEmbedUrl)
      ? `<div class="watch-player-stage"><div class="watch-player-frame ratio-${liveRatio}" id="watch-player-frame"><iframe id="webrtc-frame" src="${escapeHtml(webrtcEmbedUrl)}" class="watch-webrtc-frame" allow="autoplay; camera; microphone; fullscreen; display-capture" referrerpolicy="no-referrer"></iframe></div></div>`
    : isLiveWatch
      ? `<div class="watch-player-stage"><div class="watch-player-frame ratio-${liveRatio}" id="watch-player-frame"><video id="player" class="live-player" autoplay controls playsinline ${allowDownload ? '' : 'controlsList="nodownload noplaybackrate"'} preload="metadata"></video></div></div>`
      : `<video id="player" ${type==='channel' ? 'autoplay' : ''} controls playsinline ${allowDownload ? '' : 'controlsList="nodownload noplaybackrate"'} preload="metadata"></video>`;
  root.innerHTML = `<section class="watch-layout"><section class="watch-main"><div class="video-shell watch-main media-player-shell">${type==='series' ? `<div class="notice">اختر حلقة من القائمة الجانبية لبدء التشغيل أو الاستكمال.</div><div class="player-actions">${auth.authenticated ? `<button class="button secondary" id="fav-btn">مفضلة</button>` : ''}<a class="button secondary" href="${escapeHtml(backHref)}">رجوع</a></div>` : `${playerTag}<div class="player-actions">${auth.authenticated ? `<button class="button secondary" id="fav-btn">مفضلة</button><button class="button" id="resume-btn">استكمال</button>` : ''}${isLiveWatch ? `<div class="player-ratio-group"><button class="button secondary ${liveRatio==='16-9'?'active':''}" type="button" data-ratio="16-9">16:9</button><button class="button secondary ${liveRatio==='4-3'?'active':''}" type="button" data-ratio="4-3">4:3</button></div><div class="player-view-group"><button class="button secondary ${liveViewMode==='contain'?'active':''}" type="button" data-view-mode="contain">ملاءمة</button><button class="button secondary ${liveViewMode==='cover'?'active':''}" type="button" data-view-mode="cover">ملء</button><button class="button secondary" type="button" data-zoom-step="-0.1">-</button><button class="button secondary" type="button" data-zoom-step="0.1">+</button><button class="button secondary" type="button" id="player-fullscreen-btn">شاشة كاملة</button></div>` : ''}${allowDownload ? `<a class="button success" href="${escapeHtml(downloadUrl)}" download>تنزيل</a>` : `<span class="tag">التنزيل معطل لهذه المكتبة</span>`}<a class="button secondary" href="${escapeHtml(backHref)}">رجوع</a></div>`}</div></section><aside class="watch-aside"><div class="panel-pad" id="watch-side"></div></aside></section>`;
  if (isLiveWatch) {
    const liveControls = root.querySelector('.player-view-group');
    if (liveControls) liveControls.insertAdjacentHTML('afterbegin', '<button class="button success" type="button" id="player-live-btn">LIVE</button>');
  }
  const side = qs('#watch-side');
  const favBtn = qs('#fav-btn');
  const favoritePayload = { type, id, title:item.title || item.showTitle, poster:item.poster || item.logo || null, subtitle, href: location.pathname + location.search };
  function similarItemHref(entry){
    const rawType = String(entry?.mediaType || entry?.type || entry?.sourceType || '').toLowerCase();
    const extra = sourceContext === 'mixed' ? watchContextParams({ libraryId: entry?.libraryId || sourceLibraryId || item.libraryId || '' }, 'mixed') : null;
    if (rawType === 'episode') return mediaHref('episode', entry.id, extra);
    if (rawType === 'audio') return mediaHref('audio', entry.id, extra);
    if (rawType === 'series') return mediaHref('series', entry.id, extra);
    if (rawType === 'channel' || entry?.sourceId || entry?.sourceType) return mediaHref('channel', entry.id, extra);
    return mediaHref('movie', entry.id, extra);
  }
  function renderSimilarCard(entry){
    const rawType = String(entry?.mediaType || entry?.type || entry?.sourceType || '').toLowerCase();
    if (rawType === 'episode') return `<a class="episode-card" href="${similarItemHref(entry)}"><div><strong>${escapeHtml(entry.title || 'حلقة')}</strong></div><div class="muted">${escapeHtml(entry.showTitle || item.title || '')}${entry.episode ? ` • حلقة ${escapeHtml(entry.episode)}` : ''}</div></a>`;
    if (rawType === 'audio') return audioCard(entry, true);
    if (rawType === 'series') return seriesCard(entry, true);
    if (rawType === 'channel' || entry?.sourceId || entry?.sourceType) return channelCard(entry, true);
    return movieCard(entry, true);
  }
  async function appendSimilarContent(){
    const result = await getJson(`/api/similar/${encodeURIComponent(type)}/${encodeURIComponent(id)}?limit=${type === 'series' ? 8 : 10}`).catch(()=>null);
    const items = Array.isArray(result?.items) ? result.items.filter(entry => entry && entry.id) : [];
    if (!items.length || !side) return;
    const usesEpisodeLayout = items.some(entry => String(entry?.mediaType || entry?.type || '').toLowerCase() === 'episode');
    side.insertAdjacentHTML('beforeend', `<section style="margin-top:18px"><div class="section-header"><div><h3 class="panel-title">محتوى مشابه</h3><div class="section-subtitle">اقتراحات قريبة من هذا المحتوى</div></div></div><div class="${usesEpisodeLayout ? 'episode-grid' : 'grid cards'}" style="margin-top:10px">${items.map(renderSimilarCard).join('')}</div></section>`);
  }
  if (favBtn) {
    favBtn.textContent = favorites.has(type, id) ? 'إزالة من المفضلة' : 'مفضلة';
    favBtn.onclick = async () => {
      const result = await favorites.toggle(favoritePayload).catch(()=>null);
      if (result) favBtn.textContent = result.favorite ? 'إزالة من المفضلة' : 'مفضلة';
    };
  }
  if (type === 'series') {
    const seasons = Object.entries(item.seasons || {});
    side.innerHTML = `<h3 class="panel-title">${escapeHtml(item.title)}</h3><div class="chips">${item.libraryName ? `<span class="tag">${escapeHtml(item.libraryName)}</span>` : ''}${item.folderPath ? `<span class="tag">${escapeHtml(item.folderPath)}</span>` : ''}${item.allowDownload!==false ? `<span class="tag">التنزيل متاح</span>` : `<span class="tag">التنزيل معطل</span>`}</div>${seasons.map(([season, episodes]) => `<div class="season-block" style="margin-top:12px"><strong>${escapeHtml(season)}</strong><div class="episode-grid" style="margin-top:10px">${episodes.map(ep => `<a class="episode-card" href="${mediaHref('episode', ep.id)}"><div><strong>${escapeHtml(ep.title)}</strong></div><div class="muted">حلقة ${ep.episode} • ${formatDate(ep.addedAt)}</div></a>`).join('')}</div></div>`).join('')}`;
    await appendSimilarContent();
    return;
  }
  side.innerHTML = `<h3 class="panel-title">${escapeHtml(item.title || item.showTitle || '')}</h3><div class="chips">${item.libraryName ? `<span class="tag">${escapeHtml(item.libraryName)}</span>` : ''}${item.sourceName ? `<span class="tag">${escapeHtml(item.sourceName)}</span>` : ''}${item.folderPath ? `<span class="tag">${escapeHtml(item.folderPath)}</span>` : ''}${item.mediaFolder ? `<span class="tag">${escapeHtml(item.mediaFolder)}</span>` : ''}${item.addedAt ? `<span class="tag">${escapeHtml(formatDate(item.addedAt))}</span>` : ''}</div>${mixedSourceBadge}${item.allowDownload!==false ? `<div class="notice" style="margin-top:14px">التنزيل متاح لهذا العنصر.</div>` : `<div class="notice" style="margin-top:14px">التنزيل معطل لهذه المكتبة.</div>`}`;
  await appendSimilarContent();
  const player = qs('#player');
  const playerFrame = qs('#watch-player-frame');
  const playerStatus = qs('#player-status');
  const fullscreenBtn = qs('#player-fullscreen-btn');
  const liveBtn = qs('#player-live-btn');
  const transcodeFallbackUrl = (type === 'movie' || type === 'episode' || type === 'audio') ? String(item.transcodeUrl || '') : '';
  let usingTranscodeFallback = !!(streamUrl && transcodeFallbackUrl && streamUrl === transcodeFallbackUrl);
  let activeHlsInstance = null;
  let fallbackTriggered = false;
  function syncLivePlayerStyles(){
    if (!player || !isLiveWatch) return;
    player.style.width = '100%';
    player.style.height = '100%';
    player.style.objectPosition = 'center center';
    player.style.objectFit = liveViewMode === 'cover' ? 'cover' : 'contain';
    player.style.transform = `scale(${liveZoom})`;
    player.style.transformOrigin = 'center center';
  }
  function applyLiveRatio(nextRatio){
    if (!playerFrame) return;
    const finalRatio = nextRatio === '4-3' ? '4-3' : '16-9';
    liveRatio = finalRatio;
    playerFrame.classList.remove('ratio-16-9', 'ratio-4-3');
    playerFrame.classList.add(`ratio-${finalRatio}`);
    playerFrame.style.aspectRatio = finalRatio === '4-3' ? '4 / 3' : '16 / 9';
    qsa('[data-ratio]').forEach(btn => btn.classList.toggle('active', btn.dataset.ratio === finalRatio));
    try { localStorage.setItem(ratioStorageKey, finalRatio); } catch {}
  }
  function applyLiveViewMode(nextMode){
    if (!playerFrame) return;
    const finalMode = nextMode === 'cover' ? 'cover' : 'contain';
    liveViewMode = finalMode;
    playerFrame.classList.remove('mode-contain', 'mode-cover');
    playerFrame.classList.add(`mode-${finalMode}`);
    if (player) {
      player.classList.remove('live-view-contain', 'live-view-cover');
      player.classList.add(`live-view-${finalMode}`);
    }
    syncLivePlayerStyles();
    qsa('[data-view-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.viewMode === finalMode));
    try { localStorage.setItem(viewModeStorageKey, finalMode); } catch {}
  }
  function applyLiveZoom(nextZoom){
    if (!playerFrame) return;
    const finalZoom = Math.max(1, Math.min(1.8, Number(nextZoom || 1)));
    liveZoom = finalZoom;
    playerFrame.style.setProperty('--player-scale', String(finalZoom));
    if (player) player.style.setProperty('--player-scale', String(finalZoom));
    syncLivePlayerStyles();
    try { localStorage.setItem(zoomStorageKey, String(finalZoom)); } catch {}
  }
  function setSuggestedLiveRatio(){
    if (!isLiveWatch) return;
    const hasSavedRatio = (() => {
      try {
        const savedRatio = localStorage.getItem(ratioStorageKey);
        return savedRatio === '4-3' || savedRatio === '16-9';
      } catch {
        return false;
      }
    })();
    if (!hasSavedRatio) applyLiveRatio(inferredDefaultRatio);
  }
  qsa('[data-ratio]').forEach(btn => btn.addEventListener('click', () => applyLiveRatio(btn.dataset.ratio)));
  qsa('[data-view-mode]').forEach(btn => btn.addEventListener('click', () => applyLiveViewMode(btn.dataset.viewMode)));
  qsa('[data-zoom-step]').forEach(btn => btn.addEventListener('click', () => applyLiveZoom(Math.max(1, Math.min(1.8, liveZoom + Number(btn.dataset.zoomStep || 0))))));
  if (liveBtn) liveBtn.addEventListener('click', goToLiveEdge);
  if (fullscreenBtn && playerFrame) {
    fullscreenBtn.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement === playerFrame || document.webkitFullscreenElement === playerFrame) {
          if (document.exitFullscreen) await document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
          return;
        }
        if (playerFrame.requestFullscreen) await playerFrame.requestFullscreen();
        else if (playerFrame.webkitRequestFullscreen) playerFrame.webkitRequestFullscreen();
      } catch {}
    });
  }
  document.addEventListener('fullscreenchange', () => {
    if (!fullscreenBtn || !playerFrame) return;
    fullscreenBtn.textContent = document.fullscreenElement === playerFrame ? 'الخروج من الشاشة الكاملة' : 'شاشة كاملة';
    syncLivePlayerStyles();
  });
  document.addEventListener('webkitfullscreenchange', syncLivePlayerStyles);
  if (isLiveWatch) applyLiveRatio(liveRatio);
  if (isLiveWatch) applyLiveViewMode(liveViewMode);
  if (isLiveWatch) applyLiveZoom(liveZoom);
  syncLivePlayerStyles();
  setSuggestedLiveRatio();
  if (isWebrtcChannel && webrtcEmbedUrl) {
    if (playerStatus) playerStatus.textContent = 'تم تحميل مشغل WebRTC المباشر.';
    if (item.deviceName) side.insertAdjacentHTML('beforeend', `<div class="notice" style="margin-top:12px">جهاز الفيديو: ${escapeHtml(item.deviceName)}</div>`);
    if (item.audioDeviceName) side.insertAdjacentHTML('beforeend', `<div class="notice" style="margin-top:12px">جهاز الصوت: ${escapeHtml(item.audioDeviceName)}</div>`);
    return;
  }
  async function ensureLivePlayback(){
    if (!player) return false;
    player.defaultMuted = false;
    player.muted = false;
    player.volume = 1;
    try {
      await player.play();
      if (playerStatus) playerStatus.textContent = 'يعمل البث الآن مع الصوت.';
      return true;
    } catch (_autoplayError) {
      player.muted = true;
      try {
        await player.play();
        if (playerStatus) playerStatus.textContent = 'بدأ البث بدون صوت بسبب قيود المتصفح. ألغ الكتم من المشغل لتفعيل الصوت.';
        return true;
      } catch (_mutedFallbackError) {
        if (playerStatus) playerStatus.textContent = 'المتصفح منع التشغيل التلقائي. اضغط تشغيل داخل المشغل لبدء الصوت والصورة.';
      }
    }
    return false;
  }
  function destroyActiveHls(){
    if (activeHlsInstance && typeof activeHlsInstance.destroy === 'function') {
      try { activeHlsInstance.destroy(); } catch {}
    }
    activeHlsInstance = null;
  }
  function goToLiveEdge(){
    if (!player || !isLiveWatch) return;
    let target = Number(activeHlsInstance?.liveSyncPosition);
    if (!Number.isFinite(target) && player.seekable?.length) target = player.seekable.end(player.seekable.length - 1) - 0.25;
    if (!Number.isFinite(target) || target < 0) return;
    try { player.currentTime = target; } catch {}
    player.play().catch(() => null);
    if (playerStatus) playerStatus.textContent = 'تم الانتقال إلى أحدث نقطة متاحة في البث.';
  }
  async function tryTranscodeFallback(reason = ''){
    if (!player || !transcodeFallbackUrl || usingTranscodeFallback || fallbackTriggered || type === 'channel') return false;
    fallbackTriggered = true;
    usingTranscodeFallback = true;
    destroyActiveHls();
    try {
      player.pause();
    } catch {}
    player.removeAttribute('src');
    try {
      player.load();
    } catch {}
    if (playerStatus) playerStatus.textContent = reason ? `جاري التحويل إلى تشغيل متوافق: ${reason}` : 'جاري التحويل إلى تشغيل متوافق للصيغة والصوت...';
    await attachPlayerSource(transcodeFallbackUrl, { forceHls: true, label: 'النسخة المتوافقة' });
    return true;
  }
  async function attachPlayerSource(sourceToLoad = streamUrl, options = {}){
    if (!player || !sourceToLoad) return;
    destroyActiveHls();
    const forceHls = !!options.forceHls;
    const sourceLabel = options.label || 'الفيديو';
    if (type === 'channel') {
      player.defaultMuted = false;
      player.muted = false;
      player.volume = 1;
    }
    const isHlsStream = forceHls || /\.m3u8(?:$|\?)/i.test(sourceToLoad) || sourceToLoad.includes('/live-streams/') || sourceToLoad.includes('/transcode/');
    const buildRetryUrl = attempt => {
      const url = new URL(sourceToLoad, location.origin);
      url.searchParams.set('ts', String(Date.now()));
      url.searchParams.set('try', String(attempt));
      return url.toString();
    };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function warmupHlsManifest(maxAttempts = 8){
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetch(buildRetryUrl(attempt), { cache: 'no-store' });
          if (response.ok) return buildRetryUrl(attempt);
        } catch {}
        if (playerStatus) playerStatus.textContent = `جاري تجهيز البث المباشر... محاولة ${attempt} من ${maxAttempts}`;
        await wait(800);
      }
      return buildRetryUrl(maxAttempts);
    }
    if (!isHlsStream) {
      player.src = sourceToLoad;
      if (playerStatus) playerStatus.textContent = `تم تحميل ${sourceLabel}.`;
      return;
    }
    const resolvedHlsUrl = await warmupHlsManifest();
    if (window.Hls && typeof window.Hls.isSupported === 'function' && window.Hls.isSupported()) {
      let retryCount = 0;
      const maxRetryCount = 6;
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 12,
        maxBufferLength: 12,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 60,
        maxLiveSyncPlaybackRate: 1,
        startFragPrefetch: true,
        manifestLoadingTimeOut: 10000,
        levelLoadingTimeOut: 10000,
        fragLoadingTimeOut: 12000
      });
      activeHlsInstance = hls;
      if (playerStatus) playerStatus.textContent = `تم ربط HLS بالمشغل، جاري تحميل ${sourceLabel}...`;
      hls.loadSource(resolvedHlsUrl);
      hls.attachMedia(player);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        retryCount = 0;
        if (playerStatus) playerStatus.textContent = `تم تحميل ${sourceLabel}، جاري بدء التشغيل...`;
        if (type === 'channel') ensureLivePlayback().catch(() => null);
      });
      hls.on(window.Hls.Events.ERROR, async (_event, data) => {
        if (data?.fatal) {
          if (playerStatus) playerStatus.textContent = `تعذر تشغيل البث: ${data.details || data.type || 'خطأ HLS'}`;
          if (data.type === 'mediaError') hls.recoverMediaError();
          else if (data.type === 'networkError' && retryCount < maxRetryCount) {
            retryCount += 1;
            if (playerStatus) playerStatus.textContent = `جاري إعادة محاولة البث... ${retryCount}/${maxRetryCount}`;
            await wait(900);
            hls.stopLoad();
            hls.loadSource(await warmupHlsManifest(4));
            hls.startLoad();
          }
          else {
            hls.destroy();
            activeHlsInstance = null;
            await tryTranscodeFallback(data.details || data.type || 'خطأ HLS');
          }
        }
      });
      return;
    }
    if (player.canPlayType('application/vnd.apple.mpegurl')) {
      let nativeRetryCount = 0;
      const maxNativeRetryCount = 6;
      const loadNativeSource = async () => {
        player.src = await warmupHlsManifest(4);
        player.load();
      };
      const retryNativePlayback = async () => {
        if (nativeRetryCount >= maxNativeRetryCount) return;
        nativeRetryCount += 1;
        if (playerStatus) playerStatus.textContent = `جاري إعادة محاولة تشغيل البث... ${nativeRetryCount}/${maxNativeRetryCount}`;
        await wait(900);
        await loadNativeSource();
      };
      player.addEventListener('loadedmetadata', () => {
        if (type === 'channel') ensureLivePlayback().catch(() => null);
      });
      player.addEventListener('canplay', () => {
        if (type === 'channel') ensureLivePlayback().catch(() => null);
      });
      player.addEventListener('stalled', () => { retryNativePlayback().catch(()=>null); });
      player.addEventListener('waiting', () => { if (type === 'channel') retryNativePlayback().catch(()=>null); });
      player.addEventListener('error', () => { retryNativePlayback().catch(()=>null); });
      player.src = resolvedHlsUrl;
      if (playerStatus) playerStatus.textContent = `تم تحميل ${sourceLabel} مباشرة من المتصفح.`;
      return;
    }
    if (playerStatus) playerStatus.textContent = 'هذا المتصفح لا يدعم تشغيل HLS مباشرة.';
  }
  await attachPlayerSource();
  if (type === 'channel') {
    player.addEventListener('loadedmetadata', () => { if (playerStatus) playerStatus.textContent = 'تم تحميل بيانات البث.'; });
    player.addEventListener('playing', () => { if (playerStatus) playerStatus.textContent = player.muted ? 'يعمل البث الآن بدون صوت. ألغ الكتم من المشغل.' : 'يعمل البث الآن مع الصوت.'; });
    player.addEventListener('error', () => { if (playerStatus) playerStatus.textContent = 'المتصفح فشل في تشغيل الفيديو. حاول تحديث الصفحة أو تغيير المصدر.'; });
    player.addEventListener('volumechange', () => {
      if (!playerStatus || !player.currentSrc) return;
      if (player.muted || player.volume === 0) return;
      playerStatus.textContent = 'الصوت مفعّل لهذا البث المباشر.';
    });
  }
  if (transcodeFallbackUrl) {
    side.insertAdjacentHTML('beforeend', `<div class="notice" style="margin-top:12px">يستخدم هذا المشغل النسخة المتوافقة افتراضيًا لضمان دعم أكبر قدر ممكن من صيغ الفيديو والصوت داخل المكتبات.</div>`);
  }
  player.addEventListener('error', () => {
    if (type === 'channel') return;
    tryTranscodeFallback('فشل المتصفح في تشغيل الملف مباشرة').catch(()=>null);
  });
  player.addEventListener('contextmenu', e => e.preventDefault());
  if (!auth.authenticated) return;
  const resumeBtn = qs('#resume-btn');
  let progress = null;
  if (type !== 'channel') progress = await getJson(`/api/users/progress/${encodeURIComponent(type)}/${encodeURIComponent(id)}`).catch(()=>null);
  if (progress?.position) { resumeBtn.classList.remove('hidden'); resumeBtn.textContent = `استكمال من ${formatTime(progress.position)}`; resumeBtn.onclick = () => { player.currentTime = Number(progress.position || 0); player.play().catch(()=>null); }; } else if (resumeBtn) resumeBtn.classList.add('hidden');
  let lastSent = 0;
  player.addEventListener('timeupdate', async () => { if (type === 'channel') return; const now = Date.now(); if (now - lastSent < 5000) return; lastSent = now; await getJson('/api/users/progress', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ type, id, position: player.currentTime || 0, duration: player.duration || 0, title:item.title || item.showTitle, poster:item.poster || item.logo || null, subtitle, href:location.pathname + location.search, streamUrl })}).catch(()=>null); });
}
async function initLoginPage(){
  const auth = await getAuth();
  appShell({ auth, pageKey:'login', title:'الحسابات وتسجيل الدخول', subtitle:'يدعم النظام الآن التسجيل التلقائي حسب الجهاز مع إمكانية تعديل الاسم أو التحويل إلى حساب إداري يدوي.' });
  const root = qs('#page-root');
  root.innerHTML = `<div class="login-wrap"><div class="login-box">${auth.authenticated ? `<div class="current-user-box"><h2 class="login-title">الحساب الحالي</h2><p class="muted">${auth.user.authType === 'device' ? 'تم إنشاء هذا الحساب تلقائياً بواسطة الجهاز الحالي.' : 'أنت مسجل الدخول حالياً.'}</p><div class="grid"><input class="input" id="profile-display-name" value="${escapeHtml(auth.user.displayName || auth.user.username || '')}" placeholder="الاسم الظاهر"><button class="button" id="profile-save-btn">حفظ الاسم</button><button class="button secondary" id="logout-profile-btn">تسجيل خروج</button><div class="muted" id="profile-msg"></div></div><hr class="sep"></div>` : ''}<h2 class="login-title">تسجيل الدخول اليدوي</h2><p class="muted">استخدم هذا النموذج للتحويل إلى حساب إداري أو حساب بكلمة مرور.</p><div class="grid"><input class="input" id="username" placeholder="اسم المستخدم"><input class="input" id="password" type="password" placeholder="كلمة المرور"><button class="button" id="login-btn">دخول</button><div class="muted" id="login-msg"></div></div><div class="${auth.allowSelfRegistration ? '' : 'hidden'}" style="margin-top:18px"><hr class="sep"><h3>إنشاء حساب جديد</h3><div class="grid"><input class="input" id="reg-display" placeholder="الاسم الظاهر"><input class="input" id="reg-username" placeholder="اسم المستخدم"><input class="input" id="reg-password" type="password" placeholder="كلمة المرور"><button class="button secondary" id="register-btn">إنشاء حساب</button></div></div>${auth.autoRegisterDevices ? `<div class="notice" style="margin-top:16px">الدخول التلقائي حسب الجهاز مفعّل. أي جهاز جديد سيُنشأ له حساب تلقائياً ويمكن تعديل اسمه لاحقاً.</div>` : ''}</div></div>`;
  if (qs('#profile-save-btn')) bindProfileEditor('#profile-save-btn', '#profile-display-name', '#profile-msg');
  const logoutBtn = qs('#logout-profile-btn'); if (logoutBtn) logoutBtn.onclick = async ()=>{ await getJson('/api/auth/logout',{method:'POST'}).catch(()=>null); location.reload(); };
  qs('#login-btn').onclick = async () => { try { await getJson('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username:qs('#username').value, password:qs('#password').value })}); location.href='/'; } catch (e) { qs('#login-msg').textContent = e.error || 'فشل تسجيل الدخول'; } };
  const regBtn = qs('#register-btn'); if (regBtn) regBtn.onclick = async () => { try { await getJson('/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ displayName: qs('#reg-display').value, username: qs('#reg-username').value, password: qs('#reg-password').value })}); qs('#login-msg').textContent = 'تم إنشاء الحساب. يمكنك تسجيل الدخول الآن.'; } catch (e) { qs('#login-msg').textContent = e.error || 'تعذر إنشاء الحساب'; } };
}


/* ===== ArabCast BMS full redesign runtime overrides ===== */
function appShell({auth, pageKey, title, subtitle='', heroImage='', heroMeta=[]}){
  const system = auth?.system || {};
  document.body.className = `page-${String(pageKey || pageKeyName()).replace(/[^\w-]/g, '')} arabcast-bms`;
  if(!document.querySelector('link[href*="arabcast-bms.css"]')){
    const l=document.createElement('link'); l.rel='stylesheet'; l.href='/assets/css/arabcast-bms.css?v=20260617-professional-fix15'; document.head.appendChild(l);
  }
  const navItems=[['home','/','الرئيسية','🏠'],['movies','/movies','الأفلام','🎬'],['series','/series','المسلسلات','📺'],['audio','/audio','الصوتيات','🎵'],['mixed','/mixed','المكتبات','🎞'],['live','/live','القنوات','📡'],['sports','/sports','الرياضة','⚽']];
  if(auth.user?.role==='admin'){navItems.push(['settings','/settings','الإعدادات','⚙'],['users','/users','المستخدمون','👤']);}
  const userBox=auth.authenticated?`<div class="sidebar-user"><div><div class="sidebar-user-name">${escapeHtml(auth.user.displayName||auth.user.username)}</div><div class="muted">${auth.user.role==='admin'?'مدير ArabCast':(auth.user.authType==='device'?'جهاز مسجل':'مستخدم')}</div></div><div class="sidebar-actions"><a class="button secondary small" href="/login">الحساب</a><button class="button secondary small" id="logout-btn">خروج</button></div></div>`:`<div class="sidebar-user"><div class="sidebar-user-name">زائر</div><div class="muted">تصفح سريع أو سجّل الدخول</div><div class="sidebar-actions"><a class="button secondary small" href="/login">تسجيل الدخول</a></div></div>`;
  document.body.innerHTML=`
    <div class="mobile-topbar"><div class="brand"><button class="button secondary small" id="mobile-menu-toggle">☰</button>${brandHtml(system)}</div>${auth.authenticated?`<button class="button secondary small" id="logout-mobile">خروج</button>`:`<a class="button secondary small" href="/login">دخول</a>`}</div>
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="/">${brandHtml(system)}</a>
        <div class="sidebar-section"><div class="sidebar-label">ARABCAST BMS</div><nav class="side-nav">${navItems.map(([key,href,label,icon])=>`<a class="side-link ${key===pageKey?'active':''}" data-nav="${key}" href="${href}"><span>${icon}</span><span>${label}</span></a>`).join('')}</nav></div>
        ${userBox}
      </aside>
      <main class="content">
        <div class="arabcast-topbar"><div class="arabcast-title"><strong>${escapeHtml(title||system.name||'ArabCast BMS')}</strong><span>${escapeHtml(subtitle||system.homeMessage||'مركز إدارة الوسائط والبث المباشر')}</span></div><label class="arabcast-search"><span>⌕</span><input id="global-ui-search" placeholder="بحث سريع في الواجهة..." autocomplete="off"></label></div>
        <div id="page-root"></div>
      </main>
    </div><div class="mobile-sidebar-backdrop" id="mobile-sidebar-backdrop"></div>`;
  bindTopbarAuth(); bindMobileSidebar(); activePageNav(pageKey);
  const g=qs('#global-ui-search'); if(g){g.addEventListener('keydown',e=>{if(e.key==='Enter'&&g.value.trim()){location.href='/movies?q='+encodeURIComponent(g.value.trim())}})}
}
function acHero({system={},featured=null,auth=null,data={}}){
 const img=featured?.poster||featured?.logo||'';
 return `<section class="ac-hero"><div class="ac-hero-copy"><div><span class="ac-kicker">● ArabCast Control Center</span><h1>${escapeHtml(system.name||'ArabCast BMS')}</h1><p>${escapeHtml(system.homeMessage||'.')}</p><div class="ac-hero-actions"><a class="button" href="/live"> القنوات</a><a class="button secondary" href="/movies"> المكتبة</a>${auth?.user?.role==='admin'?`<a class="button secondary" href="/settings">لوحة الإدارة</a>`:''}</div></div><div class="ac-mini-meta"><span class="tag">RTL Ready</span><span class="tag">Mobile Pro</span><span class="tag">Live/VOD</span></div></div><div class="ac-hero-visual">${img?`<img src="${escapeHtml(img)}" alt="">`:`<div class="fallback">📺</div>`}<span class="ac-live-pill">LIVE BMS</span></div></section>`;
}
function acStats(data={},auth={}){
 const libs=data.librarySections?.length||0, live=(data.liveCategorySections?.length||data.liveSections?.length||0), channels=data.channels?.length||0;
 const items=(data.newestMovies?.length||0)+(data.newestSeries?.length||0)+(data.newestAudio?.length||0);
 return `<section class="ac-stats"><div class="ac-stat"><b>${libs}</b><span>مكتبات مضافة</span><i>📚</i></div><div class="ac-stat"><b>${live}</b><span>أقسام بث</span><i>📡</i></div><div class="ac-stat"><b>${channels}</b><span>قنوات مباشرة</span><i>▶</i></div><div class="ac-stat"><b>${auth?.authenticated?'ON':'GUEST'}</b><span>حالة الدخول</span><i>👤</i></div></section>`;
}
async function initHomePage(){
  const auth=await getAuth();
  const favorites=await createFavoritesController(auth);
  const data=await getJson('/api/home').catch(()=>({newestMovies:[],newestSeries:[],newestAudio:[],channels:[],librarySections:[],liveSections:[],liveCategorySections:[],system:{}}));
  auth.system=auth.system||data.system||{};
  const featured=data.librarySections?.find(s=>s.items?.length)?.items?.[0]||data.liveCategorySections?.find(s=>s.items?.length)?.items?.[0]||data.liveSections?.find(s=>s.items?.length)?.items?.[0]||data.newestMovies?.[0]||data.newestSeries?.[0]||data.channels?.[0]||null;
  appShell({auth,pageKey:'home',title:auth.system?.name||'ArabCast BMS',subtitle:'لوحة تشغيل وإدارة حديثة للبث والمكتبات'});
  const root=qs('#page-root');
  const shortcutSections=[...(data.librarySections||[]),...(data.liveSections||[]).map(s=>({...s,type:'live'}))];
  function favCard(item,sectionType){
    const contextItem=sectionType==='mixed'?{...item,watchHref:buildItemWatchHref(item,String(item?.mediaType||item?.type||'').toLowerCase(),'mixed')}:item;
    const payload=mediaFavoritePayload(contextItem,sectionType);
    const favoriteHtml=auth.authenticated?itemFavoriteButton(payload,favorites.has(payload.type,payload.id)):'';
    if(sectionType==='mixed'){const raw=String(contextItem?.mediaType||contextItem?.type||'').toLowerCase();return raw==='audio'?audioCard(contextItem,true,favoriteHtml):movieCard(contextItem,true,favoriteHtml)}
    return sectionType==='movies'?movieCard(item,true,favoriteHtml):sectionType==='series'?seriesCard(item,true,favoriteHtml):sectionType==='audio'?audioCard(item,true,favoriteHtml):channelCard(item,true,favoriteHtml);
  }
  const shortcuts=renderLibraryShortcutSection(shortcutSections);
  const libraryRows=(data.librarySections||[]).map(section=>renderRowSection({title:section.name,items:section.items||[],renderCard:item=>favCard(item,section.type),actionHref:libraryListingHref(section)})).join('');
  const liveRows=(((data.liveCategorySections&&data.liveCategorySections.length)?data.liveCategorySections:data.liveSections)||[]).slice(0,8).map(section=>renderRowSection({title:section.name,items:section.items||[],renderCard:item=>favCard(item,'channel'),actionHref:section.href||'/live'})).join('');
  root.innerHTML=`${acHero({system:auth.system,featured,auth,data})}${acStats(data,auth)}${shortcuts}<div id="home-dynamic"></div>${libraryRows}${liveRows}<div class="footer-space"></div>`;
  root.addEventListener('click',async e=>{const b=e.target.closest('[data-favorite-item]'); if(!b)return; e.preventDefault();e.stopPropagation();const payload={type:b.dataset.favoriteType,id:b.dataset.favoriteId,title:b.dataset.favoriteTitle,subtitle:b.dataset.favoriteSubtitle,href:b.dataset.favoriteHref,poster:b.dataset.favoritePoster||null};const result=await favorites.toggle(payload).catch(()=>null);if(result){b.classList.toggle('active',!!result.favorite);b.textContent=result.favorite?'♥':'♡';}});
  if(auth.authenticated){const [cont,fav]=await Promise.all([getJson('/api/users/continue').catch(()=>[]),getJson('/api/users/favorites').catch(()=>[])]);const d=qs('#home-dynamic');d.innerHTML=`${renderRowSection({title:'متابعة المشاهدة',items:cont,renderCard:continueCard})}${renderRowSection({title:'المفضلة',items:fav,renderCard:favoriteCard})}`;}
}






