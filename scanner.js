
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const xml2js = require('xml2js');
const { openMediaDb, openRuntimeDb } = require('./db');

const rootDir = __dirname;
const configPath = path.join(rootDir, 'config.json');
const scanStatusPath = path.join(rootDir, 'data', 'scan-status.json');
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function parseMaybeJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function isHttpUrl(value = '') { return /^https?:\/\//i.test(String(value || '').trim()); }
function isStreamInputUrl(value = '') { return /^(rtmp|srt|rtsp|udp|http|https):\/\//i.test(String(value || '').trim()); }
function isHlsPlaylistText(value = '') { return /#EXT-X-(TARGETDURATION|MEDIA-SEQUENCE|STREAM-INF|PLAYLIST-TYPE|I-FRAMES-ONLY|KEY|MAP|VERSION)/i.test(String(value || '')); }
function isLikelyHlsMediaSegment(value = '') {
  const clean = String(value || '').trim().split(/[?#]/)[0].toLowerCase();
  return /\.(ts|m2ts|m4s|cmfv|cmfa|aac|mp4)$/i.test(clean);
}
function isSegmentExtinf(meta = '') {
  return /^#EXTINF:\s*\d+(?:\.\d+)?\s*,\s*$/i.test(String(meta || '').trim());
}
function resolvePlaylistEntry(base = '', entry = '') {
  const value = String(entry || '').trim();
  if (!value || isStreamInputUrl(value) || path.isAbsolute(value)) return value;
  if (isHttpUrl(base)) {
    try { return new URL(value, base).toString(); } catch { return value; }
  }
  return base ? path.resolve(path.dirname(base), value) : value;
}
async function readTextSource(target = '') {
  const value = String(target || '').trim();
  if (!value) return { ok: false, text: '', finalUrl: '' };
  if (isHttpUrl(value)) {
    const response = await fetch(value, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'LightMediaServer/11', accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, text/plain, application/xml, */*' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    return { ok: true, text: await response.text(), finalUrl: response.url || value };
  }
  if (!fs.existsSync(value)) return { ok: false, text: '', finalUrl: value };
  return { ok: true, text: fs.readFileSync(value, 'utf8'), finalUrl: value };
}
function normalizeLibrary(lib = {}, index = 0) {
  const type = ['movies', 'series', 'audio', 'mixed'].includes(lib.type) ? lib.type : 'movies';
  return {
    id: String(lib.id || `library-${index + 1}`),
    name: String(lib.name || `مكتبة ${index + 1}`),
    type,
    paths: Array.isArray(lib.paths) ? lib.paths.map(x => String(x || '')) : [''],
    scanMode: 'recursive',
    maxDepth: 9999,
    allowDownload: lib.allowDownload !== false,
    showOnHome: lib.showOnHome !== false
  };
}
function normalizeSource(src = {}, index = 0) {
  const sourceType = ['usb_capture', 'm3u', 'rtmp', 'srt', 'rtsp', 'hls', 'webrtc'].includes(src.sourceType) ? src.sourceType : 'm3u';
  const m3uInputMode = ['auto', 'playlist', 'direct_hls'].includes(String(src.m3uInputMode || '').trim()) ? String(src.m3uInputMode).trim() : 'auto';
  const requestHeaders = src.requestHeaders && typeof src.requestHeaders === 'object' && !Array.isArray(src.requestHeaders) ? src.requestHeaders : {};
  return {
    id: String(src.id || `source-${index + 1}`),
    name: String(src.name || `مصدر ${index + 1}`),
    sourceType,
    m3uPath: String(src.m3uPath || ''),
    epgPath: String(src.epgPath || ''),
    m3uInputMode,
    groupTitle: String(src.groupTitle || src.group_title || src.category || ''),
    channelName: String(src.channelName || src.name || `Channel ${index + 1}`),
    deviceName: String(src.deviceName || ''),
    inputUrl: String(src.inputUrl || ''),
    streamUrl: String(src.streamUrl || src.url || ''),
    logo: String(src.logo || ''),
    description: String(src.description || ''),
    requestHeaders,
    userAgent: String(src.userAgent || src.user_agent || ''),
    referer: String(src.referer || src.referrer || ''),
    relayMode: ['auto', 'copy', 'transcode'].includes(String(src.relayMode || '').trim()) ? String(src.relayMode).trim() : 'auto',
    enabled: src.enabled !== false,
    ffmpegInput: String(src.ffmpegInput || ''),
    ffmpegCommand: String(src.ffmpegCommand || '')
  };
}
function normalizeConfig(cfg = {}) {
  cfg.server = { port: 8090, host: '0.0.0.0', sessionSecret: 'change-me-now', ...(cfg.server || {}) };
  cfg.performance = { pageSize: 48, newestLimit: 24, ...(cfg.performance || {}) };
  cfg.system = { name: 'STARSNET', iconText: '⭐', logoUrl: '', homeMessage: 'مرحبا بكم في الاستراحة الخاصة بنا', ...(cfg.system || {}) };
  cfg.auth = { allowSelfRegistration: false, requireLoginForViewing: false, autoRegisterDevices: true, ...(cfg.auth || {}) };
  cfg.admin = { username: 'admin', password: 'admin123', ...(cfg.admin || {}) };
  cfg.scan = { autoStartOnEmptyIndex: true, yieldEvery: 200, statusUpdateEvery: 100, followSymlinks: false, ...(cfg.scan || {}) };
  cfg.libraries = Array.isArray(cfg.libraries) ? cfg.libraries.map(normalizeLibrary) : [];
  cfg.iptv = cfg.iptv || { sources: [] };
  if (!Array.isArray(cfg.iptv.sources)) cfg.iptv.sources = [];
  cfg.iptv.sources = cfg.iptv.sources.map(normalizeSource);
  return cfg;
}
let config = normalizeConfig(readJson(configPath, {}));
const options = JSON.parse(process.env.LMS_SCAN_OPTIONS || '{}');
let yieldEvery = Number(config.scan?.yieldEvery || 200);
let statusEvery = Number(config.scan?.statusUpdateEvery || 100);
let cancelled = false;
process.on('SIGTERM', ()=>{ cancelled = true; });

function defaultStatus() { return { running: true, stage: 'running', libraryId: null, libraryName: null, startedAt: new Date().toISOString(), endedAt: null, message: '', progress: { percent: 0, processedDirs: 0, discovered: 0, errors: 0 } }; }
function relativePoster(filePath) { return filePath ? '/poster/' + Buffer.from(filePath).toString('base64url') : null; }
function relativeMedia(filePath) { return '/media/' + Buffer.from(filePath).toString('base64url'); }
function normalizeName(name) { return String(name || '').replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim(); }
const VIDEO_EXTENSIONS = [
  '.mp4', '.m4v', '.mov', '.3gp', '.3g2',
  '.mkv', '.webm', '.avi', '.asf', '.wmv',
  '.mpg', '.mpeg', '.mpe', '.m1v', '.m2v', '.mpv', '.m2p', '.m2t',
  '.ts', '.m2ts', '.mts', '.tp', '.trp', '.pva',
  '.ogv', '.ogm', '.axv',
  '.rm', '.rmvb',
  '.flv', '.mxf', '.nut', '.dv'
];
const AUDIO_EXTENSIONS = [
  '.mp3', '.aac', '.m4a', '.flac', '.wav', '.wma', '.ogg', '.opus',
  '.ac3', '.a52', '.dts', '.mp2', '.mp1',
  '.mid', '.midi', '.smf',
  '.ra', '.axa', '.voc'
];
function hasExtension(name, extensions) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return !!ext && extensions.includes(ext);
}
function isVideoFile(name) { return hasExtension(name, VIDEO_EXTENSIONS); }
function isAudioFile(name) { return hasExtension(name, AUDIO_EXTENSIONS); }
function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
function parseSeriesEpisode(filename) { const base = normalizeName(filename); const patterns = [/S(\d{1,2})E(\d{1,3})/i, /(\d{1,2})x(\d{1,3})/i, /الموسم\s*(\d{1,2}).*الحلقة\s*(\d{1,3})/i]; for (const p of patterns) { const m = base.match(p); if (m) return { season: parseInt(m[1],10), episode: parseInt(m[2],10), title: base }; } return null; }
function looksLikeSeasonDir(name) { const value = normalizeName(name); return /^(season|series|s)\s*\d{1,2}$/i.test(value) || /^الموسم\s*\d{1,2}$/i.test(value) || /^specials?$/i.test(value); }
function inferSeasonFromPath(filePath) { const patterns = [/[\\/]Season\s*(\d{1,2})[\\/]/i, /[\\/]S(\d{1,2})[\\/]/i, /[\\/]الموسم\s*(\d{1,2})[\\/]/i]; for (const p of patterns) { const m = filePath.match(p); if (m) return parseInt(m[1],10); } return null; }
function inferEpisodeFromName(name) { const patterns = [/E(\d{1,3})/i, /-(\d{1,3})(?:\D|$)/, /الحلقة\s*(\d{1,3})/i]; for (const p of patterns) { const m = name.match(p); if (m) return parseInt(m[1],10); } return null; }
function choosePrimaryVideo(files, folderName) { if (!files.length) return null; const normalizedFolder = normalizeName(folderName).toLowerCase(); const ranked = files.slice().sort((a,b)=> { const aName = normalizeName(path.basename(a)).toLowerCase(); const bName = normalizeName(path.basename(b)).toLowerCase(); const aScore = (aName.includes(normalizedFolder)?100:0) + (safeStat(a)?.size||0); const bScore = (bName.includes(normalizedFolder)?100:0) + (safeStat(b)?.size||0); return bScore - aScore; }); return ranked[0]; }
function getFolderSegments(basePath, targetDir) { const rel = path.relative(basePath, targetDir); if (!rel || rel.startsWith('..')) return []; return rel.split(path.sep).filter(Boolean); }
function getFolderMeta(libPath, mediaDir, mediaType) {
  const segments = getFolderSegments(libPath, mediaDir);
  if (!segments.length) {
    return {
      topFolder: '',
      folderPath: '',
      mediaFolder: path.basename(mediaDir),
      folderTree: [],
      folderSegments: []
    };
  }
  if (mediaType === 'movies' || mediaType === 'audio') {
    const categorySegments = segments.slice(0, -1);
    return {
      topFolder: categorySegments[0] || '',
      folderPath: categorySegments.join('/'),
      mediaFolder: segments[segments.length - 1] || path.basename(mediaDir),
      folderTree: categorySegments,
      folderSegments: segments
    };
  }
  const categorySegments = segments.length > 1 ? segments.slice(0, -1) : [];
  return {
    topFolder: categorySegments[0] || '',
    folderPath: categorySegments.join('/'),
    mediaFolder: segments[segments.length - 1] || path.basename(mediaDir),
    folderTree: categorySegments,
    folderSegments: segments
  };
}
function findImage(dir) {
  const preferred = ['poster.jpg','poster.jpeg','poster.png','cover.jpg','cover.jpeg','cover.png','folder.jpg','folder.jpeg','folder.png','fanart.jpg','fanart.jpeg','fanart.png','backdrop.jpg','backdrop.jpeg','backdrop.png','thumb.jpg','thumb.jpeg','thumb.png'];
  for (const n of preferred) { const f = path.join(dir, n); if (fs.existsSync(f)) return f; }
  let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const images = entries.filter(e => e.isFile() && /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(e.name)).map(e => path.join(dir, e.name));
  return images.length ? images.sort()[0] : null;
}
function parseXmltvDate(value) { const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+\-]\d{4})?/); if (!m) return new Date(0); const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? m[7].slice(0,3)+':'+m[7].slice(3) : 'Z'}`; return new Date(iso); }
function extractExtinfName(meta) { if (!meta) return ''; const idx = meta.lastIndexOf(','); return idx >= 0 ? meta.slice(idx + 1).trim() : ''; }
function extractAttr(meta, name) { if (!meta) return ''; const m = meta.match(new RegExp(name + '="([^"]+)"')); return m ? m[1] : ''; }
function parseM3uOptionLine(line = '', options = {}) {
  const text = String(line || '').trim();
  const next = { ...(options || {}) };
  const vlc = text.match(/^#EXTVLCOPT:([^=]+)=(.*)$/i);
  if (vlc) {
    const key = String(vlc[1] || '').trim().toLowerCase();
    const value = String(vlc[2] || '').trim();
    if (key === 'http-user-agent' && value) next.userAgent = value;
    if (['http-referrer', 'http-referer'].includes(key) && value) next.referer = value;
    if (key === 'http-header' && value) {
      const index = value.indexOf('=');
      if (index > 0) {
        const headerName = value.slice(0, index).trim();
        const headerValue = value.slice(index + 1).trim();
        if (headerName && headerValue) next.headers = { ...(next.headers || {}), [headerName]: headerValue };
      }
    }
  }
  return next;
}
function buildM3uRequestHeaders(options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.userAgent) headers['User-Agent'] = options.userAgent;
  if (options.referer) headers.Referer = options.referer;
  return headers;
}
function buildSourceM3uRequestHeaders(source = {}, options = {}) {
  const headers = {
    ...(source.requestHeaders && typeof source.requestHeaders === 'object' ? source.requestHeaders : {}),
    ...buildM3uRequestHeaders(options)
  };
  if (source.userAgent) headers['User-Agent'] = String(source.userAgent);
  if (source.referer) headers.Referer = String(source.referer);
  return headers;
}

function buildFolderNodes(items, type) {
  const nodes = new Map();
  for (const item of items) {
    const tree = Array.isArray(item.folderSegments) && item.folderSegments.length
      ? item.folderSegments.filter(Boolean)
      : Array.isArray(item.folderTree)
        ? item.folderTree.filter(Boolean)
        : [];
    if (!tree.length) continue;
    let parent = '';
    for (let i = 0; i < tree.length; i++) {
      const name = tree[i];
      const currentPath = parent ? `${parent}/${name}` : name;
      const key = `${type}|${item.libraryId || ''}|${currentPath}`;
      let node = nodes.get(key);
      if (!node) {
        node = {
          id: Buffer.from(key).toString('base64url'),
          type,
          libraryId: item.libraryId || null,
          parentPath: parent,
          path: currentPath,
          name,
          depth: i,
          poster: item.poster || null,
          itemCount: 0,
          childCount: 0,
          createdAt: item.createdAt || item.addedAt || null,
          updatedAt: item.updatedAt || item.addedAt || null,
          addedAt: item.addedAt || item.updatedAt || null,
          _children: new Set()
        };
        nodes.set(key, node);
      }
      node.itemCount += 1;
      if (!node.poster && item.poster) node.poster = item.poster;
      const itemCreated = new Date(item.createdAt || item.addedAt || 0).getTime();
      const itemUpdated = new Date(item.updatedAt || item.addedAt || 0).getTime();
      const itemAdded = new Date(item.addedAt || item.updatedAt || 0).getTime();
      const nodeCreated = new Date(node.createdAt || 0).getTime();
      const nodeUpdated = new Date(node.updatedAt || 0).getTime();
      const nodeAdded = new Date(node.addedAt || 0).getTime();
      if (itemCreated && (!nodeCreated || itemCreated < nodeCreated)) node.createdAt = item.createdAt || item.addedAt || node.createdAt;
      if (itemUpdated && (!nodeUpdated || itemUpdated > nodeUpdated)) node.updatedAt = item.updatedAt || item.addedAt || node.updatedAt;
      if (itemAdded && (!nodeAdded || itemAdded > nodeAdded)) node.addedAt = item.addedAt || item.updatedAt || node.addedAt;
      if (i + 1 < tree.length) node._children.add(tree[i + 1]);
      parent = currentPath;
    }
  }
  return [...nodes.values()].map(node => ({
    id: node.id,
    type: node.type,
    libraryId: node.libraryId,
    parentPath: node.parentPath,
    path: node.path,
    name: node.name,
    depth: node.depth,
    poster: node.poster,
    itemCount: node.itemCount,
    childCount: node._children.size,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    addedAt: node.addedAt
  }));
}

const status = defaultStatus();
status.libraryId = options.libraryId || null;
status.libraryName = options.libraryName || null;
status.message = options.libraryId ? `جاري تحديث مكتبة ${options.libraryName || options.libraryId}` : 'جاري فحص كل المكتبات في الخلفية';

function saveScanStatus(payload) {
  fs.mkdirSync(path.dirname(scanStatusPath), { recursive: true });
  fs.writeFileSync(scanStatusPath, JSON.stringify(payload, null, 2), 'utf8');
}
function buildLibraryFolderNodes(lib, movies = [], series = [], audios = []) {
  return {
    movies: buildFolderNodes(movies, 'movies'),
    series: buildFolderNodes(series, 'series'),
    audio: buildFolderNodes(audios, 'audio')
  };
}
function persistLibraryScanResults(mediaDb, lib, movies = [], series = [], audios = []) {
  const folderNodes = buildLibraryFolderNodes(lib, movies, series, audios);
  const itemCount = lib.type === 'movies'
    ? movies.length
    : lib.type === 'series'
      ? series.length
      : lib.type === 'mixed'
        ? (movies.length + audios.length)
        : audios.length;
  const updatedAt = new Date().toISOString();
  mediaDb.transaction(() => {
    mediaDb.run('DELETE FROM media_items WHERE library_id = ?', [lib.id]);
    mediaDb.run('DELETE FROM libraries_meta WHERE id = ?', [lib.id]);
    mediaDb.run('DELETE FROM folder_nodes WHERE library_id = ?', [lib.id]);
    const insertItem = mediaDb.db.prepare('INSERT OR REPLACE INTO media_items(id, type, title, library_id, library_name, poster, top_folder, folder_path, folder_tree_json, media_folder, created_at, updated_at, added_at, path, stream_url, raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    try {
      for (const item of movies) insertItem.run([item.id, 'movies', item.title, item.libraryId, item.libraryName || null, item.poster || null, item.topFolder || null, item.folderPath || null, JSON.stringify(item.folderTree || []), item.mediaFolder || null, item.createdAt || null, item.updatedAt || item.addedAt || null, item.addedAt || null, item.path || null, item.streamUrl || null, JSON.stringify(item)]);
      for (const item of series) insertItem.run([item.id, 'series', item.title, item.libraryId, item.libraryName || null, item.poster || null, item.topFolder || null, item.folderPath || null, JSON.stringify(item.folderTree || []), item.mediaFolder || null, item.createdAt || null, item.updatedAt || item.addedAt || null, item.addedAt || null, null, null, JSON.stringify(item)]);
      for (const item of audios) insertItem.run([item.id, 'audio', item.title, item.libraryId, item.libraryName || null, item.poster || null, item.topFolder || null, item.folderPath || null, JSON.stringify(item.folderTree || []), item.mediaFolder || null, item.createdAt || null, item.updatedAt || item.addedAt || null, item.addedAt || null, item.path || null, item.streamUrl || null, JSON.stringify(item)]);
    } finally { insertItem.free(); }
    const insertFolder = mediaDb.db.prepare('INSERT OR REPLACE INTO folder_nodes(id, type, library_id, parent_path, path, name, depth, poster, item_count, child_count, created_at, updated_at, added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    try {
      for (const node of folderNodes.movies) insertFolder.run([node.id, node.type, node.libraryId || null, node.parentPath || '', node.path, node.name, node.depth || 0, node.poster || null, node.itemCount || 0, node.childCount || 0, node.createdAt || null, node.updatedAt || null, node.addedAt || null]);
      for (const node of folderNodes.series) insertFolder.run([node.id, node.type, node.libraryId || null, node.parentPath || '', node.path, node.name, node.depth || 0, node.poster || null, node.itemCount || 0, node.childCount || 0, node.createdAt || null, node.updatedAt || null, node.addedAt || null]);
      for (const node of folderNodes.audio) insertFolder.run([node.id, node.type, node.libraryId || null, node.parentPath || '', node.path, node.name, node.depth || 0, node.poster || null, node.itemCount || 0, node.childCount || 0, node.createdAt || null, node.updatedAt || null, node.addedAt || null]);
    } finally { insertFolder.free(); }
    mediaDb.run('INSERT OR REPLACE INTO libraries_meta(id, name, type, updated_at, item_count) VALUES(?,?,?,?,?)', [lib.id, lib.name, lib.type, updatedAt, itemCount]);
    mediaDb.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', ['generatedAt', updatedAt]);
  });
  mediaDb.save();
  return { updatedAt, itemCount, folderCount: folderNodes.movies.length + folderNodes.series.length + folderNodes.audio.length };
}
function cleanupMissingLibraries(mediaDb, currentLibraries = []) {
  const ids = (currentLibraries || []).map(lib => String(lib?.id || '').trim()).filter(Boolean);
  if (!ids.length) {
    mediaDb.transaction(() => {
      mediaDb.run('DELETE FROM media_items');
      mediaDb.run('DELETE FROM libraries_meta');
      mediaDb.run('DELETE FROM folder_nodes');
    });
    mediaDb.save();
    return;
  }
  const placeholders = ids.map(() => '?').join(',');
  mediaDb.transaction(() => {
    mediaDb.run(`DELETE FROM media_items WHERE library_id NOT IN (${placeholders})`, ids);
    mediaDb.run(`DELETE FROM libraries_meta WHERE id NOT IN (${placeholders})`, ids);
    mediaDb.run(`DELETE FROM folder_nodes WHERE library_id NOT IN (${placeholders})`, ids);
  });
  mediaDb.save();
}
function sendStatus(extra={}) {
  const payload = { ...status, ...extra, progress: { ...status.progress, ...(extra.progress || {}) } };
  saveScanStatus(payload);
  if (process.send) process.send({ type:'status', payload });
}
async function yieldLoop() { return new Promise(resolve => setImmediate(resolve)); }
async function listDir(dir) { try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { status.progress.errors++; return []; } }

async function scanMovieLibrary(lib, libPath) {
  const results = [];
  const seen = new Set();
  const indexEachVideoFile = lib.type === 'mixed' || lib.type === 'movies' || lib.indexVideoFilesIndividually === true;
  const stack = [{ dir: libPath, depth: 0 }];
  while (stack.length && !cancelled) {
    const { dir, depth } = stack.pop();
    const entries = await listDir(dir);
    status.progress.processedDirs++;
    if (status.progress.processedDirs % yieldEvery === 0) await yieldLoop();
    if (status.progress.processedDirs % statusEvery === 0) sendStatus({ message: `فحص ${status.progress.processedDirs} مجلد...` });
    const directVideoFiles = entries.filter(e => e.isFile() && isVideoFile(e.name)).map(e => path.join(dir, e.name));
    const relCurrent = path.relative(libPath, dir);
    const isRoot = !relCurrent;
    if (indexEachVideoFile && directVideoFiles.length) {
      for (const file of directVideoFiles) {
        if (seen.has(file)) continue;
        seen.add(file);
        const st = safeStat(file);
        const folderMeta = getFolderMeta(libPath, path.dirname(file), 'mixed');
        const item = {
          id: Buffer.from(file).toString('base64url'),
          title: normalizeName(path.basename(file)),
          libraryId: lib.id,
          libraryName: lib.name,
          mediaType: 'movies',
          allowDownload: lib.allowDownload !== false,
          path: file,
          streamUrl: relativeMedia(file),
          poster: relativePoster(findImage(path.dirname(file))),
          topFolder: folderMeta.topFolder,
          folderPath: folderMeta.folderPath,
          folderTree: folderMeta.folderTree,
          folderSegments: folderMeta.folderSegments,
          mediaFolder: folderMeta.mediaFolder,
          createdAt: st?.birthtime?.toISOString?.() || st?.ctime?.toISOString?.() || st?.mtime?.toISOString?.() || new Date().toISOString(),
          updatedAt: st?.mtime?.toISOString?.() || new Date().toISOString(),
          addedAt: st?.mtime?.toISOString?.() || new Date().toISOString()
        };
        results.push(item);
        status.progress.discovered++;
      }
    } else if (isRoot && directVideoFiles.length) {
      for (const file of directVideoFiles) {
        if (seen.has(file)) continue;
        seen.add(file);
        const st = safeStat(file); const folderMeta = getFolderMeta(libPath, path.dirname(file), 'movies');
        const item = { id: Buffer.from(file).toString('base64url'), title: normalizeName(path.basename(file)), libraryId: lib.id, libraryName: lib.name, mediaType: 'movies', allowDownload: lib.allowDownload !== false, path: file, streamUrl: relativeMedia(file), poster: relativePoster(findImage(path.dirname(file))), topFolder: folderMeta.topFolder, folderPath: folderMeta.folderPath, folderTree: folderMeta.folderTree, folderSegments: folderMeta.folderSegments, mediaFolder: folderMeta.mediaFolder, createdAt: st?.birthtime?.toISOString?.() || st?.ctime?.toISOString?.() || st?.mtime?.toISOString?.() || new Date().toISOString(), updatedAt: st?.mtime?.toISOString?.() || new Date().toISOString(), addedAt: st?.mtime?.toISOString?.() || new Date().toISOString() };
        results.push(item); status.progress.discovered++;
      }
    } else if (directVideoFiles.length) {
      const movieFolder = dir;
      if (!seen.has(movieFolder)) {
        seen.add(movieFolder);
        const primary = choosePrimaryVideo(directVideoFiles, path.basename(movieFolder));
        if (primary) {
          const st = safeStat(primary); const folderMeta = getFolderMeta(libPath, movieFolder, 'movies');
          const item = { id: Buffer.from(primary).toString('base64url'), title: normalizeName(path.basename(movieFolder)), libraryId: lib.id, libraryName: lib.name, mediaType: 'movies', allowDownload: lib.allowDownload !== false, path: primary, streamUrl: relativeMedia(primary), poster: relativePoster(findImage(movieFolder)), topFolder: folderMeta.topFolder, folderPath: folderMeta.folderPath, folderTree: folderMeta.folderTree, folderSegments: folderMeta.folderSegments, mediaFolder: folderMeta.mediaFolder, createdAt: st?.birthtime?.toISOString?.() || st?.ctime?.toISOString?.() || st?.mtime?.toISOString?.() || new Date().toISOString(), updatedAt: st?.mtime?.toISOString?.() || new Date().toISOString(), addedAt: st?.mtime?.toISOString?.() || new Date().toISOString() };
          results.push(item); status.progress.discovered++;
        }
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry.isDirectory()) continue;
      if (['@eaDir', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return results;
}

async function scanSeriesLibrary(lib, libPath) {
  const seriesMap = new Map();
  const stack = [{ dir: libPath, depth: 0 }];
  while (stack.length && !cancelled) {
    const { dir, depth } = stack.pop();
    const entries = await listDir(dir);
    status.progress.processedDirs++;
    if (status.progress.processedDirs % yieldEvery === 0) await yieldLoop();
    if (status.progress.processedDirs % statusEvery === 0) sendStatus({ message: `فحص ${status.progress.processedDirs} مجلد...` });
    const directVideoFiles = entries.filter(e => e.isFile() && isVideoFile(e.name)).map(e => path.join(dir, e.name));
    if (directVideoFiles.length) {
      for (const file of directVideoFiles) {
        const rel = path.relative(libPath, file); const parts = rel.split(path.sep); const dirs = parts.slice(0,-1); const fileName = parts[parts.length-1];
        let showDirParts = dirs.slice();
        if (showDirParts.length === 0) showDirParts = [normalizeName(fileName)];
        else if (looksLikeSeasonDir(showDirParts[showDirParts.length - 1])) showDirParts = showDirParts.slice(0,-1);
        if (showDirParts.length === 0) showDirParts = [normalizeName(fileName)];
        const showPath = path.join(libPath, ...showDirParts);
        const showName = normalizeName(showDirParts[showDirParts.length - 1]);
        const showKey = `${lib.id}:${showPath}`;
        let showData = seriesMap.get(showKey);
        if (!showData) {
          const folderMeta = getFolderMeta(libPath, showPath, 'series');
          showData = { id: Buffer.from(showKey).toString('base64url'), title: showName, libraryId: lib.id, libraryName: lib.name, mediaType: 'series', allowDownload: lib.allowDownload !== false, poster: relativePoster(findImage(showPath)), topFolder: folderMeta.topFolder, folderPath: folderMeta.folderPath, folderTree: folderMeta.folderTree, folderSegments: folderMeta.folderSegments, mediaFolder: folderMeta.mediaFolder, createdAt: new Date(8640000000000000).toISOString(), updatedAt: new Date(0).toISOString(), addedAt: new Date(0).toISOString(), seasons: {} };
          seriesMap.set(showKey, showData);
        }
        const info = parseSeriesEpisode(fileName); const st = safeStat(file);
        const seasonNumber = info?.season || inferSeasonFromPath(file) || 1; const episodeNumber = info?.episode || inferEpisodeFromName(fileName) || 1; const seasonKey = `S${String(seasonNumber).padStart(2,'0')}`;
        if (!showData.seasons[seasonKey]) showData.seasons[seasonKey] = [];
        if (!showData.seasons[seasonKey].some(ep => ep.path === file)) {
          showData.seasons[seasonKey].push({ id: Buffer.from(file).toString('base64url'), title: info?.title || normalizeName(fileName), season: seasonNumber, episode: episodeNumber, allowDownload: lib.allowDownload !== false, path: file, streamUrl: relativeMedia(file), createdAt: st?.birthtime?.toISOString?.() || st?.ctime?.toISOString?.() || st?.mtime?.toISOString?.() || new Date().toISOString(), updatedAt: st?.mtime?.toISOString?.() || new Date().toISOString(), addedAt: st?.mtime?.toISOString?.() || new Date().toISOString() });
          status.progress.discovered++;
        }
        const episodeCreated = st?.birthtime || st?.ctime || st?.mtime || 0;
        if (new Date(showData.addedAt) < new Date(st?.mtime || 0)) showData.addedAt = st.mtime.toISOString();
        if (new Date(showData.updatedAt) < new Date(st?.mtime || 0)) showData.updatedAt = st.mtime.toISOString();
        if (new Date(showData.createdAt) > new Date(episodeCreated || 0)) showData.createdAt = new Date(episodeCreated).toISOString();
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry.isDirectory()) continue;
      if (['@eaDir', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  for (const showData of seriesMap.values()) Object.keys(showData.seasons).forEach(k => showData.seasons[k].sort((a,b)=> (a.episode - b.episode) || a.title.localeCompare(b.title)));
  return [...seriesMap.values()];
}


async function scanAudioLibrary(lib, libPath) {
  const results = [];
  const stack = [{ dir: libPath, depth: 0 }];
  while (stack.length && !cancelled) {
    const { dir, depth } = stack.pop();
    const entries = await listDir(dir);
    status.progress.processedDirs++;
    if (status.progress.processedDirs % yieldEvery === 0) await yieldLoop();
    if (status.progress.processedDirs % statusEvery === 0) sendStatus({ message: `فحص ${status.progress.processedDirs} مجلد...` });
    const directAudioFiles = entries.filter(e => e.isFile() && isAudioFile(e.name)).map(e => path.join(dir, e.name));
    if (directAudioFiles.length) {
      for (const file of directAudioFiles) {
        const st = safeStat(file); const folderMeta = getFolderMeta(libPath, path.dirname(file), 'audio');
        const item = { id: Buffer.from(file).toString('base64url'), title: normalizeName(path.basename(file)), libraryId: lib.id, libraryName: lib.name, mediaType: 'audio', allowDownload: lib.allowDownload !== false, path: file, streamUrl: relativeMedia(file), poster: relativePoster(findImage(path.dirname(file))), topFolder: folderMeta.topFolder, folderPath: folderMeta.folderPath, folderTree: folderMeta.folderTree, folderSegments: folderMeta.folderSegments, mediaFolder: folderMeta.mediaFolder, createdAt: st?.birthtime?.toISOString?.() || st?.ctime?.toISOString?.() || st?.mtime?.toISOString?.() || new Date().toISOString(), updatedAt: st?.mtime?.toISOString?.() || new Date().toISOString(), addedAt: st?.mtime?.toISOString?.() || new Date().toISOString() };
        results.push(item); status.progress.discovered++;
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry.isDirectory()) continue;
      if (['@eaDir', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return results;
}

async function parseEpg(epgPath) {
  if (!epgPath) return {};
  let xml = '';
  try {
    const source = await readTextSource(epgPath);
    if (!source.ok || !source.text) return {};
    xml = source.text;
  } catch {
    return {};
  }
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });
  const progs = parsed?.tv?.programme;
  if (!progs) return {};
  const arr = Array.isArray(progs) ? progs : [progs];
  const now = new Date();
  const current = {};
  for (const p of arr) {
    const ch = p.channel;
    if (!ch || !p.start || !p.stop) continue;
    const start = parseXmltvDate(p.start); const stop = parseXmltvDate(p.stop);
    if (start <= now && stop >= now) current[ch] = { title: typeof p.title === 'string' ? p.title : (p.title?._ || ''), start: start.toISOString(), stop: stop.toISOString() };
  }
  return current;
}
function makeDirectM3uChannel(source, streamUrl, currentEpg = {}) {
  const url = String(streamUrl || '').trim();
  if (!url) return null;
  const requestHeaders = buildSourceM3uRequestHeaders(source, source.requestOptions || {});
  return {
    id: Buffer.from(source.id + ':' + url).toString('base64url'),
    sourceId: source.id,
    sourceName: source.name,
    sourceType: 'm3u',
    title: source.channelName || source.name || url,
    url,
    logo: source.logo || null,
    groupTitle: source.groupTitle || '',
    requestHeaders,
    userAgent: requestHeaders['User-Agent'] || '',
    referer: requestHeaders.Referer || '',
    nowPlaying: currentEpg[source.id] || null
  };
}
function loadChannelOverrides(db) {
  const rows = db.all('SELECT * FROM channel_overrides');
  return new Map(rows.map(row => [String(row.channel_id || ''), row]));
}
function loadChannelGroupOverrides(db) {
  const rows = db.all('SELECT * FROM channel_group_overrides');
  const exact = new Map();
  const global = new Map();
  for (const row of rows) {
    const sourceId = String(row.source_id || '').trim();
    const groupTitle = String(row.original_group_title || '').trim();
    const key = `${sourceId}\u0000${groupTitle}`;
    if (sourceId) exact.set(key, row);
    else global.set(groupTitle, row);
  }
  return { exact, global };
}
function getChannelGroupOverride(groupOverrides, channel = {}) {
  if (!groupOverrides) return null;
  const sourceId = String(channel.sourceId || '').trim();
  const groupTitle = String(channel.originalGroupTitle || channel.groupTitle || '').trim();
  return groupOverrides.exact.get(`${sourceId}\u0000${groupTitle}`) || groupOverrides.global.get(groupTitle) || null;
}
function applyChannelGroupOverride(channel = {}, override = null) {
  if (!channel || !override) return channel;
  const originalGroupTitle = channel.originalGroupTitle || channel.groupTitle || '';
  const title = String(override.title || '').trim();
  return {
    ...channel,
    originalGroupTitle,
    groupTitle: title || channel.groupTitle || '',
    groupHidden: !!Number(override.hidden || 0),
    hidden: !!Number(override.hidden || 0) || !!channel.hidden,
    groupOverrideUpdatedAt: override.updated_at || null
  };
}
const CHANNEL_STREAM_SETTING_KEYS = new Set([
  'relayMode', 'resolutionPreset', 'outputWidth', 'outputHeight', 'hlsTime', 'hlsListSize',
  'videoBitrate', 'maxRate', 'bufSize', 'audioBitrate', 'frameRate', 'hwAccel',
  'skipStartupProbe', 'userAgent', 'referer', 'requestHeaders', 'egressEnabled', 'egressType',
  'egressUrl', 'egressVideoMode', 'egressHwAccel', 'egressResolutionPreset',
  'egressOutputWidth', 'egressOutputHeight', 'egressVideoBitrate', 'egressMaxRate',
  'egressBufSize', 'egressAudioBitrate', 'egressFrameRate', 'egressLowLatency',
  'egressFifo', 'egressFifoQueue', 'egressHlsTime', 'egressHlsListSize'
]);
function parseChannelStreamSettings(value = null) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const settings = {};
  for (const [key, settingValue] of Object.entries(parsed)) {
    if (!CHANNEL_STREAM_SETTING_KEYS.has(key) || settingValue === undefined || settingValue === null) continue;
    if (key === 'requestHeaders') {
      if (settingValue && typeof settingValue === 'object' && !Array.isArray(settingValue)) settings[key] = settingValue;
      continue;
    }
    settings[key] = settingValue;
  }
  return settings;
}
function applyChannelOverride(channel = {}, override = null) {
  if (!channel || !override) return channel;
  const title = String(override.title || '').trim();
  const logo = String(override.logo || '').trim();
  const groupTitle = String(override.group_title || '').trim();
  const sortValue = override.sort_order === null || override.sort_order === undefined || override.sort_order === ''
    ? null
    : Number(override.sort_order);
  const streamSettings = parseChannelStreamSettings(override.stream_settings_json);
  return {
    ...channel,
    originalTitle: channel.originalTitle || channel.title || '',
    originalLogo: channel.originalLogo || channel.logo || '',
    originalGroupTitle: channel.originalGroupTitle || channel.groupTitle || '',
    title: title || channel.title,
    logo: logo || channel.logo || null,
    groupTitle: groupTitle || channel.groupTitle || '',
    hidden: !!channel.hidden || !!Number(override.hidden || 0),
    sortOrder: Number.isFinite(sortValue) ? sortValue : null,
    ...(Object.keys(streamSettings).length ? { streamSettings } : {}),
    overrideUpdatedAt: override.updated_at || null
  };
}
function parseM3uPlaylistChannels(source, playlistText = '', baseUrl = '', currentEpg = {}) {
  const channels = [];
  const lines = String(playlistText || '').split(/\r?\n/);
  let meta = null;
  let previousDirective = '';
  let requestOptions = {};
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      meta = line;
      previousDirective = line;
      requestOptions = {};
      continue;
    }
    if (/^#EXTVLCOPT:/i.test(line)) {
      requestOptions = parseM3uOptionLine(line, requestOptions);
      previousDirective = line;
      continue;
    }
    if (line.startsWith('#')) {
      previousDirective = line;
      continue;
    }
    const url = resolvePlaylistEntry(baseUrl, line);
    if (!url) continue;
    const titleFromMeta = extractExtinfName(meta);
    const hasIptvMetadata = !!(titleFromMeta || extractAttr(meta, 'tvg-id') || extractAttr(meta, 'tvg-name') || extractAttr(meta, 'group-title'));
    const isHlsVariant = /^#EXT-X-STREAM-INF/i.test(previousDirective || '');
    const isHlsSegment = isLikelyHlsMediaSegment(url) && (!hasIptvMetadata || isSegmentExtinf(meta));
    if (isHlsVariant || isHlsSegment) {
      meta = null;
      previousDirective = '';
      requestOptions = {};
      continue;
    }
    const title = titleFromMeta || extractAttr(meta, 'tvg-name') || source.channelName || source.name || line;
    const tvgId = extractAttr(meta, 'tvg-id');
    const logo = extractAttr(meta, 'tvg-logo');
    const groupTitle = extractAttr(meta, 'group-title') || source.groupTitle || '';
    const requestHeaders = buildSourceM3uRequestHeaders(source, requestOptions);
    channels.push({
      id: Buffer.from(source.id + ':' + url).toString('base64url'),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: 'm3u',
      title,
      url,
      logo: logo || source.logo || null,
      groupTitle,
      requestHeaders,
      userAgent: requestHeaders['User-Agent'] || '',
      referer: requestHeaders.Referer || '',
      nowPlaying: currentEpg[tvgId] || null
    });
    meta = null;
    previousDirective = '';
    requestOptions = {};
  }
  return channels;
}
async function scanChannels(sourceFilterId = '') {
  const channels = [];
  for (const source of (config.iptv?.sources || [])) {
    if (source.enabled === false) continue;
    if (sourceFilterId && String(source.id || '') !== String(sourceFilterId || '')) continue;
    if (source.sourceType === 'usb_capture') {
      channels.push({
        id: Buffer.from(source.id + ':' + (source.streamUrl || source.channelName || source.name)).toString('base64url'),
        sourceId: source.id,
        sourceName: source.name,
        sourceType: 'usb_capture',
        title: source.channelName || source.deviceName || source.name,
        url: source.streamUrl || '',
        logo: source.logo || null,
        groupTitle: source.groupTitle || '',
        nowPlaying: { title: source.description || 'USB Video Capture', deviceName: source.deviceName || '', ffmpegInput: source.ffmpegInput || '' },
        deviceName: source.deviceName || '',
        ffmpegInput: source.ffmpegInput || '',
        ffmpegCommand: source.ffmpegCommand || ''
      });
      continue;
    }
    if (source.sourceType !== 'm3u') continue;
    const currentEpg = await parseEpg(source.epgPath);
    const playlistLocation = String(source.m3uPath || source.streamUrl || source.inputUrl || '').trim();
    if (!playlistLocation) continue;
    try {
      if (source.m3uInputMode === 'direct_hls') {
        const direct = makeDirectM3uChannel(source, playlistLocation, currentEpg);
        if (direct) channels.push(direct);
        continue;
      }
      const loaded = await readTextSource(playlistLocation);
      if (!loaded.ok || !loaded.text) {
        const direct = isStreamInputUrl(playlistLocation) ? makeDirectM3uChannel(source, playlistLocation, currentEpg) : null;
        if (direct) channels.push(direct);
        continue;
      }
      const parsedChannels = parseM3uPlaylistChannels(source, loaded.text, loaded.finalUrl || playlistLocation, currentEpg);
      if (parsedChannels.length) channels.push(...parsedChannels);
      else if (isHlsPlaylistText(loaded.text)) {
        const direct = makeDirectM3uChannel(source, loaded.finalUrl || playlistLocation, currentEpg);
        if (direct) channels.push(direct);
      }
      else if (isStreamInputUrl(playlistLocation)) {
        const direct = makeDirectM3uChannel(source, loaded.finalUrl || playlistLocation, currentEpg);
        if (direct) channels.push(direct);
      }
    } catch {
      status.progress.errors++;
      const direct = isStreamInputUrl(playlistLocation) ? makeDirectM3uChannel(source, playlistLocation, currentEpg) : null;
      if (direct) channels.push(direct);
    }
  }
  return channels;
}

(async () => {
  const runtimeDb = await openRuntimeDb(rootDir);
  const mediaDb = await openMediaDb(rootDir);
  const configRow = runtimeDb.get('SELECT value FROM meta WHERE key = ? LIMIT 1', ['app_config']);
  if (configRow?.value) config = normalizeConfig(parseMaybeJson(configRow.value, {}));
  else config = normalizeConfig(readJson(configPath, {}));
  yieldEvery = Number(config.scan?.yieldEvery || 200);
  statusEvery = Number(config.scan?.statusUpdateEvery || 100);
  const sourceFilterId = String(options.sourceId || '').trim();
  const channelsOnly = options.channelsOnly === true || !!sourceFilterId;
  const libs = channelsOnly ? [] : (options.libraryId ? (config.libraries || []).filter(x => x.id === options.libraryId) : (config.libraries || []));
  if (!options.libraryId && !channelsOnly) cleanupMissingLibraries(mediaDb, libs);
  status.stage = channelsOnly ? 'scanning-channels' : (options.libraryId ? 'scanning-library' : 'scanning-all');
  status.message = channelsOnly
    ? `جاري تحديث قنوات ${options.libraryName || sourceFilterId || 'مصدر محدد'} في الخلفية`
    : (options.libraryId ? `جاري تحديث ${options.libraryName || options.libraryId}` : 'جاري تحديث الفهرس الكامل');
  sendStatus();

  const activeLibraries = new Map();
  let completedLibraries = 0;
  let failedLibraries = 0;
  const scanLibraryTask = async (lib) => {
    if (cancelled) return null;
    activeLibraries.set(lib.id, lib.name);
    status.libraryId = activeLibraries.size === 1 ? lib.id : null;
    status.libraryName = activeLibraries.size === 1 ? lib.name : `${activeLibraries.size} مكتبات`;
    status.message = activeLibraries.size > 1
      ? `جاري فحص ${activeLibraries.size} مكتبات بالتوازي...`
      : `جاري فحص المكتبة: ${lib.name}`;
    sendStatus();
    try {
      let libMovies = [];
      let libSeries = [];
      let libAudios = [];
      for (const libPath of (lib.paths || [])) {
        if (cancelled) return null;
        if (!fs.existsSync(libPath)) {
          status.progress.errors++;
          continue;
        }
        if (lib.type === 'movies' || lib.type === 'mixed') libMovies.push(...(await scanMovieLibrary(lib, libPath)));
        if (lib.type === 'series') libSeries.push(...(await scanSeriesLibrary(lib, libPath)));
        if (lib.type === 'audio' || lib.type === 'mixed') libAudios.push(...(await scanAudioLibrary(lib, libPath)));
        const partial = persistLibraryScanResults(mediaDb, lib, libMovies, libSeries, libAudios);
        sendStatus({
          message: `تم حفظ نتائج ${lib.name} أثناء الفحص • ${partial.itemCount} عنصر`
        });
      }
      const finalPersist = persistLibraryScanResults(mediaDb, lib, libMovies, libSeries, libAudios);
      completedLibraries += 1;
      status.progress.percent = Math.round((completedLibraries / Math.max(1, libs.length)) * 100);
      sendStatus({
        message: `اكتمل تحديث ${lib.name} وحفظ ${finalPersist.itemCount} عنصرًا.`
      });
      return { ok: true, libraryId: lib.id, itemCount: finalPersist.itemCount };
    } catch (error) {
      failedLibraries += 1;
      status.progress.errors++;
      sendStatus({
        message: `فشل فحص ${lib.name} • ${String(error?.message || 'خطأ غير معروف')}`
      });
      return { ok: false, libraryId: lib.id, error: error?.message || 'scan failed' };
    } finally {
      activeLibraries.delete(lib.id);
      if (activeLibraries.size > 1) {
        status.libraryId = null;
        status.libraryName = `${activeLibraries.size} مكتبات`;
      } else if (activeLibraries.size === 1) {
        const [nextId, nextName] = [...activeLibraries.entries()][0];
        status.libraryId = nextId;
        status.libraryName = nextName;
      } else {
        status.libraryId = null;
        status.libraryName = null;
      }
    }
  };
  if (libs.length) await Promise.all(libs.map(lib => scanLibraryTask(lib)));

  if (cancelled) {
    const payload = { running: false, stage: 'cancelled', endedAt: new Date().toISOString(), message: 'تم إلغاء الفحص.', progress: status.progress };
    sendStatus(payload);
    if (process.send) process.send({ type: 'error', payload: { message: 'تم إلغاء الفحص.', progress: status.progress } });
    process.exit(1);
  }

  const channelOverrides = loadChannelOverrides(mediaDb);
  const channelGroupOverrides = loadChannelGroupOverrides(mediaDb);
  const channels = (await scanChannels(sourceFilterId)).map(channel => {
    const withGroupOverride = applyChannelGroupOverride(channel, getChannelGroupOverride(channelGroupOverrides, channel));
    return applyChannelOverride(withGroupOverride, channelOverrides.get(channel.id));
  });
  const generatedAt = new Date().toISOString();

  mediaDb.transaction(() => {
    if (sourceFilterId) mediaDb.run('DELETE FROM channels WHERE source_id = ?', [sourceFilterId]);
    else mediaDb.run('DELETE FROM channels');
    const insertChannel = mediaDb.db.prepare('INSERT OR REPLACE INTO channels(id, source_id, source_name, title, logo, url, now_playing_json, group_title, hidden, sort_order, raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    try { for (const ch of channels) insertChannel.run([ch.id, ch.sourceId || null, ch.sourceName || null, ch.title || null, ch.logo || null, ch.url || null, JSON.stringify(ch.nowPlaying || null), ch.groupTitle || null, ch.hidden ? 1 : 0, Number.isFinite(Number(ch.sortOrder)) ? Number(ch.sortOrder) : null, JSON.stringify(ch)]); }
    finally { insertChannel.free(); }
    mediaDb.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', ['generatedAt', generatedAt]);
  });
  mediaDb.save();

  const doneMessage = failedLibraries
    ? `${options.libraryId ? 'اكتمل تحديث المكتبة' : 'اكتمل الفحص الكامل'} مع فشل ${failedLibraries} مكتبة.`
    : (channelsOnly ? 'اكتمل تحديث قنوات المصدر.' : (options.libraryId ? 'اكتمل تحديث المكتبة.' : 'اكتمل الفحص الكامل.'));
  const donePayload = { running: false, stage: 'done', endedAt: new Date().toISOString(), message: doneMessage, progress: { ...status.progress, percent: 100 } };
  sendStatus(donePayload);
  if (process.send) process.send({ type:'done', payload:{ message: doneMessage, progress: { ...status.progress, percent: 100 } } });
  process.exit(0);
})().catch(err => {
  const payload = { running: false, stage: 'error', endedAt: new Date().toISOString(), message: err?.stack || err?.message || 'فشل الفحص.', progress: status.progress };
  try { saveScanStatus(payload); } catch {}
  if (process.send) process.send({ type:'error', payload });
  process.exit(1);
});
