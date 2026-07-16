
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const { Readable } = require('stream');
const { fork, spawn, spawnSync } = require('child_process');
const { openAppDb, openMediaDb, openRuntimeDb, sqliteErrorLooksRecoverable } = require('./db');
const {
  DEFAULT_YACINE_SOURCE_ID,
  DEFAULT_OUTPUT_FILE: DEFAULT_YACINE_OUTPUT_FILE,
  DEFAULT_STATUS_FILE: DEFAULT_YACINE_STATUS_FILE,
  refreshYacineTvPlaylist
} = require('./yacine-tv-refresh');
let NodeMediaServer = null;
try {
  NodeMediaServer = require('node-media-server');
} catch (error) {
  console.warn(`[rtmp] node-media-server غير متاح: ${error.message}`);
}

const app = express();
const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const configPath = path.join(rootDir, 'config.json');
const scanStatusPath = path.join(rootDir, 'data', 'scan-status.json');
const liveStreamsDir = path.join(rootDir, 'data', 'live-streams');
const channelRelaysDir = path.join(rootDir, 'data', 'channel-relays');
const transcodesDir = path.join(rootDir, 'data', 'transcodes');
const USB_READY_TIMEOUT_MS = 20000;
const USB_READY_POLL_MS = 250;
const USB_RESTART_DELAY_MS = 1500;
const USB_HEALTH_GRACE_MS = 15000;
const USB_PLAYLIST_STALE_MS = 45000;
const USB_WATCHDOG_INTERVAL_MS = 5000;
const DEFAULT_RTMP_INGEST_SOURCE_ID = 'rtmp-ingest-main';
const DEFAULT_RTMP_INGEST_APP = 'live';
const DEFAULT_RTMP_INGEST_PORT = 1936;

let rtmpIngestServer = null;
const rtmpIngestState = {
  enabled: false,
  running: false,
  error: '',
  startedAt: null,
  bind: '0.0.0.0',
  port: DEFAULT_RTMP_INGEST_PORT,
  appName: DEFAULT_RTMP_INGEST_APP,
  streamKey: DEFAULT_RTMP_INGEST_SOURCE_ID,
  publishUrl: '',
  activeStreams: new Set()
};

app.use(express.json({ limit: '4mb' }));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
}
function defaultScanStatus() {
  return { running: false, stage: 'idle', libraryId: null, libraryName: null, startedAt: null, endedAt: null, message: '', progress: { percent: 0, processedDirs: 0, discovered: 0, errors: 0 } };
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
const MANAGED_NETWORK_SOURCE_TYPES = ['rtmp', 'srt', 'rtsp', 'hls', 'udp', 'rtp', 'mpegts_file', 'network_push', 'resi_modulator'];
const LIVE_SOURCE_TYPES = ['usb_capture', ...MANAGED_NETWORK_SOURCE_TYPES, 'webrtc'];
const LIVE_EGRESS_TYPES = ['srt', 'udp', 'rtp', 'mpegts_file', 'hls', 'rtmp'];
const LIVE_EGRESS_VIDEO_MODES = ['same', 'copy', 'transcode'];
const CHANNEL_RELAY_MODES = ['auto', 'copy', 'transcode'];
const CHANNEL_STREAM_SETTING_KEYS = new Set([
  'relayMode', 'resolutionPreset', 'outputWidth', 'outputHeight', 'hlsTime', 'hlsListSize',
  'videoBitrate', 'maxRate', 'bufSize', 'audioBitrate', 'frameRate', 'hwAccel',
  'skipStartupProbe', 'userAgent', 'referer', 'requestHeaders', 'egressEnabled', 'egressType',
  'egressUrl', 'egressVideoMode', 'egressHwAccel', 'egressResolutionPreset',
  'egressOutputWidth', 'egressOutputHeight', 'egressVideoBitrate', 'egressMaxRate',
  'egressBufSize', 'egressAudioBitrate', 'egressFrameRate', 'egressLowLatency',
  'egressFifo', 'egressFifoQueue', 'egressHlsTime', 'egressHlsListSize'
]);
const CHANNEL_STREAM_BOOLEAN_KEYS = new Set(['skipStartupProbe', 'egressEnabled', 'egressLowLatency', 'egressFifo']);
const CHANNEL_STREAM_NUMBER_KEYS = new Set([
  'outputWidth', 'outputHeight', 'hlsTime', 'hlsListSize', 'frameRate', 'egressOutputWidth',
  'egressOutputHeight', 'egressFrameRate', 'egressFifoQueue', 'egressHlsTime', 'egressHlsListSize'
]);
function isManagedNetworkSourceType(sourceType = '') {
  return MANAGED_NETWORK_SOURCE_TYPES.includes(String(sourceType || '').trim().toLowerCase());
}
function isStreamInputUrl(value = '') {
  return /^(rtmp|srt|rtsp|udp|rtp|http|https|file):\/\//i.test(String(value || '').trim());
}
function isLocalLivePlaybackUrl(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  return normalized.startsWith('/live-streams/') || normalized.includes('/live-streams/');
}
function normalizeManagedSourceUrls(src = {}, sourceType = 'm3u') {
  const rawStreamUrl = String(src.streamUrl || src.url || '').trim();
  const rawInputUrl = String(src.inputUrl || '').trim();
  if (!isManagedNetworkSourceType(sourceType)) {
    return { inputUrl: rawInputUrl, streamUrl: rawStreamUrl };
  }
  const inferredInputUrl = rawInputUrl || ((isStreamInputUrl(rawStreamUrl) && !isLocalLivePlaybackUrl(rawStreamUrl)) ? rawStreamUrl : '');
  const normalizedStreamUrl = (!rawInputUrl && inferredInputUrl && rawStreamUrl === inferredInputUrl)
    ? ''
    : rawStreamUrl;
  return {
    inputUrl: inferredInputUrl,
    streamUrl: normalizedStreamUrl
  };
}
function sanitizeRtmpName(value = '', fallback = 'stream') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}
function normalizeRtmpServerConfig(value = {}) {
  const cfg = value && typeof value === 'object' ? value : {};
  const rawPort = Number(cfg.port || DEFAULT_RTMP_INGEST_PORT);
  const rawHttpPort = Number(cfg.httpPort || 8088);
  return {
    enabled: cfg.enabled !== false,
    host: String(cfg.host || '0.0.0.0').trim() || '0.0.0.0',
    port: Math.max(1, Math.min(65535, Number.isFinite(rawPort) ? rawPort : DEFAULT_RTMP_INGEST_PORT)),
    appName: sanitizeRtmpName(cfg.appName || DEFAULT_RTMP_INGEST_APP, DEFAULT_RTMP_INGEST_APP),
    streamKey: sanitizeRtmpName(cfg.streamKey || DEFAULT_RTMP_INGEST_SOURCE_ID, DEFAULT_RTMP_INGEST_SOURCE_ID),
    publicHost: String(cfg.publicHost || '').trim(),
    httpEnabled: cfg.httpEnabled === true,
    httpPort: Math.max(1, Math.min(65535, Number.isFinite(rawHttpPort) ? rawHttpPort : 8088))
  };
}
function normalizeYacineTvConfig(value = {}) {
  const cfg = value && typeof value === 'object' ? value : {};
  const rawIntervalHours = Number(cfg.refreshIntervalHours);
  return {
    enabled: cfg.enabled === true,
    refreshOnStartup: cfg.refreshOnStartup !== false,
    scanAfterRefresh: cfg.scanAfterRefresh !== false,
    refreshIntervalHours: Math.max(0, Math.min(24, Number.isFinite(rawIntervalHours) ? rawIntervalHours : 2))
  };
}
function buildDefaultYacineTvSource() {
  return {
    id: DEFAULT_YACINE_SOURCE_ID,
    name: 'Yacine TV Auto',
    sourceType: 'm3u',
    m3uPath: DEFAULT_YACINE_OUTPUT_FILE,
    groupTitle: 'Yacine TV',
    channelName: 'Yacine TV Auto',
    autoStart: true,
    showOnHome: true,
    logo: '',
    description: 'Auto-refreshed Yacine TV playlist'
  };
}
function syncYacineTvSource(cfg = {}) {
  cfg.iptv = cfg.iptv || { sources: [] };
  if (!Array.isArray(cfg.iptv.sources)) cfg.iptv.sources = [];
  const existingIndex = cfg.iptv.sources.findIndex(source => String(source?.id || '') === DEFAULT_YACINE_SOURCE_ID);
  if (!cfg.yacineTv?.enabled) {
    if (existingIndex >= 0) {
      const existing = cfg.iptv.sources[existingIndex] || {};
      cfg.iptv.sources[existingIndex] = normalizeSource({
        ...existing,
        id: DEFAULT_YACINE_SOURCE_ID,
        sourceType: 'm3u',
        autoStart: false,
        showOnHome: false
      }, existingIndex);
    }
    return cfg;
  }
  const defaultSource = buildDefaultYacineTvSource();
  if (existingIndex < 0) {
    cfg.iptv.sources.push(normalizeSource(defaultSource, cfg.iptv.sources.length));
    return cfg;
  }
  const existing = cfg.iptv.sources[existingIndex] || {};
  cfg.iptv.sources[existingIndex] = normalizeSource({
    ...defaultSource,
    ...existing,
    id: DEFAULT_YACINE_SOURCE_ID,
    sourceType: 'm3u',
    m3uPath: existing.m3uPath || DEFAULT_YACINE_OUTPUT_FILE,
    autoStart: true,
    showOnHome: true
  }, existingIndex);
  return cfg;
}
function buildRtmpIngestInputUrl(rtmpConfig = {}, streamKey = '') {
  const cfg = normalizeRtmpServerConfig(rtmpConfig);
  const key = sanitizeRtmpName(streamKey || cfg.streamKey || DEFAULT_RTMP_INGEST_SOURCE_ID, DEFAULT_RTMP_INGEST_SOURCE_ID);
  return `rtmp://127.0.0.1:${cfg.port}/${cfg.appName}/${key}`;
}
function ensureDefaultRtmpIngestSource(cfg = {}) {
  if (!cfg.rtmpServer?.enabled) return cfg;
  cfg.iptv = cfg.iptv || { sources: [] };
  if (!Array.isArray(cfg.iptv.sources)) cfg.iptv.sources = [];
  const streamKey = sanitizeRtmpName(cfg.rtmpServer.streamKey || DEFAULT_RTMP_INGEST_SOURCE_ID, DEFAULT_RTMP_INGEST_SOURCE_ID);
  const inputUrl = buildRtmpIngestInputUrl(cfg.rtmpServer, streamKey);
  const defaultSource = {
    id: DEFAULT_RTMP_INGEST_SOURCE_ID,
    name: 'استقبال RTMP داخلي',
    sourceType: 'rtmp',
    groupTitle: 'بث مباشر',
    channelName: 'استقبال RTMP داخلي',
    deliveryMode: 'hls',
    inputUrl,
    streamUrl: '',
    rtmpIngest: true,
    rtmpStreamKey: streamKey,
    autoStart: false,
    showOnHome: true,
    resolutionPreset: 'source',
    hlsTime: 2,
    hlsListSize: 6,
    videoBitrate: '1800k',
    maxRate: '2200k',
    bufSize: '4000k',
    audioBitrate: '96k',
    frameRate: 25,
    hwAccel: 'auto'
  };
  const existingIndex = cfg.iptv.sources.findIndex(source => source?.id === DEFAULT_RTMP_INGEST_SOURCE_ID);
  if (existingIndex < 0) {
    cfg.iptv.sources.unshift(normalizeSource(defaultSource, 0));
    return cfg;
  }
  const existing = cfg.iptv.sources[existingIndex] || {};
  cfg.iptv.sources[existingIndex] = normalizeSource({
    ...defaultSource,
    ...existing,
    id: existing.id || DEFAULT_RTMP_INGEST_SOURCE_ID,
    sourceType: 'rtmp',
    deliveryMode: 'hls',
    inputUrl,
    rtmpIngest: true,
    rtmpStreamKey: streamKey,
    autoStart: false
  }, existingIndex);
  return cfg;
}
function syncRtmpIngestSources(cfg = {}) {
  const sources = Array.isArray(cfg.iptv?.sources) ? cfg.iptv.sources : [];
  cfg.iptv.sources = sources.map((source, index) => {
    if (String(source?.sourceType || '').trim().toLowerCase() !== 'rtmp' || source?.rtmpIngest !== true) {
      return source;
    }
    const streamKey = sanitizeRtmpName(source.rtmpStreamKey || source.id || cfg.rtmpServer?.streamKey || DEFAULT_RTMP_INGEST_SOURCE_ID, DEFAULT_RTMP_INGEST_SOURCE_ID);
    return normalizeSource({
      ...source,
      sourceType: 'rtmp',
      deliveryMode: 'hls',
      rtmpIngest: true,
      rtmpStreamKey: streamKey,
      inputUrl: buildRtmpIngestInputUrl(cfg.rtmpServer, streamKey),
      autoStart: false
    }, index);
  });
  return cfg;
}
function normalizeSource(src = {}, index = 0) {
  const rawSourceType = String(src.sourceType || '').trim().toLowerCase();
  const sourceType = rawSourceType === 'm3u' || LIVE_SOURCE_TYPES.includes(rawSourceType) ? rawSourceType : 'm3u';
  const normalizedUrls = normalizeManagedSourceUrls(src, sourceType);
  const rawEgressType = String(src.egressType || src.outputProtocol || src.outputType || '').trim().toLowerCase();
  const rawEgressVideoMode = String(src.egressVideoMode || '').trim().toLowerCase();
  const rawRelayMode = String(src.relayMode || 'auto').trim().toLowerCase();
  const rawM3uInputMode = String(src.m3uInputMode || 'auto').trim().toLowerCase();
  return {
    id: String(src.id || `source-${index + 1}`),
    name: String(src.name || `مصدر ${index + 1}`),
    sourceType,
    m3uPath: String(src.m3uPath || ''),
    epgPath: String(src.epgPath || ''),
    m3uInputMode: ['auto', 'playlist', 'direct_hls'].includes(rawM3uInputMode) ? rawM3uInputMode : 'auto',
    groupTitle: String(src.groupTitle || src.group_title || src.category || ''),
    channelName: String(src.channelName || src.name || `Channel ${index + 1}`),
    deviceName: String(src.deviceName || ''),
    audioDeviceName: String(src.audioDeviceName || ''),
    deliveryMode: src.deliveryMode === 'webrtc' ? 'webrtc' : 'hls',
    streamUrl: normalizedUrls.streamUrl,
    inputUrl: normalizedUrls.inputUrl,
    webrtcEmbedUrl: String(src.webrtcEmbedUrl || ''),
    logo: String(src.logo || ''),
    description: String(src.description || ''),
    requestHeaders: normalizeHttpRequestHeaders(src.requestHeaders || src.headers || {}),
    userAgent: String(src.userAgent || src.user_agent || ''),
    referer: String(src.referer || src.referrer || ''),
    enabled: src.enabled !== false,
    autoStart: src.autoStart !== false,
    showOnHome: src.showOnHome !== false,
    resolutionPreset: String(src.resolutionPreset || 'source'),
    outputWidth: Math.max(0, Number(src.outputWidth || 0)),
    outputHeight: Math.max(0, Number(src.outputHeight || 0)),
    hlsTime: Math.max(1, Number(src.hlsTime || 0)),
    hlsListSize: Math.max(0, Number(src.hlsListSize || 0)),
    videoBitrate: String(src.videoBitrate || ''),
    maxRate: String(src.maxRate || ''),
    bufSize: String(src.bufSize || ''),
    audioBitrate: String(src.audioBitrate || ''),
    frameRate: Math.max(0, Number(src.frameRate || 0)),
    hwAccel: String(src.hwAccel || 'auto'),
    relayMode: CHANNEL_RELAY_MODES.includes(rawRelayMode) ? rawRelayMode : 'auto',
    ffmpegPath: String(src.ffmpegPath || ''),
    ffmpegInput: String(src.ffmpegInput || ''),
    ffmpegCommand: String(src.ffmpegCommand || ''),
    rtmpIngest: src.rtmpIngest === true,
    rtmpStreamKey: String(src.rtmpStreamKey || ''),
    skipStartupProbe: src.skipStartupProbe === false ? false : true,
    egressEnabled: src.egressEnabled === true || src.outputEnabled === true,
    egressType: LIVE_EGRESS_TYPES.includes(rawEgressType) ? rawEgressType : 'srt',
    egressUrl: String(src.egressUrl || src.outputUrl || ''),
    egressVideoMode: LIVE_EGRESS_VIDEO_MODES.includes(rawEgressVideoMode) ? rawEgressVideoMode : 'same',
    egressHwAccel: String(src.egressHwAccel || 'same'),
    egressResolutionPreset: String(src.egressResolutionPreset || 'same'),
    egressOutputWidth: Math.max(0, Number(src.egressOutputWidth || 0)),
    egressOutputHeight: Math.max(0, Number(src.egressOutputHeight || 0)),
    egressVideoBitrate: String(src.egressVideoBitrate || ''),
    egressMaxRate: String(src.egressMaxRate || ''),
    egressBufSize: String(src.egressBufSize || ''),
    egressAudioBitrate: String(src.egressAudioBitrate || ''),
    egressFrameRate: Math.max(0, Number(src.egressFrameRate || 0)),
    egressLowLatency: src.egressLowLatency !== false,
    egressFifo: src.egressFifo !== false,
    egressFifoQueue: Math.max(60, Number(src.egressFifoQueue || 600)),
    egressHlsTime: Math.max(0, Number(src.egressHlsTime || 0)),
    egressHlsListSize: Math.max(0, Number(src.egressHlsListSize || 0))
  };
}
function normalizeUsbCaptureConfig(value = {}) {
  const cfg = value && typeof value === 'object' ? value : {};
  return {
    ffmpegPath: String(cfg.ffmpegPath || ''),
    outputRoot: String(cfg.outputRoot || ''),
    publicBaseUrl: String(cfg.publicBaseUrl || ''),
    publicBasePath: String(cfg.publicBasePath || ''),
    hlsTime: Math.max(1, Number(cfg.hlsTime || 2)),
    hlsListSize: Math.max(3, Number(cfg.hlsListSize || 6)),
    resolutionPreset: String(cfg.resolutionPreset || 'source'),
    outputWidth: Math.max(0, Number(cfg.outputWidth || 0)),
    outputHeight: Math.max(0, Number(cfg.outputHeight || 0)),
    videoBitrate: String(cfg.videoBitrate || '2500k'),
    maxRate: String(cfg.maxRate || cfg.videoBitrate || '2500k'),
    bufSize: String(cfg.bufSize || '3500k'),
    audioBitrate: String(cfg.audioBitrate || '96k'),
    frameRate: Math.max(24, Number(cfg.frameRate || 25)),
    hwAccel: String(cfg.hwAccel || 'auto')
  };
}
function normalizeMediaTranscodeConfig(value = {}) {
  const cfg = value && typeof value === 'object' ? value : {};
  const qualityProfile = String(cfg.qualityProfile || 'balanced').trim().toLowerCase();
  return {
    hwAccel: String(cfg.hwAccel || 'auto').trim().toLowerCase(),
    qualityProfile: ['mobile', 'balanced', 'high'].includes(qualityProfile) ? qualityProfile : 'balanced',
    audioBitrate: String(cfg.audioBitrate || '160k'),
    hlsTime: Math.max(2, Number(cfg.hlsTime || 4)),
    hlsListSize: Math.max(6, Number(cfg.hlsListSize || 10))
  };
}
function normalizeBandwidthConfig(value = {}) {
  const cfg = value && typeof value === 'object' ? value : {};
  const rawLimit = cfg.limitKBps ?? cfg.limitKbps ?? 0;
  return {
    enabled: !!cfg.enabled,
    limitKBps: Math.max(0, Number(rawLimit || 0)),
    burstSeconds: Math.max(1, Math.min(20, Number(cfg.burstSeconds || 3))),
    applyToMedia: cfg.applyToMedia !== false,
    applyToLive: cfg.applyToLive !== false,
    applyToTranscode: cfg.applyToTranscode !== false
  };
}
function normalizeFootballConfig(value = {}) {
  const cfg = value && typeof value === 'object' ? value : {};
  const defaultFeeds = [
    { name: 'Google News Arabic Football', url: 'https://news.google.com/rss/search?q=%D9%83%D8%B1%D8%A9%20%D8%A7%D9%84%D9%82%D8%AF%D9%85&hl=ar&gl=SA&ceid=SA:ar' },
    { name: 'Google News Arabic World Cup', url: 'https://news.google.com/rss/search?q=%D9%83%D8%A3%D8%B3%20%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85%202026&hl=ar&gl=SA&ceid=SA:ar' },
    { name: 'BBC Sport Football', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
    { name: 'ESPN Soccer', url: 'https://www.espn.com/espn/rss/soccer/news' }
  ];
  const defaultProfiles = [
    { type: 'club', name: 'Real Madrid CF' },
    { type: 'club', name: 'FC Barcelona' },
    { type: 'club', name: 'Manchester City F.C.' },
    { type: 'club', name: 'Liverpool F.C.' },
    { type: 'club', name: 'Paris Saint-Germain F.C.' },
    { type: 'club', name: 'FC Bayern Munich' },
    { type: 'player', name: 'Lionel Messi' },
    { type: 'player', name: 'Cristiano Ronaldo' },
    { type: 'player', name: 'Kylian Mbappe' },
    { type: 'player', name: 'Erling Haaland' }
  ];
  const configuredFeeds = Array.isArray(cfg.newsFeeds) && cfg.newsFeeds.length ? cfg.newsFeeds : defaultFeeds;
  const feedMap = new Map();
  for (const feed of [...defaultFeeds, ...configuredFeeds]) {
    const url = String(feed?.url || '').trim();
    if (url.toLowerCase() === 'https://feeds.bbci.co.uk/arabic/sports/rss.xml') continue;
    if (!/^https?:\/\//i.test(url) || feedMap.has(url.toLowerCase())) continue;
    feedMap.set(url.toLowerCase(), { name: String(feed?.name || 'Football Feed').trim(), url });
  }
  const feeds = [...feedMap.values()];
  const profiles = Array.isArray(cfg.trackedProfiles) ? cfg.trackedProfiles : defaultProfiles;
  return {
    autoImport: cfg.autoImport !== false,
    importOnStartup: cfg.importOnStartup !== false,
    intervalHours: Math.max(1, Math.min(48, Number(cfg.intervalHours || 6))),
    maxNewsItems: Math.max(10, Math.min(250, Number(cfg.maxNewsItems || 80))),
    newsFeeds: feeds.map(feed => ({
      name: String(feed?.name || 'Football Feed').trim(),
      url: String(feed?.url || '').trim()
    })).filter(feed => /^https?:\/\//i.test(feed.url)).slice(0, 12),
    trackedProfiles: profiles.map(profile => ({
      type: String(profile?.type || 'club').toLowerCase() === 'player' ? 'player' : 'club',
      name: String(profile?.name || '').trim(),
      title: String(profile?.title || '').trim()
    })).filter(profile => profile.name).slice(0, 80),
    lastImportAt: cfg.lastImportAt || null,
    lastImportSummary: cfg.lastImportSummary || null
  };
}
function normalizeScanConfig(value = {}) {
  const cfg = value && typeof value === 'object' ? value : {};
  const defaultTimes = ['06:00', '18:00'];
  const scheduleTimes = Array.isArray(cfg.scheduleTimes) ? cfg.scheduleTimes : defaultTimes;
  const normalizedTimes = [...new Set(scheduleTimes
    .map(time => String(time || '').trim())
    .filter(time => /^\d{2}:\d{2}$/.test(time))
    .map(time => {
      const [h, m] = time.split(':').map(Number);
      const hours = Math.max(0, Math.min(23, Number.isFinite(h) ? h : 0));
      const minutes = Math.max(0, Math.min(59, Number.isFinite(m) ? m : 0));
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }))];
  return {
    autoStartOnEmptyIndex: cfg.autoStartOnEmptyIndex !== false,
    yieldEvery: Math.max(50, Number(cfg.yieldEvery || 200)),
    statusUpdateEvery: Math.max(10, Number(cfg.statusUpdateEvery || 100)),
    followSymlinks: !!cfg.followSymlinks,
    autoDailyTwice: cfg.autoDailyTwice !== false,
    scheduleTimes: normalizedTimes.length ? normalizedTimes.slice(0, 4) : defaultTimes,
    lastScheduledRuns: (cfg.lastScheduledRuns && typeof cfg.lastScheduledRuns === 'object') ? cfg.lastScheduledRuns : {}
  };
}
function normalizeConfig(cfg = {}) {
  cfg.server = { port: 8050, host: '0.0.0.0', sessionSecret: 'change-me-now', publicBaseUrl: '', ...(cfg.server || {}) };
  cfg.performance = { pageSize: 48, newestLimit: 24, ...(cfg.performance || {}) };
  cfg.system = { name: 'STARSNET', iconText: '⭐', logoUrl: '', homeMessage: 'مرحبا بكم في الاستراحة الخاصة بنا', webrtcPublisherAutoStart: false, setupProfile: 'recommended', ...(cfg.system || {}) };
  cfg.auth = { allowSelfRegistration: false, requireLoginForViewing: false, autoRegisterDevices: true, ...(cfg.auth || {}) };
  cfg.admin = { username: 'admin', password: 'admin123', ...(cfg.admin || {}) };
  cfg.scan = normalizeScanConfig(cfg.scan || {});
  cfg.usbCapture = normalizeUsbCaptureConfig(cfg.usbCapture || {});
  cfg.rtmpServer = normalizeRtmpServerConfig(cfg.rtmpServer || {});
  cfg.yacineTv = normalizeYacineTvConfig(cfg.yacineTv || {});
  cfg.mediaTranscode = normalizeMediaTranscodeConfig(cfg.mediaTranscode || {});
  cfg.bandwidth = normalizeBandwidthConfig(cfg.bandwidth || {});
  cfg.football = normalizeFootballConfig(cfg.football || {});
  cfg.libraries = Array.isArray(cfg.libraries) ? cfg.libraries.map(normalizeLibrary) : [];
  cfg.iptv = cfg.iptv || { sources: [] };
  if (!Array.isArray(cfg.iptv.sources)) cfg.iptv.sources = [];
  cfg.iptv.sources = cfg.iptv.sources.map(normalizeSource);
  cfg.iptv.disableGroups = cfg.iptv.disableGroups === true;
  cfg.iptv.keepRelaysAlive = cfg.iptv.keepRelaysAlive === true;
  cfg.iptv.disabledGroups = Array.isArray(cfg.iptv.disabledGroups) ? cfg.iptv.disabledGroups.map(x => String(x || '').trim()) : [];
  ensureDefaultRtmpIngestSource(cfg);
  syncRtmpIngestSources(cfg);
  syncYacineTvSource(cfg);
  return cfg;
}
function ensureConfig() {
  if (!fs.existsSync(configPath)) fs.copyFileSync(path.join(rootDir, 'config.example.json'), configPath);
  const cfg = normalizeConfig(readJson(configPath, {}));
  writeJson(configPath, cfg);
  return cfg;
}
let config = ensureConfig();

const bandwidthBuckets = new Map();
const BANDWIDTH_BUCKET_TTL_MS = 10 * 60 * 1000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function getClientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}
function getBandwidthClientKey(req) {
  if (req.user?.id) return `user:${req.user.id}`;
  return `ip:${getClientAddress(req)}`;
}
function refillBandwidthBucket(bucket) {
  const now = Date.now();
  const elapsed = Math.max(0, now - bucket.lastRefill) / 1000;
  bucket.lastRefill = now;
  bucket.updatedAt = now;
  bucket.tokens = Math.min(bucket.burstBytes, bucket.tokens + (elapsed * bucket.rateBytesPerSecond));
}
function getBandwidthBucket(key, bandwidthConfig) {
  const rateBytesPerSecond = Math.max(1024, Number(bandwidthConfig.limitKBps || 0) * 1024);
  const burstBytes = Math.max(rateBytesPerSecond, rateBytesPerSecond * Math.max(1, Number(bandwidthConfig.burstSeconds || 3)));
  let bucket = bandwidthBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: burstBytes, rateBytesPerSecond, burstBytes, lastRefill: Date.now(), updatedAt: Date.now() };
    bandwidthBuckets.set(key, bucket);
    return bucket;
  }
  refillBandwidthBucket(bucket);
  bucket.rateBytesPerSecond = rateBytesPerSecond;
  bucket.burstBytes = burstBytes;
  bucket.tokens = Math.min(bucket.tokens, bucket.burstBytes);
  bucket.updatedAt = Date.now();
  return bucket;
}
async function waitForBandwidthTokens(bucket, byteCount) {
  if (!byteCount || byteCount <= 0 || !bucket?.rateBytesPerSecond) return;
  let remaining = byteCount;
  const maxGrant = Math.max(16 * 1024, Math.min(bucket.burstBytes, bucket.rateBytesPerSecond));
  while (remaining > 0) {
    const wanted = Math.min(remaining, maxGrant);
    refillBandwidthBucket(bucket);
    if (bucket.tokens >= wanted) {
      bucket.tokens -= wanted;
      remaining -= wanted;
      continue;
    }
    const needed = wanted - bucket.tokens;
    const waitMs = Math.max(8, Math.min(1000, Math.ceil((needed / bucket.rateBytesPerSecond) * 1000)));
    await delay(waitMs);
  }
}
function shouldThrottleBandwidth(req) {
  const bandwidthConfig = normalizeBandwidthConfig(config.bandwidth || {});
  if (!bandwidthConfig.enabled || bandwidthConfig.limitKBps <= 0) return null;
  const requestPath = String(req.path || req.originalUrl || '');
  if (/\.m3u8(?:$|\?)/i.test(requestPath)) return null;
  const isMedia = bandwidthConfig.applyToMedia !== false && /^\/media\//i.test(requestPath);
  const isLive = bandwidthConfig.applyToLive !== false && (/^\/live-streams\//i.test(requestPath) || /^\/channel-relays\//i.test(requestPath));
  const isTranscode = bandwidthConfig.applyToTranscode !== false && (/^\/transcoded\//i.test(requestPath) || /^\/convert-media\//i.test(requestPath));
  return (isMedia || isLive || isTranscode) ? bandwidthConfig : null;
}
function bandwidthThrottleMiddleware(req, res, next) {
  const bandwidthConfig = shouldThrottleBandwidth(req);
  if (!bandwidthConfig) return next();

  const bucket = getBandwidthBucket(getBandwidthClientKey(req), bandwidthConfig);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let chain = Promise.resolve();
  let closed = false;

  res.setHeader('X-Bandwidth-Limit-KBps', String(bandwidthConfig.limitKBps));
  res.on('close', () => { closed = true; });

  function enqueue(task) {
    chain = chain.then(async () => {
      if (closed) return;
      await task();
    }).catch(error => {
      if (!closed) {
        try { res.destroy(error); } catch {}
      }
    });
    return chain;
  }

  res.write = function throttledWrite(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '', encoding);
    enqueue(async () => {
      await waitForBandwidthTokens(bucket, buffer.length);
      if (closed) return;
      await new Promise((resolve, reject) => {
        const done = (error) => {
          if (callback) {
            try { callback(error); } catch {}
          }
          if (error) reject(error);
          else resolve();
        };
        try { originalWrite(buffer, encoding, done); } catch (error) { done(error); }
      });
      if (!closed) res.emit('drain');
    });
    return false;
  };

  res.end = function throttledEnd(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk !== undefined && chunk !== null && chunk.length !== 0) {
      res.write(chunk, encoding);
    }
    enqueue(async () => {
      if (closed) return;
      await new Promise((resolve, reject) => {
        const done = (error) => {
          if (callback) {
            try { callback(error); } catch {}
          }
          if (error) reject(error);
          else resolve();
        };
        try { originalEnd(done); } catch (error) { done(error); }
      });
    });
    return res;
  };

  return next();
}
function cleanupBandwidthBuckets() {
  const cutoff = Date.now() - BANDWIDTH_BUCKET_TTL_MS;
  for (const [key, bucket] of bandwidthBuckets.entries()) {
    if ((bucket.updatedAt || 0) < cutoff) bandwidthBuckets.delete(key);
  }
}
const bandwidthCleanupTimer = setInterval(cleanupBandwidthBuckets, 60 * 1000);
if (bandwidthCleanupTimer.unref) bandwidthCleanupTimer.unref();

function isManagedLiveSource(source) {
  return !!source && (source.sourceType === 'usb_capture' || isManagedNetworkSourceType(source.sourceType)) && source.deliveryMode !== 'webrtc';
}
function isDirectLiveSource(source) {
  return !!source && (source.sourceType === 'webrtc' || (source.sourceType === 'usb_capture' && source.deliveryMode === 'webrtc'));
}
function isLiveSource(source) {
  return !!source && source.sourceType !== 'm3u';
}

function sanitizeSourceSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'usb-source';
}
function buildLocalLiveStreamUrl(source) {
  const sourceKey = encodeURIComponent(sanitizeSourceSegment(source.id));
  const publicBaseUrl = String(config.usbCapture?.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (publicBaseUrl) return `${publicBaseUrl}/${sourceKey}/index.m3u8`;
  const publicBasePath = String(config.usbCapture?.publicBasePath || '').trim().replace(/\/+$/, '');
  if (publicBasePath) return `${publicBasePath}/${sourceKey}/index.m3u8`;
  return `/live-streams/${sourceKey}/index.m3u8`;
}
function getManagedLiveInputUrl(source) {
  if (!source || source.sourceType === 'usb_capture') return '';
  const inputUrl = String(source.inputUrl || '').trim();
  if (inputUrl) return inputUrl;
  const legacyStreamUrl = String(source.streamUrl || '').trim();
  if (isManagedNetworkSourceType(source.sourceType) && isStreamInputUrl(legacyStreamUrl) && !isLocalLivePlaybackUrl(legacyStreamUrl)) {
    return legacyStreamUrl;
  }
  return '';
}
function getXtreamHlsCandidateUrl(inputUrl = '') {
  const value = String(inputUrl || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split('/').filter(Boolean).map(part => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
    const liveOffset = parts[0]?.toLowerCase() === 'live' ? 1 : 0;
    const username = parts[liveOffset] || '';
    const password = parts[liveOffset + 1] || '';
    const rawStreamId = parts[liveOffset + 2] || '';
    if (!username || !password || !rawStreamId || parts.length !== liveOffset + 3) return '';
    const streamId = rawStreamId.replace(/\.(?:ts|m3u8)$/i, '');
    if (!/^\d+$/.test(streamId)) return '';
    parsed.pathname = `/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.m3u8`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}
function getPreferredHttpLiveInputUrl(source = {}, inputUrl = '') {
  const value = String(inputUrl || '').trim();
  const sourceType = String(source?.sourceType || '').trim().toLowerCase();
  if (source?.preferRawHttp === true || source?.preferXtreamHls === false) return value;
  if (sourceType && !['hls', 'm3u'].includes(sourceType)) return value;
  return getXtreamHlsCandidateUrl(value) || value;
}
function isXtreamLiveHlsUrl(inputUrl = '') {
  return isHlsPlaylistUrl(inputUrl) && !!getXtreamHlsCandidateUrl(inputUrl);
}
function isSrtUrl(value = '') {
  return /^srt:\/\//i.test(String(value || '').trim());
}
function isProtocolUrl(value = '', protocol = '') {
  const wanted = String(protocol || '').replace(/:$/, '');
  return new RegExp(`^${wanted}:\\/\\/`, 'i').test(String(value || '').trim());
}
function parseSrtUrl(value = '') {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}
function parseProtocolUrl(value = '') {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}
function getUrlSearchParam(inputUrl = '', key = '') {
  const parsed = parseProtocolUrl(inputUrl);
  if (parsed) return String(parsed.searchParams.get(key) || '').trim().toLowerCase();
  const escapedKey = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(inputUrl || '').match(new RegExp(`[?&]${escapedKey}=([^&#]+)`, 'i'));
  return match ? decodeURIComponent(match[1] || '').trim().toLowerCase() : '';
}
function appendUrlSearchParams(inputUrl = '', params = {}) {
  const value = String(inputUrl || '').trim();
  if (!value) return value;
  const hashIndex = value.indexOf('#');
  const base = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
  const additions = Object.entries(params)
    .filter(([key]) => !getUrlSearchParam(base, key))
    .map(([key, paramValue]) => `${encodeURIComponent(key)}=${encodeURIComponent(paramValue)}`);
  if (!additions.length) return value;
  return `${base}${base.includes('?') ? '&' : '?'}${additions.join('&')}${hash}`;
}
function getSrtMode(inputUrl = '') {
  if (!isSrtUrl(inputUrl)) return '';
  return getUrlSearchParam(inputUrl, 'mode');
}
function isLocalBindHost(hostname = '') {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::' || host === '::1';
}
function appendSrtMode(inputUrl = '', mode = 'listener') {
  const value = String(inputUrl || '').trim();
  if (!value || getSrtMode(value)) return value;
  return appendUrlSearchParams(value, { mode });
}
function shouldAutoListenForSrt(source = {}, inputUrl = '') {
  if (String(source?.sourceType || '').trim().toLowerCase() !== 'srt') return false;
  if (!isSrtUrl(inputUrl) || getSrtMode(inputUrl)) return false;
  const parsed = parseSrtUrl(inputUrl);
  return isLocalBindHost(parsed?.hostname || '');
}
function shouldAutoListenForPacketInput(source = {}, inputUrl = '') {
  const sourceType = String(source?.sourceType || '').trim().toLowerCase();
  if (!['udp', 'rtp'].includes(sourceType)) return false;
  if (!isProtocolUrl(inputUrl, sourceType) || getUrlSearchParam(inputUrl, 'listen')) return false;
  const parsed = parseProtocolUrl(inputUrl);
  return isLocalBindHost(parsed?.hostname || '');
}
function appendPacketListenerOptions(inputUrl = '', sourceType = '') {
  const protocol = String(sourceType || '').trim().toLowerCase();
  const params = protocol === 'udp'
    ? { listen: '1', fifo_size: '1000000', overrun_nonfatal: '1' }
    : { listen: '1' };
  return appendUrlSearchParams(inputUrl, params);
}
function getEffectiveManagedLiveInputUrl(source) {
  const inputUrl = getManagedLiveInputUrl(source);
  if (shouldAutoListenForSrt(source, inputUrl)) return appendSrtMode(inputUrl, 'listener');
  if (shouldAutoListenForPacketInput(source, inputUrl)) return appendPacketListenerOptions(inputUrl, source?.sourceType);
  return getPreferredHttpLiveInputUrl(source, inputUrl);
}
function isSrtListenerInput(source = {}, inputUrl = '') {
  const sourceType = String(source?.sourceType || '').trim().toLowerCase();
  return sourceType === 'srt' && isSrtUrl(inputUrl) && getSrtMode(inputUrl) === 'listener';
}
function isPacketListenerInput(source = {}, inputUrl = '') {
  const sourceType = String(source?.sourceType || '').trim().toLowerCase();
  if (!['udp', 'rtp'].includes(sourceType) || !isProtocolUrl(inputUrl, sourceType)) return false;
  const listen = getUrlSearchParam(inputUrl, 'listen');
  if (!['1', 'true', 'yes'].includes(listen)) return false;
  const parsed = parseProtocolUrl(inputUrl);
  return isLocalBindHost(parsed?.hostname || '');
}
function isPushListenerInput(source = {}, inputUrl = '') {
  return isSrtListenerInput(source, inputUrl) || isPacketListenerInput(source, inputUrl);
}
function getRtmpIngestStreamKey(source = {}) {
  return sanitizeRtmpName(source.rtmpStreamKey || config.rtmpServer?.streamKey || source.id || DEFAULT_RTMP_INGEST_SOURCE_ID, DEFAULT_RTMP_INGEST_SOURCE_ID);
}
function isLocalRtmpIngestUrl(inputUrl = '', streamKey = '') {
  const parsed = parseProtocolUrl(inputUrl);
  if (!parsed || parsed.protocol.toLowerCase() !== 'rtmp:') return false;
  const rtmpCfg = normalizeRtmpServerConfig(config.rtmpServer || {});
  const urlPort = Number(parsed.port || 1935);
  if (urlPort !== rtmpCfg.port) return false;
  if (!isLocalBindHost(parsed.hostname || '')) return false;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] !== rtmpCfg.appName) return false;
  if (streamKey && parts[1] !== streamKey) return false;
  return true;
}
function isRtmpIngestSource(source = {}) {
  if (String(source?.sourceType || '').trim().toLowerCase() !== 'rtmp') return false;
  const inputUrl = getManagedLiveInputUrl(source);
  return source?.rtmpIngest === true || isLocalRtmpIngestUrl(inputUrl, source?.rtmpStreamKey || '');
}
function getRtmpActiveStreamPathForSource(source = {}) {
  const rtmpCfg = normalizeRtmpServerConfig(config.rtmpServer || {});
  return `/${rtmpCfg.appName}/${getRtmpIngestStreamKey(source)}`;
}
function isRtmpIngestPublisherActive(source = {}) {
  if (!isRtmpIngestSource(source)) return false;
  return rtmpIngestState.activeStreams.has(getRtmpActiveStreamPathForSource(source));
}
function getUsbStreamPublicUrl(source) {
  const explicitStreamUrl = String(source?.streamUrl || '').trim();
  const hasCustomCommand = !!String(source?.ffmpegCommand || '').trim();
  const shouldPreferLocalOutput = !!source && isManagedLiveSource(source) && !hasCustomCommand && (
    source.sourceType === 'usb_capture'
      || !!getManagedLiveInputUrl(source)
      || !explicitStreamUrl
      || (isStreamInputUrl(explicitStreamUrl) && !isLocalLivePlaybackUrl(explicitStreamUrl))
  );
  if (shouldPreferLocalOutput) return buildLocalLiveStreamUrl(source);
  if (explicitStreamUrl) return explicitStreamUrl;
  return buildLocalLiveStreamUrl(source);
}
function getConfiguredAppBaseUrl() {
  const explicit = String(config.server?.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const rawHost = String(config.server?.host || '').trim();
  const finalHost = (!rawHost || rawHost === '0.0.0.0' || rawHost === '::') ? 'localhost' : rawHost;
  const port = Number(config.server?.port || 8088);
  return `http://${finalHost}:${port}`;
}
function buildAppUrl(pathname='') {
  const base = getConfiguredAppBaseUrl();
  const normalizedPath = String(pathname || '');
  return normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')
    ? normalizedPath
    : `${base}${normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`}`;
}
function getWebrtcViewerPath(sourceId='') {
  return `/webrtc-viewer?sourceId=${encodeURIComponent(sourceId || '')}`;
}
function getWebrtcPublisherPath(sourceId='') {
  return `/webrtc-publisher?sourceId=${encodeURIComponent(sourceId || '')}`;
}
function getDirectLivePlaybackUrl(source) {
  return source?.webrtcEmbedUrl || buildAppUrl(getWebrtcViewerPath(source?.id || ''));
}
function toInlineSingleLine(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 280);
}
function getWebrtcPublisherUrl(source) {
  if (!source?.id) return '';
  return buildAppUrl(getWebrtcPublisherPath(source.id));
}
function getSourcePlaybackUrl(source) {
  if (!source) return '';
  return isDirectLiveSource(source) ? getDirectLivePlaybackUrl(source) : getUsbStreamPublicUrl(source);
}
function resolveUrlAgainst(baseUrl = '', ref = '') {
  const rawRef = String(ref || '').trim();
  if (!rawRef) return '';
  try {
    return new URL(rawRef, String(baseUrl || '').trim() || undefined).toString();
  } catch {
    return rawRef;
  }
}
function isHlsPlaylistUrl(value = '') {
  return /\.m3u8(?:$|[?#])/i.test(String(value || '').trim());
}
function inputProbeFormatName(probe = null) {
  return String(probe?.formatName || '').trim().toLowerCase();
}
function probeFormatContains(probe = null, pattern = null) {
  const formatName = inputProbeFormatName(probe);
  if (!formatName || !pattern) return false;
  return formatName.split(',').some(format => pattern.test(format.trim()));
}
function isProbeHlsFormat(probe = null) {
  return probeFormatContains(probe, /^(hls|applehttp)$/i);
}
function isProbeMpegTsFormat(probe = null) {
  return probeFormatContains(probe, /^mpegts$/i);
}
function hasExplicitInputFormat(inputArgs = []) {
  return Array.isArray(inputArgs) && inputArgs.some(arg => String(arg || '').trim().toLowerCase() === '-f');
}
function normalizeHttpRequestHeaders(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const headers = {};
  for (const [key, headerValue] of Object.entries(raw)) {
    const name = String(key || '').trim();
    const text = String(headerValue || '').trim();
    if (!name || !text || /[\r\n:]/.test(name) || /[\r\n]/.test(text)) continue;
    headers[name] = text;
  }
  return headers;
}
function normalizeChannelStreamSettings(value = null) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const settings = {};
  for (const [key, settingValue] of Object.entries(parsed)) {
    if (!CHANNEL_STREAM_SETTING_KEYS.has(key) || settingValue === undefined || settingValue === null) continue;
    if (key === 'requestHeaders') {
      const headers = normalizeHttpRequestHeaders(settingValue);
      if (Object.keys(headers).length) settings.requestHeaders = headers;
      continue;
    }
    if (CHANNEL_STREAM_BOOLEAN_KEYS.has(key)) {
      settings[key] = settingValue === true || String(settingValue).trim().toLowerCase() === 'true';
      continue;
    }
    if (CHANNEL_STREAM_NUMBER_KEYS.has(key)) {
      const valueNumber = Number(settingValue);
      if (!Number.isFinite(valueNumber)) continue;
      if (key === 'hlsTime') settings[key] = Math.max(1, valueNumber);
      else if (key === 'hlsListSize') settings[key] = Math.max(3, valueNumber);
      else if (key === 'egressFifoQueue') settings[key] = Math.max(60, valueNumber);
      else if (key === 'egressHlsTime') settings[key] = Math.max(1, valueNumber);
      else if (key === 'egressHlsListSize') settings[key] = Math.max(3, valueNumber);
      else settings[key] = Math.max(0, valueNumber);
      continue;
    }
    const text = String(settingValue || '').trim();
    if (!text) continue;
    if (key === 'relayMode') {
      settings[key] = CHANNEL_RELAY_MODES.includes(text) ? text : 'auto';
    } else if (key === 'egressType') {
      settings[key] = LIVE_EGRESS_TYPES.includes(text) ? text : 'srt';
    } else if (key === 'egressVideoMode') {
      settings[key] = LIVE_EGRESS_VIDEO_MODES.includes(text) ? text : 'same';
    } else {
      settings[key] = text.slice(0, key === 'egressUrl' ? 4096 : 2048);
    }
  }
  return settings;
}
function getChannelHttpRequestHeaders(item = {}) {
  const streamSettings = normalizeChannelStreamSettings(item.streamSettings);
  const sourceSettings = (config?.iptv?.sources || []).find(source => String(source?.id || '') === String(item.sourceId || '')) || {};
  const headers = normalizeHttpRequestHeaders({
    ...(item.requestHeaders || item.headers || {}),
    ...(sourceSettings.requestHeaders || sourceSettings.headers || {}),
    ...(streamSettings.requestHeaders || {})
  });
  const userAgent = String(streamSettings.userAgent || sourceSettings.userAgent || sourceSettings.user_agent || item.userAgent || item.user_agent || headers['User-Agent'] || headers['user-agent'] || '').trim();
  const referer = String(streamSettings.referer || sourceSettings.referer || sourceSettings.referrer || item.referer || item.referrer || headers.Referer || headers.referer || '').trim();
  if (userAgent) headers['User-Agent'] = userAgent;
  if (referer) headers.Referer = referer;
  return headers;
}
function buildHttpInputHeaderArgs(headers = {}) {
  const clean = normalizeHttpRequestHeaders(headers);
  const args = [];
  const userAgent = clean['User-Agent'] || clean['user-agent'] || '';
  if (userAgent) args.push('-user_agent', userAgent);
  const headerLines = Object.entries(clean)
    .filter(([key]) => key.toLowerCase() !== 'user-agent')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  if (headerLines) args.push('-headers', `${headerLines}\r\n`);
  return args;
}
function buildHttpReconnectInputArgs(inputUrl = '') {
  if (isHlsPlaylistUrl(inputUrl)) {
    return ['-rw_timeout', '15000000'];
  }
  const args = [
    '-rw_timeout', '15000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1'
  ];
  args.push('-reconnect_at_eof', '1');
  args.push(
    '-reconnect_on_network_error', '1',
    '-reconnect_on_http_error', '4xx,5xx',
    '-reconnect_delay_max', '2'
  );
  return args;
}
function summarizeProbePayload(payload = {}) {
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find(stream => stream?.codec_type === 'video') || null;
  const audio = streams.find(stream => stream?.codec_type === 'audio') || null;
  const videoCodec = String(video?.codec_name || '').trim().toLowerCase();
  const audioCodec = String(audio?.codec_name || '').trim().toLowerCase();
  const browserFriendlyVideo = !videoCodec || ['h264', 'avc1'].includes(videoCodec);
  const browserFriendlyAudio = !audioCodec || ['aac', 'mp3'].includes(audioCodec);
  return {
    videoCodec,
    audioCodec,
    browserFriendlyVideo,
    browserFriendlyAudio,
    streamSummary: streams
      .map(stream => `${stream?.codec_type || 'data'}:${stream?.codec_name || '?'}`)
      .join(', '),
    browserFriendly: browserFriendlyVideo && browserFriendlyAudio
  };
}
function probeNetworkInput(source = {}, inputUrl = '') {
  const targetUrl = String(inputUrl || '').trim();
  if (!targetUrl) return { ok: false, error: 'رابط الإدخال فارغ.' };
  const ffprobeBinary = resolveFfprobeBinaryPath(source);
  const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format'];
  if (/^rtsp:\/\//i.test(targetUrl)) args.push('-rtsp_transport', 'tcp');
  if (/^https?:\/\//i.test(targetUrl)) args.push('-rw_timeout', '15000000');
  args.push(targetUrl);
  try {
    const result = spawnSync(ffprobeBinary, args, {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    });
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    if (result.error || result.status !== 0) {
      return {
        ok: false,
        error: toInlineSingleLine(result.error?.message || stderr || stdout || 'ffprobe failed'),
        ffprobePath: ffprobeBinary
      };
    }
    const payload = JSON.parse(stdout || '{}');
    return {
      ok: true,
      ffprobePath: ffprobeBinary,
      formatName: String(payload?.format?.format_name || '').trim(),
      ...summarizeProbePayload(payload)
    };
  } catch (error) {
    return { ok: false, error: toInlineSingleLine(error?.message || 'تعذر تحليل المصدر عبر FFprobe.'), ffprobePath: ffprobeBinary };
  }
}
function shouldUseManagedHlsCopyRelay(source = {}, probe = null) {
  const sourceType = String(source?.sourceType || '').trim().toLowerCase();
  const relayMode = String(source?.relayMode || 'auto').trim().toLowerCase();
  if (relayMode === 'transcode') return false;
  if (relayMode === 'copy') {
    return isManagedNetworkSourceType(sourceType);
  }
  const preferredHwAccel = String(source?.hwAccel || config.usbCapture?.hwAccel || 'auto').trim().toLowerCase();
  const resolutionPreset = String(source?.resolutionPreset || 'source').trim().toLowerCase();
  const customWidth = Math.max(0, Number(source?.outputWidth || 0));
  const customHeight = Math.max(0, Number(source?.outputHeight || 0));
  const keepsSourceResolution = resolutionPreset === 'source' || (resolutionPreset === 'custom' && !(customWidth > 0 && customHeight > 0));
  const autoMode = !preferredHwAccel || preferredHwAccel === 'auto';
  return isManagedNetworkSourceType(sourceType) && autoMode && !isProbeMpegTsFormat(probe) && !!probe?.ok && !!probe?.browserFriendly && keepsSourceResolution;
}
function shouldUseManagedHlsAudioRelay(source = {}, probe = null) {
  const sourceType = String(source?.sourceType || '').trim().toLowerCase();
  const preferredHwAccel = String(source?.hwAccel || config.usbCapture?.hwAccel || 'auto').trim().toLowerCase();
  const resolutionPreset = String(source?.resolutionPreset || 'source').trim().toLowerCase();
  const customWidth = Math.max(0, Number(source?.outputWidth || 0));
  const customHeight = Math.max(0, Number(source?.outputHeight || 0));
  const keepsSourceResolution = resolutionPreset === 'source' || (resolutionPreset === 'custom' && !(customWidth > 0 && customHeight > 0));
  const autoMode = !preferredHwAccel || preferredHwAccel === 'auto';
  return isManagedNetworkSourceType(sourceType)
    && autoMode
    && !isProbeMpegTsFormat(probe)
    && !!probe?.ok
    && !!probe?.browserFriendlyVideo
    && probe?.browserFriendlyAudio === false
    && keepsSourceResolution;
}
function getManagedSourceStartupGraceMs(source = null) {
  const sourceType = String(source?.sourceType || '').trim().toLowerCase();
  if (sourceType === 'hls') return 35000;
  if (['rtsp', 'rtmp', 'srt', 'udp', 'rtp', 'network_push', 'resi_modulator'].includes(sourceType)) return 25000;
  return USB_HEALTH_GRACE_MS;
}
function getLiveEgressConfig(source = {}) {
  const type = String(source?.egressType || '').trim().toLowerCase();
  const url = String(source?.egressUrl || '').trim();
  if (!source?.egressEnabled || !LIVE_EGRESS_TYPES.includes(type) || !url) return null;
  return { type, url };
}
function withLiveEgressDefaults(type = '', rawUrl = '') {
  const url = String(rawUrl || '').trim();
  if (!url) return url;
  if (type === 'srt') return appendUrlSearchParams(url, { mode: 'caller', latency: '120', transtype: 'live', tlpktdrop: '1' });
  if (type === 'udp') return appendUrlSearchParams(url, { pkt_size: '1316', buffer_size: '65536' });
  if (type === 'rtp') return appendUrlSearchParams(url, { pkt_size: '1316' });
  return url;
}
function isFilesystemEgressTarget(type = '', targetUrl = '') {
  const value = String(targetUrl || '').trim();
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return type === 'hls' || type === 'mpegts_file' || /^[a-zA-Z]:[\\/]/.test(value) || value.includes('/') || value.includes('\\');
}
function ensureEgressParentDir(type = '', targetUrl = '') {
  if (!isFilesystemEgressTarget(type, targetUrl)) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(rootDir, targetUrl)), { recursive: true });
  } catch {}
}
function resolveEgressOutputResolution(source = {}) {
  const preset = String(source.egressResolutionPreset || 'same').trim().toLowerCase();
  if (!preset || preset === 'same') return { same: true, label: 'same' };
  if (preset === 'source') return null;
  if (preset === 'custom') {
    const width = Math.max(0, Number(source.egressOutputWidth || 0));
    const height = Math.max(0, Number(source.egressOutputHeight || 0));
    if (width > 0 && height > 0) return { width, height, label: `${width}x${height}` };
    return { same: true, label: 'same' };
  }
  return getResolutionPresetDimensions(preset);
}
function buildFifoEgressArgs(source = {}, format = '', targetUrl = '', formatOpts = '') {
  const useFifo = source.egressFifo !== false && ['flv', 'mpegts', 'rtp_mpegts'].includes(format);
  if (!useFifo) return null;
  const queueSize = Math.max(60, Number(source.egressFifoQueue || 600));
  return [
    '-f', 'fifo',
    '-fifo_format', format,
    ...(formatOpts ? ['-format_opts', formatOpts] : []),
    '-queue_size', String(queueSize),
    '-drop_pkts_on_overflow', '1',
    '-attempt_recovery', '1',
    '-recover_any_error', '1',
    '-recovery_wait_time', '1',
    '-restart_with_keyframe', '1',
    targetUrl
  ];
}
function buildLiveEgressOutputArgs(source = {}, options = {}) {
  const egress = getLiveEgressConfig(source);
  if (!egress) return { args: [], egress: null };
  const targetUrl = withLiveEgressDefaults(egress.type, egress.url);
  ensureEgressParentDir(egress.type, targetUrl);
  const lowLatency = source.egressLowLatency !== false;
  const hlsTime = Math.max(1, Number(source.egressHlsTime || (lowLatency ? 1 : 0) || options.hlsTime || source.hlsTime || config.usbCapture?.hlsTime || 2));
  const hlsListSize = Math.max(3, Number(source.egressHlsListSize || (lowLatency ? 4 : 0) || options.hlsListSize || source.hlsListSize || config.usbCapture?.hlsListSize || 6));
  const baseVideoBitrate = String(options.videoBitrate || source.videoBitrate || config.usbCapture?.videoBitrate || '2500k');
  const videoBitrate = String(source.egressVideoBitrate || baseVideoBitrate);
  const maxRate = String(source.egressMaxRate || options.maxRate || source.maxRate || config.usbCapture?.maxRate || videoBitrate);
  const bufSize = String(source.egressBufSize || options.bufSize || source.bufSize || config.usbCapture?.bufSize || '3500k');
  const audioBitrate = String(source.egressAudioBitrate || options.audioBitrate || source.audioBitrate || config.usbCapture?.audioBitrate || '96k');
  const frameRate = Math.max(24, Number(source.egressFrameRate || options.frameRate || source.frameRate || config.usbCapture?.frameRate || 25));
  const rawMode = String(source.egressVideoMode || 'same').trim().toLowerCase();
  const videoMode = LIVE_EGRESS_VIDEO_MODES.includes(rawMode) ? rawMode : 'same';
  const egressHwAccel = String(source.egressHwAccel || 'same').trim().toLowerCase();
  const inheritedEncoder = options.videoEncoder || { codec: 'libx264', label: 'CPU / libx264', args: [] };
  const videoEncoder = egressHwAccel && egressHwAccel !== 'same'
    ? resolveVideoEncoder({ ...source, hwAccel: egressHwAccel }, options.ffmpegBinary || getUsbFfmpegBinary(source))
    : inheritedEncoder;
  const resolution = resolveEgressOutputResolution(source);
  const scaleFilter = resolution?.same
    ? String(options.scaleFilter || '').trim()
    : (resolution ? buildScaleFilter(resolution.width, resolution.height) : '');
  const hasSeparateEgressVideo = egressHwAccel !== 'same'
    || videoMode === 'transcode'
    || !!source.egressVideoBitrate
    || !!source.egressMaxRate
    || !!source.egressBufSize
    || !!source.egressFrameRate
    || (!!source.egressResolutionPreset && String(source.egressResolutionPreset).trim().toLowerCase() !== 'same');
  const shouldTranscodeVideo = egress.type === 'rtmp'
    || (videoMode === 'copy' ? false : (options.copyVideo === false || videoMode === 'transcode' || hasSeparateEgressVideo));
  const videoArgs = shouldTranscodeVideo
    ? [
        '-fps_mode', 'cfr',
        '-r', String(frameRate),
        ...(scaleFilter ? ['-vf', scaleFilter] : []),
        ...buildLiveVideoEncoderArgs(videoEncoder, { frameRate, videoBitrate, maxRate, bufSize })
      ]
    : ['-c:v', 'copy'];
  const base = [
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    ...(lowLatency ? ['-max_muxing_queue_size', '2048'] : []),
    ...videoArgs,
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', audioBitrate,
    ...(lowLatency ? ['-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0'] : [])
  ];
  const egressInfo = { ...egress, url: targetUrl, videoMode: shouldTranscodeVideo ? 'transcode' : 'copy', encoder: shouldTranscodeVideo ? videoEncoder.label : 'copy', resolution: resolution?.same ? 'same' : (resolution?.label || 'source'), lowLatency, fifo: source.egressFifo !== false };
  if (egress.type === 'rtmp') {
    const fifoArgs = buildFifoEgressArgs(source, 'flv', targetUrl, 'flvflags=no_duration_filesize');
    return { args: [...base, ...(fifoArgs || ['-flvflags', 'no_duration_filesize', '-f', 'flv', targetUrl])], egress: egressInfo };
  }
  if (egress.type === 'rtp') {
    const fifoArgs = buildFifoEgressArgs(source, 'rtp_mpegts', targetUrl, '');
    return { args: [...base, ...(fifoArgs || ['-f', 'rtp_mpegts', targetUrl])], egress: egressInfo };
  }
  if (egress.type === 'hls') {
    return {
      args: [
        ...base,
        '-f', 'hls',
        '-hls_time', String(hlsTime),
        '-hls_list_size', String(hlsListSize),
        '-hls_allow_cache', '0',
        '-hls_flags', 'delete_segments+omit_endlist+independent_segments+program_date_time',
        '-hls_start_number_source', 'epoch',
        '-hls_delete_threshold', lowLatency ? '1' : '2',
        targetUrl
      ],
      egress: { ...egressInfo, fifo: false }
    };
  }
  const fifoArgs = buildFifoEgressArgs(source, 'mpegts', targetUrl, 'mpegts_flags=+resend_headers');
  return { args: [...base, ...(fifoArgs || ['-mpegts_flags', '+resend_headers', '-f', 'mpegts', targetUrl])], egress: egressInfo };
}
function buildManagedLiveHlsArgs(options = {}) {
  const {
    source = {},
    ffmpegBinary = '',
    inputArgs = [],
    inputUrl = '',
    scaleFilter = '',
    videoEncoder = { codec: 'libx264', label: 'CPU / libx264', args: [] },
    videoBitrate = '2500k',
    maxRate = '2500k',
    bufSize = '3500k',
    audioBitrate = '96k',
    frameRate = 25,
    hlsTime = 2,
    hlsListSize = 6,
    segmentPattern = '',
    playlistPath = ''
  } = options;
  const listenerInput = isPushListenerInput(source, inputUrl) || isRtmpIngestSource(source);
  const skipStartupProbe = !listenerInput && source?.skipStartupProbe !== false && isXtreamLiveHlsUrl(inputUrl);
  const inputProbe = listenerInput
    ? { ok: false, skipped: true, listener: true, streamSummary: '' }
    : skipStartupProbe
      ? {
          ok: true,
          skipped: true,
          formatName: 'hls',
          videoCodec: '',
          audioCodec: '',
          browserFriendlyVideo: true,
          browserFriendlyAudio: true,
          browserFriendly: true,
          streamSummary: 'hls:xtream'
        }
    : probeNetworkInput(source, inputUrl);
  const useCopyRelay = shouldUseManagedHlsCopyRelay(source, inputProbe);
  const useAudioRelay = !useCopyRelay && shouldUseManagedHlsAudioRelay(source, inputProbe);
  const egressOutput = buildLiveEgressOutputArgs(source, {
    ffmpegBinary,
    hlsTime,
    hlsListSize,
    videoEncoder,
    videoBitrate,
    maxRate,
    bufSize,
    audioBitrate,
    frameRate,
    scaleFilter
  });
  const hasForcedInputFormat = hasExplicitInputFormat(inputArgs);
  const isHlsInput = isHlsPlaylistUrl(inputUrl) || isProbeHlsFormat(inputProbe);
  const isMpegTsInput = !isHlsInput && (
    String(source?.sourceType || '').trim().toLowerCase() === 'mpegts_file'
    || /\.(ts|mts|m2ts)(?:$|[?#])/i.test(String(inputUrl || '').trim())
    || isProbeMpegTsFormat(inputProbe)
  );
  const commonArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-thread_queue_size', '1024',
    '-analyzeduration', (useCopyRelay || useAudioRelay) ? '2000000' : '500000',
    '-probesize', (useCopyRelay || useAudioRelay) ? '8000000' : '1000000',
    ...(isMpegTsInput ? ['-fflags', '+genpts+discardcorrupt'] : []),
    ...inputArgs,
    ...(isHlsInput ? [
      '-f', 'hls',
      '-allowed_extensions', 'ALL',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,udp,rtp',
      '-http_persistent', '0',
      '-live_start_index', '-3'
    ] : []),
    ...(isMpegTsInput && !hasForcedInputFormat ? [
      '-f', 'mpegts'
    ] : []),
    '-i', inputUrl
  ];
  const hlsOutputArgs = [
    '-f', 'hls',
    '-hls_init_time', '0',
    '-hls_time', String(hlsTime),
    '-hls_list_size', String(hlsListSize),
    '-hls_allow_cache', '0',
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments+program_date_time',
    '-hls_start_number_source', 'epoch',
    '-hls_delete_threshold', '4',
    '-hls_segment_filename', segmentPattern,
    playlistPath
  ];
  if (useCopyRelay) {
    return {
      args: [
        ...commonArgs,
        '-map', '0:v:0?',
        '-map', '0:a:0?',
        '-sn',
        '-dn',
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-muxdelay', '0',
        '-muxpreload', '0',
        ...hlsOutputArgs,
        ...egressOutput.args
      ],
      inputProbe,
      appliedVideoEncoder: 'Copy / HLS Relay',
      appliedScaleFilter: '',
      relayMode: 'copy',
      egress: egressOutput.egress
    };
  }
  if (useAudioRelay) {
    return {
      args: [
        ...commonArgs,
        '-fflags', '+genpts+discardcorrupt',
        '-map', '0:v:0?',
        '-map', '0:a:0?',
        '-sn',
        '-dn',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', audioBitrate,
        '-muxdelay', '0',
        '-muxpreload', '0',
        ...hlsOutputArgs,
        ...egressOutput.args
      ],
      inputProbe,
      appliedVideoEncoder: 'Copy Video + AAC Audio',
      appliedScaleFilter: '',
      relayMode: 'audio-transcode',
      egress: egressOutput.egress
    };
  }
  return {
    args: [
      ...commonArgs,
      '-fflags', '+genpts+discardcorrupt',
      '-map', '0:v:0?',
      '-map', '0:a:0?',
      '-sn',
      '-dn',
      '-fps_mode', 'cfr',
      '-r', String(frameRate),
      ...(scaleFilter ? ['-vf', scaleFilter] : []),
      ...buildLiveVideoEncoderArgs(videoEncoder, { frameRate, videoBitrate, maxRate, bufSize }),
      '-c:a', 'aac',
      '-ar', '44100',
      '-ac', '2',
      '-b:a', audioBitrate,
      ...hlsOutputArgs,
      ...egressOutput.args
    ],
    inputProbe,
    appliedVideoEncoder: videoEncoder.label,
    appliedScaleFilter: scaleFilter || '',
    relayMode: 'transcode',
    egress: egressOutput.egress
  };
}
async function probeUrlHeadOrRange(targetUrl = '') {
  const headers = { 'user-agent': 'LightMediaServer/11' };
  try {
    const headResponse = await fetch(targetUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers
    });
    if (headResponse.ok) {
      return {
        ok: true,
        status: headResponse.status,
        finalUrl: headResponse.url || targetUrl,
        contentType: String(headResponse.headers.get('content-type') || '').trim()
      };
    }
  } catch {}
  const rangeResponse = await fetch(targetUrl, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
    headers: { ...headers, range: 'bytes=0-2047' }
  });
  const buffer = await rangeResponse.arrayBuffer().catch(() => new ArrayBuffer(0));
  return {
    ok: rangeResponse.ok,
    status: rangeResponse.status,
    finalUrl: rangeResponse.url || targetUrl,
    contentType: String(rangeResponse.headers.get('content-type') || '').trim(),
    bytesRead: buffer.byteLength
  };
}
async function inspectHlsPlaylist(targetUrl = '', depth = 0) {
  const response = await fetch(targetUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
    headers: { 'user-agent': 'LightMediaServer/11', accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.9, */*;q=0.5' }
  });
  const playlistText = await response.text();
  const details = {
    ok: response.ok,
    url: targetUrl,
    finalUrl: response.url || targetUrl,
    status: response.status,
    contentType: String(response.headers.get('content-type') || '').trim(),
    lineCount: playlistText.split(/\r?\n/).filter(Boolean).length
  };
  if (!response.ok) return details;
  let previousDirective = '';
  const lines = playlistText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('#')) {
      previousDirective = line;
      continue;
    }
    const resolvedUrl = resolveUrlAgainst(details.finalUrl, line);
    const isNestedPlaylist = /\.m3u8(?:$|[?#])/i.test(line) || /^#EXT-X-STREAM-INF/i.test(previousDirective);
    if (isNestedPlaylist && depth < 2) {
      const nested = await inspectHlsPlaylist(resolvedUrl, depth + 1);
      return {
        ...details,
        variantPlaylistUrl: resolvedUrl,
        nested,
        firstMediaUrl: nested?.firstMediaUrl || nested?.variantPlaylistUrl || resolvedUrl
      };
    }
    return {
      ...details,
      firstMediaUrl: resolvedUrl
    };
  }
  return details;
}
async function testManagedSourceInput(source = {}) {
  const sourceType = String(source?.sourceType || '').trim().toLowerCase();
  if (!isManagedNetworkSourceType(sourceType)) {
    return { ok: false, sourceType, message: 'الاختبار مخصص لمصادر RTMP/SRT/RTSP/HLS/UDP/RTP/MPEG-TS.' };
  }
  const configuredInputUrl = getManagedLiveInputUrl(source);
  const inputUrl = getEffectiveManagedLiveInputUrl(source);
  if (!inputUrl) {
    return { ok: false, sourceType, message: 'يجب تعبئة رابط الإدخال أولًا.' };
  }
  const base = {
    ok: false,
    sourceType,
    resolvedInputUrl: inputUrl,
    configuredInputUrl,
    testedAt: new Date().toISOString()
  };
  if (isSrtListenerInput(source, inputUrl)) {
    return {
      ...base,
      ok: true,
      probe: { ok: true, skipped: true, listener: true },
      message: `مصدر SRT مضبوط كوضع استقبال Listener على ${inputUrl}. شغّل البث من الجهاز المرسل إلى نفس المنفذ، وسيظهر HLS بعد وصول أول بث.`
    };
  }
  if (isPacketListenerInput(source, inputUrl)) {
    return {
      ...base,
      ok: true,
      probe: { ok: true, skipped: true, listener: true },
      message: `مصدر ${sourceType.toUpperCase()} مضبوط كوضع استقبال على ${inputUrl}. شغّل الإرسال من الجهاز إلى نفس المنفذ، وسيظهر HLS بعد وصول أول بث.`
    };
  }
  if (isRtmpIngestSource(source)) {
    return {
      ...base,
      ok: !!rtmpIngestState.running,
      probe: { ok: !!rtmpIngestState.running, skipped: true, listener: true },
      message: rtmpIngestState.running
        ? `خادم RTMP الداخلي يستقبل على ${buildRtmpIngestInputUrl(config.rtmpServer, getRtmpIngestStreamKey(source))}. ادفع البث إلى هذا الرابط وسيظهر HLS بعد وصول الإشارة.`
        : `خادم RTMP الداخلي غير عامل حاليًا.${rtmpIngestState.error ? ` ${rtmpIngestState.error}` : ''}`
    };
  }
  if (sourceType !== 'hls') {
    const probe = probeNetworkInput(source, inputUrl);
    return {
      ...base,
      ok: !!probe.ok,
      probe,
      message: probe.ok
        ? `المصدر ${sourceType.toUpperCase()} متاح من هذا الجهاز${probe.streamSummary ? ` • ${probe.streamSummary}` : ''}.`
        : `تعذر فتح المصدر ${sourceType.toUpperCase()} من هذا الجهاز.${probe.error ? ` ${probe.error}` : ''}`
    };
  }
  const probe = probeNetworkInput(source, inputUrl);
  if (!isHlsPlaylistUrl(inputUrl) && !isProbeHlsFormat(probe)) {
    return {
      ...base,
      ok: !!probe.ok,
      probe,
      message: probe.ok
        ? `المصدر HTTP/MPEG-TS متاح من هذا الجهاز وسيتم تحويله إلى HLS داخليًا${probe.streamSummary ? ` • ${probe.streamSummary}` : ''}.`
        : `تعذر فتح مصدر HTTP من هذا الجهاز.${probe.error ? ` ${probe.error}` : ''}`
    };
  }
  try {
    const playlist = await inspectHlsPlaylist(inputUrl, 0);
    const segmentUrl = playlist?.nested?.firstMediaUrl || playlist?.firstMediaUrl || '';
    const segment = segmentUrl ? await probeUrlHeadOrRange(segmentUrl).catch(error => ({
      ok: false,
      error: toSingleLine(error?.message || 'تعذر اختبار أول ملف TS/segment.')
    })) : null;
    const playlistReachable = !!playlist?.ok;
    const segmentReachable = !!segment?.ok;
    let message = '';
    if (playlistReachable && segmentReachable) {
      message = 'ملف HLS وأول segment متاحان من هذا الجهاز.';
      if (probe.ok && !probe.browserFriendly) {
        message += ` قد يعمل المصدر في VLC أكثر من المتصفح لأن الترميز الحالي ${probe.streamSummary || `${probe.videoCodec || '?'} / ${probe.audioCodec || '?'}`} أقل توافقًا من H.264/AAC.`;
      }
    } else if (playlistReachable) {
      message = 'تم الوصول إلى ملف HLS لكن فشل الوصول إلى أول segment/TS من هذا الجهاز.';
    } else {
      message = 'تعذر الوصول إلى ملف HLS من هذا الجهاز.';
    }
    return {
      ...base,
      ok: playlistReachable && segmentReachable,
      playlistReachable,
      segmentReachable,
      playlist,
      segment,
      probe,
      message
    };
  } catch (error) {
    return {
      ...base,
      message: `تعذر اختبار مصدر HLS من هذا الجهاز. ${toInlineSingleLine(error?.message || '')}`.trim()
    };
  }
}
function getUsbOutputDir(source) {
  const outputRoot = String(config.usbCapture?.outputRoot || '').trim();
  return path.join(outputRoot || liveStreamsDir, sanitizeSourceSegment(source.id));
}
function getUsbSourceByStreamKey(sourceKey) {
  const key = sanitizeSourceSegment(decodeURIComponent(String(sourceKey || '').trim()));
  if (!key) return null;
  return (config.iptv?.sources || []).find(source => sanitizeSourceSegment(source.id) === key) || null;
}
  function getUsbPlaylistPath(source) {
  return path.join(getUsbOutputDir(source), 'index.m3u8');
}
function hasReadyUsbPlaylist(source) {
  if (!source) return false;
  const playlistPath = getUsbPlaylistPath(source);
  try {
    const stats = fs.existsSync(playlistPath) ? fs.statSync(playlistPath) : null;
    return !!(stats && stats.isFile() && stats.size > 0);
  } catch {
    return false;
  }
}
function getUsbSegmentPattern(source) {
  return path.join(getUsbOutputDir(source), 'segment-%05d.ts');
}
function getResolutionPresetDimensions(preset = 'source') {
  const normalized = String(preset || 'source').trim().toLowerCase();
  return {
    '360p': { width: 640, height: 360, label: '360p' },
    '480p': { width: 854, height: 480, label: '480p' },
    '720p': { width: 1280, height: 720, label: '720p' },
    '1080p': { width: 1920, height: 1080, label: '1080p' }
  }[normalized] || null;
}
function resolveOutputResolution(source = {}) {
  const preset = String(source.resolutionPreset || config.usbCapture?.resolutionPreset || 'source').trim().toLowerCase();
  if (preset === 'custom') {
    const width = Math.max(0, Number(source.outputWidth || config.usbCapture?.outputWidth || 0));
    const height = Math.max(0, Number(source.outputHeight || config.usbCapture?.outputHeight || 0));
    if (width > 0 && height > 0) return { width, height, label: `${width}x${height}` };
    return null;
  }
  return getResolutionPresetDimensions(preset);
}
function buildScaleFilter(width, height) {
  if (!(width > 0 && height > 0)) return '';
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
}
const LEGACY_MEDIA_EXTENSIONS = new Set(['.rm', '.rmvb', '.ra']);
const NO_TRANSCODE_DIRECT_EXTENSIONS = new Set(['.mp4', '.mp3']);
const PERMANENT_CONVERT_EXTENSIONS = { audio: '.mp3', video: '.mp4' };
const MEDIA_BACKUP_SUFFIX = '.lmsbak';
function getLegacyMediaInputArgs(fullPath = '') {
  const ext = path.extname(String(fullPath || '')).toLowerCase();
  if (!LEGACY_MEDIA_EXTENSIONS.has(ext)) return [];
  return [
    '-analyzeduration', '200M',
    '-probesize', '200M',
    '-fflags', '+genpts+discardcorrupt'
  ];
}
function isLegacyMediaFormat(fullPath = '') {
  return LEGACY_MEDIA_EXTENSIONS.has(path.extname(String(fullPath || '')).toLowerCase());
}
function shouldBypassTranscode(fullPath = '') {
  return NO_TRANSCODE_DIRECT_EXTENSIONS.has(path.extname(String(fullPath || '')).toLowerCase());
}
function getPermanentConvertedPath(fullPath = '', mediaType = 'video') {
  const targetExt = PERMANENT_CONVERT_EXTENSIONS[mediaType === 'audio' ? 'audio' : 'video'];
  return path.join(path.dirname(fullPath), `${path.basename(fullPath, path.extname(fullPath))}${targetExt}`);
}
function makeMediaBackupPath(fullPath = '') {
  const preferred = `${fullPath}${MEDIA_BACKUP_SUFFIX}`;
  if (!fs.existsSync(preferred)) return preferred;
  return `${fullPath}.${Date.now()}${MEDIA_BACKUP_SUFFIX}`;
}
const ffmpegEncoderCatalog = new Map();
function getAvailableVideoEncoders(ffmpegBinary) {
  if (ffmpegEncoderCatalog.has(ffmpegBinary)) return ffmpegEncoderCatalog.get(ffmpegBinary);
  const result = new Set(['libx264']);
  try {
    const probe = spawnSync(ffmpegBinary, ['-hide_banner', '-encoders'], {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: true
    });
    const text = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*V[\.\w]+\s+([a-z0-9_]+)/i);
      if (match) result.add(match[1]);
    }
  } catch {}
  ffmpegEncoderCatalog.set(ffmpegBinary, result);
  return result;
}
function resolveVideoEncoder(source, ffmpegBinary) {
  const available = getAvailableVideoEncoders(ffmpegBinary);
  const preferred = String(source.hwAccel || config.usbCapture?.hwAccel || 'auto').trim().toLowerCase();
  const choose = (codec, label, args = []) => available.has(codec) ? { codec, label, args } : null;
  const fallback = { codec: 'libx264', label: 'CPU / libx264', args: ['-preset', 'superfast', '-tune', 'zerolatency'] };
  if (preferred === 'none' || preferred === 'cpu' || preferred === 'libx264') return fallback;
  if (preferred === 'nvenc') return choose('h264_nvenc', 'NVIDIA NVENC', ['-preset', 'p1', '-tune', 'll']) || fallback;
  if (preferred === 'qsv' || preferred === 'intel') return choose('h264_qsv', 'Intel QSV') || fallback;
  if (preferred === 'amf' || preferred === 'amd') return choose('h264_amf', 'AMD AMF', ['-quality', 'speed']) || fallback;
  return choose('h264_nvenc', 'NVIDIA NVENC', ['-preset', 'p1', '-tune', 'll'])
    || choose('h264_qsv', 'Intel QSV')
    || choose('h264_amf', 'AMD AMF', ['-quality', 'speed'])
    || fallback;
}
function buildLiveVideoEncoderArgs(encoder = { codec: 'libx264', args: [] }, options = {}) {
  const frameRate = Math.max(1, Number(options.frameRate || 25));
  const videoBitrate = String(options.videoBitrate || '2500k');
  const maxRate = String(options.maxRate || videoBitrate);
  const bufSize = String(options.bufSize || '3500k');
  const codec = String(encoder?.codec || 'libx264').trim().toLowerCase();
  if (codec === 'libx264') {
    return [
      '-c:v', 'libx264',
      ...((encoder?.args || []).filter(Boolean)),
      '-profile:v', 'baseline',
      '-pix_fmt', 'yuv420p',
      '-g', String(frameRate),
      '-keyint_min', String(frameRate),
      '-sc_threshold', '0',
      '-bf', '0',
      '-b:v', videoBitrate,
      '-maxrate', maxRate,
      '-bufsize', bufSize
    ];
  }
  if (codec === 'h264_nvenc') {
    return [
      '-c:v', 'h264_nvenc',
      ...((encoder?.args || []).filter(Boolean)),
      '-rc', 'cbr',
      '-pix_fmt', 'yuv420p',
      '-g', String(frameRate),
      '-keyint_min', String(frameRate),
      '-bf', '0',
      '-b:v', videoBitrate,
      '-maxrate', maxRate,
      '-bufsize', bufSize
    ];
  }
  if (codec === 'h264_qsv') {
    return [
      '-c:v', 'h264_qsv',
      ...((encoder?.args || []).filter(Boolean)),
      '-look_ahead', '0',
      '-g', String(frameRate),
      '-bf', '0',
      '-b:v', videoBitrate,
      '-maxrate', maxRate,
      '-bufsize', bufSize
    ];
  }
  if (codec === 'h264_amf') {
    return [
      '-c:v', 'h264_amf',
      ...((encoder?.args || []).filter(Boolean)),
      '-g', String(frameRate),
      '-bf', '0',
      '-b:v', videoBitrate,
      '-maxrate', maxRate,
      '-bufsize', bufSize
    ];
  }
  return [
    '-c:v', codec || 'libx264',
    ...((encoder?.args || []).filter(Boolean)),
    '-g', String(frameRate),
    '-bf', '0',
    '-b:v', videoBitrate,
    '-maxrate', maxRate,
    '-bufsize', bufSize
  ];
}
function resolveFfmpegBinaryPath(source = null) {
  return resolveExistingPath([
    source?.ffmpegPath,
    config.usbCapture?.ffmpegPath,
    config.server?.ffmpegPath,
    path.join(rootDir, 'runtime', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(rootDir, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
    'ffmpeg'
  ]);
}
function resolveFfprobeBinaryPath(source = null) {
  const ffmpegBinary = resolveFfmpegBinaryPath(source);
  const dir = path.dirname(ffmpegBinary);
  return resolveExistingPath([
    path.join(dir, 'ffprobe.exe'),
    path.join(rootDir, 'runtime', 'ffmpeg', 'bin', 'ffprobe.exe'),
    path.join(rootDir, 'runtime', 'ffmpeg', 'ffprobe.exe'),
    'ffprobe'
  ]);
}
function getMediaTranscodeQualityProfiles() {
  return {
    mobile: {
      label: 'جودة هاتف',
      width: 854,
      height: 480,
      videoBitrate: '1200k',
      maxRate: '1500k',
      bufSize: '2500k',
      audioBitrate: '96k'
    },
    balanced: {
      label: 'متوسطة',
      width: 1280,
      height: 720,
      videoBitrate: '2200k',
      maxRate: '2800k',
      bufSize: '5000k',
      audioBitrate: '128k'
    },
    high: {
      label: 'عالية',
      width: 1920,
      height: 1080,
      videoBitrate: '4200k',
      maxRate: '5200k',
      bufSize: '8500k',
      audioBitrate: '160k'
    }
  };
}
function formatHwAccelSelectionLabel(value = 'auto') {
  const normalized = String(value || 'auto').trim().toLowerCase();
  if (normalized === 'nvenc') return 'NVIDIA NVENC';
  if (normalized === 'qsv' || normalized === 'intel') return 'Intel QSV';
  if (normalized === 'amf' || normalized === 'amd') return 'AMD AMF';
  if (normalized === 'cpu' || normalized === 'libx264' || normalized === 'none') return 'CPU / libx264';
  return 'تلقائي';
}
function getCpuTranscodePlan(profileId = 'balanced') {
  const cpuCount = Math.max(1, Number(os.cpus()?.length || 1));
  const profile = String(profileId || 'balanced').trim().toLowerCase();
  if (cpuCount <= 4) {
    return profile === 'high'
      ? { preset: 'veryfast', crf: 22, cpuCount }
      : { preset: 'superfast', crf: profile === 'mobile' ? 24 : 23, cpuCount };
  }
  if (cpuCount <= 8) {
    return profile === 'high'
      ? { preset: 'faster', crf: 21, cpuCount }
      : { preset: 'veryfast', crf: profile === 'mobile' ? 23 : 22, cpuCount };
  }
  return profile === 'high'
    ? { preset: 'fast', crf: 20, cpuCount }
    : { preset: 'faster', crf: profile === 'mobile' ? 22 : 21, cpuCount };
}
function resolveMediaTranscodeSettings(fullPath = '', mediaType = 'video') {
  const mediaCfg = normalizeMediaTranscodeConfig(config.mediaTranscode || {});
  const profiles = getMediaTranscodeQualityProfiles();
  const profile = profiles[mediaCfg.qualityProfile] || profiles.balanced;
  const ffmpegBinary = resolveFfmpegBinaryPath();
  const encoder = resolveVideoEncoder({ hwAccel: mediaCfg.hwAccel }, ffmpegBinary);
  const cpuPlan = getCpuTranscodePlan(mediaCfg.qualityProfile);
  const scaleFilter = mediaType === 'video' ? buildScaleFilter(profile.width, profile.height) : '';
  const audioBitrate = String(mediaCfg.audioBitrate || profile.audioBitrate || '160k');
  const base = {
    ffmpegBinary,
    encoder,
    cpuPlan,
    profileId: mediaCfg.qualityProfile,
    profileLabel: profile.label,
    scaleFilter,
    audioBitrate,
    hlsTime: Math.max(2, Number(mediaCfg.hlsTime || 4)),
    hlsListSize: Math.max(6, Number(mediaCfg.hlsListSize || 10)),
    videoBitrate: profile.videoBitrate,
    maxRate: profile.maxRate,
    bufSize: profile.bufSize
  };
  if (mediaType === 'audio') return base;
  if (encoder.codec === 'libx264') {
    return {
      ...base,
      videoArgs: [
        '-c:v', 'libx264',
        '-preset', cpuPlan.preset,
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-crf', String(cpuPlan.crf),
        '-maxrate', profile.maxRate,
        '-bufsize', profile.bufSize,
        '-movflags', '+faststart'
      ]
    };
  }
  const gpuArgs = ['-c:v', encoder.codec, ...encoder.args, '-b:v', profile.videoBitrate, '-maxrate', profile.maxRate, '-bufsize', profile.bufSize];
  if (encoder.codec === 'h264_qsv') gpuArgs.push('-look_ahead', '0');
  return { ...base, videoArgs: gpuArgs };
}
function resolvePermanentMediaConvertSettings(fullPath = '', mediaType = 'video') {
  const transcode = resolveMediaTranscodeSettings(fullPath, mediaType);
  if (mediaType === 'audio') {
    return {
      ...transcode,
      outputExt: '.mp3',
      outputArgs: [
        '-map', '0:a:0?',
        '-vn',
        '-sn',
        '-dn',
        '-c:a', 'libmp3lame',
        '-b:a', String(transcode.audioBitrate || '192k'),
        '-ac', '2',
        '-ar', '44100',
        '-f', 'mp3'
      ]
    };
  }
  const videoArgs = transcode.encoder?.codec === 'libx264'
    ? [
        '-c:v', 'libx264',
        '-preset', transcode.cpuPlan?.preset || 'veryfast',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-crf', String(transcode.cpuPlan?.crf || 22)
      ]
    : [
        '-c:v', transcode.encoder?.codec || 'libx264',
        ...(transcode.encoder?.args || []),
        '-b:v', String(transcode.videoBitrate || '2500k'),
        '-maxrate', String(transcode.maxRate || transcode.videoBitrate || '2500k'),
        '-bufsize', String(transcode.bufSize || '5000k')
      ];
  if ((transcode.encoder?.codec || '') === 'h264_qsv') videoArgs.push('-look_ahead', '0');
  return {
    ...transcode,
    outputExt: '.mp4',
    outputArgs: [
      '-map', '0:v:0?',
      '-map', '0:a:0?',
      '-sn',
      '-dn',
      ...videoArgs,
      '-c:a', 'aac',
      '-b:a', String(transcode.audioBitrate || '160k'),
      '-ac', '2',
      '-ar', '48000',
      '-movflags', '+faststart',
      '-f', 'mp4'
    ]
  };
}
function cleanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      cleanDir(full);
      try { fs.rmdirSync(full); } catch {}
    } else {
      try { fs.unlinkSync(full); } catch {}
    }
  }
}
function resolveExistingPath(candidates = []) {
  let commandFallback = '';
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = String(candidate).trim();
    if (!trimmed) continue;
    if (/^(ffmpeg|ffprobe)(?:\.exe)?$/i.test(trimmed)) {
      if (!commandFallback) commandFallback = trimmed;
      continue;
    }
    if (fs.existsSync(trimmed)) return trimmed;
  }
  return commandFallback || 'ffmpeg';
}
function decodeMediaPath(encoded = '') {
  try {
    const full = Buffer.from(String(encoded || ''), 'base64url').toString('utf8');
    if (!full.startsWith('\\\\') && !path.isAbsolute(full)) return '';
    return full;
  } catch {
    return '';
  }
}
function encodeMediaPath(fullPath = '') {
  return Buffer.from(String(fullPath || '')).toString('base64url');
}
function mediaPathFromStreamUrl(streamUrl = '') {
  const value = String(streamUrl || '');
  const prefix = '/media/';
  if (!value.startsWith(prefix)) return '';
  return decodeMediaPath(value.slice(prefix.length));
}
function getItemMediaPath(item = null) {
  return item?.path || mediaPathFromStreamUrl(item?.streamUrl || item?.url || '');
}

function hashPassword(password, salt) {
  const finalSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), finalSalt, 64).toString('hex');
  return `${finalSalt}:${hash}`;
}
function verifyPassword(password, encoded) {
  if (!encoded || !encoded.includes(':')) return false;
  const [salt] = encoded.split(':');
  return hashPassword(password, salt) === encoded;
}
function uid(prefix = 'id') { return prefix + '-' + crypto.randomBytes(8).toString('hex'); }
function parseMaybeJson(value, fallback = null) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function toBool(value) { return !!Number(value); }
function getSafeUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: toBool(row.active),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    deviceId: row.device_id || null,
    authType: row.auth_type || 'password'
  };
}
function sortKeyToSql(sort) {
  if (sort === 'old') return 'added_at ASC';
  if (sort === 'name') return 'title COLLATE NOCASE ASC';
  if (sort === 'created-desc') return 'created_at DESC';
  if (sort === 'created-asc') return 'created_at ASC';
  if (sort === 'updated-asc') return 'updated_at ASC';
  return 'updated_at DESC';
}
function isCustomMediaSort(sort = '') {
  return ['rating-desc', 'rating-asc', 'popular-desc', 'year-desc', 'year-asc', 'recommended-desc'].includes(String(sort || '').trim());
}
function extractGlobalRating(item = {}) {
  const candidates = [
    item.globalRating,
    item.rating,
    item.imdbRating,
    item.tmdbRating,
    item.voteAverage,
    item.vote_average,
    item.score,
    item.communityRating
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}
function extractItemYear(item = {}) {
  const direct = Number(item.year || 0);
  if (Number.isFinite(direct) && direct > 1800) return direct;
  const dates = [item.releaseDate, item.premiereDate, item.addedAt, item.updatedAt, item.createdAt];
  for (const value of dates) {
    const dt = new Date(value);
    const year = dt.getFullYear();
    if (Number.isFinite(year) && year > 1800) return year;
  }
  return 0;
}
function sanitizeDeviceId(value) { return String(value || '').trim().replace(/[^a-zA-Z0-9:_\-.]/g, '').slice(0, 120); }
function makeDeviceUsername(deviceId) { return `device-${sanitizeDeviceId(deviceId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || crypto.randomBytes(3).toString('hex')}`; }

(async () => {
  const appDb = await openAppDb(rootDir);
  const mediaDb = await openMediaDb(rootDir);
  const runtimeDb = await openRuntimeDb(rootDir);
  const usbCaptureRuntime = new Map();
  const webrtcSessions = new Map();

  function getWebrtcSession(sourceId) {
    if (!webrtcSessions.has(sourceId)) webrtcSessions.set(sourceId, { sourceId, publisherHeartbeatAt: 0, viewers: new Map() });
    return webrtcSessions.get(sourceId);
  }
  function cleanupWebrtcSessions() {
    const now = Date.now();
    for (const [sourceId, session] of webrtcSessions.entries()) {
      for (const [viewerId, viewer] of session.viewers.entries()) {
        if ((now - Number(viewer.updatedAt || 0)) > 2 * 60 * 1000) session.viewers.delete(viewerId);
      }
      if (!session.viewers.size && (now - Number(session.publisherHeartbeatAt || 0)) > 5 * 60 * 1000) webrtcSessions.delete(sourceId);
    }
  }
  function getWebrtcViewer(sourceId, viewerId) {
    const session = getWebrtcSession(sourceId);
    return session.viewers.get(viewerId) || null;
  }
  function makeDefaultWebrtcViewerUrl(sourceId) {
    return buildAppUrl(getWebrtcViewerPath(sourceId));
  }

  function getUsbSourceById(sourceId) {
    return (config.iptv?.sources || []).find(source => isLiveSource(source) && source.id === sourceId) || null;
  }
  function getUsbCaptureStatus(sourceId) {
    const state = usbCaptureRuntime.get(sourceId);
    const source = getUsbSourceById(sourceId);
    if (state) {
      return {
        state: state.state,
        startedAt: state.startedAt || null,
        stoppedAt: state.stoppedAt || null,
        pid: state.process?.pid || null,
        streamUrl: state.streamUrl || null,
        message: state.message || '',
        errorDetail: state.errorDetail || '',
        outputDir: state.outputDir || null,
        appliedResolution: state.appliedResolution || 'source',
        appliedScaleFilter: state.appliedScaleFilter || '',
        appliedVideoEncoder: state.appliedVideoEncoder || '',
        appliedHlsTime: state.appliedHlsTime || null,
        appliedHlsListSize: state.appliedHlsListSize || null,
        requestedHwAccel: source?.hwAccel || config.usbCapture?.hwAccel || 'auto',
        requestedVideoEncoder: formatHwAccelSelectionLabel(source?.hwAccel || config.usbCapture?.hwAccel || 'auto'),
        relayMode: state.relayMode || '',
        probeSummary: state.probeSummary || '',
        egress: state.egress || getLiveEgressConfig(source) || null
      };
    }
    if (source && isDirectLiveSource(source)) {
      const session = getWebrtcSession(sourceId);
      const hasPublisher = (Date.now() - Number(session.publisherHeartbeatAt || 0)) < 15000;
      return {
        state: source?.autoStart === false ? 'disabled' : (hasPublisher ? 'running' : 'waiting-publisher'),
        startedAt: hasPublisher ? new Date(session.publisherHeartbeatAt).toISOString() : null,
        stoppedAt: null,
        pid: null,
      streamUrl: getDirectLivePlaybackUrl(source),
      message: source?.autoStart === false
        ? 'هذا المصدر معطّل.'
        : (hasPublisher
            ? 'ناشر WebRTC متصل الآن ويمكن المشاهدة.'
            : 'هذا المصدر يعمل عبر WebRTC. افتح صفحة الناشر على جهاز الكاميرا لبدء البث.'),
        errorDetail: '',
        outputDir: null,
        appliedResolution: 'direct',
        appliedScaleFilter: '',
        appliedVideoEncoder: 'WebRTC',
        appliedHlsTime: null,
        appliedHlsListSize: null,
        requestedHwAccel: source?.hwAccel || config.usbCapture?.hwAccel || 'auto',
        requestedVideoEncoder: formatHwAccelSelectionLabel(source?.hwAccel || config.usbCapture?.hwAccel || 'auto'),
        relayMode: 'direct',
        probeSummary: '',
        egress: getLiveEgressConfig(source) || null
      };
    }
    return {
      state: source?.autoStart === false ? 'disabled' : 'idle',
      startedAt: null,
      stoppedAt: null,
      pid: null,
      streamUrl: source ? getSourcePlaybackUrl(source) : null,
      message: source ? 'لم يبدأ التشغيل بعد.' : 'المصدر غير موجود.',
      errorDetail: '',
      outputDir: source ? getUsbOutputDir(source) : null,
      appliedResolution: source ? (resolveOutputResolution(source)?.label || 'source') : 'source',
      appliedScaleFilter: source ? (resolveOutputResolution(source) ? buildScaleFilter(resolveOutputResolution(source).width, resolveOutputResolution(source).height) : '') : '',
      appliedVideoEncoder: source ? resolveVideoEncoder(source, getUsbFfmpegBinary(source)).label : '',
      appliedHlsTime: source ? Math.max(1, Number(source.hlsTime || config.usbCapture?.hlsTime || 2)) : null,
      appliedHlsListSize: source ? Math.max(3, Number(source.hlsListSize || config.usbCapture?.hlsListSize || 6)) : null,
      requestedHwAccel: source?.hwAccel || config.usbCapture?.hwAccel || 'auto',
      requestedVideoEncoder: formatHwAccelSelectionLabel(source?.hwAccel || config.usbCapture?.hwAccel || 'auto'),
      relayMode: '',
      probeSummary: '',
      egress: getLiveEgressConfig(source) || null
    };
  }
  function listUsbCaptureStatuses() {
    return (config.iptv?.sources || [])
      .filter(source => isLiveSource(source))
      .map(source => ({
        id: source.id,
        name: source.name,
        channelName: source.channelName,
        sourceType: source.sourceType,
        autoStart: source.autoStart !== false,
        ...getUsbCaptureStatus(source.id)
      }));
  }
  async function waitForUsbPlaylist(source, timeoutMs = USB_READY_TIMEOUT_MS) {
    const playlistPath = getUsbPlaylistPath(source);
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      if (hasReadyUsbPlaylist(source)) return true;
      await new Promise(resolve => setTimeout(resolve, USB_READY_POLL_MS));
    }
    return false;
  }
  function markUsbCaptureRunning(sourceId, message = '') {
    const runtime = usbCaptureRuntime.get(sourceId);
    if (!runtime) return;
    runtime.state = 'running';
    if (message) runtime.message = message;
  }
  async function ensureUsbCaptureReady(source, reason = 'viewer-open') {
    if (!source || !isManagedLiveSource(source)) return false;
    const allowRtmpIngestStart = isRtmpIngestSource(source) && isRtmpIngestPublisherActive(source);
    const startResult = startUsbCapture(source.id, { reason, ignoreAutoStart: allowRtmpIngestStart });
    if (!startResult.ok && startResult.error) throw new Error(startResult.error);
    const ready = await waitForUsbPlaylist(source);
    if (ready) {
      markUsbCaptureRunning(source.id, `البث المباشر جاهز الآن على ${getUsbStreamPublicUrl(source)}`);
      syncUsbChannels();
    }
    return ready;
  }
  function shouldRecoverUsbCapture(source, runtime) {
    if (!source || !runtime || !runtime.process) return false;
    const now = Date.now();
    const startedAt = Number(new Date(runtime.startedAt || 0).getTime() || 0);
    const playlistPath = getUsbPlaylistPath(source);
    let stats = null;
    try {
      if (fs.existsSync(playlistPath)) stats = fs.statSync(playlistPath);
    } catch {}
    const startupGraceMs = getManagedSourceStartupGraceMs(source);
    if (runtime.state === 'starting' && startedAt && (now - startedAt) > startupGraceMs && !stats) return true;
    if (runtime.state === 'running' && stats) {
      const updatedAt = Number(stats.mtimeMs || 0);
      if (updatedAt && (now - updatedAt) > USB_PLAYLIST_STALE_MS) return true;
    }
    return false;
  }
  function getUsbFfmpegBinary(source = null) {
    return resolveFfmpegBinaryPath(source);
  }
  function getFfprobeBinary(source = null) {
    return resolveFfprobeBinaryPath(source);
  }
  const mediaProbeCache = new Map();
  const mediaTranscodeRuntime = new Map();
  const channelRelayRuntime = new Map();
  const permanentMediaConvertRuntime = new Map();
  function mediaTranscodeKey(fullPath = '') {
    return crypto.createHash('sha1').update(String(fullPath || '')).digest('hex').slice(0, 16);
  }
  function getMediaTranscodeDir(fullPath = '') {
    return path.join(transcodesDir, mediaTranscodeKey(fullPath));
  }
  function getMediaTranscodePlaylistPath(fullPath = '') {
    return path.join(getMediaTranscodeDir(fullPath), 'index.m3u8');
  }
  function getMediaTranscodeSegmentPattern(fullPath = '') {
    return path.join(getMediaTranscodeDir(fullPath), 'segment-%05d.ts');
  }
  function getMediaTranscodeUrl(fullPath = '') {
    return `/transcoded/${mediaTranscodeKey(fullPath)}/index.m3u8`;
  }
  function channelRelayKey(channelId = '') {
    return sanitizeSourceSegment(channelId || 'channel');
  }
  function getChannelRelayDir(channelId = '') {
    return path.join(channelRelaysDir, channelRelayKey(channelId));
  }
  function getChannelRelayPlaylistPath(channelId = '') {
    return path.join(getChannelRelayDir(channelId), 'index.m3u8');
  }
  function getChannelRelaySegmentPattern(channelId = '') {
    return path.join(getChannelRelayDir(channelId), 'segment-%05d.ts');
  }
  function getChannelRelayUrl(channelId = '') {
    return `/channel-relays/${encodeURIComponent(channelRelayKey(channelId))}/index.m3u8`;
  }
  function getLocalHttpBaseUrl() {
    return `http://127.0.0.1:${Number(config.server?.port || 8088)}`;
  }
  function encodeProxyUrl(value = '') {
    return Buffer.from(String(value || ''), 'utf8').toString('base64url');
  }
  function decodeProxyUrl(value = '') {
    try { return Buffer.from(String(value || ''), 'base64url').toString('utf8'); } catch { return ''; }
  }
  function getChannelProxyPlaylistUrl(channelId = '', targetUrl = '') {
    const query = targetUrl ? `?u=${encodeURIComponent(encodeProxyUrl(targetUrl))}` : '';
    return `/channel-proxy/${encodeURIComponent(channelRelayKey(channelId))}/index.m3u8${query}`;
  }
  function getChannelProxySegmentUrl(channelId = '', targetUrl = '') {
    return `/channel-proxy/${encodeURIComponent(channelRelayKey(channelId))}/segment/${encodeProxyUrl(targetUrl)}.ts`;
  }
  function getChannelProxyAbsolutePlaylistUrl(channelId = '', targetUrl = '') {
    return `${getLocalHttpBaseUrl()}${getChannelProxyPlaylistUrl(channelId, targetUrl)}`;
  }
  function findChannelItemByRelayKey(channelKey = '') {
    const key = sanitizeSourceSegment(decodeURIComponent(String(channelKey || '').trim()));
    if (!key) return null;
    const row = mediaDb.all('SELECT raw_json FROM channels').find((entry) => {
      const item = rowToItem(entry);
      return item?.id && channelRelayKey(item.id) === key;
    }) || null;
    return row ? enrichChannelPlaybackItem(hydrateChannelItem(rowToItem(row))) : null;
  }
  function shouldProxyChannelInput(item = {}, directUrl = '') {
    return /^https?:\/\//i.test(String(directUrl || '')) && isHlsPlaylistUrl(directUrl) && shouldRelayChannelItem(item);
  }
  function resolveUrlAgainst(baseUrl = '', value = '') {
    try { return new URL(String(value || ''), baseUrl).toString(); } catch { return String(value || ''); }
  }
  function rewriteChannelProxyPlaylist(channelId = '', playlistText = '', playlistUrl = '') {
    const lines = String(playlistText || '').split(/\r?\n/);
    let previousDirective = '';
    return lines.map((rawLine) => {
      const line = String(rawLine || '').trim();
      if (!line) return rawLine;
      if (line.startsWith('#')) {
        previousDirective = line;
        return rawLine;
      }
      const absolute = resolveUrlAgainst(playlistUrl, line);
      const nestedPlaylist = /\.m3u8(?:$|[?#])/i.test(line) || /^#EXT-X-STREAM-INF/i.test(previousDirective);
      previousDirective = '';
      return nestedPlaylist
        ? getChannelProxyPlaylistUrl(channelId, absolute)
        : getChannelProxySegmentUrl(channelId, absolute);
    }).join('\n');
  }
  function shouldRelayChannelItem(item = {}) {
    if (!item) return false;
    if (item.sourceId && LIVE_SOURCE_TYPES.includes(String(item.sourceType || '').trim().toLowerCase())) {
      return false;
    }
    const directUrl = String(item.streamUrl || item.url || '').trim();
    if (!directUrl || !isStreamInputUrl(directUrl)) return false;
    return /^https?:\/\//i.test(directUrl) || /\.(m3u8|ts)(?:$|\?)/i.test(directUrl);
  }
  function isGroupDisabled(groupTitle) {
    if (!groupTitle) return false;
    const disabled = config.iptv?.disabledGroups || [];
    return disabled.some(g => String(g || '').trim().toLowerCase() === String(groupTitle).trim().toLowerCase());
  }
  function isChannelGroupDisabled(item) {
    if (!item) return false;
    return isGroupDisabled(item.groupTitle || item.group_title);
  }
  function enrichChannelPlaybackItem(item = null) {
    if (!item) return item;
    const directUrl = String(item.streamUrl || item.url || '').trim();
    if (!directUrl) return item;
    const relayUrl = shouldRelayChannelItem(item) ? getChannelRelayUrl(item.id) : '';
    return {
      ...item,
      directStreamUrl: directUrl,
      preferredStreamUrl: relayUrl || directUrl,
      playbackMode: relayUrl ? 'channel-relay-hls' : 'channel-direct'
    };
  }
  function getChannelRelaySourceConfig(item = {}) {
    const sourceId = String(item?.sourceId || '').trim();
    const sourceConfig = (config.iptv?.sources || []).find(source => String(source?.id || '') === sourceId) || {};
    const streamSettings = normalizeChannelStreamSettings(item?.streamSettings);
    return {
      ...sourceConfig,
      ...streamSettings,
      id: sourceConfig.id || sourceId || 'channel-relay',
      name: sourceConfig.name || item?.sourceName || item?.title || 'Channel Relay',
      sourceType: 'hls'
    };
  }
  function inspectMediaFile(fullPath = '') {
    const cacheKey = String(fullPath || '');
    const cached = mediaProbeCache.get(cacheKey);
    if (cached && (Date.now() - cached.updatedAt) < 10 * 60 * 1000) return cached.value;
    const ffprobeBinary = getFfprobeBinary();
    const result = spawnSync(ffprobeBinary, [...getLegacyMediaInputArgs(fullPath), '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', fullPath], {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: true
    });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout || '{}'); } catch {}
    const value = {
      ok: !result.error && result.status === 0 && !!parsed,
      probe: parsed || null,
      error: result.error?.message || (result.status !== 0 ? (result.stderr || result.stdout || 'ffprobe failed') : '')
    };
    mediaProbeCache.set(cacheKey, { updatedAt: Date.now(), value });
    return value;
  }
  function isDirectPlayCompatible(fullPath = '', mediaType = 'video') {
    if (!fullPath) return { directPlay: false, reason: 'missing-path' };
    const ext = path.extname(fullPath).toLowerCase();
    if (shouldBypassTranscode(fullPath)) {
      return {
        directPlay: true,
        reason: 'direct-extension-bypass',
        bypassTranscode: true,
        extension: ext
      };
    }
    if (mediaType === 'audio') {
      return { directPlay: ['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav'].includes(ext), reason: 'audio-extension-check' };
    }
    const inspection = inspectMediaFile(fullPath);
    if (inspection.ok && inspection.probe) {
      const streams = Array.isArray(inspection.probe.streams) ? inspection.probe.streams : [];
      const video = streams.find(stream => stream.codec_type === 'video') || null;
      const audio = streams.find(stream => stream.codec_type === 'audio') || null;
      const videoCodec = String(video?.codec_name || '').toLowerCase();
      const audioCodec = String(audio?.codec_name || '').toLowerCase();
      if (['.mp4', '.m4v'].includes(ext)) {
        const videoOk = ['h264', 'av1'].includes(videoCodec);
        const audioOk = !audio || ['aac', 'mp3', 'mp4a'].includes(audioCodec);
        return { directPlay: !!videoOk && !!audioOk, reason: 'mp4-codec-check', videoCodec, audioCodec };
      }
      if (ext === '.webm') {
        const videoOk = ['vp8', 'vp9', 'av1'].includes(videoCodec);
        const audioOk = !audio || ['opus', 'vorbis'].includes(audioCodec);
        return { directPlay: !!videoOk && !!audioOk, reason: 'webm-codec-check', videoCodec, audioCodec };
      }
      return { directPlay: false, reason: 'container-not-browser-native', videoCodec, audioCodec };
    }
    return { directPlay: false, reason: inspection.error ? `probe-failed:${inspection.error}` : 'probe-unavailable' };
  }
  function cleanupMediaTranscodes() {
    const now = Date.now();
    for (const [key, runtime] of mediaTranscodeRuntime.entries()) {
      if (runtime.process && (now - Number(runtime.lastAccessAt || 0)) > 45 * 60 * 1000) {
        try { runtime.process.kill('SIGTERM'); } catch {}
      }
      if (!runtime.process && (now - Number(runtime.lastAccessAt || 0)) > 60 * 60 * 1000) {
        mediaTranscodeRuntime.delete(key);
      }
    }
  }
  function cleanupChannelRelays() {
    const now = Date.now();
    const keepAlive = config.iptv?.keepRelaysAlive === true;
    for (const [key, runtime] of channelRelayRuntime.entries()) {
      if (!keepAlive && runtime.process && (now - Number(runtime.lastAccessAt || 0)) > 30 * 60 * 1000) {
        try { runtime.process.kill('SIGTERM'); } catch {}
      }
      if (!runtime.process && (now - Number(runtime.lastAccessAt || 0)) > 45 * 60 * 1000) {
        channelRelayRuntime.delete(key);
      }
    }
  }

  function autoStartChannelRelays() {
    if (config.iptv?.keepRelaysAlive !== true) return;
    try {
      const rows = mediaDb.all("SELECT raw_json FROM channels WHERE hidden = 0");
      let startedCount = 0;
      const MAX_STAGGER_PER_TICK = 3;
      for (const row of rows) {
        const item = rowToItem(row);
        if (item && shouldRelayChannelItem(item) && !isChannelGroupDisabled(item)) {
          const sourceId = String(item.sourceId || '').trim();
          const sourceConfig = (config.iptv?.sources || []).find(src => String(src?.id || '') === sourceId);
          if (sourceConfig && sourceConfig.enabled === false) {
            const key = channelRelayKey(item.id);
            const current = channelRelayRuntime.get(key);
            if (current?.process) {
              try { current.process.kill('SIGTERM'); } catch {}
              current.process = null;
            }
            continue;
          }
          const key = channelRelayKey(item.id);
          const current = channelRelayRuntime.get(key);
          if (current) {
            if (current.process) {
              current.lastAccessAt = Date.now();
              continue;
            }
            if (current.stoppedAt) {
              const lastStop = Date.parse(current.stoppedAt);
              if (Date.now() - lastStop < 60000) {
                continue;
              }
            }
          }
          if (startedCount >= MAX_STAGGER_PER_TICK) {
            continue;
          }
          try {
            ensureChannelRelay(item);
            startedCount++;
            console.log(`[watchdog] Staggered start channel relay for: ${item.name} (${startedCount}/${MAX_STAGGER_PER_TICK})`);
          } catch (e) {
            // ignore error
          }
        }
      }
    } catch (err) {
      console.error('[watchdog] autoStartChannelRelays error:', err.message);
    }
  }

  async function runFfmpegProcess(ffmpegBinary, ffmpegArgs, runtime = null) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegBinary, ffmpegArgs, {
        cwd: rootDir,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
      if (runtime) runtime.process = child;
      let lastMessage = '';
      child.stderr.on('data', chunk => {
        const text = String(chunk || '').trim();
        if (!text) return;
        lastMessage = text.slice(-500);
        if (runtime) runtime.message = lastMessage;
      });
      child.on('error', error => {
        if (runtime) runtime.process = null;
        reject(new Error(error?.message || 'تعذر تشغيل FFmpeg.'));
      });
      child.on('close', code => {
        if (runtime) runtime.process = null;
        if (code === 0) resolve(lastMessage);
        else reject(new Error(lastMessage || `توقف FFmpeg برمز ${code}.`));
      });
    });
  }
  function ensureChannelRelay(item = null) {
    cleanupChannelRelays();
    const originalDirectUrl = String(item?.streamUrl || item?.url || '').trim();
    if (!item?.id || !originalDirectUrl) throw new Error('القناة لا تحتوي رابط بث صالح.');
    const key = channelRelayKey(item.id);
    const outputDir = getChannelRelayDir(item.id);
    const playlistPath = getChannelRelayPlaylistPath(item.id);
    const segmentPattern = getChannelRelaySegmentPattern(item.id);
    const current = channelRelayRuntime.get(key);
    if (current?.process) {
      current.lastAccessAt = Date.now();
      return { key, outputDir, playlistPath, url: getChannelRelayUrl(item.id), started: false };
    }
    cleanDir(outputDir);
    fs.mkdirSync(outputDir, { recursive: true });
    const sourceConfig = getChannelRelaySourceConfig(item);
    const relayInputUrl = shouldProxyChannelInput(item, originalDirectUrl)
      ? getChannelProxyAbsolutePlaylistUrl(item.id, originalDirectUrl)
      : originalDirectUrl;
    const directUrl = getPreferredHttpLiveInputUrl(sourceConfig, relayInputUrl);
    const ffmpegBinary = getUsbFfmpegBinary(sourceConfig);
    const sourceLike = {
      ...sourceConfig,
      sourceType: 'hls',
      resolutionPreset: sourceConfig.resolutionPreset || config.usbCapture?.resolutionPreset || 'source',
      outputWidth: Number(sourceConfig.outputWidth || config.usbCapture?.outputWidth || 0),
      outputHeight: Number(sourceConfig.outputHeight || config.usbCapture?.outputHeight || 0),
      hwAccel: sourceConfig.hwAccel || config.usbCapture?.hwAccel || 'auto'
    };
    const outputResolution = resolveOutputResolution(sourceLike);
    const scaleFilter = outputResolution ? buildScaleFilter(outputResolution.width, outputResolution.height) : '';
    const videoEncoder = resolveVideoEncoder(sourceLike, ffmpegBinary);
    const hlsTime = Math.max(1, Number(sourceConfig.hlsTime || config.usbCapture?.hlsTime || 2));
    const hlsListSize = Math.max(3, Number(sourceConfig.hlsListSize || config.usbCapture?.hlsListSize || 6));
    const videoBitrate = String(sourceConfig.videoBitrate || config.usbCapture?.videoBitrate || '2500k');
    const maxRate = String(sourceConfig.maxRate || config.usbCapture?.maxRate || videoBitrate);
    const bufSize = String(sourceConfig.bufSize || config.usbCapture?.bufSize || '3500k');
    const audioBitrate = String(sourceConfig.audioBitrate || config.usbCapture?.audioBitrate || '96k');
    const frameRate = Math.max(24, Number(sourceConfig.frameRate || config.usbCapture?.frameRate || 25));
    const inputArgs = [];
    if (/^https?:\/\//i.test(directUrl)) {
      if (directUrl === originalDirectUrl) inputArgs.push(...buildHttpInputHeaderArgs(getChannelHttpRequestHeaders(item)));
      inputArgs.push(...buildHttpReconnectInputArgs(directUrl));
    }
    if (/^rtsp:\/\//i.test(directUrl)) inputArgs.push('-rtsp_transport', 'tcp');
    const relayPlan = buildManagedLiveHlsArgs({
      source: { ...sourceLike, sourceType: 'hls' },
      ffmpegBinary,
      inputArgs,
      inputUrl: directUrl,
      scaleFilter,
      videoEncoder,
      videoBitrate,
      maxRate,
      bufSize,
      audioBitrate,
      frameRate,
      hlsTime,
      hlsListSize,
      segmentPattern,
      playlistPath
    });
    const ffmpegArgs = relayPlan.args;
      const runtime = {
        key,
        itemId: item.id,
        title: item.title || item.sourceName || item.id,
        inputUrl: directUrl,
        requestHeaders: getChannelHttpRequestHeaders(item),
      outputDir,
      playlistPath,
      process: null,
      lastAccessAt: Date.now(),
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        message: 'جاري تجهيز Relay HLS للقناة...',
        errorDetail: '',
        appliedVideoEncoder: relayPlan.appliedVideoEncoder || videoEncoder.label,
        appliedResolution: relayPlan.relayMode === 'copy' ? 'source' : (outputResolution ? outputResolution.label : 'source'),
        relayMode: relayPlan.relayMode || 'transcode',
        probeSummary: relayPlan.inputProbe?.streamSummary || ''
      };
    channelRelayRuntime.set(key, runtime);
    const child = spawn(ffmpegBinary, ffmpegArgs, {
      cwd: rootDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    runtime.process = child;
    child.stderr.on('data', chunk => {
      const text = String(chunk || '').trim();
      if (!text) return;
      runtime.message = text.slice(-500);
      runtime.errorDetail = runtime.message;
    });
    child.on('error', error => {
      runtime.process = null;
      runtime.stoppedAt = new Date().toISOString();
      runtime.message = `تعذر تشغيل FFmpeg: ${error.message}`;
      runtime.errorDetail = runtime.message;
    });
    child.on('close', code => {
      runtime.process = null;
      runtime.stoppedAt = new Date().toISOString();
      runtime.message = code === 0
        ? 'توقف Relay HLS للقناة.'
        : `توقف Relay HLS برمز ${code}.`;
      if (runtime.errorDetail && code !== 0) runtime.message += ` ${runtime.errorDetail}`;
    });
    return { key, outputDir, playlistPath, url: getChannelRelayUrl(item.id), started: true };
  }
  function updateMovieOrAudioMediaReference(type = '', id = '', newPath = '') {
    const dbType = type === 'audio' ? 'audio' : 'movies';
    const row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', [dbType, id]);
    if (!row?.raw_json) return false;
    const item = rowToItem(row);
    if (!item) return false;
    const now = new Date().toISOString();
    item.path = newPath;
    item.streamUrl = relativeMedia(newPath);
    item.updatedAt = now;
    mediaDb.run('UPDATE media_items SET path = ?, stream_url = ?, updated_at = ?, raw_json = ? WHERE type = ? AND id = ?', [newPath, item.streamUrl, now, JSON.stringify(item), dbType, id]);
    mediaDb.save();
    return true;
  }
  function updateEpisodeMediaReference(id = '', newPath = '') {
    const rows = mediaDb.all('SELECT id, raw_json FROM media_items WHERE type = ?', ['series']);
    const now = new Date().toISOString();
    for (const row of rows) {
      const show = rowToItem(row);
      if (!show?.seasons) continue;
      let changed = false;
      for (const seasonKey of Object.keys(show.seasons || {})) {
        const episodes = Array.isArray(show.seasons[seasonKey]) ? show.seasons[seasonKey] : [];
        for (const episode of episodes) {
          if (String(episode?.id || '') !== String(id || '')) continue;
          episode.path = newPath;
          episode.streamUrl = relativeMedia(newPath);
          episode.updatedAt = now;
          changed = true;
          break;
        }
        if (changed) break;
      }
      if (!changed) continue;
      show.updatedAt = now;
      mediaDb.run('UPDATE media_items SET updated_at = ?, raw_json = ? WHERE type = ? AND id = ?', [now, JSON.stringify(show), 'series', show.id]);
      mediaDb.save();
      return true;
    }
    return false;
  }
  async function ensurePermanentMediaConversion(fullPath = '', mediaType = 'video') {
    const normalizedType = mediaType === 'audio' ? 'audio' : 'video';
    if (!fullPath || !fs.existsSync(fullPath)) throw new Error('الملف الأصلي غير موجود.');
    if (shouldBypassTranscode(fullPath)) return { path: fullPath, converted: false, bypassed: true };
    const targetPath = getPermanentConvertedPath(fullPath, normalizedType);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      let backupPath = '';
      if (fs.existsSync(fullPath) && path.resolve(fullPath) !== path.resolve(targetPath)) {
        backupPath = makeMediaBackupPath(fullPath);
        fs.renameSync(fullPath, backupPath);
      }
      return { path: targetPath, converted: false, reused: true, backupPath };
    }
    const runtimeKey = `${normalizedType}:${fullPath}`;
    const existing = permanentMediaConvertRuntime.get(runtimeKey);
    if (existing?.promise) return existing.promise;
    const runtime = { process: null, message: '', sourcePath: fullPath, targetPath, startedAt: new Date().toISOString() };
    const promise = (async () => {
      const settings = resolvePermanentMediaConvertSettings(fullPath, normalizedType);
      const tempPath = path.join(
        path.dirname(targetPath),
        `${path.basename(targetPath, settings.outputExt)}.tmp-${Date.now()}${settings.outputExt}`
      );
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-y',
        ...getLegacyMediaInputArgs(fullPath),
        '-i', fullPath,
        ...settings.outputArgs,
        tempPath
      ];
      try {
        await runFfmpegProcess(settings.ffmpegBinary, ffmpegArgs, runtime);
        if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size <= 0) throw new Error('ملف التحويل الناتج غير صالح.');
        if (fs.existsSync(targetPath)) {
          try { fs.unlinkSync(targetPath); } catch {}
        }
        fs.renameSync(tempPath, targetPath);
        const backupPath = makeMediaBackupPath(fullPath);
        fs.renameSync(fullPath, backupPath);
        mediaProbeCache.delete(String(fullPath || ''));
        mediaProbeCache.delete(String(targetPath || ''));
        return { path: targetPath, backupPath, converted: true, reused: false };
      } catch (error) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        throw error;
      } finally {
        permanentMediaConvertRuntime.delete(runtimeKey);
      }
    })();
    permanentMediaConvertRuntime.set(runtimeKey, { ...runtime, promise });
    return promise;
  }
  async function findLibraryPlaybackItem(type = '', id = '') {
    if (type === 'movie') {
      const row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', ['movies', id]);
      return row ? rowToItem(row) : null;
    }
    if (type === 'audio') {
      const row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', ['audio', id]);
      return row ? rowToItem(row) : null;
    }
    if (type === 'episode') {
      const rows = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ?', ['series']);
      for (const r of rows) {
        const show = rowToItem(r);
        for (const eps of Object.values(show?.seasons || {})) {
          const ep = (eps || []).find(entry => entry.id === id);
          if (ep) return { ...ep, showTitle: show.title, poster: show.poster, libraryId: show.libraryId, libraryName: show.libraryName };
        }
      }
      return null;
    }
    return null;
  }
  async function ensurePortableLibraryMedia(type = '', id = '') {
    const item = await findLibraryPlaybackItem(type, id);
    if (!item) throw new Error('العنصر غير موجود.');
    const mediaPath = getItemMediaPath(item);
    if (!mediaPath || !fs.existsSync(mediaPath)) throw new Error('ملف الوسائط غير موجود.');
    const mediaType = type === 'audio' ? 'audio' : 'video';
    const result = await ensurePermanentMediaConversion(mediaPath, mediaType);
    const finalPath = result.path || mediaPath;
    if (finalPath !== mediaPath) {
      if (type === 'audio' || type === 'movie') updateMovieOrAudioMediaReference(type, id, finalPath);
      else if (type === 'episode') updateEpisodeMediaReference(id, finalPath);
    }
    return { ...result, path: finalPath, item };
  }
  const libraryConvertJobs = new Map();
  function summarizeLibraryConvertJob(job = null) {
    if (!job) return null;
    const total = Number(job.total || 0);
    const processed = Number(job.processed || 0);
    return {
      libraryId: job.libraryId,
      libraryName: job.libraryName,
      libraryType: job.libraryType,
      running: !!job.running,
      startedAt: job.startedAt || null,
      endedAt: job.endedAt || null,
      total,
      processed,
      converted: Number(job.converted || 0),
      skipped: Number(job.skipped || 0),
      failed: Number(job.failed || 0),
      percent: total ? Math.min(100, Math.round((processed / total) * 100)) : 0,
      currentTitle: job.currentTitle || '',
      message: job.message || ''
    };
  }
  function listLibraryConvertJobs() {
    return [...libraryConvertJobs.values()].map(summarizeLibraryConvertJob);
  }
  function getLibraryConvertJob(libraryId = '') {
    return summarizeLibraryConvertJob(libraryConvertJobs.get(String(libraryId || '').trim()) || null);
  }
  function buildLibraryConvertTargets(library = null) {
    if (!library?.id) return [];
    const targets = [];
    const pushTarget = (entry) => {
      if (!entry?.id || !entry?.path) return;
      targets.push(entry);
    };
    if (library.type === 'movies' || library.type === 'mixed') {
      const wantedTypes = library.type === 'mixed' ? ['movies', 'audio'] : ['movies'];
      for (const wantedType of wantedTypes) {
        const rows = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ? AND library_id = ?', [wantedType, library.id]);
        for (const row of rows) {
          const item = rowToItem(row);
          if (!item?.path) continue;
          pushTarget({
            type: wantedType === 'audio' ? 'audio' : 'movie',
            id: item.id,
            title: item.title || item.mediaFolder || path.basename(item.path || ''),
            path: item.path
          });
        }
      }
    }
    if (library.type === 'audio') {
      const rows = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ? AND library_id = ?', ['audio', library.id]);
      for (const row of rows) {
        const item = rowToItem(row);
        if (!item?.path) continue;
        pushTarget({
          type: 'audio',
          id: item.id,
          title: item.title || item.mediaFolder || path.basename(item.path || ''),
          path: item.path
        });
      }
    }
    if (library.type === 'series') {
      const rows = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ? AND library_id = ?', ['series', library.id]);
      for (const row of rows) {
        const show = rowToItem(row);
        for (const episodes of Object.values(show?.seasons || {})) {
          for (const episode of (episodes || [])) {
            if (!episode?.path) continue;
            pushTarget({
              type: 'episode',
              id: episode.id,
              title: `${show?.title || 'مسلسل'} - ${episode.title || ''}`.trim(),
              path: episode.path
            });
          }
        }
      }
    }
    return targets;
  }
  function startLibraryConvertJob(libraryId = '') {
    const library = (config.libraries || []).find(entry => String(entry.id || '').trim() === String(libraryId || '').trim());
    if (!library) throw new Error('المكتبة غير موجودة.');
    const existing = libraryConvertJobs.get(library.id);
    if (existing?.running) return summarizeLibraryConvertJob(existing);
    const targets = buildLibraryConvertTargets(library);
    const job = {
      libraryId: library.id,
      libraryName: library.name || library.id,
      libraryType: library.type || 'movies',
      running: true,
      startedAt: new Date().toISOString(),
      endedAt: null,
      total: targets.length,
      processed: 0,
      converted: 0,
      skipped: 0,
      failed: 0,
      currentTitle: '',
      message: targets.length ? 'تم بدء التحويل المسبق للمكتبة.' : 'لا توجد ملفات تحتاج تحويلًا في هذه المكتبة.'
    };
    libraryConvertJobs.set(library.id, job);
    const finalize = () => {
      job.running = false;
      job.endedAt = new Date().toISOString();
      if (!targets.length) job.message = 'لا توجد ملفات تحتاج تحويلًا. تم تخطي mp3/mp4.';
      else if (job.failed) job.message = `اكتمل التحويل مع ${job.failed} ملف فشل.`;
      else job.message = 'اكتمل التحويل المسبق للمكتبة.';
    };
    job.promise = (async () => {
      for (const target of targets) {
        job.currentTitle = target.title || path.basename(target.path || '');
        job.message = `جاري تحويل: ${job.currentTitle}`;
        try {
          if (!target.path || !fs.existsSync(target.path)) {
            job.skipped += 1;
          } else if (shouldBypassTranscode(target.path)) {
            job.skipped += 1;
          } else {
            const result = await ensurePortableLibraryMedia(target.type, target.id);
            if (result?.converted || result?.reused) job.converted += 1;
            else job.skipped += 1;
          }
        } catch (error) {
          job.failed += 1;
          job.message = `فشل تحويل: ${job.currentTitle} • ${toSingleLine(error?.message || 'unknown error')}`;
        } finally {
          job.processed += 1;
        }
      }
      finalize();
    })().catch(error => {
      job.failed += 1;
      job.message = toSingleLine(error?.message || 'فشل غير متوقع أثناء تحويل المكتبة.');
      finalize();
    });
    return summarizeLibraryConvertJob(job);
  }
  async function waitForFile(filePath, timeoutMs = 5000) {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return true;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return fs.existsSync(filePath);
  }
  function ensureMediaTranscode(fullPath = '', mediaType = 'video') {
    cleanupMediaTranscodes();
    const key = `${mediaType}:${mediaTranscodeKey(fullPath)}`;
    const outputDir = getMediaTranscodeDir(fullPath);
    const playlistPath = getMediaTranscodePlaylistPath(fullPath);
    const segmentPattern = getMediaTranscodeSegmentPattern(fullPath);
    const current = mediaTranscodeRuntime.get(key);
    if (current?.process) {
      current.lastAccessAt = Date.now();
      return { key, outputDir, playlistPath, url: getMediaTranscodeUrl(fullPath), started: false };
    }
    cleanDir(outputDir);
    fs.mkdirSync(outputDir, { recursive: true });
    const transcodeSettings = resolveMediaTranscodeSettings(fullPath, mediaType === 'audio' ? 'audio' : 'video');
    const ffmpegBinary = transcodeSettings.ffmpegBinary;
    const inputArgs = getLegacyMediaInputArgs(fullPath);
    const ffmpegArgs = mediaType === 'audio'
      ? [
          '-hide_banner',
          '-loglevel', 'warning',
          '-y',
          ...inputArgs,
          '-i', fullPath,
          '-map', '0:a:0?',
          '-vn',
          '-sn',
          '-dn',
          '-c:a', 'aac',
          '-b:a', transcodeSettings.audioBitrate,
          '-ac', '2',
          '-ar', '48000',
          '-f', 'hls',
          '-hls_init_time', '0',
          '-hls_time', String(transcodeSettings.hlsTime),
          '-hls_list_size', String(transcodeSettings.hlsListSize),
          '-hls_allow_cache', '0',
          '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
          '-hls_segment_filename', segmentPattern,
          playlistPath
        ]
      : [
          '-hide_banner',
          '-loglevel', 'warning',
          '-y',
          ...inputArgs,
          '-i', fullPath,
          '-map', '0:v:0?',
          '-map', '0:a:0?',
          '-sn',
          '-dn',
          ...(transcodeSettings.scaleFilter ? ['-vf', transcodeSettings.scaleFilter] : []),
          ...transcodeSettings.videoArgs,
          '-c:a', 'aac',
          '-b:a', transcodeSettings.audioBitrate,
          '-ac', '2',
          '-ar', '48000',
          '-f', 'hls',
          '-hls_init_time', '0',
          '-hls_time', String(transcodeSettings.hlsTime),
          '-hls_list_size', String(transcodeSettings.hlsListSize),
          '-hls_allow_cache', '0',
          '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
          '-hls_segment_filename', segmentPattern,
          playlistPath
        ];
    const child = spawn(ffmpegBinary, ffmpegArgs, {
      cwd: rootDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    const runtime = {
      key,
      fullPath,
      outputDir,
      playlistPath,
      process: child,
      startedAt: new Date().toISOString(),
      lastAccessAt: Date.now(),
      message: '',
      state: 'starting',
      encoderLabel: transcodeSettings.encoder?.label || 'CPU / libx264',
      qualityProfile: transcodeSettings.profileLabel || transcodeSettings.profileId || 'balanced'
    };
    mediaTranscodeRuntime.set(key, runtime);
    child.stderr.on('data', chunk => {
      const text = String(chunk || '').trim();
      if (text) runtime.message = text.slice(-240);
    });
    child.on('error', err => {
      runtime.process = null;
      runtime.state = 'error';
      runtime.message = err.message;
    });
    child.on('close', code => {
      runtime.process = null;
      runtime.state = code === 0 ? 'stopped' : 'error';
      runtime.message = code === 0 ? 'انتهى البث المحول.' : `توقف FFmpeg برمز ${code}.`;
    });
    return { key, outputDir, playlistPath, url: getMediaTranscodeUrl(fullPath), started: true };
  }
  function parseDshowDevices(stderrText = '') {
    const video = [];
    const audio = [];
    let currentType = '';
    let pendingDevice = null;
    const pushDevice = (type, device) => {
      if (!type || !device?.label) return;
      const list = type === 'video' ? video : audio;
      const sameLabelCount = list.filter(item => item.label === device.label).length;
      list.push({
        kind: type,
        label: device.label,
        input: device.alternativeName || device.label,
        alternativeName: device.alternativeName || '',
        displayName: sameLabelCount ? `${device.label} (${sameLabelCount + 1})` : device.label
      });
    };
    for (const rawLine of String(stderrText || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.includes('DirectShow video devices')) {
        if (pendingDevice) pushDevice(currentType, pendingDevice);
        currentType = 'video';
        pendingDevice = null;
        continue;
      }
      if (line.includes('DirectShow audio devices')) {
        if (pendingDevice) pushDevice(currentType, pendingDevice);
        currentType = 'audio';
        pendingDevice = null;
        continue;
      }
      if (line.includes('Could not enumerate audio only devices')) {
        if (pendingDevice) pushDevice(currentType, pendingDevice);
        currentType = 'audio';
        pendingDevice = null;
        continue;
      }
      const match = line.match(/"([^"]+)"/);
      if (!match) continue;
      const name = match[1];
      const inferredType = line.includes('(audio)') ? 'audio' : line.includes('(video)') ? 'video' : '';
      if (inferredType && currentType !== inferredType) {
        if (pendingDevice) pushDevice(currentType, pendingDevice);
        currentType = inferredType;
        pendingDevice = null;
      }
      if (!currentType && !name.startsWith('@device_')) currentType = inferredType || 'video';
      if (!currentType) continue;
      if (line.includes('Alternative name') || name.startsWith('@device_')) {
        if (pendingDevice) pendingDevice.alternativeName = name;
        continue;
      }
      if (pendingDevice) pushDevice(currentType, pendingDevice);
      pendingDevice = { label: name, alternativeName: '' };
    }
    if (pendingDevice) pushDevice(currentType, pendingDevice);
    return { video, audio };
  }
  function collectActiveUsbDeviceUsage() {
    const usage = {
      video: new Map(),
      audio: new Map()
    };
    for (const source of (config.iptv?.sources || []).filter(entry => entry?.sourceType === 'usb_capture')) {
      const runtime = usbCaptureRuntime.get(source.id);
      const state = runtime?.state || (source.autoStart === false ? 'disabled' : 'configured');
      const runningNow = !!runtime?.process && (runtime.state === 'running' || runtime.state === 'starting');
      if (source.deviceName) {
        usage.video.set(source.deviceName, {
          sourceId: source.id,
          sourceName: source.channelName || source.name || source.id,
          state,
          runningNow
        });
      }
      if (source.audioDeviceName) {
        usage.audio.set(source.audioDeviceName, {
          sourceId: source.id,
          sourceName: source.channelName || source.name || source.id,
          state,
          runningNow
        });
      }
    }
    return usage;
  }
  function applyUsbDeviceUsage(devices, usageMap, kind) {
    return (devices || []).map(device => {
      const usage = usageMap.get(device.input) || usageMap.get(device.alternativeName) || usageMap.get(device.label) || null;
      return {
        ...device,
        kind,
        active: !!usage,
        runningNow: !!usage?.runningNow,
        activeState: usage?.state || 'available',
        activeSourceId: usage?.sourceId || '',
        activeSourceName: usage?.sourceName || ''
      };
    });
  }
  function listUsbDevices() {
    return new Promise((resolve) => {
      const ffmpegBinary = getUsbFfmpegBinary();
      const child = spawn(ffmpegBinary, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { cwd: rootDir, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk || ''); });
      child.on('error', err => resolve({ ok: false, error: `تعذر تشغيل FFmpeg: ${err.message}`, video: [], audio: [], ffmpegPath: ffmpegBinary }));
      child.on('close', () => {
        const parsed = parseDshowDevices(stderr);
        const usage = collectActiveUsbDeviceUsage();
        resolve({
          ok: true,
          video: applyUsbDeviceUsage(parsed.video, usage.video, 'video'),
          audio: applyUsbDeviceUsage(parsed.audio, usage.audio, 'audio'),
          ffmpegPath: ffmpegBinary,
          raw: stderr
        });
      });
    });
  }
  function hydrateChannelItem(item) {
    if (!item || !LIVE_SOURCE_TYPES.includes(String(item.sourceType || '').trim().toLowerCase()) || !item.sourceId) return item;
    const source = getUsbSourceById(item.sourceId);
    const status = getUsbCaptureStatus(item.sourceId);
    if (!source) return { ...item, captureStatus: status };
    const customized = !!(item.overrideUpdatedAt || item.originalTitle || item.originalLogo || item.originalGroupTitle);
    return {
      ...item,
      title: customized && item.title ? item.title : (source.channelName || source.deviceName || source.name || item.title),
      url: getSourcePlaybackUrl(source),
      streamUrl: getSourcePlaybackUrl(source),
      logo: customized && item.logo ? item.logo : (source.logo || item.logo || null),
      groupTitle: item.groupTitle || source.groupTitle || source.category || '',
      sourceName: source.name || item.sourceName,
      deviceName: source.deviceName || item.deviceName || '',
      audioDeviceName: source.audioDeviceName || item.audioDeviceName || '',
      deliveryMode: source.deliveryMode || item.deliveryMode || 'hls',
      inputUrl: source.inputUrl || item.inputUrl || '',
      webrtcEmbedUrl: source.webrtcEmbedUrl || item.webrtcEmbedUrl || (isDirectLiveSource(source) ? makeDefaultWebrtcViewerUrl(source.id) : ''),
      webrtcPublisherUrl: isDirectLiveSource(source) ? getWebrtcPublisherUrl(source) : '',
      ffmpegInput: source.ffmpegInput || item.ffmpegInput || '',
      ffmpegCommand: source.ffmpegCommand || item.ffmpegCommand || '',
      captureStatus: status,
      nowPlaying: {
        ...(item.nowPlaying || {}),
        title: source.description || item.nowPlaying?.title || source.sourceType.toUpperCase(),
        deviceName: source.deviceName || '',
        ffmpegInput: source.ffmpegInput || '',
        captureState: status.state
      }
    };
  }
  function upsertUsbChannel(source) {
    const streamUrl = getSourcePlaybackUrl(source);
    const captureStatus = getUsbCaptureStatus(source.id);
    const channel = hydrateChannelItem({
      id: Buffer.from(source.id + ':' + (streamUrl || source.channelName || source.name)).toString('base64url'),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.sourceType,
      title: source.channelName || source.deviceName || source.name,
      url: streamUrl,
      streamUrl,
      logo: source.logo || null,
      groupTitle: source.groupTitle || source.category || '',
      deviceName: source.deviceName || '',
      audioDeviceName: source.audioDeviceName || '',
      deliveryMode: source.deliveryMode || 'hls',
      inputUrl: source.inputUrl || '',
      webrtcEmbedUrl: source.webrtcEmbedUrl || (isDirectLiveSource(source) ? makeDefaultWebrtcViewerUrl(source.id) : ''),
      ffmpegInput: source.ffmpegInput || '',
      ffmpegCommand: source.ffmpegCommand || '',
      nowPlaying: { title: source.description || source.sourceType.toUpperCase(), deviceName: source.deviceName || '', ffmpegInput: source.ffmpegInput || '' }
    });
    const finalChannel = applyChannelOverrideToItem(channel, getChannelOverride(channel.id));
    mediaDb.run(
      'INSERT OR REPLACE INTO channels(id, source_id, source_name, title, logo, url, now_playing_json, group_title, hidden, sort_order, raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [finalChannel.id, finalChannel.sourceId, finalChannel.sourceName, finalChannel.title, finalChannel.logo || null, finalChannel.url || null, JSON.stringify({ ...(finalChannel.nowPlaying || {}), captureStatus }), finalChannel.groupTitle || null, finalChannel.hidden ? 1 : 0, Number.isFinite(Number(finalChannel.sortOrder)) ? Number(finalChannel.sortOrder) : null, JSON.stringify(finalChannel)]
    );
  }
  function syncUsbChannels() {
    const sourceIds = new Set((config.iptv?.sources || []).filter(source => isLiveSource(source)).map(source => source.id));
    const rows = mediaDb.all('SELECT id, source_id, raw_json FROM channels');
    for (const row of rows) {
      const item = row.raw_json ? parseMaybeJson(row.raw_json, null) : null;
      const isUsb = isLiveSource(item);
      const sourceId = row.source_id || item?.sourceId || null;
      if (isUsb && sourceId && !sourceIds.has(sourceId)) mediaDb.run('DELETE FROM channels WHERE id = ?', [row.id]);
    }
    for (const source of (config.iptv?.sources || []).filter(entry => isLiveSource(entry))) {
      mediaDb.run('DELETE FROM channels WHERE source_id = ?', [source.id]);
      upsertUsbChannel(source);
    }
    mediaDb.save();
  }
  function buildUsbSpawnPlan(source) {
    const outputDir = getUsbOutputDir(source);
    const playlistPath = getUsbPlaylistPath(source);
    const segmentPattern = getUsbSegmentPattern(source);
    const hlsTime = Math.max(1, Number(source.hlsTime || config.usbCapture?.hlsTime || 2));
    const hlsListSize = Math.max(3, Number(source.hlsListSize || config.usbCapture?.hlsListSize || 6));
    const videoBitrate = String(source.videoBitrate || config.usbCapture?.videoBitrate || '2500k');
    const maxRate = String(source.maxRate || config.usbCapture?.maxRate || videoBitrate);
    const bufSize = String(source.bufSize || config.usbCapture?.bufSize || '3500k');
    const audioBitrate = String(source.audioBitrate || config.usbCapture?.audioBitrate || '96k');
    const frameRate = Math.max(24, Number(source.frameRate || config.usbCapture?.frameRate || 25));
    const outputResolution = resolveOutputResolution(source);
    const scaleFilter = outputResolution ? buildScaleFilter(outputResolution.width, outputResolution.height) : '';
    const ffmpegBinary = getUsbFfmpegBinary(source);
    const videoEncoder = resolveVideoEncoder(source, ffmpegBinary);
    const inputArgs = [];
    if (source.sourceType === 'usb_capture') {
      const dshowParts = [];
      if (source.deviceName) dshowParts.push(`video=${source.deviceName}`);
      if (source.audioDeviceName) dshowParts.push(`audio=${source.audioDeviceName}`);
      const finalInput = source.ffmpegInput || dshowParts.join(':');
      if (!finalInput) return { error: 'يجب اختيار جهاز فيديو على الأقل لتشغيل USB Capture.' };
      inputArgs.push('-f', 'dshow', '-rtbufsize', '64M', '-i', finalInput);
    } else {
      const inputUrl = getEffectiveManagedLiveInputUrl(source);
      if (!inputUrl) return { error: `يجب تعبئة رابط الإدخال لمصدر ${String(source.sourceType).toUpperCase()}.` };
      if (source.sourceType === 'rtsp') inputArgs.push('-rtsp_transport', 'tcp');
      if (source.sourceType === 'udp' || source.sourceType === 'rtp') inputArgs.push('-fflags', '+genpts+discardcorrupt');
      if (source.sourceType === 'mpegts_file' || /\.(ts|mts|m2ts)(?:$|\?)/i.test(inputUrl)) inputArgs.push('-f', 'mpegts');
      if (/^https?:\/\//i.test(inputUrl)) {
        inputArgs.push(...buildHttpReconnectInputArgs(inputUrl));
      }
    }
    if (source.ffmpegCommand && source.ffmpegCommand.trim()) {
      const command = source.ffmpegCommand
        .replace(/\{\{ffmpeg\}\}/g, ffmpegBinary)
        .replace(/\{\{input\}\}/g, source.ffmpegInput || '')
        .replace(/\{\{output\}\}/g, playlistPath)
        .replace(/\{\{playlist\}\}/g, playlistPath)
        .replace(/\{\{segments\}\}/g, segmentPattern)
        .replace(/\{\{publicUrl\}\}/g, getUsbStreamPublicUrl(source));
      return { mode: 'shell', command, outputDir, playlistPath };
    }
    if (source.sourceType === 'usb_capture' && !source.ffmpegInput && !source.deviceName) {
      return { error: 'يجب اختيار جهاز فيديو أو تعبئة FFmpeg Input لتشغيل USB Capture.' };
    }
    if (source.sourceType !== 'usb_capture') {
      const relayPlan = buildManagedLiveHlsArgs({
        source,
        ffmpegBinary,
        inputArgs,
        inputUrl: getEffectiveManagedLiveInputUrl(source),
        scaleFilter,
        videoEncoder,
        videoBitrate,
        maxRate,
        bufSize,
        audioBitrate,
        frameRate,
        hlsTime,
        hlsListSize,
        segmentPattern,
        playlistPath
      });
      return {
        mode: 'spawn',
        command: ffmpegBinary,
        args: relayPlan.args,
        outputDir,
        playlistPath,
        appliedResolution: relayPlan.relayMode === 'copy' ? 'source' : (outputResolution ? outputResolution.label : 'source'),
        appliedScaleFilter: relayPlan.appliedScaleFilter || '',
        appliedVideoEncoder: relayPlan.appliedVideoEncoder || videoEncoder.label,
        appliedHlsTime: hlsTime,
        appliedHlsListSize: hlsListSize,
        inputProbe: relayPlan.inputProbe || null,
        egress: relayPlan.egress || null
      };
    }
    const egressOutput = buildLiveEgressOutputArgs(source, {
      ffmpegBinary,
      hlsTime,
      hlsListSize,
      videoEncoder,
      videoBitrate,
      maxRate,
      bufSize,
      audioBitrate,
      frameRate,
      scaleFilter,
      copyVideo: false
    });
    return {
      mode: 'spawn',
      command: ffmpegBinary,
      args: [
        '-hide_banner',
        '-loglevel', 'warning',
        '-y',
        '-thread_queue_size', '1024',
        '-analyzeduration', '500000',
        '-probesize', '1000000',
        ...inputArgs,
        '-fps_mode', 'cfr',
        '-r', String(frameRate),
        ...(scaleFilter ? ['-vf', scaleFilter] : []),
        ...buildLiveVideoEncoderArgs(videoEncoder, { frameRate, videoBitrate, maxRate, bufSize }),
        '-c:a', 'aac',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', audioBitrate,
        '-f', 'hls',
        '-hls_init_time', '0',
        '-hls_time', String(hlsTime),
        '-hls_list_size', String(hlsListSize),
        '-hls_allow_cache', '0',
        '-hls_flags', 'delete_segments+omit_endlist+independent_segments+program_date_time',
        '-hls_start_number_source', 'epoch',
        '-hls_delete_threshold', '4',
        '-hls_segment_filename', segmentPattern,
        playlistPath,
        ...egressOutput.args
      ],
      outputDir,
      playlistPath,
      appliedResolution: outputResolution ? outputResolution.label : 'source',
      appliedScaleFilter: scaleFilter || '',
      appliedVideoEncoder: videoEncoder.label,
      appliedHlsTime: hlsTime,
      appliedHlsListSize: hlsListSize,
      egress: egressOutput.egress
    };
  }
  function scheduleUsbRestart(sourceId, delayMs = USB_RESTART_DELAY_MS) {
    const runtime = usbCaptureRuntime.get(sourceId);
    const source = getUsbSourceById(sourceId);
    const allowRtmpRestart = isRtmpIngestSource(source) && isRtmpIngestPublisherActive(source);
    if (!runtime || !source || (source.autoStart === false && !allowRtmpRestart)) return;
    if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
    runtime.restartTimer = setTimeout(() => startUsbCapture(sourceId, { reason: allowRtmpRestart ? 'rtmp-restart' : 'restart', ignoreAutoStart: allowRtmpRestart }), delayMs);
  }
  function stopUsbCapture(sourceId, reason = 'manual-stop') {
    const runtime = usbCaptureRuntime.get(sourceId);
    if (!runtime) return false;
    runtime.manualStop = true;
    if (runtime.readinessTimer) {
      clearInterval(runtime.readinessTimer);
      runtime.readinessTimer = null;
    }
    if (runtime.restartTimer) {
      clearTimeout(runtime.restartTimer);
      runtime.restartTimer = null;
    }
    if (runtime.process) {
      try { runtime.process.kill('SIGTERM'); } catch {}
    }
    runtime.process = null;
    runtime.state = reason === 'removed' ? 'removed' : 'stopped';
    runtime.stoppedAt = new Date().toISOString();
    runtime.message = reason === 'removed'
      ? 'تم حذف المصدر من الإعدادات.'
      : (reason === 'rtmp-publisher-ended' ? 'توقف ناشر RTMP، وتم إيقاف تحويل HLS لهذا المصدر.' : 'تم إيقاف البث.');
    syncUsbChannels();
    return true;
  }
  function startUsbCapture(sourceId, options = {}) {
    const source = getUsbSourceById(sourceId);
    if (!source) return { ok: false, error: 'المصدر غير موجود' };
    const ignoreAutoStart = options.ignoreAutoStart === true || options.reason === 'rtmp-publish' || options.reason === 'rtmp-restart';
    if (source.autoStart === false && !ignoreAutoStart) {
      usbCaptureRuntime.set(sourceId, {
        ...(usbCaptureRuntime.get(sourceId) || {}),
        state: 'disabled',
        startedAt: null,
        stoppedAt: new Date().toISOString(),
      process: null,
      restartTimer: null,
      readinessTimer: null,
      streamUrl: getUsbStreamPublicUrl(source),
      outputDir: getUsbOutputDir(source),
        message: isRtmpIngestSource(source)
          ? `بانتظار وصول بث RTMP على ${buildRtmpIngestInputUrl(config.rtmpServer, getRtmpIngestStreamKey(source))}.`
          : 'التشغيل التلقائي معطّل لهذا المصدر.',
        manualStop: true
      });
      syncUsbChannels();
      return { ok: true, status: getUsbCaptureStatus(sourceId) };
    }
    const current = usbCaptureRuntime.get(sourceId);
    if (current?.process) return { ok: true, status: getUsbCaptureStatus(sourceId) };
    const plan = buildUsbSpawnPlan(source);
    if (plan.error) {
      usbCaptureRuntime.set(sourceId, {
        ...(current || {}),
        state: 'error',
        startedAt: null,
        stoppedAt: new Date().toISOString(),
      process: null,
      restartTimer: null,
      readinessTimer: null,
      streamUrl: getUsbStreamPublicUrl(source),
      outputDir: getUsbOutputDir(source),
        message: plan.error,
        manualStop: true
      });
      syncUsbChannels();
      return { ok: false, error: plan.error };
    }
    fs.mkdirSync(plan.outputDir, { recursive: true });
    cleanDir(plan.outputDir);
    const runtime = {
      ...(current || {}),
      state: 'starting',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      process: null,
      restartTimer: null,
      readinessTimer: null,
      streamUrl: getUsbStreamPublicUrl(source),
      outputDir: plan.outputDir,
      appliedResolution: plan.appliedResolution || 'source',
      appliedScaleFilter: plan.appliedScaleFilter || '',
      appliedVideoEncoder: plan.appliedVideoEncoder || 'CPU / libx264',
      appliedHlsTime: plan.appliedHlsTime || null,
      appliedHlsListSize: plan.appliedHlsListSize || null,
      egress: plan.egress || null,
      message: options.reason === 'restart'
        ? 'جاري إعادة تشغيل FFmpeg...'
        : (options.reason === 'rtmp-publish' ? 'وصل بث RTMP. جاري تجهيز HLS...' : (options.reason === 'sync' ? 'جاري تجهيز البث التلقائي...' : 'جاري تشغيل FFmpeg...')),
      errorDetail: '',
      manualStop: false
    };
    usbCaptureRuntime.set(sourceId, runtime);
    let child = null;
    try {
      child = plan.mode === 'shell'
        ? spawn(plan.command, { cwd: rootDir, shell: true, stdio: ['ignore', 'ignore', 'pipe'] })
        : spawn(plan.command, plan.args, { cwd: rootDir, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      runtime.process = null;
      runtime.state = 'error';
      runtime.stoppedAt = new Date().toISOString();
      runtime.message = `تعذّر تشغيل المصدر: ${err.message}`;
      syncUsbChannels();
      return { ok: false, error: runtime.message };
    }
    runtime.process = child;
    runtime.state = 'starting';
    runtime.message = `يتم الآن تجهيز البث على ${runtime.streamUrl} • الدقة: ${runtime.appliedResolution} • المرمّز: ${runtime.appliedVideoEncoder}`;
    runtime.readinessTimer = setInterval(() => {
      if (!runtime.process) {
        if (runtime.readinessTimer) {
          clearInterval(runtime.readinessTimer);
          runtime.readinessTimer = null;
        }
        return;
      }
      if (hasReadyUsbPlaylist(source)) {
        runtime.state = 'running';
        const detail = String(runtime.errorDetail || '').toLowerCase();
        if (!runtime.message || detail.includes('will reconnect') || detail.includes('error=end of file')) {
          runtime.message = `البث المباشر يعمل الآن على ${runtime.streamUrl} • المرمّز: ${runtime.appliedVideoEncoder}`;
        }
      }
    }, 1000);
    child.stderr.on('data', chunk => {
      const line = String(chunk || '').trim();
      if (line) {
        const lower = line.toLowerCase();
        const playlistReady = fs.existsSync(plan.playlistPath);
        if (playlistReady) runtime.state = 'running';
        runtime.message = (playlistReady && lower.includes('will reconnect') && lower.includes('end of file'))
          ? `البث الحي متصل ويواصل تحديث المصدر الخارجي...`
          : line.slice(-240);
        runtime.errorDetail = line.slice(-500);
      }
    });
    child.on('error', err => {
      if (runtime.readinessTimer) {
        clearInterval(runtime.readinessTimer);
        runtime.readinessTimer = null;
      }
      runtime.process = null;
      runtime.state = 'error';
      runtime.stoppedAt = new Date().toISOString();
      runtime.message = `تعذّر تشغيل FFmpeg: ${err.message}`;
      runtime.errorDetail = err.message;
      scheduleUsbRestart(sourceId, USB_RESTART_DELAY_MS);
      syncUsbChannels();
    });
    child.on('close', code => {
      if (runtime.readinessTimer) {
        clearInterval(runtime.readinessTimer);
        runtime.readinessTimer = null;
      }
      runtime.process = null;
      runtime.stoppedAt = new Date().toISOString();
      runtime.state = runtime.manualStop ? 'stopped' : (code === 0 ? 'stopped' : 'error');
      const detail = String(runtime.errorDetail || runtime.message || '').toLowerCase();
      if (runtime.manualStop) {
        runtime.message = 'تم إيقاف البث.';
      } else if (detail.includes('error during demuxing: i/o error') || detail.includes('could not find codec parameters for stream 0')) {
        runtime.message = 'جهاز الفيديو المحدد لا يرسل إطارات إلى FFmpeg. جرّب جهازًا آخر أو OBS Virtual Camera.';
      } else {
        runtime.message = `توقف FFmpeg ${code === null ? 'بشكل غير متوقع' : `برمز ${code}`}.`;
      }
      if (!runtime.manualStop) scheduleUsbRestart(sourceId, USB_RESTART_DELAY_MS);
      syncUsbChannels();
    });
    syncUsbChannels();
    return { ok: true, status: getUsbCaptureStatus(sourceId) };
  }
  function syncUsbCaptures() {
    const activeIds = new Set((config.iptv?.sources || []).filter(source => isManagedLiveSource(source)).map(source => source.id));
    for (const sourceId of [...usbCaptureRuntime.keys()]) {
      if (!activeIds.has(sourceId)) {
        stopUsbCapture(sourceId, 'removed');
        usbCaptureRuntime.delete(sourceId);
      }
    }
    for (const source of (config.iptv?.sources || []).filter(entry => isManagedLiveSource(entry))) {
      const current = usbCaptureRuntime.get(source.id);
      const rtmpPublisherActive = isRtmpIngestSource(source) && isRtmpIngestPublisherActive(source);
      if (source.autoStart === false && !rtmpPublisherActive) {
        stopUsbCapture(source.id, isRtmpIngestSource(source) ? 'rtmp-publisher-ended' : 'manual-stop');
        startUsbCapture(source.id, { reason: 'disabled-refresh' });
      } else {
        if (shouldRecoverUsbCapture(source, current)) stopUsbCapture(source.id, 'watchdog-restart');
        startUsbCapture(source.id, { reason: rtmpPublisherActive ? 'rtmp-publish' : (current ? 'watchdog' : 'sync'), ignoreAutoStart: rtmpPublisherActive });
      }
    }
    syncUsbChannels();
  }

  function getRtmpSessionPath(session = {}) {
    const streamPath = String(session.streamPath || '').trim();
    if (streamPath) return streamPath.startsWith('/') ? streamPath : `/${streamPath}`;
    const appName = sanitizeRtmpName(session.streamApp || config.rtmpServer?.appName || DEFAULT_RTMP_INGEST_APP, DEFAULT_RTMP_INGEST_APP);
    const streamKey = sanitizeRtmpName(session.streamName || config.rtmpServer?.streamKey || DEFAULT_RTMP_INGEST_SOURCE_ID, DEFAULT_RTMP_INGEST_SOURCE_ID);
    return `/${appName}/${streamKey}`;
  }
  function findRtmpIngestSourceForSession(session = {}) {
    const pathValue = getRtmpSessionPath(session);
    const streamName = sanitizeRtmpName(session.streamName || pathValue.split('/').filter(Boolean)[1] || '', '');
    return (config.iptv?.sources || []).find(source => {
      if (!isRtmpIngestSource(source)) return false;
      if (getRtmpActiveStreamPathForSource(source) === pathValue) return true;
      return streamName && getRtmpIngestStreamKey(source) === streamName;
    }) || null;
  }
  function getRtmpIngestStatus() {
    const cfg = normalizeRtmpServerConfig(config.rtmpServer || {});
    const publishHost = cfg.publicHost || 'SERVER-IP';
    const publishUrl = `rtmp://${publishHost}:${cfg.port}/${cfg.appName}/${cfg.streamKey}`;
    return {
      enabled: cfg.enabled,
      running: !!rtmpIngestState.running,
      error: rtmpIngestState.error || '',
      startedAt: rtmpIngestState.startedAt,
      bind: cfg.host,
      port: cfg.port,
      appName: cfg.appName,
      streamKey: cfg.streamKey,
      localPublishUrl: buildRtmpIngestInputUrl(cfg, cfg.streamKey),
      publishUrl,
      activeStreams: [...rtmpIngestState.activeStreams]
    };
  }
  function startRtmpIngestServer() {
    const cfg = normalizeRtmpServerConfig(config.rtmpServer || {});
    rtmpIngestState.enabled = cfg.enabled;
    rtmpIngestState.bind = cfg.host;
    rtmpIngestState.port = cfg.port;
    rtmpIngestState.appName = cfg.appName;
    rtmpIngestState.streamKey = cfg.streamKey;
    rtmpIngestState.publishUrl = buildRtmpIngestInputUrl(cfg, cfg.streamKey);
    if (!cfg.enabled) {
      rtmpIngestState.running = false;
      rtmpIngestState.error = 'خادم RTMP الداخلي معطّل من الإعدادات.';
      return getRtmpIngestStatus();
    }
    if (rtmpIngestServer) return getRtmpIngestStatus();
    if (!NodeMediaServer) {
      rtmpIngestState.running = false;
      rtmpIngestState.error = 'حزمة node-media-server غير مثبتة.';
      return getRtmpIngestStatus();
    }
    try {
      const nmsConfig = {
        bind: cfg.host,
        rtmp: {
          port: cfg.port,
          chunk_size: 60000,
          gop_cache: true,
          ping: 30,
          ping_timeout: 60
        }
      };
      if (cfg.httpEnabled) {
        nmsConfig.http = { port: cfg.httpPort, allow_origin: '*' };
      }
      const server = new NodeMediaServer(nmsConfig);
      server.rtmpServer?.tcpServer?.on('error', (error) => {
        rtmpIngestState.running = false;
        rtmpIngestState.error = `تعذر تشغيل RTMP على ${cfg.host}:${cfg.port}: ${error.message}`;
        console.error(`[rtmp] ${rtmpIngestState.error}`);
      });
      server.on('postPublish', (session) => {
        const streamPath = getRtmpSessionPath(session);
        rtmpIngestState.activeStreams.add(streamPath);
        const source = findRtmpIngestSourceForSession(session);
        if (!source) {
          console.warn(`[rtmp] وصل بث على ${streamPath} بدون مصدر مطابق في الإعدادات.`);
          return;
        }
        console.log(`[rtmp] publisher connected: ${streamPath} -> source ${source.id}`);
        setTimeout(() => {
          try { startUsbCapture(source.id, { reason: 'rtmp-publish', ignoreAutoStart: true }); } catch (error) { console.error(`[rtmp] start failed: ${error.message}`); }
        }, 300);
      });
      server.on('donePublish', (session) => {
        const streamPath = getRtmpSessionPath(session);
        rtmpIngestState.activeStreams.delete(streamPath);
        const source = findRtmpIngestSourceForSession(session);
        if (source) {
          console.log(`[rtmp] publisher disconnected: ${streamPath}`);
          stopUsbCapture(source.id, 'rtmp-publisher-ended');
        }
      });
      server.run();
      rtmpIngestServer = server;
      rtmpIngestState.running = true;
      rtmpIngestState.error = '';
      rtmpIngestState.startedAt = new Date().toISOString();
      console.log(`[rtmp] RTMP ingest enabled on rtmp://${cfg.host}:${cfg.port}/${cfg.appName}/${cfg.streamKey}`);
    } catch (error) {
      rtmpIngestState.running = false;
      rtmpIngestState.error = `تعذر تشغيل RTMP: ${error.message}`;
      console.error(`[rtmp] ${rtmpIngestState.error}`);
    }
    return getRtmpIngestStatus();
  }

  let scheduledScanTimer = null;
  function loadConfigFromDb() {
    const row = runtimeDb.get('SELECT value FROM meta WHERE key = ? LIMIT 1', ['app_config']);
    if (!row?.value) return null;
    return normalizeConfig(parseMaybeJson(row.value, null) || {});
  }
  function persistConfigToDb(newConfig) {
    runtimeDb.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', ['app_config', JSON.stringify(newConfig)]);
    runtimeDb.save();
  }
  function saveConfig(newConfig) {
    config = normalizeConfig(newConfig || {});
    persistConfigToDb(config);
    writeJson(configPath, config);
  }
  const dbConfig = loadConfigFromDb();
  if (dbConfig) {
    config = dbConfig;
    writeJson(configPath, config);
  } else {
    saveConfig(config);
  }
  function readScanStatus() {
    const data = readJson(scanStatusPath, null);
    return data ? { ...defaultScanStatus(), ...data, progress: { ...defaultScanStatus().progress, ...(data.progress || {}) } } : defaultScanStatus();
  }
  function writeScanStatus(data) {
    const merged = { ...defaultScanStatus(), ...data, progress: { ...defaultScanStatus().progress, ...(data.progress || {}) } };
    writeJson(scanStatusPath, merged);
    return merged;
  }
  function getGeneratedAt() {
    const row = mediaDb.get('SELECT value FROM meta WHERE key = ?', ['generatedAt']);
    return row ? row.value : null;
  }
  function setGeneratedAt(value) {
    mediaDb.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', ['generatedAt', value || '']);
    mediaDb.save();
  }
  function ensureAdmin() {
    const row = appDb.get('SELECT * FROM users WHERE username = ? LIMIT 1', [config.admin.username]);
    if (!row) {
      appDb.run(
        'INSERT INTO users(id, username, display_name, password_hash, role, active, created_at, last_login_at, device_id, auth_type) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [uid('user'), config.admin.username, 'Administrator', hashPassword(config.admin.password), 'admin', 1, new Date().toISOString(), null, null, 'password']
      );
      appDb.save();
    }
  }
  ensureAdmin();
  if (!fs.existsSync(scanStatusPath)) writeScanStatus(defaultScanStatus());

  app.use(session({
    secret: config.server.sessionSecret || 'change-me-now',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' }
  }));

  function getSessionUser(req) {
    const userId = req.session?.userId;
    if (!userId) return null;
    try {
      return getSafeUserRow(appDb.get('SELECT * FROM users WHERE id = ? AND active = 1 LIMIT 1', [userId]));
    } catch (error) {
      if (!sqliteErrorLooksRecoverable(error)) throw error;
      console.warn(`[auth] تم تجاوز جلسة مؤقتًا بسبب خطأ في قاعدة البيانات: ${error.message}`);
      try { req.session.userId = null; } catch {}
      return null;
    }
  }
  function authOptional(req, _res, next) { req.user = getSessionUser(req); next(); }
  function requireLogin(req, res, next) {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
    req.user = user; next();
  }
  function requireAdmin(req, res, next) {
    const user = getSessionUser(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'صلاحيات الإدارة مطلوبة' });
    req.user = user; next();
  }
  function mustLoginForViewing() { return !!config.auth?.requireLoginForViewing; }

  app.use(authOptional);
  app.use(bandwidthThrottleMiddleware);
  app.use('/assets', express.static(path.join(publicDir, 'assets'), {
    maxAge: '1h',
    etag: true,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    }
  }));
  app.get('/live-streams/:sourceKey/index.m3u8', async (req, res, next) => {
    const source = getUsbSourceByStreamKey(req.params.sourceKey);
    if (!source || !isManagedLiveSource(source)) return next();
    res.type('application/vnd.apple.mpegurl');
    if (source.autoStart === false) {
      if (!isRtmpIngestSource(source) || !isRtmpIngestPublisherActive(source)) {
        return res.status(503).type('text/plain; charset=utf-8').send(isRtmpIngestSource(source)
          ? `بانتظار وصول بث RTMP على ${buildRtmpIngestInputUrl(config.rtmpServer, getRtmpIngestStreamKey(source))}.`
          : 'هذا المصدر معطّل من التشغيل التلقائي.');
      }
    }
    if (hasReadyUsbPlaylist(source)) {
      return res.sendFile(getUsbPlaylistPath(source));
    }
    try {
      const ready = await ensureUsbCaptureReady(source, 'viewer-open');
      if (!ready) {
        return res.status(503).type('text/plain; charset=utf-8').send('جاري تجهيز البث المباشر، حاول مرة أخرى خلال ثوانٍ قليلة.');
      }
      return res.sendFile(getUsbPlaylistPath(source));
    } catch (err) {
      return res.status(503).type('text/plain; charset=utf-8').send(`تعذّر بدء البث المباشر: ${err.message}`);
    }
  });
  app.use('/live-streams', express.static(liveStreamsDir, {
    maxAge: 0,
    setHeaders: (res, filePath) => {
      const ext = path.extname(String(filePath || '')).toLowerCase();
      if (ext === '.m3u8') res.type('application/vnd.apple.mpegurl');
      if (ext === '.ts') res.type('video/mp2t');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }));
  app.get('/channel-proxy/:channelKey/index.m3u8', async (req, res, next) => {
    const item = findChannelItemByRelayKey(req.params.channelKey);
    if (!item) return next();
    const directUrl = String(item.directStreamUrl || item.streamUrl || item.url || '').trim();
    const targetUrl = decodeProxyUrl(req.query.u || '') || directUrl;
    if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).type('text/plain; charset=utf-8').send('Bad playlist URL');
    try {
      const response = await fetch(targetUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: {
          ...getChannelHttpRequestHeaders(item),
          accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain;q=0.9, */*;q=0.5'
        }
      });
      const text = await response.text();
      if (!response.ok) return res.status(response.status).type('text/plain; charset=utf-8').send(text || `HTTP ${response.status}`);
      res.type('application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(rewriteChannelProxyPlaylist(item.id, text, response.url || targetUrl));
    } catch (error) {
      return res.status(502).type('text/plain; charset=utf-8').send(toInlineSingleLine(error?.message || 'Proxy playlist failed'));
    }
  });
  app.get('/channel-proxy/:channelKey/segment/:encoded.ts', async (req, res, next) => {
    const item = findChannelItemByRelayKey(req.params.channelKey);
    if (!item) return next();
    const targetUrl = decodeProxyUrl(req.params.encoded || '');
    if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).type('text/plain; charset=utf-8').send('Bad segment URL');
    try {
      const response = await fetch(targetUrl, {
        redirect: 'follow',
        headers: getChannelHttpRequestHeaders(item)
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return res.status(response.status).type('text/plain; charset=utf-8').send(text || `HTTP ${response.status}`);
      }
      res.type(response.headers.get('content-type') || 'video/mp2t');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!response.body) return res.status(502).type('text/plain; charset=utf-8').send('Empty segment response');
      const bodyStream = Readable.fromWeb(response.body);
      bodyStream.on('error', (error) => {
        if (!res.headersSent) {
          res.status(502).type('text/plain; charset=utf-8').end(toInlineSingleLine(error?.message || 'Segment stream failed'));
        } else {
          try { res.destroy(error); } catch {}
        }
      });
      res.on('close', () => {
        try { bodyStream.destroy(); } catch {}
      });
      return bodyStream.pipe(res);
    } catch (error) {
      return res.status(502).type('text/plain; charset=utf-8').send(toInlineSingleLine(error?.message || 'Proxy segment failed'));
    }
  });
  app.get('/channel-relays/:channelKey/index.m3u8', async (req, res, next) => {
    const item = findChannelItemByRelayKey(req.params.channelKey);
    if (!item || !shouldRelayChannelItem(item)) return next();
    try {
      const relay = ensureChannelRelay(item);
      const ready = await waitForFile(relay.playlistPath, 10000);
      if (!ready) {
        return res.status(503).type('text/plain; charset=utf-8').send('جاري تجهيز Relay HLS للقناة، حاول مرة أخرى خلال ثوانٍ قليلة.');
      }
      res.type('application/vnd.apple.mpegurl');
      return res.sendFile(relay.playlistPath);
    } catch (error) {
      return res.status(503).type('text/plain; charset=utf-8').send(`تعذّر تشغيل Relay HLS للقناة: ${error.message}`);
    }
  });
  app.use('/channel-relays', express.static(channelRelaysDir, {
    maxAge: 0,
    setHeaders: (res, filePath) => {
      const ext = path.extname(String(filePath || '')).toLowerCase();
      if (ext === '.m3u8') res.type('application/vnd.apple.mpegurl');
      if (ext === '.ts') res.type('video/mp2t');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }));
  app.use('/transcoded', express.static(transcodesDir, {
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }));

  let scanWorker = null;
  function stopScanWorker() {
    if (scanWorker) {
      try { scanWorker.kill('SIGTERM'); } catch {}
      scanWorker = null;
    }
    const st = readScanStatus();
    writeScanStatus({ ...st, running: false, stage: 'cancelled', endedAt: new Date().toISOString(), message: 'تم إيقاف الفحص من الإدارة.' });
  }
  function startBackgroundScan(options = {}) {
    const current = readScanStatus();
    if (current.running) return { started: false, reason: 'running', status: current };
    const workerPath = path.join(rootDir, 'scanner.js');
    writeScanStatus({
      running: true,
      stage: 'starting',
      startedAt: new Date().toISOString(),
      endedAt: null,
      message: options.sourceId ? 'تم بدء تحديث مصدر القنوات في الخلفية.' : (options.libraryId ? 'تم بدء تحديث مكتبة واحدة في الخلفية.' : 'تم بدء فحص كامل في الخلفية.'),
      libraryId: options.libraryId || null,
      libraryName: options.libraryName || null,
      sourceId: options.sourceId || null,
      progress: { percent: 0, processedDirs: 0, discovered: 0, errors: 0 }
    });
    scanWorker = fork(workerPath, [], { cwd: rootDir, env: { ...process.env, LMS_SCAN_OPTIONS: JSON.stringify(options || {}) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    scanWorker.on('message', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'status') writeScanStatus({ ...readScanStatus(), ...msg.payload });
      if (msg.type === 'done') {
        writeScanStatus({ ...readScanStatus(), running: false, stage: 'done', endedAt: new Date().toISOString(), message: msg.payload?.message || 'اكتمل الفحص.', progress: msg.payload?.progress || readScanStatus().progress, libraryId: null, libraryName: null });
        scanWorker = null;
      }
      if (msg.type === 'error') {
        writeScanStatus({ ...readScanStatus(), running: false, stage: 'error', endedAt: new Date().toISOString(), message: msg.payload?.message || 'فشل الفحص.', progress: msg.payload?.progress || readScanStatus().progress, libraryId: null, libraryName: null });
        scanWorker = null;
      }
    });
    scanWorker.on('exit', code => {
      const st = readScanStatus();
      if (st.running) writeScanStatus({ ...st, running: false, stage: code === 0 ? 'done' : 'error', endedAt: new Date().toISOString(), message: code === 0 ? 'اكتمل الفحص.' : 'انتهت عملية الفحص بشكل غير متوقع.' });
      scanWorker = null;
    });
    return { started: true, status: readScanStatus() };
  }

  let yacineTvRefreshTimer = null;
  let yacineTvRefreshRunning = false;
  function resolveProjectPath(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    return path.isAbsolute(text) ? text : path.join(rootDir, text);
  }
  function getYacineTvSource() {
    return (config.iptv?.sources || []).find(source => String(source?.id || '') === DEFAULT_YACINE_SOURCE_ID) || null;
  }
  function isYacineTvEnabled() {
    return config.yacineTv?.enabled === true;
  }
  function readYacineTvStatus() {
    return readJson(resolveProjectPath(DEFAULT_YACINE_STATUS_FILE), null);
  }
  function getDisabledChannelSourceIds() {
    return (config.iptv?.sources || [])
      .filter(source => source?.enabled === false)
      .map(source => String(source.id || '').trim())
      .filter(Boolean);
  }
  function addDisabledSourceVisibilityFilter(where, params, sourceId = '') {
    const disabledIds = getDisabledChannelSourceIds();
    if (!disabledIds.length) return;
    if (sourceId && disabledIds.includes(String(sourceId || ''))) {
      where.push('1 = 0');
      return;
    }
    if (!sourceId) {
      where.push(`(source_id IS NULL OR source_id NOT IN (${disabledIds.map(() => '?').join(',')}))`);
      params.push(...disabledIds);
    }
  }
  function addYacineTvVisibilityFilter(where, params, sourceId = '') {
    if (isYacineTvEnabled()) return;
    if (String(sourceId || '') === DEFAULT_YACINE_SOURCE_ID) {
      where.push('1 = 0');
      return;
    }
    if (!sourceId) {
      where.push('(source_id IS NULL OR source_id <> ?)');
      params.push(DEFAULT_YACINE_SOURCE_ID);
    }
  }
  async function runYacineTvRefresh(reason = 'manual', options = {}) {
    if (!isYacineTvEnabled()) {
      return { ok: false, disabled: true, error: 'خيار Yacine TV Auto معطّل من الإعدادات.' };
    }
    const source = getYacineTvSource();
    if (!source) {
      return { ok: false, error: `مصدر ${DEFAULT_YACINE_SOURCE_ID} غير موجود في الإعدادات.` };
    }
    if (yacineTvRefreshRunning) {
      return { ok: false, running: true, status: readYacineTvStatus() };
    }
    yacineTvRefreshRunning = true;
    try {
      const status = await refreshYacineTvPlaylist({
        rootDir,
        outputPath: source.m3uPath || DEFAULT_YACINE_OUTPUT_FILE,
        statusPath: DEFAULT_YACINE_STATUS_FILE
      });
      const shouldScan = options.startScan !== false && config.yacineTv?.scanAfterRefresh !== false;
      const scan = !shouldScan
        ? { started: false, reason: 'disabled' }
        : startBackgroundScan({ reason: `yacine-tv-${reason}`, libraryName: 'Yacine TV', sourceId: DEFAULT_YACINE_SOURCE_ID, channelsOnly: true });
      return { ok: true, status, scan };
    } catch (error) {
      const failure = {
        ok: false,
        sourceId: DEFAULT_YACINE_SOURCE_ID,
        finishedAt: new Date().toISOString(),
        error: toSingleLine(error?.message || String(error))
      };
      writeJson(resolveProjectPath(DEFAULT_YACINE_STATUS_FILE), failure);
      return failure;
    } finally {
      yacineTvRefreshRunning = false;
    }
  }
  function setupYacineTvAutoRefresh(runStartup = false) {
    if (yacineTvRefreshTimer) {
      clearInterval(yacineTvRefreshTimer);
      yacineTvRefreshTimer = null;
    }
    if (!isYacineTvEnabled() || !getYacineTvSource()) return;
    const intervalHours = Number(config.yacineTv?.refreshIntervalHours || 0);
    if (intervalHours > 0) {
      const intervalMs = intervalHours * 60 * 60 * 1000;
      yacineTvRefreshTimer = setInterval(() => {
        runYacineTvRefresh('schedule', { startScan: true }).catch(error => console.warn(`[yacine-tv] ${error.message}`));
      }, intervalMs);
      if (yacineTvRefreshTimer.unref) yacineTvRefreshTimer.unref();
    }
    if (runStartup && config.yacineTv?.refreshOnStartup !== false) {
      setTimeout(() => {
        runYacineTvRefresh('startup', { startScan: true }).catch(error => console.warn(`[yacine-tv] ${error.message}`));
      }, 2500);
    }
  }

  function paginateMeta(page, limit, total) {
    const p = Math.max(1, parseInt(page || 1, 10));
    const l = Math.max(1, Math.min(100, parseInt(limit || config.performance?.pageSize || 48, 10)));
    const offset = (p - 1) * l;
    return { page: p, limit: l, total, offset, hasMore: offset + l < total };
  }
  function rowToItem(row) {
    return parseMaybeJson(row.raw_json, null);
  }
  function normalizeLiveGroup(value = '') {
    const text = String(value || '').trim();
    return text || 'غير مصنفة';
  }
  function liveGroupQueryValue(value = '') {
    const text = String(value || '').trim();
    return text || '__uncategorized';
  }
  function liveGroupRank(value = '') {
    const text = normalizeLiveGroup(value).toLowerCase();
    if (/(رياض|sport|bein|كرة|football|soccer)/i.test(text)) return 10;
    if (/(أخبار|اخبار|news)/i.test(text)) return 20;
    if (/(أطفال|اطفال|kids|cartoon|children)/i.test(text)) return 30;
    if (/(أفلام|افلام|movie|cinema)/i.test(text)) return 40;
    if (/(موسيقى|music|audio)/i.test(text)) return 50;
    if (text === 'غير مصنفة') return 99;
    return 60;
  }
  function rowToChannelItem(row) {
    if (!row) return null;
    const item = hydrateChannelItem(rowToItem(row));
    if (!item) return item;
    return {
      ...item,
      groupTitle: String(row.group_title || item.groupTitle || '').trim()
    };
  }
  function collectLiveGroups({ sourceId = '', q = '' } = {}) {
    const where = ['hidden = 0'];
    const params = [];
    if (sourceId) { where.push('source_id = ?'); params.push(sourceId); }
    addDisabledSourceVisibilityFilter(where, params, sourceId);
    addYacineTvVisibilityFilter(where, params, sourceId);
    if (q) { where.push('(LOWER(title) LIKE ? OR LOWER(url) LIKE ? OR LOWER(group_title) LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    const rows = mediaDb.all(
      `SELECT CASE WHEN group_title IS NULL OR TRIM(group_title) = '' THEN '' ELSE TRIM(group_title) END AS group_value, COUNT(*) AS count
       FROM channels
       WHERE ${where.join(' AND ')}
       GROUP BY CASE WHEN group_title IS NULL OR TRIM(group_title) = '' THEN '' ELSE TRIM(group_title) END`,
      params
    );
    return rows.map(row => {
      const raw = String(row.group_value || '').trim();
      const label = normalizeLiveGroup(raw);
      const id = liveGroupQueryValue(raw);
      return { id, value: raw, label, count: Number(row.count || 0) };
    }).sort((a, b) => {
      const rank = liveGroupRank(a.label) - liveGroupRank(b.label);
      return rank || a.label.localeCompare(b.label, 'ar');
    });
  }
  function buildLiveCategorySections(items = [], limit = 24) {
    const groups = new Map();
    for (const item of items) {
      if (!item?.id) continue;
      const label = normalizeLiveGroup(item.groupTitle);
      const key = liveGroupQueryValue(item.groupTitle);
      if (!groups.has(key)) {
        groups.set(key, { id: `live-group-${key}`, key, name: label, groupTitle: item.groupTitle || '', sourceType: 'category', type: 'live', items: [] });
      }
      const section = groups.get(key);
      if (section.items.length < limit) section.items.push(item);
    }
    return [...groups.values()]
      .filter(section => section.items.length)
      .sort((a, b) => {
        const rank = liveGroupRank(a.name) - liveGroupRank(b.name);
        return rank || a.name.localeCompare(b.name, 'ar');
      })
      .map(section => ({
        ...section,
        subtitle: `${section.items.length} قناة في هذا القسم`,
        href: section.key === '__uncategorized' ? '/live?group=__uncategorized' : `/live?group=${encodeURIComponent(section.name)}`
      }));
  }
  function footballHash(value = '') {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
  }
  function decodeXmlEntities(value = '') {
    return String(value || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code || 0)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }
  function stripHtml(value = '') {
    return decodeXmlEntities(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function firstXmlTag(block = '', tag = '') {
    const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = String(block || '').match(pattern);
    return match ? decodeXmlEntities(match[1]).trim() : '';
  }
  function firstXmlAttr(block = '', tag = '', attr = '') {
    const pattern = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, 'i');
    const match = String(block || '').match(pattern);
    return match ? decodeXmlEntities(match[1]).trim() : '';
  }
  async function fetchTextUrl(url = '', timeoutMs = 15000) {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'LightMediaServer-FootballImporter/1.0', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }
  function parseFeedItems(xml = '', feed = {}) {
    const text = String(xml || '');
    const blocks = text.match(/<item[\s\S]*?<\/item>/gi) || text.match(/<entry[\s\S]*?<\/entry>/gi) || [];
    return blocks.map(block => {
      const title = stripHtml(firstXmlTag(block, 'title'));
      const link = stripHtml(firstXmlTag(block, 'link')) || firstXmlAttr(block, 'link', 'href');
      const summary = stripHtml(firstXmlTag(block, 'description') || firstXmlTag(block, 'summary') || firstXmlTag(block, 'content:encoded')).slice(0, 500);
      const published = stripHtml(firstXmlTag(block, 'pubDate') || firstXmlTag(block, 'published') || firstXmlTag(block, 'updated') || firstXmlTag(block, 'dc:date'));
      const image = firstXmlAttr(block, 'media:thumbnail', 'url') || firstXmlAttr(block, 'media:content', 'url') || firstXmlTag(block, 'image');
      if (!title || !link) return null;
      const publishedDate = published ? new Date(published) : null;
      return {
        id: `news-${footballHash(link || title)}`,
        title,
        summary,
        url: link,
        source: feed.name || '',
        image,
        publishedAt: publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : new Date().toISOString(),
        raw: { feed: feed.name || '', importedFrom: feed.url || '' }
      };
    }).filter(Boolean);
  }
  function rowToFootballNews(row = {}) {
    return {
      id: row.id,
      title: row.title || '',
      summary: row.summary || '',
      url: row.url || '',
      source: row.source || '',
      image: row.image || '',
      publishedAt: row.published_at || '',
      raw: parseMaybeJson(row.raw_json, {}),
      createdAt: row.created_at || '',
      updatedAt: row.updated_at || ''
    };
  }
  function rowToFootballProfile(row = {}) {
    const teamMeta = footballTeamMetaFromRow(row, row.title || row.name || '');
    return {
      id: row.id,
      type: row.type || 'club',
      name: row.name || '',
      title: row.title || row.name || '',
      summary: row.summary || '',
      url: row.url || '',
      image: row.image || '',
      source: row.source || '',
      code: teamMeta.code || '',
      flag: teamMeta.flag || '',
      kind: teamMeta.kind || (row.type || 'club'),
      teamMeta,
      visible: !!Number(row.visible ?? 1),
      priority: Number(row.priority || 0),
      updatedAt: row.updated_at || ''
    };
  }
  function hasArabicText(value = '') {
    return /[\u0600-\u06FF]/.test(String(value || ''));
  }
  function hasFootballNewsText(value = '') {
    const text = String(value || '').toLowerCase();
    return /(football|soccer|fifa|world cup|uefa|champions league|premier league|كرة القدم|كأس العالم|مونديال|فيفا|دوري|منتخب|نادي|لاعب|مباراة|مباريات|الأرجنتين|البرازيل|رونالدو|ميسي)/i.test(text);
  }
  function isPlaceholderFootballTeamName(value = '') {
    const text = String(value || '').trim();
    return /^[123][A-L](?:\/[A-L])*$/i.test(text) || /^W\d+/i.test(text) || /^L\d+/i.test(text);
  }
  const footballFifaIsoMap = {
    ALG: 'DZ', ARG: 'AR', AUS: 'AU', AUT: 'AT', BEL: 'BE', BIH: 'BA', BRA: 'BR', CAN: 'CA',
    CIV: 'CI', COD: 'CD', COL: 'CO', CPV: 'CV', CRO: 'HR', CUW: 'CW', CZE: 'CZ', ECU: 'EC',
    EGY: 'EG', ENG: 'GB-ENG', ESP: 'ES', FRA: 'FR', GER: 'DE', GHA: 'GH', HAI: 'HT', IRN: 'IR',
    IRQ: 'IQ', JOR: 'JO', JPN: 'JP', KOR: 'KR', KSA: 'SA', MAR: 'MA', MEX: 'MX', NED: 'NL',
    NOR: 'NO', NZL: 'NZ', PAN: 'PA', PAR: 'PY', POR: 'PT', QAT: 'QA', RSA: 'ZA', SCO: 'GB-SCT',
    SEN: 'SN', SUI: 'CH', SWE: 'SE', TUN: 'TN', TUR: 'TR', URU: 'UY', USA: 'US', UZB: 'UZ'
  };
  function isoFlagEmoji(iso = '') {
    const code = String(iso || '').trim().toUpperCase();
    if (code === 'GB-ENG') return '🏴';
    if (code === 'GB-SCT') return '🏴';
    if (!/^[A-Z]{2}$/.test(code)) return '';
    return [...code].map(ch => String.fromCodePoint(127397 + ch.charCodeAt(0))).join('');
  }
  function footballFlagFromCode(code = '') {
    const raw = String(code || '').trim().toUpperCase();
    if (!raw) return '';
    const iso = footballFifaIsoMap[raw] || (/^[A-Z]{2}$/.test(raw) ? raw : '');
    return isoFlagEmoji(iso);
  }
  function footballTeamMetaFromRow(row = null, fallbackName = '') {
    if (!row) return { title: fallbackName || '', flag: '', image: '', code: '', kind: 'club' };
    const raw = parseMaybeJson(row.raw_json, {});
    const code = String(raw.code || raw.scheduleCode || '').trim().toUpperCase();
    const source = String(row.source || '');
    const kind = source.includes('World Cup') ? 'team' : (row.type === 'player' ? 'player' : 'club');
    return {
      title: row.title || row.name || fallbackName || '',
      flag: footballFlagFromCode(code),
      image: row.image || '',
      code,
      kind
    };
  }
  function getFootballTeamMeta(name = '') {
    const teamName = String(name || '').trim();
    if (!teamName || isPlaceholderFootballTeamName(teamName)) return { title: teamName, flag: '', image: '', code: '', kind: 'club' };
    const row = mediaDb.get(
      `SELECT * FROM football_profiles
       WHERE visible = 1 AND (LOWER(name) = LOWER(?) OR LOWER(title) = LOWER(?))
       ORDER BY CASE WHEN source LIKE '%World Cup%' THEN 0 ELSE 1 END ASC, priority DESC
       LIMIT 1`,
      [teamName, teamName]
    );
    return footballTeamMetaFromRow(row, teamName);
  }
  function listFootballNews(query = {}) {
    const limit = Math.max(1, Math.min(120, Number(query.limit || 30)));
    const lang = String(query.lang || '').trim().toLowerCase();
    const topic = String(query.topic || '').trim().toLowerCase();
    const q = String(query.q || '').trim().toLowerCase();
    const where = [];
    const params = [];
    if (q) {
      where.push('(LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(source) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sqlLimit = lang === 'ar' ? Math.max(limit, 250) : limit;
    const rows = mediaDb.all(`SELECT * FROM football_news ${whereSql} ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ?`, [...params, sqlLimit]);
    let items = rows.map(rowToFootballNews);
    if (lang === 'ar') items = items.filter(item => hasArabicText(`${item.title} ${item.summary} ${item.source}`));
    if (topic === 'football') items = items.filter(item => hasFootballNewsText(`${item.title} ${item.summary} ${item.source}`));
    return items.slice(0, limit);
  }
  function listFootballProfiles(query = {}) {
    const where = ['visible = 1'];
    const params = [];
    const kind = String(query.kind || '').trim().toLowerCase();
    const type = String(query.type || '').trim().toLowerCase();
    if (kind === 'team') {
      where.push("source LIKE '%World Cup%'");
    } else if (kind === 'club') {
      where.push('type = ?');
      params.push('club');
      where.push("(source IS NULL OR source NOT LIKE '%World Cup%')");
    } else if (kind === 'player') {
      where.push('type = ?');
      params.push('player');
    } else if (type === 'club' || type === 'player') {
      where.push('type = ?');
      params.push(type);
    }
    const q = String(query.q || '').trim().toLowerCase();
    if (q) {
      where.push('(LOWER(name) LIKE ? OR LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(source) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const limit = Math.max(1, Math.min(120, Number(query.limit || 40)));
    return mediaDb.all(`SELECT * FROM football_profiles WHERE ${where.join(' AND ')} ORDER BY priority DESC, name COLLATE NOCASE ASC LIMIT ?`, [...params, limit]).map(rowToFootballProfile);
  }
  async function fetchFootballProfileSummary(profile = {}) {
    const title = String(profile.title || profile.name || '').trim();
    if (!title) return null;
    const urlTitle = encodeURIComponent(title.replace(/\s+/g, '_'));
    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${urlTitle}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'LightMediaServer-FootballImporter/1.0', accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
    const data = await response.json();
    const summary = String(data.extract || '').trim();
    if (!summary) return null;
    return {
      id: `profile-${footballHash(`${profile.type}:${profile.name}`)}`,
      type: profile.type === 'player' ? 'player' : 'club',
      name: profile.name,
      title: data.title || profile.name,
      summary: summary.slice(0, 900),
      url: data.content_urls?.desktop?.page || '',
      image: data.thumbnail?.source || data.originalimage?.source || '',
      source: 'Wikipedia',
      priority: Number(profile.priority || 0),
      raw: { pageid: data.pageid || null, wikibaseItem: data.wikibase_item || null }
    };
  }
  let footballImportTimer = null;
  let footballImportStatus = { running: false, lastStartedAt: null, lastFinishedAt: null, message: 'لم يبدأ الاستيراد بعد.', newsImported: 0, profilesImported: 0, errors: [] };
  async function runFootballImport(reason = 'manual') {
    if (footballImportStatus.running) return { ...footballImportStatus, skipped: true };
    const footballCfg = normalizeFootballConfig(config.football || {});
    footballImportStatus = { running: true, lastStartedAt: new Date().toISOString(), lastFinishedAt: null, message: 'جاري استيراد أخبار ومعلومات كرة القدم...', newsImported: 0, profilesImported: 0, errors: [] };
    const now = new Date().toISOString();
    try {
      const newsSeen = new Set();
      let importedNews = 0;
      for (const feed of footballCfg.newsFeeds) {
        try {
          const xml = await fetchTextUrl(feed.url);
          const items = parseFeedItems(xml, feed).slice(0, footballCfg.maxNewsItems);
          for (const item of items) {
            if (newsSeen.has(item.id)) continue;
            newsSeen.add(item.id);
            mediaDb.run(
              'INSERT OR REPLACE INTO football_news(id, title, summary, url, source, image, published_at, raw_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,COALESCE((SELECT created_at FROM football_news WHERE id = ?), ?),?)',
              [item.id, item.title, item.summary, item.url, item.source, item.image || null, item.publishedAt, JSON.stringify(item.raw || {}), item.id, now, now]
            );
            importedNews += 1;
          }
        } catch (error) {
          footballImportStatus.errors.push(`${feed.name || feed.url}: ${error.message}`);
        }
      }
      const teamRows = mediaDb.all('SELECT DISTINCT home_team AS name FROM football_matches UNION SELECT DISTINCT away_team AS name FROM football_matches');
      const dynamicProfiles = teamRows.map(row => ({ type: 'club', name: row.name })).filter(profile => profile.name);
      const profileMap = new Map();
      for (const profile of [...footballCfg.trackedProfiles, ...dynamicProfiles]) {
        const key = `${profile.type}:${String(profile.name || '').toLowerCase()}`;
        if (!profile.name || profileMap.has(key)) continue;
        profileMap.set(key, profile);
      }
      let importedProfiles = 0;
      for (const profile of [...profileMap.values()].slice(0, 40)) {
        try {
          const item = await fetchFootballProfileSummary(profile);
          if (!item) continue;
          mediaDb.run(
            'INSERT OR REPLACE INTO football_profiles(id, type, name, title, summary, url, image, source, visible, priority, raw_json, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            [item.id, item.type, item.name, item.title, item.summary, item.url, item.image || null, item.source, 1, item.priority, JSON.stringify(item.raw || {}), now]
          );
          importedProfiles += 1;
        } catch (error) {
          footballImportStatus.errors.push(`${profile.name}: ${error.message}`);
        }
      }
      mediaDb.save();
      const summary = { reason, newsImported: importedNews, profilesImported: importedProfiles, errors: footballImportStatus.errors.slice(0, 10) };
      saveConfig({ ...config, football: { ...footballCfg, lastImportAt: now, lastImportSummary: summary } });
      footballImportStatus = { running: false, lastStartedAt: footballImportStatus.lastStartedAt, lastFinishedAt: new Date().toISOString(), message: 'اكتمل استيراد كرة القدم.', newsImported: importedNews, profilesImported: importedProfiles, errors: footballImportStatus.errors };
      setupFootballImportSchedule(false);
      return footballImportStatus;
    } catch (error) {
      footballImportStatus = { ...footballImportStatus, running: false, lastFinishedAt: new Date().toISOString(), message: error.message || 'فشل استيراد كرة القدم.' };
      return footballImportStatus;
    }
  }
  function setupFootballImportSchedule(runStartup = false) {
    if (footballImportTimer) clearInterval(footballImportTimer);
    const footballCfg = normalizeFootballConfig(config.football || {});
    if (!footballCfg.autoImport) return;
    const intervalMs = Math.max(1, Number(footballCfg.intervalHours || 6)) * 60 * 60 * 1000;
    footballImportTimer = setInterval(() => { runFootballImport('schedule').catch(() => null); }, intervalMs);
    if (footballImportTimer.unref) footballImportTimer.unref();
    if (runStartup && footballCfg.importOnStartup) {
      setTimeout(() => { runFootballImport('startup').catch(() => null); }, 8000);
    }
  }
  function normalizeMatchStatus(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (['live', 'running', 'in_play'].includes(raw)) return 'live';
    if (['finished', 'done', 'ended'].includes(raw)) return 'finished';
    if (['postponed', 'delayed'].includes(raw)) return 'postponed';
    if (['cancelled', 'canceled'].includes(raw)) return 'cancelled';
    return 'scheduled';
  }
  function normalizeMatchNews(value = []) {
    if (Array.isArray(value)) {
      return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12);
    }
    return String(value || '')
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  function getLinkedChannelInfo(channelId = '') {
    const id = String(channelId || '').trim();
    if (!id) return null;
    const row = mediaDb.get('SELECT raw_json, group_title FROM channels WHERE id = ? AND hidden = 0 LIMIT 1', [id]);
    const item = row ? rowToChannelItem(row) : null;
    if (!item?.id) return null;
    return {
      id: item.id,
      title: item.title || 'قناة',
      logo: item.logo || null,
      sourceName: item.sourceName || '',
      groupTitle: item.groupTitle || '',
      watchHref: `/watch?type=channel&id=${encodeURIComponent(item.id)}`
    };
  }
  function rowToFootballMatch(row = {}) {
    const linkedChannel = getLinkedChannelInfo(row.linked_channel_id);
    const homeTeamMeta = getFootballTeamMeta(row.home_team || '');
    const awayTeamMeta = getFootballTeamMeta(row.away_team || '');
    return {
      id: row.id,
      competition: row.competition || '',
      homeTeam: row.home_team || '',
      awayTeam: row.away_team || '',
      homeTeamMeta,
      awayTeamMeta,
      kickoffAt: row.kickoff_at || '',
      status: normalizeMatchStatus(row.status),
      homeScore: row.home_score === null || row.home_score === undefined || row.home_score === '' ? null : Number(row.home_score),
      awayScore: row.away_score === null || row.away_score === undefined || row.away_score === '' ? null : Number(row.away_score),
      venue: row.venue || '',
      round: row.round || '',
      headline: row.headline || '',
      summary: row.summary || '',
      details: row.details || '',
      news: parseMaybeJson(row.news_json, []),
      linkedChannelId: row.linked_channel_id || '',
      linkedChannelTitle: linkedChannel?.title || row.linked_channel_title || '',
      linkedChannel,
      visible: !!Number(row.visible ?? 1),
      priority: Number(row.priority || 0),
      createdAt: row.created_at || '',
      updatedAt: row.updated_at || ''
    };
  }
  function listFootballMatches(query = {}, admin = false) {
    const where = [];
    const params = [];
    if (!admin) where.push('visible = 1');
    if (query.includeHidden === '0' || query.includeHidden === 'false') where.push('visible = 1');
    const status = String(query.status || '').trim().toLowerCase();
    if (status && status !== 'all') { where.push('status = ?'); params.push(normalizeMatchStatus(status)); }
    const competition = String(query.competition || '').trim();
    if (competition) { where.push('LOWER(competition) = LOWER(?)'); params.push(competition); }
    const q = String(query.q || '').trim().toLowerCase();
    if (q) {
      where.push('(LOWER(home_team) LIKE ? OR LOWER(away_team) LIKE ? OR LOWER(competition) LIKE ? OR LOWER(headline) LIKE ? OR LOWER(summary) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(mediaDb.get(`SELECT COUNT(*) AS count FROM football_matches ${whereSql}`, params)?.count || 0);
    const meta = paginateMeta(query.page, query.limit || 80, total);
    const rows = mediaDb.all(
      `SELECT * FROM football_matches ${whereSql}
       ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'postponed' THEN 2 WHEN 'finished' THEN 3 ELSE 4 END ASC,
                priority DESC,
                COALESCE(kickoff_at, '') ASC,
                updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, meta.limit, meta.offset]
    );
    const competitions = mediaDb.all(`SELECT competition, COUNT(*) AS count FROM football_matches ${admin ? '' : 'WHERE visible = 1'} GROUP BY competition ORDER BY competition COLLATE NOCASE ASC`)
      .map(row => ({ name: row.competition || 'بطولات عامة', count: Number(row.count || 0) }));
    return { ...meta, items: rows.map(rowToFootballMatch), competitions };
  }
  function buildFootballStandings(query = {}) {
    const where = ['visible = 1'];
    const params = [];
    const competition = String(query.competition || '').trim();
    if (competition) { where.push('LOWER(competition) = LOWER(?)'); params.push(competition); }
    const q = String(query.q || '').trim().toLowerCase();
    if (q) {
      where.push('(LOWER(home_team) LIKE ? OR LOWER(away_team) LIKE ? OR LOWER(competition) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = mediaDb.all(
      `SELECT competition, home_team, away_team, status, home_score, away_score, kickoff_at
       FROM football_matches
       WHERE ${where.join(' AND ')}
       ORDER BY competition COLLATE NOCASE ASC, COALESCE(kickoff_at, '') ASC`,
      params
    );
    const groups = new Map();
    function entryFor(group, team) {
      const name = String(team || '').trim();
      if (!name || isPlaceholderFootballTeamName(name)) return null;
      if (!group.rows.has(name)) {
        group.rows.set(name, { team: name, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0, results: [] });
      }
      return group.rows.get(name);
    }
    for (const row of rows) {
      const competitionName = row.competition || 'بطولات عامة';
      if (/الأدوار الإقصائية|إقصائية|knockout|round of|quarter|semi|final/i.test(competitionName)) continue;
      if (!groups.has(competitionName)) groups.set(competitionName, { competition: competitionName, rows: new Map() });
      const group = groups.get(competitionName);
      const home = entryFor(group, row.home_team);
      const away = entryFor(group, row.away_team);
      const hasHomeScore = row.home_score !== null && row.home_score !== undefined && row.home_score !== '';
      const hasAwayScore = row.away_score !== null && row.away_score !== undefined && row.away_score !== '';
      const status = normalizeMatchStatus(row.status);
      if (!home || !away || !hasHomeScore || !hasAwayScore || !['finished', 'live'].includes(status)) continue;
      const homeScore = Number(row.home_score);
      const awayScore = Number(row.away_score);
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
      home.played += 1; away.played += 1;
      home.goalsFor += homeScore; home.goalsAgainst += awayScore;
      away.goalsFor += awayScore; away.goalsAgainst += homeScore;
      if (homeScore > awayScore) {
        home.wins += 1; home.points += 3; away.losses += 1;
        home.results.push('فوز'); away.results.push('خسارة');
      } else if (homeScore < awayScore) {
        away.wins += 1; away.points += 3; home.losses += 1;
        away.results.push('فوز'); home.results.push('خسارة');
      } else {
        home.draws += 1; away.draws += 1; home.points += 1; away.points += 1;
        home.results.push('تعادل'); away.results.push('تعادل');
      }
      home.goalDiff = home.goalsFor - home.goalsAgainst;
      away.goalDiff = away.goalsFor - away.goalsAgainst;
    }
    const resultGroups = [...groups.values()].map(group => ({
      competition: group.competition,
      rows: [...group.rows.values()]
        .map(row => ({ ...row, results: row.results.slice(-5) }))
        .sort((a, b) =>
          b.points - a.points ||
          b.goalDiff - a.goalDiff ||
          b.goalsFor - a.goalsFor ||
          a.team.localeCompare(b.team, 'ar')
        )
        .map((row, index) => ({ rank: index + 1, ...row, teamMeta: getFootballTeamMeta(row.team) }))
    })).filter(group => group.rows.length);
    const limitGroups = Math.max(1, Math.min(40, Number(query.limitGroups || 18)));
    return { groups: resultGroups.slice(0, limitGroups), totalGroups: resultGroups.length };
  }
  function normalizeFootballMatchPayload(body = {}, existing = null) {
    const now = new Date().toISOString();
    const linkedChannel = getLinkedChannelInfo(body.linkedChannelId || body.linked_channel_id || '');
    const homeScoreRaw = body.homeScore ?? body.home_score ?? '';
    const awayScoreRaw = body.awayScore ?? body.away_score ?? '';
    return {
      id: existing?.id || String(body.id || uid('match')),
      competition: String(body.competition || '').trim(),
      homeTeam: String(body.homeTeam || body.home_team || '').trim(),
      awayTeam: String(body.awayTeam || body.away_team || '').trim(),
      kickoffAt: String(body.kickoffAt || body.kickoff_at || '').trim(),
      status: normalizeMatchStatus(body.status),
      homeScore: homeScoreRaw === '' || homeScoreRaw === null || homeScoreRaw === undefined ? null : Number(homeScoreRaw),
      awayScore: awayScoreRaw === '' || awayScoreRaw === null || awayScoreRaw === undefined ? null : Number(awayScoreRaw),
      venue: String(body.venue || '').trim(),
      round: String(body.round || '').trim(),
      headline: String(body.headline || '').trim(),
      summary: String(body.summary || '').trim(),
      details: String(body.details || '').trim(),
      news: normalizeMatchNews(body.news ?? body.newsText ?? ''),
      linkedChannelId: linkedChannel?.id || '',
      linkedChannelTitle: linkedChannel?.title || '',
      visible: body.visible === false || body.visible === 'false' || body.visible === 0 || body.visible === '0' ? 0 : 1,
      priority: Number(body.priority || 0),
      createdAt: existing?.created_at || now,
      updatedAt: now
    };
  }
  function saveFootballMatch(match, persist = true) {
    mediaDb.run(
      `INSERT OR REPLACE INTO football_matches(id, competition, home_team, away_team, kickoff_at, status, home_score, away_score, venue, round, headline, summary, details, news_json, linked_channel_id, linked_channel_title, visible, priority, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [match.id, match.competition, match.homeTeam, match.awayTeam, match.kickoffAt || null, match.status, match.homeScore, match.awayScore, match.venue, match.round, match.headline, match.summary, match.details, JSON.stringify(match.news || []), match.linkedChannelId || null, match.linkedChannelTitle || null, match.visible, match.priority, match.createdAt, match.updatedAt]
    );
    if (!persist) return match;
    mediaDb.save();
    return rowToFootballMatch(mediaDb.get('SELECT * FROM football_matches WHERE id = ? LIMIT 1', [match.id]));
  }
  let worldCupImportStatus = { running: false, lastImportedAt: null, message: 'لم يتم تضمين ملفات كأس العالم بعد.', matchesImported: 0, matchesUpdated: 0, teamsImported: 0, errors: [] };
  function worldCupDataFile(name) {
    return path.join(publicDir, 'data', name);
  }
  function worldCupDataSignature() {
    const files = ['worldcup_matches_2026.json', 'worldcup_teams.json', 'worldcup_sources.json', 'worldcup_openfootball_2026_import.json'];
    return files.map(name => {
      const file = worldCupDataFile(name);
      if (!fs.existsSync(file)) return `${name}:missing`;
      const stat = fs.statSync(file);
      return `${name}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    }).join('|');
  }
  function worldCupTeamLabel(team = {}) {
    return String(team.arabicName || team.name || team.code || '').trim();
  }
  function worldCupMatchPayload(item = {}, existing = null) {
    const homeTeam = String(item.homeTeamArabic || item.homeTeam || item.team1 || '').trim();
    const awayTeam = String(item.awayTeamArabic || item.awayTeam || item.team2 || '').trim();
    const groupValue = String(item.group || '').replace(/^Group\s+/i, '').trim();
    const scoreText = item.homeScore !== null && item.homeScore !== undefined && item.awayScore !== null && item.awayScore !== undefined
      ? `النتيجة: ${item.homeScore} - ${item.awayScore}`
      : '';
    const details = [
      item.details || '',
      item.homeTeam && item.homeTeam !== homeTeam ? `الاسم الإنجليزي: ${item.homeTeam} ضد ${item.awayTeam || ''}` : ''
    ].filter(Boolean).join('\n');
    return normalizeFootballMatchPayload({
      id: item.id || `wc2026-${String(item.sourceId || item.num || footballHash(`${homeTeam}:${awayTeam}:${item.kickoffAt || item.date || ''}`)).padStart(3, '0')}`,
      competition: item.competition || (groupValue ? `كأس العالم 2026 - المجموعة ${groupValue}` : 'كأس العالم 2026'),
      homeTeam,
      awayTeam,
      kickoffAt: item.kickoffAt || '',
      status: item.status || (item.score ? 'finished' : 'scheduled'),
      homeScore: item.homeScore ?? item.score?.ft?.[0] ?? '',
      awayScore: item.awayScore ?? item.score?.ft?.[1] ?? '',
      venue: item.venue || '',
      round: item.round || '',
      headline: item.headline || `${homeTeam} ضد ${awayTeam}`,
      summary: item.summary || `مباراة ${homeTeam} ضد ${awayTeam} ضمن كأس العالم 2026.`,
      details,
      news: normalizeMatchNews([...new Set([...(Array.isArray(item.news) ? item.news : []), groupValue ? `المجموعة ${groupValue}` : '', item.homeCode && item.awayCode ? `${item.homeCode} - ${item.awayCode}` : '', scoreText].filter(Boolean))]),
      visible: existing ? !!Number(existing.visible ?? 1) : item.visible !== false,
      priority: existing ? Number(existing.priority || 0) : Number(item.priority || 0),
      linkedChannelId: existing?.linked_channel_id || ''
    }, existing);
  }
  function importWorldCupDataFromFiles({ reason = 'manual', force = true } = {}) {
    if (worldCupImportStatus.running) return { ...worldCupImportStatus, skipped: true };
    const signature = worldCupDataSignature();
    const metaKey = 'worldcup_2026_import_signature';
    const previousSignature = mediaDb.get('SELECT value FROM meta WHERE key = ? LIMIT 1', [metaKey])?.value || '';
    if (!force && previousSignature === signature) {
      return { ...worldCupImportStatus, skipped: true, message: 'ملفات كأس العالم مضمّنة مسبقًا.' };
    }
    worldCupImportStatus = { running: true, lastImportedAt: null, message: 'جاري تضمين كأس العالم 2026...', matchesImported: 0, matchesUpdated: 0, teamsImported: 0, errors: [] };
    const now = new Date().toISOString();
    try {
      const matchData = readJson(worldCupDataFile('worldcup_matches_2026.json'), {});
      const teamData = readJson(worldCupDataFile('worldcup_teams.json'), {});
      const sourceData = readJson(worldCupDataFile('worldcup_sources.json'), {});
      const matches = Array.isArray(matchData.matches) ? matchData.matches : [];
      const teams = Array.isArray(teamData.teams) ? teamData.teams : [];
      for (const item of matches) {
        try {
          const existing = mediaDb.get('SELECT * FROM football_matches WHERE id = ? LIMIT 1', [item.id || '']);
          const match = worldCupMatchPayload(item, existing);
          if (!match.homeTeam || !match.awayTeam) continue;
          saveFootballMatch(match, false);
          if (existing) worldCupImportStatus.matchesUpdated += 1;
          else worldCupImportStatus.matchesImported += 1;
        } catch (error) {
          worldCupImportStatus.errors.push(`match ${item?.id || item?.sourceId || ''}: ${error.message}`);
        }
      }
      for (const team of teams) {
        try {
          const code = String(team.code || team.scheduleCode || team.id || '').trim().toLowerCase();
          const title = worldCupTeamLabel(team);
          if (!code || !title) continue;
          const players = Array.isArray(team.players) ? team.players : [];
          const coach = team.coach?.name ? `المدرب: ${team.coach.name}` : '';
          const group = team.group ? `المجموعة ${team.group}` : '';
          const summary = [group, coach, `${players.length} لاعب في القائمة`].filter(Boolean).join(' • ');
          mediaDb.run(
            'INSERT OR REPLACE INTO football_profiles(id, type, name, title, summary, url, image, source, visible, priority, raw_json, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            [`profile-wc2026-${code}`, 'club', team.name || title, title, summary, sourceData.squadSource || '', '', 'FIFA World Cup 2026', 1, 80, JSON.stringify({
              id: team.id || code,
              code: team.code || '',
              scheduleCode: team.scheduleCode || '',
              name: team.name || '',
              arabicName: team.arabicName || '',
              group: team.group || '',
              coach: team.coach || null,
              playerCount: players.length,
              sources: sourceData
            }), now]
          );
          worldCupImportStatus.teamsImported += 1;
        } catch (error) {
          worldCupImportStatus.errors.push(`team ${team?.code || team?.name || ''}: ${error.message}`);
        }
      }
      mediaDb.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', [metaKey, signature]);
      mediaDb.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', ['worldcup_2026_import_status', JSON.stringify({ ...worldCupImportStatus, running: false, reason, source: matchData.source || '', generatedAt: matchData.generatedAt || '' })]);
      mediaDb.save();
      worldCupImportStatus = { ...worldCupImportStatus, running: false, lastImportedAt: now, message: 'تم تضمين كأس العالم 2026 في المباريات.', errors: worldCupImportStatus.errors.slice(0, 20) };
      return { ...worldCupImportStatus, reason, matchCount: matches.length, teamCount: teams.length };
    } catch (error) {
      worldCupImportStatus = { ...worldCupImportStatus, running: false, lastImportedAt: now, message: error.message || 'فشل تضمين كأس العالم 2026.' };
      return worldCupImportStatus;
    }
  }
  function channelOrderSql() {
    return 'CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END ASC, sort_order ASC, title COLLATE NOCASE ASC';
  }
  function applyChannelOverrideToItem(item = {}, override = null) {
    if (!item || !override) return item;
    const title = String(override.title || '').trim();
    const logo = String(override.logo || '').trim();
    const groupTitle = String(override.group_title || '').trim();
    const sortValue = override.sort_order === null || override.sort_order === undefined || override.sort_order === ''
      ? null
      : Number(override.sort_order);
    const streamSettings = normalizeChannelStreamSettings(override.stream_settings_json);
    return {
      ...item,
      originalTitle: item.originalTitle || override.original_title || item.title || '',
      originalLogo: item.originalLogo || override.original_logo || item.logo || '',
      originalGroupTitle: item.originalGroupTitle || item.groupTitle || '',
      title: title || item.title,
      logo: logo || item.logo || null,
      groupTitle: groupTitle || item.groupTitle || '',
      hidden: !!item.hidden || !!Number(override.hidden || 0),
      sortOrder: Number.isFinite(sortValue) ? sortValue : null,
      ...(Object.keys(streamSettings).length ? { streamSettings } : {}),
      overrideUpdatedAt: override.updated_at || null
    };
  }
  function getChannelOverride(channelId = '') {
    return mediaDb.get('SELECT * FROM channel_overrides WHERE channel_id = ? LIMIT 1', [String(channelId || '')]);
  }
  function updateChannelOverride(channelId = '', patch = {}) {
    const row = mediaDb.get('SELECT * FROM channels WHERE id = ? LIMIT 1', [channelId]);
    if (!row) return null;
    const currentItem = rowToItem(row) || {};
    const existing = getChannelOverride(channelId) || {};
    const originalTitle = existing.original_title || currentItem.originalTitle || currentItem.title || row.title || '';
    const originalLogo = existing.original_logo || currentItem.originalLogo || currentItem.logo || row.logo || '';
    const sortRaw = patch.sortOrder ?? patch.sort_order ?? '';
    const sortOrder = sortRaw === '' || sortRaw === null || sortRaw === undefined ? null : Number(sortRaw);
    const hasStreamSettings = Object.prototype.hasOwnProperty.call(patch, 'streamSettings');
    const streamSettings = normalizeChannelStreamSettings(hasStreamSettings ? patch.streamSettings : existing.stream_settings_json);
    const streamSettingsJson = Object.keys(streamSettings).length ? JSON.stringify(streamSettings) : null;
    const override = {
      channel_id: channelId,
      source_id: currentItem.sourceId || row.source_id || '',
      original_title: originalTitle,
      original_logo: originalLogo,
      title: String(patch.title || '').trim(),
      logo: String(patch.logo || '').trim(),
      group_title: String(patch.groupTitle || patch.group_title || '').trim(),
      hidden: patch.hidden ? 1 : 0,
      sort_order: Number.isFinite(sortOrder) ? sortOrder : null,
      notes: String(patch.notes || '').trim(),
      stream_settings_json: streamSettingsJson,
      updated_at: new Date().toISOString()
    };
    mediaDb.run(
      'INSERT OR REPLACE INTO channel_overrides(channel_id, source_id, original_title, original_logo, title, logo, group_title, hidden, sort_order, notes, stream_settings_json, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [override.channel_id, override.source_id, override.original_title, override.original_logo, override.title, override.logo, override.group_title, override.hidden, override.sort_order, override.notes, override.stream_settings_json, override.updated_at]
    );
    const updatedItem = applyChannelOverrideToItem({
      ...currentItem,
      title: currentItem.originalTitle || currentItem.title || row.title || '',
      logo: currentItem.originalLogo || currentItem.logo || row.logo || null,
      groupTitle: currentItem.groupTitle || row.group_title || ''
    }, override);
    mediaDb.run(
      'UPDATE channels SET title = ?, logo = ?, group_title = ?, hidden = ?, sort_order = ?, raw_json = ? WHERE id = ?',
      [updatedItem.title || null, updatedItem.logo || null, updatedItem.groupTitle || null, updatedItem.hidden ? 1 : 0, updatedItem.sortOrder, JSON.stringify(updatedItem), channelId]
    );
    mediaDb.save();
    return updatedItem;
  }
  function resetChannelOverride(channelId = '') {
    const row = mediaDb.get('SELECT * FROM channels WHERE id = ? LIMIT 1', [channelId]);
    if (!row) return null;
    const existing = getChannelOverride(channelId);
    const currentItem = rowToItem(row) || {};
    const restored = {
      ...currentItem,
      title: existing?.original_title || currentItem.originalTitle || currentItem.title || row.title || '',
      logo: existing?.original_logo || currentItem.originalLogo || currentItem.logo || row.logo || null,
      hidden: false,
      sortOrder: null,
      groupTitle: currentItem.originalGroupTitle || currentItem.groupTitle || row.group_title || ''
    };
    delete restored.overrideUpdatedAt;
    mediaDb.run('DELETE FROM channel_overrides WHERE channel_id = ?', [channelId]);
    const finalItem = applyChannelGroupOverrideToItem(restored, getChannelGroupOverrideForItem(restored));
    mediaDb.run(
      'UPDATE channels SET title = ?, logo = ?, group_title = ?, hidden = ?, sort_order = NULL, raw_json = ? WHERE id = ?',
      [finalItem.title || null, finalItem.logo || null, finalItem.groupTitle || null, finalItem.hidden ? 1 : 0, JSON.stringify(finalItem), channelId]
    );
    mediaDb.save();
    return finalItem;
  }
  function normalizeChannelGroupValue(value = '') {
    return String(value || '').trim();
  }
  function getChannelGroupOverride(sourceId = '', groupTitle = '') {
    const source = String(sourceId || '').trim();
    const group = normalizeChannelGroupValue(groupTitle);
    return mediaDb.get(
      'SELECT * FROM channel_group_overrides WHERE source_id = ? AND original_group_title = ? LIMIT 1',
      [source, group]
    );
  }
  function getChannelGroupOverrideForItem(item = {}) {
    const sourceId = String(item.sourceId || '').trim();
    const groupTitle = normalizeChannelGroupValue(item.originalGroupTitle || item.groupTitle || '');
    return getChannelGroupOverride(sourceId, groupTitle) || getChannelGroupOverride('', groupTitle) || null;
  }
  function applyChannelGroupOverrideToItem(item = {}, override = null) {
    if (!item || !override) return item;
    const originalGroupTitle = item.originalGroupTitle || item.groupTitle || '';
    const title = String(override.title || '').trim();
    return {
      ...item,
      originalGroupTitle,
      groupTitle: title || item.groupTitle || '',
      groupHidden: !!Number(override.hidden || 0),
      hidden: !!Number(override.hidden || 0) || !!item.hidden,
      groupOverrideUpdatedAt: override.updated_at || null
    };
  }
  function channelRowMatchesGroup(row = {}, item = {}, groupTitle = '') {
    const wanted = normalizeChannelGroupValue(groupTitle);
    const current = normalizeChannelGroupValue(row.group_title || item.groupTitle || '');
    const original = normalizeChannelGroupValue(item.originalGroupTitle || current);
    return wanted ? (current === wanted || original === wanted) : (!current || !original);
  }
  function updateChannelRowFromItem(channelId = '', item = {}) {
    mediaDb.run(
      'UPDATE channels SET title = ?, logo = ?, group_title = ?, hidden = ?, sort_order = ?, raw_json = ? WHERE id = ?',
      [
        item.title || null,
        item.logo || null,
        item.groupTitle || null,
        item.hidden ? 1 : 0,
        Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : null,
        JSON.stringify(item),
        channelId
      ]
    );
  }
  function recomputeChannelPresentation(row = {}, groupOverride = null) {
    const currentItem = rowToItem(row) || {};
    const originalGroupTitle = currentItem.originalGroupTitle || row.group_title || currentItem.groupTitle || '';
    const baseItem = {
      ...currentItem,
      originalGroupTitle,
      groupTitle: originalGroupTitle,
      hidden: false
    };
    const withGroup = applyChannelGroupOverrideToItem(baseItem, groupOverride || getChannelGroupOverrideForItem(baseItem));
    const channelOverride = getChannelOverride(row.id);
    return channelOverride ? applyChannelOverrideToItem(withGroup, channelOverride) : withGroup;
  }
  function findRowsForChannelGroup(sourceId = '', groupTitle = '') {
    const source = String(sourceId || '').trim();
    const rows = source
      ? mediaDb.all('SELECT * FROM channels WHERE source_id = ?', [source])
      : mediaDb.all('SELECT * FROM channels');
    return rows.filter(row => channelRowMatchesGroup(row, rowToItem(row) || {}, groupTitle));
  }
  function updateChannelGroupOverride(patch = {}) {
    const sourceId = String(patch.sourceId || patch.source_id || '').trim();
    const originalGroupTitle = normalizeChannelGroupValue(patch.groupTitle || patch.group_title || patch.originalGroupTitle || patch.original_group_title || '');
    const sortRaw = patch.sortOrder ?? patch.sort_order ?? '';
    const sortOrder = sortRaw === '' || sortRaw === null || sortRaw === undefined ? null : Number(sortRaw);
    const override = {
      source_id: sourceId,
      original_group_title: originalGroupTitle,
      title: String(patch.title || '').trim(),
      hidden: patch.hidden ? 1 : 0,
      sort_order: Number.isFinite(sortOrder) ? sortOrder : null,
      notes: String(patch.notes || '').trim(),
      updated_at: new Date().toISOString()
    };
    mediaDb.run(
      'INSERT OR REPLACE INTO channel_group_overrides(source_id, original_group_title, title, hidden, sort_order, notes, updated_at) VALUES(?,?,?,?,?,?,?)',
      [override.source_id, override.original_group_title, override.title, override.hidden, override.sort_order, override.notes, override.updated_at]
    );
    const rows = findRowsForChannelGroup(sourceId, originalGroupTitle);
    for (const row of rows) {
      const updated = recomputeChannelPresentation(row, override);
      updateChannelRowFromItem(row.id, updated);
    }
    mediaDb.save();
    return { ...override, affected: rows.length };
  }
  function resetChannelGroupOverride(sourceId = '', groupTitle = '') {
    const source = String(sourceId || '').trim();
    const group = normalizeChannelGroupValue(groupTitle);
    const rows = findRowsForChannelGroup(source, group);
    mediaDb.run('DELETE FROM channel_group_overrides WHERE source_id = ? AND original_group_title = ?', [source, group]);
    for (const row of rows) {
      const updated = recomputeChannelPresentation(row, null);
      updateChannelRowFromItem(row.id, updated);
    }
    mediaDb.save();
    return { sourceId: source, groupTitle: group, affected: rows.length };
  }
  function normalizeMediaType(value = '') {
    const raw = String(value || '').toLowerCase();
    if (raw === 'movie' || raw === 'movies') return 'movies';
    if (raw === 'series' || raw === 'episode') return 'series';
    if (raw === 'audio') return 'audio';
    if (raw === 'channel') return 'channel';
    return raw;
  }
  function tokenizeMediaText(value = '') {
    return String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token && token.length > 1);
  }
  function getMediaTokens(item = {}) {
    const fields = [
      item.title,
      item.showTitle,
      item.libraryName,
      item.folderPath,
      item.mediaFolder,
      item.description,
      Array.isArray(item.genres) ? item.genres.join(' ') : ''
    ];
    return new Set(fields.flatMap(tokenizeMediaText));
  }
  function scoreSimilarItem(baseItem, candidate) {
    if (!baseItem || !candidate || baseItem.id === candidate.id) return -1;
    let score = 0;
    if (baseItem.libraryId && candidate.libraryId && baseItem.libraryId === candidate.libraryId) score += 30;
    if (baseItem.folderPath && candidate.folderPath && (candidate.folderPath.startsWith(baseItem.folderPath) || baseItem.folderPath.startsWith(candidate.folderPath))) score += 25;
    if (baseItem.showTitle && candidate.showTitle && baseItem.showTitle === candidate.showTitle) score += 40;
    if (baseItem.sourceType && candidate.sourceType && baseItem.sourceType === candidate.sourceType) score += 20;
    const baseTokens = getMediaTokens(baseItem);
    const candidateTokens = getMediaTokens(candidate);
    let overlap = 0;
    for (const token of candidateTokens) {
      if (baseTokens.has(token)) overlap += 1;
    }
    score += Math.min(30, overlap * 4);
    return score;
  }
  function getEpisodeParentShow(episodeId = '') {
    const rows = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ?', ['series']);
    for (const row of rows) {
      const show = rowToItem(row);
      const seasons = Object.values(show?.seasons || {});
      for (const episodes of seasons) {
        const found = (episodes || []).find(ep => String(ep?.id || '') === String(episodeId || ''));
        if (found) return { show, episode: found };
      }
    }
    return null;
  }
  function getSimilarContent(type = '', id = '', limit = 12) {
    const normalizedType = normalizeMediaType(type);
    let baseItem = null;
    let candidates = [];
    if (normalizedType === 'channel') {
      const row = mediaDb.get('SELECT raw_json FROM channels WHERE id = ? LIMIT 1', [id]);
      baseItem = row ? hydrateChannelItem(rowToItem(row)) : null;
      candidates = mediaDb.all('SELECT raw_json FROM channels').map(rowToItem).map(hydrateChannelItem);
    } else if (normalizedType === 'series' && String(type || '').toLowerCase() === 'episode') {
      const parent = getEpisodeParentShow(id);
      if (parent?.show) {
        baseItem = { ...parent.show, showTitle: parent.show.title, currentEpisodeId: id };
        const siblingEpisodes = Object.values(parent.show.seasons || {}).flat().filter(ep => String(ep?.id || '') !== String(id || '')).slice(0, 6).map(ep => ({
          ...ep,
          type: 'episode',
          mediaType: 'episode',
          libraryId: parent.show.libraryId,
          libraryName: parent.show.libraryName,
          folderPath: parent.show.folderPath,
          showTitle: parent.show.title,
          poster: parent.show.poster
        }));
        const seriesRows = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ?', ['series']).map(rowToItem).filter(item => item?.id !== parent.show.id);
        const similarSeries = seriesRows
          .map(item => ({ item, score: scoreSimilarItem(parent.show, item) }))
          .filter(entry => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(0, limit - siblingEpisodes.length))
          .map(entry => entry.item);
        return [...siblingEpisodes, ...similarSeries].slice(0, limit);
      }
    } else {
      const row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', [normalizedType, id]);
      baseItem = row ? rowToItem(row) : null;
      candidates = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ?', [normalizedType]).map(rowToItem);
    }
    if (!baseItem) return [];
    return candidates
      .map(item => ({ item, score: scoreSimilarItem(baseItem, item) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(entry => entry.item);
  }
  function enrichPlaybackItem(item, type) {
    if (!item) return item;
    const mediaPath = getItemMediaPath(item);
    if (!mediaPath || !fs.existsSync(mediaPath)) return item;
    const playbackType = type === 'audio' ? 'audio' : 'video';
    const compatibility = isDirectPlayCompatible(mediaPath, playbackType);
    const bypassTranscode = !!compatibility.bypassTranscode;
    const directUrl = item.streamUrl || item.url || '';
    const transcodeUrl = bypassTranscode ? '' : `/convert-media/${encodeURIComponent(type)}/${encodeURIComponent(item.id)}`;
    return {
      ...item,
      mediaPath,
      directStreamUrl: directUrl,
      transcodeUrl,
      needsTranscode: !bypassTranscode,
      playbackProfile: compatibility,
      preferredStreamUrl: bypassTranscode
        ? directUrl
        : (compatibility.directPlay ? directUrl : transcodeUrl),
      playbackMode: bypassTranscode
        ? 'direct-required'
        : (compatibility.directPlay ? 'direct-preferred' : 'portable-convert-required')
    };
  }
  function getLibraryIdsForBrowseType(type = '') {
    const normalized = String(type || '').trim().toLowerCase();
    return (config.libraries || [])
      .filter((library) => {
        if (normalized === 'mixed') return library.type === 'mixed';
        if (normalized === 'movies') return library.type === 'movies';
        if (normalized === 'audio') return library.type === 'audio';
        if (normalized === 'series') return library.type === 'series';
        return false;
      })
      .map((library) => String(library.id || '').trim())
      .filter(Boolean);
  }
  function mediaFolderSqlPath() {
    return "(CASE WHEN COALESCE(media_folder, '') <> '' AND COALESCE(folder_path, '') <> '' THEN folder_path || '/' || media_folder WHEN COALESCE(media_folder, '') <> '' THEN media_folder ELSE COALESCE(folder_path, '') END)";
  }
  function buildMediaWhere(type, reqQuery) {
    const mediaTypes = type === 'mixed' ? ['movies', 'audio'] : [type];
    const where = mediaTypes.length > 1
      ? [`type IN (${mediaTypes.map(() => '?').join(', ')})`]
      : ['type = ?'];
    const params = [...mediaTypes];
    const folderExpr = mediaFolderSqlPath();
    const allowedLibraryIds = getLibraryIdsForBrowseType(type);
    const libraryId = (reqQuery.libraryId || '').trim();
    const folder = (reqQuery.folder || '').trim();
    const q = (reqQuery.q || '').trim().toLowerCase();
    const directOnly = ['1', 'true', 'yes'].includes(String(reqQuery.directOnly || '').toLowerCase());
    if (libraryId) {
      if (allowedLibraryIds.length && !allowedLibraryIds.includes(libraryId)) where.push('1 = 0');
      else { where.push('library_id = ?'); params.push(libraryId); }
    } else {
      if (!allowedLibraryIds.length) where.push('1 = 0');
      else {
        where.push(`library_id IN (${allowedLibraryIds.map(() => '?').join(', ')})`);
        params.push(...allowedLibraryIds);
      }
    }
    if (folder) {
      if (directOnly) {
        where.push(`${folderExpr} = ?`);
        params.push(folder);
      } else {
        where.push(`(${folderExpr} = ? OR COALESCE(top_folder,'') = ? OR ${folderExpr} LIKE ?)`);
        params.push(folder, folder, folder + '/%');
      }
    } else if (directOnly) { where.push(`${folderExpr} = ''`); }
    if (q) { where.push('LOWER(title) LIKE ?'); params.push('%' + q + '%'); }
    return { where: where.join(' AND '), params };
  }
  function listMedia(type, reqQuery) {
    const { where, params } = buildMediaWhere(type, reqQuery);
    const totalRow = mediaDb.get(`SELECT COUNT(*) AS count FROM media_items WHERE ${where}`, params);
    const meta = paginateMeta(reqQuery.page, reqQuery.limit, Number(totalRow?.count || 0));
    const sort = (reqQuery.sort || 'new').trim();
    if (isCustomMediaSort(sort)) {
      const rows = mediaDb.all(`SELECT raw_json FROM media_items WHERE ${where}`, params);
      const sorted = sortMediaItems(rows.map(rowToItem), sort, type);
      return { ...meta, items: sorted.slice(meta.offset, meta.offset + meta.limit), generatedAt: getGeneratedAt(), scan: readScanStatus() };
    }
    const orderBy = sortKeyToSql(sort);
    const rows = mediaDb.all(`SELECT raw_json FROM media_items WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, meta.limit, meta.offset]);
    return { ...meta, items: rows.map(rowToItem), generatedAt: getGeneratedAt(), scan: readScanStatus() };
  }
  function listFolderNodes(type, reqQuery) {
    const mediaTypes = type === 'mixed' ? ['movies', 'audio'] : [type];
    const where = mediaTypes.length > 1
      ? [`type IN (${mediaTypes.map(() => '?').join(', ')})`]
      : ['type = ?'];
    const params = [...mediaTypes];
    const allowedLibraryIds = getLibraryIdsForBrowseType(type);
    const libraryId = (reqQuery.libraryId || '').trim();
    const parent = (reqQuery.parent || '').trim();
    const q = (reqQuery.q || '').trim().toLowerCase();
    if (libraryId) {
      if (allowedLibraryIds.length && !allowedLibraryIds.includes(libraryId)) where.push('1 = 0');
      else { where.push('library_id = ?'); params.push(libraryId); }
    } else {
      if (!allowedLibraryIds.length) where.push('1 = 0');
      else {
        where.push(`library_id IN (${allowedLibraryIds.map(() => '?').join(', ')})`);
        params.push(...allowedLibraryIds);
      }
    }
    where.push("COALESCE(parent_path, '') = ?");
    params.push(parent);
    if (q) { where.push('LOWER(name) LIKE ?'); params.push('%' + q + '%'); }
    const whereSql = where.join(' AND ');
    const allRows = mediaDb.all(`SELECT id, path, name, parent_path, depth, poster, item_count, child_count, created_at, updated_at, added_at FROM folder_nodes WHERE ${whereSql} ORDER BY name COLLATE NOCASE ASC`, params);
    const mergedRows = type === 'mixed'
      ? [...allRows.reduce((map, row) => {
          const key = String(row.path || '');
          const existing = map.get(key);
          if (!existing) {
            map.set(key, { ...row });
            return map;
          }
          existing.item_count = Number(existing.item_count || 0) + Number(row.item_count || 0);
          existing.child_count = Math.max(Number(existing.child_count || 0), Number(row.child_count || 0));
          if (!existing.poster && row.poster) existing.poster = row.poster;
          if ((!existing.created_at || new Date(row.created_at || 0).getTime() < new Date(existing.created_at || 0).getTime()) && row.created_at) existing.created_at = row.created_at;
          if ((!existing.updated_at || new Date(row.updated_at || 0).getTime() > new Date(existing.updated_at || 0).getTime()) && row.updated_at) existing.updated_at = row.updated_at;
          if ((!existing.added_at || new Date(row.added_at || 0).getTime() > new Date(existing.added_at || 0).getTime()) && row.added_at) existing.added_at = row.added_at;
          return map;
        }, new Map()).values()]
      : allRows;
    const meta = paginateMeta(reqQuery.page, reqQuery.limit || 30, mergedRows.length);
    const rows = mergedRows.slice(meta.offset, meta.offset + meta.limit);
    return {
      ...meta,
      parent,
      nodes: rows.map(r => ({
        id: r.id,
        path: r.path,
        name: r.name,
        parent: r.parent_path || '',
        depth: Number(r.depth || 0),
        poster: r.poster || null,
        itemCount: Number(r.item_count || 0),
        childCount: Number(r.child_count || 0),
        leaf: Number(r.child_count || 0) === 0,
        createdAt: r.created_at || null,
        updatedAt: r.updated_at || null,
        addedAt: r.added_at || null
      })),
      generatedAt: getGeneratedAt()
    };
  }
  function getUserPreferences(userId) {
    const row = appDb.get('SELECT json FROM preferences WHERE user_id = ? LIMIT 1', [userId]);
    return row ? parseMaybeJson(row.json, {}) : {};
  }
  function setUserPreferences(userId, patch) {
    const merged = { ...(getUserPreferences(userId) || {}), ...(patch || {}) };
    appDb.run('INSERT OR REPLACE INTO preferences(user_id, json) VALUES(?, ?)', [userId, JSON.stringify(merged)]);
    appDb.save();
    return merged;
  }
  function listFavorites(userId) {
    return appDb.all('SELECT type, item_id, title, poster, subtitle, href, updated_at FROM favorites WHERE user_id = ? ORDER BY updated_at DESC', [userId])
      .map(r => ({ type: r.type, id: r.item_id, title: r.title, poster: r.poster, subtitle: r.subtitle, href: r.href, updatedAt: r.updated_at }));
  }
  function toggleFavorite(userId, fav) {
    const exists = appDb.get('SELECT 1 AS x FROM favorites WHERE user_id = ? AND type = ? AND item_id = ? LIMIT 1', [userId, fav.type, fav.id]);
    if (exists) {
      appDb.run('DELETE FROM favorites WHERE user_id = ? AND type = ? AND item_id = ?', [userId, fav.type, fav.id]);
      appDb.save();
      return false;
    }
    appDb.run('INSERT OR REPLACE INTO favorites(user_id, type, item_id, title, poster, subtitle, href, updated_at) VALUES(?,?,?,?,?,?,?,?)', [userId, fav.type, fav.id, fav.title || null, fav.poster || null, fav.subtitle || null, fav.href || null, new Date().toISOString()]);
    appDb.save();
    return true;
  }
  function upsertHistory(userId, entry) {
    appDb.run('INSERT OR REPLACE INTO history(user_id, type, item_id, title, poster, subtitle, href, updated_at) VALUES(?,?,?,?,?,?,?,?)', [userId, entry.type, entry.id, entry.title || null, entry.poster || null, entry.subtitle || null, entry.href || null, new Date().toISOString()]);
  }
  function setProgress(userId, entry) {
    appDb.run('INSERT OR REPLACE INTO progress(user_id, type, item_id, position, duration, title, poster, subtitle, href, stream_url, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [userId, entry.type, entry.id, entry.position || 0, entry.duration || 0, entry.title || null, entry.poster || null, entry.subtitle || null, entry.href || null, entry.streamUrl || null, new Date().toISOString()]);
  }
  function removeProgress(userId, type, id) {
    appDb.run('DELETE FROM progress WHERE user_id = ? AND type = ? AND item_id = ?', [userId, type, id]);
  }
  function getContinueWatching(userId) {
    return appDb.all('SELECT type, item_id, position, duration, title, poster, subtitle, href, stream_url, updated_at FROM progress WHERE user_id = ? ORDER BY updated_at DESC', [userId])
      .filter(x => Number(x.position || 0) > 0 && Number(x.duration || 0) > 0 && Number(x.position || 0) < Number(x.duration || 0) * 0.95)
      .slice(0, 24)
      .map(x => ({ type: x.type, id: x.item_id, position: Number(x.position || 0), duration: Number(x.duration || 0), title: x.title, poster: x.poster, subtitle: x.subtitle, href: x.href, streamUrl: x.stream_url, updatedAt: x.updated_at }));
  }
  function buildEngagementIndex(type = '') {
    const normalizedTypes = type === 'mixed'
      ? ['movie', 'audio']
      : [type === 'movies' || type === 'movie'
        ? 'movie'
        : type === 'series'
          ? 'series'
          : type === 'audio'
            ? 'audio'
            : type];
    const scoreMap = new Map();
    const addScore = (itemId, amount) => {
      if (!itemId) return;
      scoreMap.set(String(itemId), Number(scoreMap.get(String(itemId)) || 0) + Number(amount || 0));
    };
    for (const normalizedType of normalizedTypes) {
      for (const row of appDb.all('SELECT item_id, COUNT(*) AS total FROM favorites WHERE type = ? GROUP BY item_id', [normalizedType])) addScore(row.item_id, Number(row.total || 0) * 5);
      for (const row of appDb.all('SELECT item_id, COUNT(*) AS total FROM history WHERE type = ? GROUP BY item_id', [normalizedType])) addScore(row.item_id, Number(row.total || 0) * 3);
      for (const row of appDb.all('SELECT item_id, COUNT(*) AS total FROM progress WHERE type = ? GROUP BY item_id', [normalizedType])) addScore(row.item_id, Number(row.total || 0) * 4);
    }
    return scoreMap;
  }
  function sortMediaItems(items, sort, type = '') {
    const mode = String(sort || '').trim();
    const list = (items || []).slice();
    const engagement = ['popular-desc', 'recommended-desc'].includes(mode) ? buildEngagementIndex(type) : null;
    list.sort((a, b) => {
      const ratingA = extractGlobalRating(a);
      const ratingB = extractGlobalRating(b);
      const yearA = extractItemYear(a);
      const yearB = extractItemYear(b);
      const scoreA = Number(engagement?.get(String(a?.id || '')) || 0);
      const scoreB = Number(engagement?.get(String(b?.id || '')) || 0);
      if (mode === 'rating-desc') return ratingB - ratingA || String(a?.title || '').localeCompare(String(b?.title || ''), 'ar');
      if (mode === 'rating-asc') return ratingA - ratingB || String(a?.title || '').localeCompare(String(b?.title || ''), 'ar');
      if (mode === 'year-desc') return yearB - yearA || ratingB - ratingA;
      if (mode === 'year-asc') return yearA - yearB || ratingB - ratingA;
      if (mode === 'popular-desc') return scoreB - scoreA || ratingB - ratingA || String(a?.title || '').localeCompare(String(b?.title || ''), 'ar');
      if (mode === 'recommended-desc') {
        const recA = scoreA + (ratingA * 2) + Math.min(10, Math.max(0, (yearA - 2000) / 3));
        const recB = scoreB + (ratingB * 2) + Math.min(10, Math.max(0, (yearB - 2000) / 3));
        return recB - recA || String(a?.title || '').localeCompare(String(b?.title || ''), 'ar');
      }
      return 0;
    });
    return list;
  }
  function hasIndexedItems() {
    const row = mediaDb.get('SELECT COUNT(*) AS count FROM media_items');
    return Number(row?.count || 0) > 0;
  }
  function maybeAutoStartScan() {
    const generatedAt = getGeneratedAt();
    const status = readScanStatus();
    if (!generatedAt && !hasIndexedItems() && config.scan?.autoStartOnEmptyIndex && !status.running) startBackgroundScan({ reason: 'auto-empty-index' });
  }
  function maybeRunScheduledScans() {
    const scanCfg = normalizeScanConfig(config.scan || {});
    if (!scanCfg.autoDailyTwice) return;
    const status = readScanStatus();
    if (status.running) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    let changed = false;
    for (const time of scanCfg.scheduleTimes || []) {
      if (time !== currentTime) continue;
      if (scanCfg.lastScheduledRuns?.[time] === today) continue;
      const result = startBackgroundScan({ reason: 'scheduled-daily', libraryName: 'كل المكتبات' });
      if (result.started) {
        scanCfg.lastScheduledRuns[time] = today;
        changed = true;
      }
    }
    if (changed) saveConfig({ ...config, scan: scanCfg });
  }
  function setupScheduledScans() {
    if (scheduledScanTimer) clearInterval(scheduledScanTimer);
    scheduledScanTimer = setInterval(() => {
      try { maybeRunScheduledScans(); } catch {}
    }, 60 * 1000);
    setTimeout(() => {
      try { maybeRunScheduledScans(); } catch {}
    }, 3000);
  }

  function formatBytes(bytes = 0) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    const digits = size >= 100 ? 0 : (size >= 10 ? 1 : 2);
    return `${size.toFixed(digits)} ${units[index]}`;
  }
  function toSingleLine(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  }
  function getBinaryDiagnostic(binaryPath = '', args = ['-version']) {
    const binary = String(binaryPath || '').trim();
    const usesPathLookup = !!binary && !(/[\\/]/.test(binary) || /^[a-zA-Z]:/.test(binary));
    const explicitExists = !binary ? false : (usesPathLookup ? null : fs.existsSync(binary));
    try {
      const probe = spawnSync(binary, args, {
        cwd: rootDir,
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true
      });
      const ok = !probe.error && probe.status === 0;
      const version = toSingleLine((probe.stdout || probe.stderr || '').split(/\r?\n/)[0] || '');
      return {
        path: binary,
        usesPathLookup,
        exists: explicitExists,
        ok,
        version: ok ? version : '',
        error: ok ? '' : toSingleLine(probe.error?.message || probe.stderr || probe.stdout || `exit ${probe.status}`)
      };
    } catch (error) {
      return {
        path: binary,
        usesPathLookup,
        exists: explicitExists,
        ok: false,
        version: '',
        error: toSingleLine(error?.message || 'unknown error')
      };
    }
  }
  function getFsEntryDiagnostic(targetPath = '') {
    const value = String(targetPath || '').trim();
    if (!value) return { path: '', exists: false, readable: false, kind: 'missing', size: 0, modifiedAt: null, error: 'المسار فارغ' };
    try {
      if (!fs.existsSync(value)) return { path: value, exists: false, readable: false, kind: 'missing', size: 0, modifiedAt: null, error: 'غير موجود' };
      const stat = fs.statSync(value);
      try {
        fs.accessSync(value, fs.constants.R_OK);
      } catch (error) {
        return {
          path: value,
          exists: true,
          readable: false,
          kind: stat.isDirectory() ? 'directory' : (stat.isFile() ? 'file' : 'other'),
          size: stat.isFile() ? Number(stat.size || 0) : 0,
          modifiedAt: stat.mtime?.toISOString?.() || null,
          error: toSingleLine(error?.message || 'تعذر الوصول')
        };
      }
      return {
        path: value,
        exists: true,
        readable: true,
        kind: stat.isDirectory() ? 'directory' : (stat.isFile() ? 'file' : 'other'),
        size: stat.isFile() ? Number(stat.size || 0) : 0,
        modifiedAt: stat.mtime?.toISOString?.() || null,
        error: ''
      };
    } catch (error) {
      return { path: value, exists: false, readable: false, kind: 'unknown', size: 0, modifiedAt: null, error: toSingleLine(error?.message || 'خطأ غير معروف') };
    }
  }
  function getMediaCounts() {
    const counts = { movies: 0, series: 0, audio: 0, total: 0, channels: 0, users: 0 };
    for (const row of mediaDb.all('SELECT type, COUNT(*) AS total FROM media_items GROUP BY type')) counts[String(row.type || '')] = Number(row.total || 0);
    counts.movies = Number(counts.movies || 0);
    counts.series = Number(counts.series || 0);
    counts.audio = Number(counts.audio || 0);
    counts.total = counts.movies + counts.series + counts.audio;
    counts.channels = Number(mediaDb.get('SELECT COUNT(*) AS total FROM channels')?.total || 0);
    counts.users = Number(appDb.get('SELECT COUNT(*) AS total FROM users')?.total || 0);
    return counts;
  }
  function getIndexedCountForPath(libraryId = '', targetPath = '') {
    const normalized = String(targetPath || '').trim().replace(/[\\/]+$/, '');
    if (!libraryId || !normalized) return 0;
    const row = mediaDb.get('SELECT COUNT(*) AS total FROM media_items WHERE library_id = ? AND path LIKE ?', [libraryId, `${normalized}%`]);
    return Number(row?.total || 0);
  }
  function getLibraryDiagnostics() {
    return (config.libraries || []).map((library) => {
      const itemCount = Number(mediaDb.get('SELECT COUNT(*) AS total FROM media_items WHERE library_id = ?', [library.id])?.total || 0);
      const convertJob = getLibraryConvertJob(library.id);
      const paths = (library.paths || []).map((targetPath) => {
        const diag = getFsEntryDiagnostic(targetPath);
        return {
          ...diag,
          indexedItems: getIndexedCountForPath(library.id, targetPath)
        };
      });
      return {
        id: library.id,
        name: library.name,
        type: library.type,
        allowDownload: library.allowDownload !== false,
        showOnHome: library.showOnHome !== false,
        itemCount,
        totalPaths: paths.length,
        reachablePaths: paths.filter(entry => entry.exists && entry.readable).length,
        missingPaths: paths.filter(entry => !entry.exists).length,
        unreadablePaths: paths.filter(entry => entry.exists && !entry.readable).length,
        convertJob,
        paths
      };
    });
  }
  function getSourceDiagnostics() {
    const usbStatuses = new Map(listUsbCaptureStatuses().map(status => [status.id, status]));
    return (config.iptv?.sources || []).map((source) => {
      const runtime = usbStatuses.get(source.id);
      return {
        id: source.id,
        name: source.name,
        type: source.sourceType,
        deliveryMode: source.deliveryMode || 'hls',
        autoStart: source.autoStart !== false,
        showOnHome: source.showOnHome !== false,
        streamUrl: getSourcePlaybackUrl(source),
        state: runtime?.state || (source.autoStart === false ? 'disabled' : 'idle'),
        encoder: runtime?.appliedVideoEncoder || resolveVideoEncoder(source, getUsbFfmpegBinary(source)).label,
        resolution: runtime?.appliedResolution || (resolveOutputResolution(source)?.label || 'source'),
        message: runtime?.message || ''
      };
    });
  }
  function getStorageDiagnostics() {
    const entries = [
      ['config', configPath],
      ['appDb', path.join(rootDir, 'data', 'app.sqlite')],
      ['mediaDb', path.join(rootDir, 'data', 'media.sqlite')],
      ['runtimeDb', path.join(rootDir, 'data', 'runtime.sqlite')],
      ['scanStatus', scanStatusPath],
      ['liveStreams', liveStreamsDir],
      ['transcodes', transcodesDir]
    ];
    return entries.map(([id, targetPath]) => {
      const diag = getFsEntryDiagnostic(targetPath);
      return { id, ...diag, sizeLabel: formatBytes(diag.size || 0) };
    });
  }
  function getSystemProfiles() {
    return {
      recommended: {
        id: 'recommended',
        title: 'موصى به',
        description: 'أفضل توازن بين المكتبات والبث وسهولة الإدارة.',
        performance: { pageSize: 60, newestLimit: 30 },
        scan: { autoStartOnEmptyIndex: true, autoDailyTwice: true, yieldEvery: 200, statusUpdateEvery: 100 },
        usbCapture: { hlsTime: 2, hlsListSize: 6, resolutionPreset: '720p', videoBitrate: '1800k', maxRate: '2200k', bufSize: '4000k', audioBitrate: '96k', frameRate: 25, hwAccel: 'auto' },
        mediaTranscode: { hwAccel: 'auto', qualityProfile: 'balanced', audioBitrate: '128k', hlsTime: 4, hlsListSize: 10 },
        auth: { autoRegisterDevices: true }
      },
      performance: {
        id: 'performance',
        title: 'أداء خفيف',
        description: 'تقليل الحمل على المعالج والشبكة للأجهزة الأضعف.',
        performance: { pageSize: 36, newestLimit: 18 },
        scan: { autoStartOnEmptyIndex: true, autoDailyTwice: true, yieldEvery: 300, statusUpdateEvery: 120 },
        usbCapture: { hlsTime: 2, hlsListSize: 6, resolutionPreset: '480p', videoBitrate: '1200k', maxRate: '1500k', bufSize: '2500k', audioBitrate: '96k', frameRate: 24, hwAccel: 'auto' },
        mediaTranscode: { hwAccel: 'auto', qualityProfile: 'mobile', audioBitrate: '96k', hlsTime: 4, hlsListSize: 10 },
        auth: { autoRegisterDevices: true }
      },
      quality: {
        id: 'quality',
        title: 'جودة عالية',
        description: 'أفضل جودة عرض مع بقاء النظام منظمًا للمكتبات.',
        performance: { pageSize: 72, newestLimit: 36 },
        scan: { autoStartOnEmptyIndex: true, autoDailyTwice: true, yieldEvery: 160, statusUpdateEvery: 80 },
        usbCapture: { hlsTime: 3, hlsListSize: 8, resolutionPreset: '1080p', videoBitrate: '3500k', maxRate: '4500k', bufSize: '7000k', audioBitrate: '128k', frameRate: 30, hwAccel: 'auto' },
        mediaTranscode: { hwAccel: 'auto', qualityProfile: 'high', audioBitrate: '160k', hlsTime: 6, hlsListSize: 12 },
        auth: { autoRegisterDevices: true }
      },
      live: {
        id: 'live',
        title: 'بث مباشر',
        description: 'مناسب عندما تكون الأولوية لاستقرار القنوات وأجهزة الالتقاط.',
        performance: { pageSize: 48, newestLimit: 24 },
        scan: { autoStartOnEmptyIndex: true, autoDailyTwice: true, yieldEvery: 220, statusUpdateEvery: 100 },
        usbCapture: { hlsTime: 2, hlsListSize: 6, resolutionPreset: '720p', videoBitrate: '1800k', maxRate: '2200k', bufSize: '3500k', audioBitrate: '96k', frameRate: 25, hwAccel: 'auto' },
        mediaTranscode: { hwAccel: 'auto', qualityProfile: 'balanced', audioBitrate: '128k', hlsTime: 4, hlsListSize: 10 },
        auth: { autoRegisterDevices: true }
      }
    };
  }
  function applyProfileToSource(source, profile) {
    if (!source || !profile?.usbCapture) return normalizeSource(source || {});
    if (!isManagedLiveSource(source)) return normalizeSource(source);
    return normalizeSource({
      ...source,
      resolutionPreset: profile.usbCapture.resolutionPreset,
      hlsTime: profile.usbCapture.hlsTime,
      hlsListSize: profile.usbCapture.hlsListSize,
      videoBitrate: profile.usbCapture.videoBitrate,
      maxRate: profile.usbCapture.maxRate,
      bufSize: profile.usbCapture.bufSize,
      audioBitrate: profile.usbCapture.audioBitrate,
      frameRate: profile.usbCapture.frameRate,
      hwAccel: source.hwAccel || profile.usbCapture.hwAccel
    });
  }
  function applySystemProfile(profileId = 'recommended') {
    const profile = getSystemProfiles()[profileId] || getSystemProfiles().recommended;
    const nextConfig = normalizeConfig(JSON.parse(JSON.stringify(config || {})));
    nextConfig.performance = { ...nextConfig.performance, ...(profile.performance || {}) };
    nextConfig.scan = normalizeScanConfig({ ...nextConfig.scan, ...(profile.scan || {}) });
    nextConfig.usbCapture = normalizeUsbCaptureConfig({ ...nextConfig.usbCapture, ...(profile.usbCapture || {}) });
    nextConfig.mediaTranscode = normalizeMediaTranscodeConfig({ ...nextConfig.mediaTranscode, ...(profile.mediaTranscode || {}) });
    nextConfig.auth = { ...nextConfig.auth, ...(profile.auth || {}) };
    nextConfig.system = { ...nextConfig.system, setupProfile: profile.id };
    nextConfig.libraries = (nextConfig.libraries || []).map((library) => normalizeLibrary({ ...library, scanMode: 'recursive', maxDepth: 9999 }));
    nextConfig.iptv = nextConfig.iptv || { sources: [] };
    nextConfig.iptv.sources = Array.isArray(nextConfig.iptv.sources) ? nextConfig.iptv.sources.map((source) => applyProfileToSource(source, profile)) : [];
    saveConfig(nextConfig);
    setupScheduledScans();
    setupFootballImportSchedule(false);
    syncUsbCaptures();
    return profile;
  }
  function buildAdminDiagnostics() {
    const packageInfo = readJson(path.join(rootDir, 'package.json'), {});
    const ffmpeg = getBinaryDiagnostic(resolveFfmpegBinaryPath());
    const ffprobe = getBinaryDiagnostic(resolveFfprobeBinaryPath());
    const mediaTranscode = resolveMediaTranscodeSettings('', 'video');
    const counts = getMediaCounts();
    const scan = readScanStatus();
    const libraries = getLibraryDiagnostics();
    const sources = getSourceDiagnostics();
    const storage = getStorageDiagnostics();
    const missingPaths = libraries.flatMap((library) => library.paths.filter(entry => !entry.exists).map(entry => ({ libraryId: library.id, libraryName: library.name, ...entry })));
    const unreadablePaths = libraries.flatMap((library) => library.paths.filter(entry => entry.exists && !entry.readable).map(entry => ({ libraryId: library.id, libraryName: library.name, ...entry })));
    const recommendations = [];
    if (!ffmpeg.ok) recommendations.push({ level: 'critical', title: 'FFmpeg غير جاهز', detail: ffmpeg.error || 'تأكد من وجود FFmpeg داخل runtime أو ضمن PATH.' });
    if (!ffprobe.ok) recommendations.push({ level: 'warning', title: 'FFprobe غير جاهز', detail: ffprobe.error || 'قد تتعطل معرفة الترميز أو الصيغ.' });
    if (!libraries.length) recommendations.push({ level: 'warning', title: 'لا توجد مكتبات', detail: 'أضف مكتبة واحدة على الأقل لتظهر الأفلام والمسلسلات والصوتيات.' });
    if (missingPaths.length) recommendations.push({ level: 'critical', title: 'يوجد مسارات غير موجودة', detail: `عدد المسارات غير المرئية الآن: ${missingPaths.length}. شغّل السيرفر بنفس المستخدم الذي يرى الأقراص أو استخدم UNC.` });
    if (unreadablePaths.length) recommendations.push({ level: 'warning', title: 'يوجد مسارات غير قابلة للقراءة', detail: `عدد المسارات التي تحتاج صلاحية قراءة: ${unreadablePaths.length}.` });
    if (!counts.total && libraries.length) recommendations.push({ level: 'warning', title: 'الفهرس فارغ', detail: 'المكتبات موجودة لكن لا توجد عناصر مفهرسة بعد. شغّل فحصًا بعد التأكد من المسارات.' });
    if ((config.server?.sessionSecret || '') === 'change-me-now') recommendations.push({ level: 'warning', title: 'سر الجلسة افتراضي', detail: 'غيّر sessionSecret لاحقًا لأمان أعلى.' });
    if ((config.admin?.password || '') === 'admin123') recommendations.push({ level: 'warning', title: 'كلمة مرور الإدارة افتراضية', detail: 'غيّر كلمة مرور الإدارة لحماية النظام.' });
    if (!String(config.server?.publicBaseUrl || '').trim()) recommendations.push({ level: 'info', title: 'الرابط الخارجي غير مضبوط', detail: 'أضف Public Base URL إذا كنت ستفتح النظام أو WebRTC من أجهزة أخرى.' });
    const readinessScore = Math.max(0, 100
      - (ffmpeg.ok ? 0 : 35)
      - (ffprobe.ok ? 0 : 10)
      - Math.min(30, missingPaths.length * 5)
      - Math.min(15, unreadablePaths.length * 4)
      - (libraries.length ? 0 : 15)
      - (counts.total ? 0 : 10)
      - ((config.server?.sessionSecret || '') === 'change-me-now' ? 5 : 0)
      - ((config.admin?.password || '') === 'admin123' ? 5 : 0));
    return {
      generatedAt: new Date().toISOString(),
      app: {
        name: packageInfo.name || 'light-media-server',
        version: packageInfo.version || 'unknown',
        systemName: config.system?.name || 'STARSNET',
        profile: config.system?.setupProfile || 'recommended'
      },
      server: {
        host: config.server?.host || '0.0.0.0',
        port: Number(config.server?.port || 0),
        publicBaseUrl: String(config.server?.publicBaseUrl || '').trim(),
        appBaseUrl: getConfiguredAppBaseUrl()
      },
      binaries: { ffmpeg, ffprobe },
      mediaTranscode: {
        hwAccel: config.mediaTranscode?.hwAccel || 'auto',
        qualityProfile: config.mediaTranscode?.qualityProfile || 'balanced',
        audioBitrate: config.mediaTranscode?.audioBitrate || '160k',
        hlsTime: Number(config.mediaTranscode?.hlsTime || 4),
        hlsListSize: Number(config.mediaTranscode?.hlsListSize || 10),
        encoder: mediaTranscode.encoder?.label || 'CPU / libx264',
        cpuCores: Number(mediaTranscode.cpuPlan?.cpuCount || os.cpus()?.length || 1)
      },
      counts,
      scan,
      libraries,
      sources,
      storage,
      recommendations,
      readinessScore,
      profiles: Object.values(getSystemProfiles()).map(profile => ({ id: profile.id, title: profile.title, description: profile.description }))
    };
  }
  function buildAdminDiagnosticsSafe() {
    try {
      return buildAdminDiagnostics();
    } catch (error) {
      return {
        generatedAt: new Date().toISOString(),
        app: {
          name: 'light-media-server',
          version: 'unknown',
          systemName: config.system?.name || 'STARSNET',
          profile: config.system?.setupProfile || 'recommended'
        },
        server: {
          host: config.server?.host || '0.0.0.0',
          port: Number(config.server?.port || 0),
          publicBaseUrl: String(config.server?.publicBaseUrl || '').trim(),
          appBaseUrl: getConfiguredAppBaseUrl()
        },
        binaries: {
          ffmpeg: getBinaryDiagnostic(resolveFfmpegBinaryPath()),
          ffprobe: getBinaryDiagnostic(resolveFfprobeBinaryPath())
        },
        mediaTranscode: {
          hwAccel: config.mediaTranscode?.hwAccel || 'auto',
          qualityProfile: config.mediaTranscode?.qualityProfile || 'balanced',
          audioBitrate: config.mediaTranscode?.audioBitrate || '160k',
          hlsTime: Number(config.mediaTranscode?.hlsTime || 4),
          hlsListSize: Number(config.mediaTranscode?.hlsListSize || 10),
          encoder: 'غير متاح الآن',
          cpuCores: Number(os.cpus()?.length || 1)
        },
        counts: getMediaCounts(),
        scan: readScanStatus(),
        libraries: getLibraryDiagnostics(),
        sources: getSourceDiagnostics(),
        storage: getStorageDiagnostics(),
        recommendations: [{
          level: 'warning',
          title: 'تعذر بناء التشخيص الكامل',
          detail: toSingleLine(error?.message || 'حدث خطأ غير معروف أثناء فحص الإعدادات.')
        }],
        readinessScore: 50,
        profiles: Object.values(getSystemProfiles()).map(profile => ({ id: profile.id, title: profile.title, description: profile.description })),
        error: toSingleLine(error?.stack || error?.message || 'unknown error')
      };
    }
  }
  function buildAdminExportPayload() {
    return {
      exportedAt: new Date().toISOString(),
      product: 'Light Media Server',
      config,
      diagnostics: buildAdminDiagnosticsSafe(),
      scanStatus: readScanStatus(),
      liveStatus: listUsbCaptureStatuses()
    };
  }
  async function buildSettingsPayload(options = {}) {
    const includeDiagnostics = !!options.includeDiagnostics;
    const includeDevices = !!options.includeDevices;
    const devices = includeDevices ? await listUsbDevices().catch(() => null) : null;
    return {
      ...config,
      libraryConvertJobs: listLibraryConvertJobs(),
      diagnostics: includeDiagnostics ? buildAdminDiagnosticsSafe() : null,
      liveStatus: listUsbCaptureStatuses(),
      rtmpIngestStatus: getRtmpIngestStatus(),
      yacineTvStatus: {
        enabled: isYacineTvEnabled(),
        running: yacineTvRefreshRunning,
        source: getYacineTvSource(),
        status: readYacineTvStatus()
      },
      deviceCatalog: includeDevices ? {
        video: devices?.ok ? (devices.video || []) : [],
        audio: devices?.ok ? (devices.audio || []) : [],
        ffmpegPath: devices?.ffmpegPath || '',
        loaded: !!devices?.ok,
        error: devices?.ok ? '' : (devices?.error || '')
      } : {
        video: [],
        audio: [],
        ffmpegPath: '',
        loaded: false,
        error: ''
      }
    };
  }

  app.get('/media/:encoded', (req, res) => {
    if (mustLoginForViewing() && !req.user) return res.status(401).end('Login required');
    const full = Buffer.from(req.params.encoded, 'base64url').toString('utf8');
    if (!full.startsWith('\\\\') && !path.isAbsolute(full)) return res.status(400).end('Bad path');
    if (!fs.existsSync(full)) return res.status(404).end('Not found');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(full);
  });
  app.get('/transcode/:type/:id/index.m3u8', async (req, res) => {
    if (mustLoginForViewing() && !req.user) return res.status(401).end('Login required');
    const { type, id } = req.params;
    let item = null;
    if (type === 'movie') {
      const row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', ['movies', id]);
      item = row ? rowToItem(row) : null;
    } else if (type === 'audio') {
      const row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', ['audio', id]);
      item = row ? rowToItem(row) : null;
    } else if (type === 'episode') {
      const rows = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ?', ['series']);
      for (const r of rows) {
        const show = rowToItem(r);
        for (const eps of Object.values(show.seasons || {})) {
          const ep = eps.find(entry => entry.id === id);
          if (ep) { item = ep; break; }
        }
        if (item) break;
      }
    } else {
      return res.status(400).json({ error: 'التحويل مدعوم للأفلام والحلقات والصوتيات فقط.' });
    }
    const mediaPath = getItemMediaPath(item);
    if (!mediaPath || !fs.existsSync(mediaPath)) return res.status(404).json({ error: 'ملف الوسائط غير موجود.' });
    const session = ensureMediaTranscode(mediaPath, type === 'audio' ? 'audio' : 'video');
    const ready = await waitForFile(session.playlistPath, isLegacyMediaFormat(mediaPath) ? 15000 : 7000);
    if (!ready) return res.status(202).json({ ok: false, error: 'جاري تجهيز البث المحول، حاول مجددًا بعد ثوانٍ قليلة.' });
    return res.redirect(session.url);
  });
  app.get('/convert-media/:type/:id', async (req, res) => {
    if (mustLoginForViewing() && !req.user) return res.status(401).end('Login required');
    const { type, id } = req.params;
    if (!['movie', 'audio', 'episode'].includes(type)) return res.status(400).json({ error: 'التحويل الدائم مدعوم للأفلام والحلقات والصوتيات فقط.' });
    try {
      const result = await ensurePortableLibraryMedia(type, id);
      const finalPath = result.path;
      if (!finalPath || !fs.existsSync(finalPath)) return res.status(404).json({ error: 'تعذر الوصول إلى الملف بعد التحويل.' });
      res.setHeader('Content-Disposition', 'inline');
      return res.sendFile(finalPath);
    } catch (error) {
      return res.status(500).json({ error: toSingleLine(error?.message || 'فشل تحويل الملف إلى الصيغة المطلوبة.') });
    }
  });
  app.get('/poster/:encoded', (req, res) => {
    const full = Buffer.from(req.params.encoded, 'base64url').toString('utf8');
    if (!full.startsWith('\\\\') && !path.isAbsolute(full)) return res.status(400).end('Bad path');
    if (!fs.existsSync(full)) return res.status(404).end('Poster not found');
    res.sendFile(path.resolve(full));
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const row = appDb.get('SELECT * FROM users WHERE LOWER(username) = LOWER(?) AND active = 1 LIMIT 1', [String(username || '')]);
    if (!row || !verifyPassword(password, row.password_hash)) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    appDb.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
    appDb.save();
    req.session.userId = row.id;
    res.json({ ok: true, user: getSafeUserRow({ ...row, last_login_at: new Date().toISOString() }) });
  });
  app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
  app.get('/api/auth/status', (req, res) => res.json({ authenticated: !!req.user, user: req.user || null, requireLoginForViewing: mustLoginForViewing(), allowSelfRegistration: !!config.auth?.allowSelfRegistration, autoRegisterDevices: !!config.auth?.autoRegisterDevices, system: config.system || {} }));
  app.get('/api/meta', (_req, res) => res.json({
    system: config.system || {},
    libraries: (config.libraries || []).map(x => ({ id: x.id, name: x.name, type: x.type, allowDownload: !!x.allowDownload, showOnHome: x.showOnHome !== false })),
    sources: (config.iptv?.sources || []).map(x => ({
      id: x.id,
      name: x.name,
      sourceType: x.sourceType || 'm3u',
      groupTitle: x.groupTitle || '',
      streamUrl: isManagedLiveSource(x) ? getSourcePlaybackUrl(x) : (x.streamUrl || ''),
      webrtcViewerUrl: isDirectLiveSource(x) ? getDirectLivePlaybackUrl(x) : '',
      webrtcPublisherUrl: isDirectLiveSource(x) ? getWebrtcPublisherUrl(x) : '',
      autoStart: x.autoStart !== false,
      showOnHome: x.showOnHome !== false
    })),
    usbCapture: listUsbCaptureStatuses(),
    rtmpIngestStatus: getRtmpIngestStatus()
  }));
  app.post('/api/auth/register', (req, res) => {
    if (!config.auth?.allowSelfRegistration) return res.status(403).json({ error: 'التسجيل الذاتي غير مفعّل' });
    const { username, password, displayName } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    if (appDb.get('SELECT 1 AS x FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [String(username)])) return res.status(409).json({ error: 'اسم المستخدم موجود بالفعل' });
    const user = { id: uid('user'), username: String(username).trim(), displayName: String(displayName || username).trim(), passwordHash: hashPassword(password), role: 'user', active: 1, createdAt: new Date().toISOString(), lastLoginAt: null };
    appDb.run('INSERT INTO users(id, username, display_name, password_hash, role, active, created_at, last_login_at, device_id, auth_type) VALUES(?,?,?,?,?,?,?,?,?,?)', [user.id, user.username, user.displayName, user.passwordHash, user.role, user.active, user.createdAt, null, null, 'password']);
    appDb.save();
    res.json({ ok: true, user: getSafeUserRow({ id: user.id, username: user.username, display_name: user.displayName, role: user.role, active: 1, created_at: user.createdAt, last_login_at: null }) });
  });
  app.post('/api/auth/device-auto', (req, res) => {
    if (!config.auth?.autoRegisterDevices) return res.status(403).json({ error: 'التسجيل التلقائي بالأجهزة غير مفعّل' });
    const deviceId = sanitizeDeviceId(req.body?.deviceId);
    const deviceName = String(req.body?.deviceName || 'جهاز جديد').trim().slice(0, 120);
    if (!deviceId) return res.status(400).json({ error: 'معرّف الجهاز مطلوب' });
    let row = appDb.get('SELECT * FROM users WHERE device_id = ? LIMIT 1', [deviceId]);
    if (!row) {
      let username = makeDeviceUsername(deviceId);
      let i = 1;
      while (appDb.get('SELECT 1 AS x FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [username])) { username = `${makeDeviceUsername(deviceId)}-${i++}`; }
      const id = uid('user');
      const createdAt = new Date().toISOString();
      const displayName = deviceName || username;
      appDb.run('INSERT INTO users(id, username, display_name, password_hash, role, active, created_at, last_login_at, device_id, auth_type) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, username, displayName, hashPassword(crypto.randomBytes(12).toString('hex')), 'user', 1, createdAt, createdAt, deviceId, 'device']);
      appDb.save();
      row = appDb.get('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    } else {
      appDb.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
      appDb.save();
      row = appDb.get('SELECT * FROM users WHERE id = ? LIMIT 1', [row.id]);
    }
    req.session.userId = row.id;
    res.json({ ok: true, user: getSafeUserRow(row) });
  });

  app.get('/api/users/me', requireLogin, (req, res) => res.json(req.user));
  app.put('/api/users/me', requireLogin, (req, res) => {
    const displayName = String(req.body?.displayName || '').trim();
    if (!displayName) return res.status(400).json({ error: 'الاسم الظاهر مطلوب' });
    appDb.run('UPDATE users SET display_name = ? WHERE id = ?', [displayName.slice(0, 120), req.user.id]);
    appDb.save();
    return res.json(getSafeUserRow(appDb.get('SELECT * FROM users WHERE id = ? LIMIT 1', [req.user.id])));
  });
  app.get('/api/users/favorites', requireLogin, (req, res) => res.json(listFavorites(req.user.id)));
  app.post('/api/users/favorites/toggle', requireLogin, (req, res) => {
    const { type, id, title, poster, subtitle, href } = req.body || {};
    if (!type || !id) return res.status(400).json({ error: 'بيانات ناقصة' });
    const favorite = toggleFavorite(req.user.id, { type, id, title, poster, subtitle, href });
    res.json({ ok: true, favorite });
  });
  app.get('/api/users/history', requireLogin, (req, res) => {
    const rows = appDb.all('SELECT type, item_id, title, poster, subtitle, href, updated_at FROM history WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', [req.user.id]);
    res.json(rows.map(x => ({ type: x.type, id: x.item_id, title: x.title, poster: x.poster, subtitle: x.subtitle, href: x.href, updatedAt: x.updated_at })));
  });
  app.get('/api/users/continue', requireLogin, (req, res) => res.json(getContinueWatching(req.user.id)));
  app.get('/api/users/progress/:type/:id', requireLogin, (req, res) => {
    const row = appDb.get('SELECT type, item_id, position, duration, title, poster, subtitle, href, stream_url, updated_at FROM progress WHERE user_id = ? AND type = ? AND item_id = ? LIMIT 1', [req.user.id, req.params.type, req.params.id]);
    if (!row) return res.json(null);
    res.json({ type: row.type, id: row.item_id, position: Number(row.position || 0), duration: Number(row.duration || 0), title: row.title, poster: row.poster, subtitle: row.subtitle, href: row.href, streamUrl: row.stream_url, updatedAt: row.updated_at });
  });
  app.post('/api/users/progress', requireLogin, (req, res) => {
    const { type, id, position, duration, title, poster, subtitle, href, streamUrl } = req.body || {};
    if (!type || !id) return res.status(400).json({ error: 'بيانات ناقصة' });
    if (Number(duration || 0) > 0 && Number(position || 0) >= Number(duration || 0) * 0.95) removeProgress(req.user.id, type, id);
    else setProgress(req.user.id, { type, id, position: Number(position || 0), duration: Number(duration || 0), title, poster, subtitle, href, streamUrl });
    upsertHistory(req.user.id, { type, id, title, poster, subtitle, href });
    appDb.save();
    res.json({ ok: true });
  });
  app.get('/api/users/preferences', requireLogin, (req, res) => res.json(getUserPreferences(req.user.id)));
  app.post('/api/users/preferences', requireLogin, (req, res) => res.json({ ok: true, preferences: setUserPreferences(req.user.id, req.body || {}) }));
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      time: new Date().toISOString()
    });
  });

  app.get('/api/admin/users', requireAdmin, (_req, res) => {
    const rows = appDb.all('SELECT * FROM users ORDER BY created_at DESC');
    res.json(rows.map(getSafeUserRow));
  });
  app.post('/api/admin/users', requireAdmin, (req, res) => {
    const { username, password, displayName, role, active } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    if (appDb.get('SELECT 1 AS x FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [String(username)])) return res.status(409).json({ error: 'اسم المستخدم موجود بالفعل' });
    const id = uid('user');
    appDb.run('INSERT INTO users(id, username, display_name, password_hash, role, active, created_at, last_login_at, device_id, auth_type) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, String(username).trim(), String(displayName || username).trim(), hashPassword(password), role === 'admin' ? 'admin' : 'user', active === false ? 0 : 1, new Date().toISOString(), null, null, 'password']);
    appDb.save();
    res.json({ ok: true, user: getSafeUserRow(appDb.get('SELECT * FROM users WHERE id = ?', [id])) });
  });
  app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
    const existing = appDb.get('SELECT * FROM users WHERE id = ? LIMIT 1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const { username, displayName, role, active, password } = req.body || {};
    if (username && appDb.get('SELECT 1 AS x FROM users WHERE id <> ? AND LOWER(username) = LOWER(?) LIMIT 1', [existing.id, String(username)])) return res.status(409).json({ error: 'اسم المستخدم مستخدم' });
    const finalUser = {
      ...existing,
      username: username ? String(username).trim() : existing.username,
      display_name: displayName !== undefined ? (String(displayName || '').trim() || (username ? String(username).trim() : existing.username)) : existing.display_name,
      role: role ? (role === 'admin' ? 'admin' : 'user') : existing.role,
      active: active !== undefined ? (active ? 1 : 0) : existing.active,
      password_hash: password ? hashPassword(password) : existing.password_hash
    };
    appDb.run('UPDATE users SET username = ?, display_name = ?, password_hash = ?, role = ?, active = ? WHERE id = ?', [finalUser.username, finalUser.display_name, finalUser.password_hash, finalUser.role, finalUser.active, existing.id]);
    appDb.save();
    res.json({ ok: true, user: getSafeUserRow(appDb.get('SELECT * FROM users WHERE id = ?', [existing.id])) });
  });
  app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
    const existing = appDb.get('SELECT * FROM users WHERE id = ? LIMIT 1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (existing.id === req.user.id) return res.status(400).json({ error: 'لا يمكن حذف حسابك الحالي' });
    appDb.transaction(() => {
      appDb.run('DELETE FROM users WHERE id = ?', [existing.id]);
      appDb.run('DELETE FROM favorites WHERE user_id = ?', [existing.id]);
      appDb.run('DELETE FROM progress WHERE user_id = ?', [existing.id]);
      appDb.run('DELETE FROM history WHERE user_id = ?', [existing.id]);
      appDb.run('DELETE FROM preferences WHERE user_id = ?', [existing.id]);
    });
    appDb.save();
    res.json({ ok: true });
  });

  app.get('/api/home', (_req, res) => {
    maybeAutoStartScan();
    const limit = Math.max(6, Math.min(24, Number(config.performance?.newestLimit || 18)));
    const livePoolLimit = Math.max(80, Math.min(240, limit * 8));
    const newestMovies = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ? ORDER BY added_at DESC LIMIT ?', ['movies', limit]).map(rowToItem);
    const newestSeries = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ? ORDER BY added_at DESC LIMIT ?', ['series', limit]).map(rowToItem);
    const newestAudio = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ? ORDER BY added_at DESC LIMIT ?', ['audio', limit]).map(rowToItem);
    const visibleSourceIds = new Set((config.iptv?.sources || []).filter(src => src.enabled !== false && src.showOnHome !== false).map(src => src.id));
    const homeChannelPool = mediaDb.all(`SELECT raw_json, group_title FROM channels WHERE hidden = 0 ORDER BY CASE WHEN group_title IS NULL OR TRIM(group_title) = '' THEN 1 ELSE 0 END ASC, group_title COLLATE NOCASE ASC, ${channelOrderSql()} LIMIT ?`, [livePoolLimit])
      .map(rowToChannelItem)
      .filter(item => (!item?.sourceId || visibleSourceIds.has(item.sourceId)) && !isChannelGroupDisabled(item));
    const channels = homeChannelPool.slice(0, limit);
    const librarySections = (config.libraries || []).filter(lib => lib.showOnHome !== false).map(lib => ({
      id: lib.id,
      name: lib.name,
      type: lib.type,
      allowDownload: !!lib.allowDownload,
      items: lib.type === 'mixed'
        ? mediaDb.all('SELECT raw_json FROM media_items WHERE library_id = ? AND type IN (?, ?) ORDER BY added_at DESC LIMIT ?', [lib.id, 'movies', 'audio', limit]).map(rowToItem)
        : mediaDb.all('SELECT raw_json FROM media_items WHERE type = ? AND library_id = ? ORDER BY added_at DESC LIMIT ?', [lib.type, lib.id, limit]).map(rowToItem)
    })).filter(section => section.items.length);
    const liveSections = (config.iptv?.sources || []).filter(src => src.enabled !== false && src.showOnHome !== false).map(src => ({
      id: src.id,
      name: src.name,
      sourceType: src.sourceType || 'm3u',
      items: mediaDb.all(`SELECT raw_json, group_title FROM channels WHERE source_id = ? AND hidden = 0 ORDER BY ${channelOrderSql()} LIMIT ?`, [src.id, limit]).map(rowToChannelItem).filter(item => !isChannelGroupDisabled(item))
    })).filter(section => section.items.length);
    const liveCategorySections = buildLiveCategorySections(homeChannelPool, limit);
    res.json({ generatedAt: getGeneratedAt(), system: config.system || {}, newestMovies, newestSeries, newestAudio, channels, librarySections, liveSections, liveCategorySections, scan: readScanStatus() });
  });
  app.get('/api/movies', (req, res) => { maybeAutoStartScan(); res.json(listMedia('movies', req.query || {})); });
  app.get('/api/series', (req, res) => { maybeAutoStartScan(); res.json(listMedia('series', req.query || {})); });
  app.get('/api/audio', (req, res) => { maybeAutoStartScan(); res.json(listMedia('audio', req.query || {})); });
  app.get('/api/mixed', (req, res) => { maybeAutoStartScan(); res.json(listMedia('mixed', req.query || {})); });
  app.get('/api/folders/:type', (req, res) => {
    maybeAutoStartScan();
    const type = req.params.type === 'series'
      ? 'series'
      : req.params.type === 'audio'
        ? 'audio'
        : req.params.type === 'mixed'
          ? 'mixed'
          : 'movies';
    res.json(listFolderNodes(type, req.query || {}));
  });
  app.get('/api/live', (req, res) => {
    maybeAutoStartScan();
    const sourceId = (req.query.sourceId || '').trim();
    const q = (req.query.q || '').trim().toLowerCase();
    const group = String(req.query.group || '').trim();
    const where = ['hidden = 0'];
    const params = [];
    if (sourceId) { where.push('source_id = ?'); params.push(sourceId); }
    addDisabledSourceVisibilityFilter(where, params, sourceId);
    addYacineTvVisibilityFilter(where, params, sourceId);
    if (q) { where.push('(LOWER(title) LIKE ? OR LOWER(url) LIKE ? OR LOWER(group_title) LIKE ?)'); params.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    const disableGroups = config.iptv?.disableGroups === true;
    const disabledGroupsList = config.iptv?.disabledGroups || [];
    if (!disableGroups && disabledGroupsList.length) {
      const placeholders = disabledGroupsList.map(() => '?').join(',');
      where.push(`(group_title IS NULL OR TRIM(group_title) = '' OR LOWER(group_title) NOT IN (${placeholders}))`);
      disabledGroupsList.forEach(g => params.push(String(g || '').trim().toLowerCase()));
    }
    const groups = disableGroups ? [] : collectLiveGroups({ sourceId, q }).filter(g => !isGroupDisabled(g.value));
    if (group && !disableGroups) {
      if (group === '__uncategorized') where.push('(group_title IS NULL OR TRIM(group_title) = \'\')');
      else { where.push('LOWER(group_title) = LOWER(?)'); params.push(group); }
    }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const totalRow = mediaDb.get(`SELECT COUNT(*) AS count FROM channels ${whereSql}`, params);
    const meta = paginateMeta(req.query.page, req.query.limit, Number(totalRow?.count || 0));
    const rows = mediaDb.all(`SELECT raw_json, group_title FROM channels ${whereSql} ORDER BY CASE WHEN group_title IS NULL OR TRIM(group_title) = '' THEN 1 ELSE 0 END ASC, group_title COLLATE NOCASE ASC, ${channelOrderSql()} LIMIT ? OFFSET ?`, [...params, meta.limit, meta.offset]);
    const items = rows.map(rowToChannelItem);
    if (disableGroups) {
      items.forEach(item => { if (item) item.groupTitle = ''; });
    }
    res.json({ ...meta, items, groups, generatedAt: getGeneratedAt(), scan: readScanStatus(), usbCapture: listUsbCaptureStatuses() });
  });
  app.get('/api/live/all-groups', requireAdmin, (req, res) => {
    try {
      const rows = mediaDb.all(
        `SELECT DISTINCT CASE WHEN group_title IS NULL OR TRIM(group_title) = '' THEN '' ELSE TRIM(group_title) END AS name
         FROM channels
         ORDER BY name COLLATE NOCASE ASC`
      );
      const groups = rows.map(r => String(r.name || '').trim()).filter(Boolean);
      res.json({ groups, disabledGroups: config.iptv?.disabledGroups || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/api/matches', (req, res) => {
    maybeAutoStartScan();
    res.json({ ok: true, ...listFootballMatches(req.query || {}, false), generatedAt: getGeneratedAt() });
  });
  app.get('/api/football/news', (req, res) => {
    res.json({ ok: true, items: listFootballNews(req.query || {}), importStatus: footballImportStatus, generatedAt: getGeneratedAt() });
  });
  app.get('/api/football/profiles', (req, res) => {
    res.json({ ok: true, items: listFootballProfiles(req.query || {}), importStatus: footballImportStatus, generatedAt: getGeneratedAt() });
  });
  app.get('/api/football/standings', (req, res) => {
    res.json({ ok: true, ...buildFootballStandings(req.query || {}), generatedAt: getGeneratedAt() });
  });
  app.get('/api/matches/:matchId', (req, res) => {
    const row = mediaDb.get('SELECT * FROM football_matches WHERE id = ? AND visible = 1 LIMIT 1', [req.params.matchId]);
    if (!row) return res.status(404).json({ error: 'المباراة غير موجودة.' });
    res.json({ ok: true, item: rowToFootballMatch(row) });
  });
  app.get('/api/item/:type/:id', (req, res) => {
    maybeAutoStartScan();
    const { type, id } = req.params;
    let row = null;
    if (type === 'movie') row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', ['movies', id]);
    if (type === 'series') row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', ['series', id]);
    if (type === 'audio') row = mediaDb.get('SELECT raw_json FROM media_items WHERE type = ? AND id = ? LIMIT 1', ['audio', id]);
    if (type === 'channel') row = mediaDb.get('SELECT raw_json FROM channels WHERE id = ? LIMIT 1', [id]);
    if (row) {
      const rawItem = type === 'channel'
        ? enrichChannelPlaybackItem(hydrateChannelItem(rowToItem(row)))
        : rowToItem(row);
      return res.json(type === 'movie' || type === 'audio' ? enrichPlaybackItem(rawItem, type) : rawItem);
    }
    if (type === 'episode') {
      const rows = mediaDb.all('SELECT raw_json FROM media_items WHERE type = ?', ['series']);
      for (const r of rows) {
        const show = rowToItem(r);
        for (const eps of Object.values(show.seasons || {})) {
          const ep = eps.find(x => x.id === id);
          if (ep) return res.json(enrichPlaybackItem({ ...ep, showTitle: show.title, poster: show.poster }, type));
        }
      }
    }
    return res.status(404).json({ error: 'Not found' });
  });
  app.get('/api/similar/:type/:id', (req, res) => {
    maybeAutoStartScan();
    const { type, id } = req.params;
    const limit = Math.max(1, Math.min(20, Number(req.query.limit || 10)));
    const items = getSimilarContent(type, id, limit);
    res.json({ ok: true, items, total: items.length });
  });
  app.get('/api/live/status', requireAdmin, (_req, res) => res.json({ items: listUsbCaptureStatuses() }));
  app.get('/api/live/devices', requireAdmin, async (_req, res) => {
    const devices = await listUsbDevices();
    if (!devices.ok) return res.status(500).json(devices);
    res.json(devices);
  });
  app.post('/api/webrtc/sources/:sourceId/publisher/heartbeat', requireAdmin, (req, res) => {
    cleanupWebrtcSessions();
    const source = getUsbSourceById(req.params.sourceId);
    if (!source || !isDirectLiveSource(source)) return res.status(404).json({ error: 'مصدر WebRTC غير موجود' });
    const session = getWebrtcSession(req.params.sourceId);
    session.publisherHeartbeatAt = Date.now();
    res.json({ ok: true, viewers: session.viewers.size });
  });
  app.get('/api/webrtc/sources/:sourceId/publisher/viewers', requireAdmin, (req, res) => {
    cleanupWebrtcSessions();
    const source = getUsbSourceById(req.params.sourceId);
    if (!source || !isDirectLiveSource(source)) return res.status(404).json({ error: 'مصدر WebRTC غير موجود' });
    const session = getWebrtcSession(req.params.sourceId);
    session.publisherHeartbeatAt = Date.now();
    const viewers = [...session.viewers.values()].map(v => ({ id: v.id, offer: v.offer, answer: v.answer, updatedAt: v.updatedAt }));
    res.json({ ok: true, items: viewers });
  });
  app.post('/api/webrtc/sources/:sourceId/viewers', (req, res) => {
    cleanupWebrtcSessions();
    const source = getUsbSourceById(req.params.sourceId);
    if (!source || !isDirectLiveSource(source)) return res.status(404).json({ error: 'مصدر WebRTC غير موجود' });
    const session = getWebrtcSession(req.params.sourceId);
    const viewerId = uid('viewer');
    session.viewers.set(viewerId, {
      id: viewerId,
      offer: req.body?.offer || null,
      answer: null,
      publisherCandidates: [],
      viewerCandidates: [],
      updatedAt: Date.now()
    });
    res.json({ ok: true, viewerId });
  });
  app.get('/api/webrtc/sources/:sourceId/viewers/:viewerId/answer', (req, res) => {
    cleanupWebrtcSessions();
    const viewer = getWebrtcViewer(req.params.sourceId, req.params.viewerId);
    if (!viewer) return res.status(404).json({ error: 'المشاهد غير موجود' });
    res.json({ ok: true, answer: viewer.answer || null });
  });
  app.post('/api/webrtc/sources/:sourceId/viewers/:viewerId/answer', requireAdmin, (req, res) => {
    cleanupWebrtcSessions();
    const viewer = getWebrtcViewer(req.params.sourceId, req.params.viewerId);
    if (!viewer) return res.status(404).json({ error: 'المشاهد غير موجود' });
    viewer.answer = req.body?.answer || null;
    viewer.updatedAt = Date.now();
    res.json({ ok: true });
  });
  app.post('/api/webrtc/sources/:sourceId/viewers/:viewerId/candidates', (req, res) => {
    cleanupWebrtcSessions();
    const viewer = getWebrtcViewer(req.params.sourceId, req.params.viewerId);
    if (!viewer) return res.status(404).json({ error: 'المشاهد غير موجود' });
    const from = req.query.from === 'publisher' ? 'publisher' : 'viewer';
    const candidate = req.body?.candidate || null;
    if (candidate) {
      if (from === 'publisher') viewer.publisherCandidates.push(candidate);
      else viewer.viewerCandidates.push(candidate);
    }
    viewer.updatedAt = Date.now();
    res.json({ ok: true });
  });
  app.get('/api/webrtc/sources/:sourceId/viewers/:viewerId/candidates', (req, res) => {
    cleanupWebrtcSessions();
    const viewer = getWebrtcViewer(req.params.sourceId, req.params.viewerId);
    if (!viewer) return res.status(404).json({ error: 'المشاهد غير موجود' });
    const forRole = req.query.for === 'publisher' ? 'publisher' : 'viewer';
    const items = forRole === 'publisher' ? [...viewer.viewerCandidates] : [...viewer.publisherCandidates];
    if (forRole === 'publisher') viewer.viewerCandidates = [];
    else viewer.publisherCandidates = [];
    viewer.updatedAt = Date.now();
    res.json({ ok: true, items });
  });
  app.delete('/api/webrtc/sources/:sourceId/viewers/:viewerId', (req, res) => {
    cleanupWebrtcSessions();
    const session = getWebrtcSession(req.params.sourceId);
    session.viewers.delete(req.params.viewerId);
    res.json({ ok: true });
  });
  app.post('/api/live/restart/:sourceId', requireAdmin, (req, res) => {
    stopUsbCapture(req.params.sourceId, 'manual-stop');
    const result = startUsbCapture(req.params.sourceId, { reason: 'manual-restart' });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, status: getUsbCaptureStatus(req.params.sourceId) });
  });
  app.post('/api/admin/source-test/:sourceId', requireAdmin, async (req, res) => {
    const requestedId = String(req.params.sourceId || '').trim();
    const baseSource = (config.iptv?.sources || []).find(source => String(source?.id || '').trim() === requestedId) || {};
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const candidate = normalizeSource({
      ...baseSource,
      ...body,
      id: requestedId || body.id || baseSource.id || `source-${Date.now()}`
    });
    const result = await testManagedSourceInput(candidate);
    res.status(result.ok ? 200 : 400).json({ ok: !!result.ok, result });
  });
  app.get('/api/admin/channels', requireAdmin, (req, res) => {
    const sourceId = String(req.query.sourceId || '').trim();
    const group = String(req.query.group || '').trim();
    const q = String(req.query.q || '').trim().toLowerCase();
    const includeHidden = req.query.includeHidden !== '0' && req.query.includeHidden !== 'false';
    const sort = String(req.query.sort || 'default').trim();
    const baseWhere = [];
    const baseParams = [];
    if (sourceId) { baseWhere.push('c.source_id = ?'); baseParams.push(sourceId); }
    if (!includeHidden) baseWhere.push('c.hidden = 0');
    const groupWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : '';
    const groups = mediaDb.all(
      `SELECT CASE WHEN c.group_title IS NULL OR TRIM(c.group_title) = '' THEN '' ELSE TRIM(c.group_title) END AS group_value,
              COUNT(*) AS count,
              SUM(CASE WHEN c.hidden = 0 THEN 1 ELSE 0 END) AS visible_count,
              SUM(CASE WHEN c.hidden <> 0 THEN 1 ELSE 0 END) AS hidden_count
       FROM channels c
       ${groupWhereSql}
       GROUP BY CASE WHEN c.group_title IS NULL OR TRIM(c.group_title) = '' THEN '' ELSE TRIM(c.group_title) END
       ORDER BY CASE WHEN group_value = '' THEN 1 ELSE 0 END ASC, group_value COLLATE NOCASE ASC`,
      baseParams
    ).map(row => {
      const value = String(row.group_value || '').trim();
      const visibleCount = Number(row.visible_count || 0);
      const hiddenCount = Number(row.hidden_count || 0);
      const exactOverride = sourceId ? getChannelGroupOverride(sourceId, value) : null;
      const globalOverride = getChannelGroupOverride('', value);
      const override = exactOverride || globalOverride || null;
      return {
        id: value || '__blank__',
        value,
        label: value || 'غير مصنفة',
        count: Number(row.count || 0),
        visibleCount,
        hiddenCount,
        hidden: visibleCount === 0 && hiddenCount > 0,
        override: override ? {
          sourceId: override.source_id || '',
          originalGroupTitle: override.original_group_title || value,
          title: override.title || '',
          hidden: !!Number(override.hidden || 0),
          sortOrder: override.sort_order === null || override.sort_order === undefined ? null : Number(override.sort_order),
          notes: override.notes || '',
          updatedAt: override.updated_at || ''
        } : null
      };
    });
    const where = [...baseWhere];
    const params = [...baseParams];
    if (group) {
      if (group === '__blank__') where.push('(c.group_title IS NULL OR TRIM(c.group_title) = \'\')');
      else { where.push('TRIM(c.group_title) = ?'); params.push(group); }
    }
    if (q) {
      where.push('(LOWER(c.title) LIKE ? OR LOWER(c.url) LIKE ? OR LOWER(c.source_name) LIKE ? OR LOWER(c.group_title) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(mediaDb.get(`SELECT COUNT(*) AS count FROM channels c ${whereSql}`, params)?.count || 0);
    const meta = paginateMeta(req.query.page, req.query.limit || 80, total);
    const defaultOrderSql = channelOrderSql().replaceAll('sort_order', 'c.sort_order').replaceAll('title', 'c.title');
    const orderSql = {
      name: 'c.title COLLATE NOCASE ASC',
      group: 'CASE WHEN c.group_title IS NULL OR TRIM(c.group_title) = \'\' THEN 1 ELSE 0 END ASC, c.group_title COLLATE NOCASE ASC, c.title COLLATE NOCASE ASC',
      source: 'c.source_name COLLATE NOCASE ASC, c.title COLLATE NOCASE ASC',
      hidden: 'c.hidden ASC, c.title COLLATE NOCASE ASC',
      default: defaultOrderSql
    }[sort] || defaultOrderSql;
    const rows = mediaDb.all(
      `SELECT c.*, o.title AS override_title, o.logo AS override_logo, o.group_title AS override_group_title, o.notes AS override_notes, o.stream_settings_json AS override_stream_settings_json, o.updated_at AS override_updated_at
       FROM channels c
       LEFT JOIN channel_overrides o ON o.channel_id = c.id
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`,
      [...params, meta.limit, meta.offset]
    );
    const items = rows.map(row => {
      const item = rowToItem(row) || {};
      const streamSettings = normalizeChannelStreamSettings(row.override_stream_settings_json || item.streamSettings);
      return {
        ...item,
        id: row.id,
        sourceId: row.source_id || item.sourceId || '',
        sourceName: row.source_name || item.sourceName || '',
        title: row.title || item.title || '',
        logo: row.logo || item.logo || '',
        url: row.url || item.url || '',
        groupTitle: row.group_title || item.groupTitle || '',
        hidden: !!Number(row.hidden || item.hidden || 0),
        sortOrder: row.sort_order === null || row.sort_order === undefined ? (item.sortOrder ?? null) : Number(row.sort_order),
        ...(Object.keys(streamSettings).length ? { streamSettings } : {}),
        override: {
          title: row.override_title || '',
          logo: row.override_logo || '',
          groupTitle: row.override_group_title || '',
          notes: row.override_notes || '',
          streamSettings,
          updatedAt: row.override_updated_at || ''
        }
      };
    });
    res.json({ ...meta, items, sources: config.iptv?.sources || [], groups });
  });
  app.get('/api/admin/matches', requireAdmin, (req, res) => {
    res.json({ ok: true, ...listFootballMatches(req.query || {}, true) });
  });
  app.get('/api/admin/football/import/status', requireAdmin, (_req, res) => {
    res.json({ ok: true, status: footballImportStatus, config: normalizeFootballConfig(config.football || {}) });
  });
  app.post('/api/admin/football/import', requireAdmin, async (_req, res) => {
    const status = await runFootballImport('manual');
    res.json({ ok: !status.running || !status.skipped, status });
  });
  app.get('/api/admin/worldcup/import/status', requireAdmin, (_req, res) => {
    res.json({ ok: true, status: worldCupImportStatus });
  });
  app.post('/api/admin/worldcup/import', requireAdmin, (_req, res) => {
    const status = importWorldCupDataFromFiles({ reason: 'manual', force: true });
    res.json({ ok: !status.running && !status.error, status });
  });
  app.post('/api/admin/matches', requireAdmin, (req, res) => {
    try {
      const match = normalizeFootballMatchPayload(req.body || {});
      if (!match.homeTeam || !match.awayTeam) return res.status(400).json({ error: 'اسم الفريقين مطلوب.' });
      res.json({ ok: true, item: saveFootballMatch(match) });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'تعذر حفظ المباراة.' });
    }
  });
  app.put('/api/admin/matches/:matchId', requireAdmin, (req, res) => {
    const existing = mediaDb.get('SELECT * FROM football_matches WHERE id = ? LIMIT 1', [req.params.matchId]);
    if (!existing) return res.status(404).json({ error: 'المباراة غير موجودة.' });
    try {
      const match = normalizeFootballMatchPayload({ ...(req.body || {}), id: req.params.matchId }, existing);
      if (!match.homeTeam || !match.awayTeam) return res.status(400).json({ error: 'اسم الفريقين مطلوب.' });
      res.json({ ok: true, item: saveFootballMatch(match) });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'تعذر تحديث المباراة.' });
    }
  });
  app.delete('/api/admin/matches/:matchId', requireAdmin, (req, res) => {
    mediaDb.run('DELETE FROM football_matches WHERE id = ?', [req.params.matchId]);
    mediaDb.save();
    res.json({ ok: true });
  });
  app.post('/api/admin/channel-groups', requireAdmin, (req, res) => {
    try {
      const updated = updateChannelGroupOverride(req.body || {});
      res.json({ ok: true, item: updated });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'تعذر حفظ إعدادات المجموعة.' });
    }
  });
  app.delete('/api/admin/channel-groups', requireAdmin, (req, res) => {
    try {
      const restored = resetChannelGroupOverride(req.query.sourceId || '', req.query.groupTitle || '');
      res.json({ ok: true, item: restored });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'تعذر إعادة إعدادات المجموعة.' });
    }
  });
  app.post('/api/admin/channels/:channelId', requireAdmin, (req, res) => {
    const updated = updateChannelOverride(req.params.channelId, req.body || {});
    if (!updated) return res.status(404).json({ error: 'القناة غير موجودة.' });
    res.json({ ok: true, item: updated });
  });
  app.delete('/api/admin/channels/:channelId', requireAdmin, (req, res) => {
    const restored = resetChannelOverride(req.params.channelId);
    if (!restored) return res.status(404).json({ error: 'القناة غير موجودة.' });
    res.json({ ok: true, item: restored });
  });
  app.get('/api/settings', requireAdmin, async (req, res) => {
    const includeDiagnostics = ['1', 'true', 'yes'].includes(String(req.query.includeDiagnostics || '').trim().toLowerCase());
    const includeDevices = ['1', 'true', 'yes'].includes(String(req.query.includeDevices || '').trim().toLowerCase());
    res.json(await buildSettingsPayload({ includeDiagnostics, includeDevices }));
  });
  app.post('/api/settings', requireAdmin, (req, res) => {
    const body = req.body || {};
    body.server = { ...config.server, ...(body.server || {}) };
    body.performance = { ...config.performance, ...(body.performance || {}) };
    body.system = { ...config.system, ...(body.system || {}) };
    body.auth = { ...config.auth, ...(body.auth || {}) };
    body.admin = { ...config.admin, ...(body.admin || {}) };
    body.scan = normalizeScanConfig({ ...config.scan, ...(body.scan || {}) });
    body.usbCapture = normalizeUsbCaptureConfig({ ...config.usbCapture, ...(body.usbCapture || {}) });
    body.rtmpServer = normalizeRtmpServerConfig({ ...config.rtmpServer, ...(body.rtmpServer || {}) });
    body.yacineTv = normalizeYacineTvConfig({ ...config.yacineTv, ...(body.yacineTv || {}) });
    body.mediaTranscode = normalizeMediaTranscodeConfig({ ...config.mediaTranscode, ...(body.mediaTranscode || {}) });
    body.bandwidth = normalizeBandwidthConfig({ ...config.bandwidth, ...(body.bandwidth || {}) });
    body.football = normalizeFootballConfig({ ...config.football, ...(body.football || {}) });
    delete body.deviceCatalog;
    if (!body.server.sessionSecret) body.server.sessionSecret = config.server.sessionSecret;
    body.libraries = Array.isArray(body.libraries) ? body.libraries.map(normalizeLibrary) : [];
    body.iptv = body.iptv || { sources: [] };
    if (!Array.isArray(body.iptv.sources)) body.iptv.sources = [];
    body.iptv.sources = body.iptv.sources.map(normalizeSource);
    saveConfig(body);
    startRtmpIngestServer();
    setupScheduledScans();
    setupFootballImportSchedule(false);
    setupYacineTvAutoRefresh(false);
    syncUsbCaptures();
    res.json({
      ok: true,
      config,
      diagnostics: buildAdminDiagnosticsSafe(),
      liveStatus: listUsbCaptureStatuses(),
      rtmpIngestStatus: getRtmpIngestStatus(),
      yacineTvStatus: {
        enabled: isYacineTvEnabled(),
        running: yacineTvRefreshRunning,
        source: getYacineTvSource(),
        status: readYacineTvStatus()
      },
      libraryConvertJobs: listLibraryConvertJobs()
    });
  });
  app.get('/api/admin/library-convert/status', requireAdmin, (_req, res) => {
    res.json({ ok: true, items: listLibraryConvertJobs() });
  });
  app.post('/api/admin/library-convert/:libraryId/start', requireAdmin, (req, res) => {
    try {
      const job = startLibraryConvertJob(req.params.libraryId);
      res.json({ ok: true, job, items: listLibraryConvertJobs() });
    } catch (error) {
      res.status(400).json({ error: toSingleLine(error?.message || 'تعذر بدء تحويل المكتبة.') });
    }
  });
  app.get('/api/admin/diagnostics', requireAdmin, (_req, res) => {
    res.json(buildAdminDiagnosticsSafe());
  });
  app.post('/api/admin/apply-profile', requireAdmin, (req, res) => {
    const profileId = String(req.body?.profile || 'recommended').trim().toLowerCase();
    const profile = applySystemProfile(profileId);
    res.json({
      ok: true,
      profile: { id: profile.id, title: profile.title, description: profile.description },
      config,
      diagnostics: buildAdminDiagnosticsSafe(),
      liveStatus: listUsbCaptureStatuses()
    });
  });
  app.get('/api/admin/export', requireAdmin, (_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="light-media-server-backup-${Date.now()}.json"`);
    res.end(JSON.stringify(buildAdminExportPayload(), null, 2), 'utf8');
  });
  app.get('/api/scan/status', requireAdmin, (_req, res) => res.json(readScanStatus()));
  app.post('/api/scan/start', requireAdmin, (req, res) => {
    const libraryId = req.body?.libraryId || null;
    const sourceId = req.body?.sourceId || null;
    const lib = libraryId ? (config.libraries || []).find(x => x.id === libraryId) : null;
    const source = sourceId ? (config.iptv?.sources || []).find(x => x.id === sourceId) : null;
    if (libraryId && !lib) return res.status(404).json({ error: 'المكتبة غير موجودة' });
    if (sourceId && !source) return res.status(404).json({ error: 'مصدر القنوات غير موجود' });
    const result = startBackgroundScan({ libraryId, libraryName: lib?.name || source?.name || null, sourceId, channelsOnly: !!sourceId });
    if (!result.started && result.reason === 'running') return res.status(409).json({ error: 'يوجد فحص آخر قيد التشغيل', status: result.status });
    res.json({ ok: true, status: readScanStatus() });
  });
  app.post('/api/scan/cancel', requireAdmin, (_req, res) => { stopScanWorker(); res.json({ ok: true, status: readScanStatus() }); });
  app.post('/api/scan', requireAdmin, (req, res) => {
    const libraryId = req.body?.libraryId || null;
    const sourceId = req.body?.sourceId || null;
    const lib = libraryId ? (config.libraries || []).find(x => x.id === libraryId) : null;
    const source = sourceId ? (config.iptv?.sources || []).find(x => x.id === sourceId) : null;
    if (libraryId && !lib) return res.status(404).json({ error: 'المكتبة غير موجودة' });
    if (sourceId && !source) return res.status(404).json({ error: 'مصدر القنوات غير موجود' });
    const result = startBackgroundScan({ libraryId, libraryName: lib?.name || source?.name || null, sourceId, channelsOnly: !!sourceId });
    if (!result.started && result.reason === 'running') return res.status(409).json({ error: 'يوجد فحص آخر قيد التشغيل', status: result.status });
    res.json({ ok: true, status: readScanStatus() });
  });
  app.get('/api/admin/yacine-tv/status', requireAdmin, (_req, res) => {
    res.json({ ok: true, enabled: isYacineTvEnabled(), source: getYacineTvSource(), running: yacineTvRefreshRunning, status: readYacineTvStatus() });
  });
  app.post('/api/admin/yacine-tv/refresh', requireAdmin, async (req, res) => {
    const result = await runYacineTvRefresh('manual', { startScan: req.body?.scan !== false });
    res.status(result.ok ? 200 : 400).json(result);
  });

  function servePage(file) {
    return (req, res) => {
      if (mustLoginForViewing() && !req.user && !['/login'].includes(req.path)) return res.redirect('/login');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(path.join(publicDir, file));
    };
  }
  app.get('/', servePage('index.html'));
  app.get('/movies', servePage('movies.html'));
  app.get('/series', servePage('series.html'));
  app.get('/audio', servePage('audio.html'));
  app.get('/mixed', servePage('mixed.html'));
  app.get('/live', servePage('live.html'));
  app.get('/sports', servePage('sports.html'));
  app.get('/matches', servePage('matches.html'));
  app.get('/football-news', servePage('football-news.html'));
  app.get('/football-profiles', servePage('football-profiles.html'));
  app.get('/football-standings', servePage('football-standings.html'));
  app.get('/teams', servePage('teams.html'));
  app.get('/settings', servePage('settings.html'));
  app.get('/watch', servePage('watch.html'));
  app.get('/webrtc-publisher', requireAdmin, servePage('webrtc-publisher.html'));
  app.get('/webrtc-viewer', servePage('webrtc-viewer.html'));
  app.get('/login', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(publicDir, 'login.html'));
  });
  app.get('/users', servePage('users.html'));
  app.use(express.static(publicDir, {
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }));

  const port = Number(config.server.port || 8088);
  const host = config.server.host || '0.0.0.0';
  setupScheduledScans();
  try { importWorldCupDataFromFiles({ reason: 'startup', force: false }); } catch (error) { console.warn(`World Cup import skipped: ${error.message}`); }
  setupFootballImportSchedule(true);
  setupYacineTvAutoRefresh(true);
  startRtmpIngestServer();
  syncUsbCaptures();
  try { autoStartChannelRelays(); } catch {}
  const httpServer = app.listen(port, host, () => {
    console.log(`Light Media Server v11 (SQLite) running on http://localhost:${port}`);
    setTimeout(() => {
      try { syncUsbCaptures(); } catch {}
      try { autoStartChannelRelays(); } catch {}
    }, 1500);
    setInterval(() => {
      try { syncUsbCaptures(); } catch {}
      try { autoStartChannelRelays(); } catch {}
    }, USB_WATCHDOG_INTERVAL_MS);
  });

  httpServer.on('error', (error) => {
    console.error(`Light Media Server failed on ${host}:${port}: ${error.message}`);
    setTimeout(() => process.exit(1), 100);
  });

  function shutdown(signal) {
    console.log(`Received ${signal}; shutting down Light Media Server.`);
    try {
      console.log('Flushing databases to disk...');
      if (typeof appDb !== 'undefined' && appDb.save) appDb.save(true);
      if (typeof mediaDb !== 'undefined' && mediaDb.save) mediaDb.save(true);
      if (typeof runtimeDb !== 'undefined' && runtimeDb.save) runtimeDb.save(true);
      console.log('Databases flushed successfully.');
    } catch (e) {
      console.error('Error flushing databases during shutdown:', e);
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
  });
})();
