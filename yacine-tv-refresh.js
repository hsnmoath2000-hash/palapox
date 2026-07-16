const fs = require('fs');
const path = require('path');

const DEFAULT_YACINE_SOURCE_ID = 'yacine-tv-auto';
const DEFAULT_API_BASE = 'http://ver3.yacinelive.com/api/';
const DEFAULT_OUTPUT_FILE = path.join('data', 'yacine-tv-auto.m3u');
const DEFAULT_STATUS_FILE = path.join('data', 'yacine-tv-auto-status.json');
const CRYPT_PREFIX = Buffer.from('c!xZj+N9&G@Ev@vw', 'utf8');
const API_USER_AGENT = 'okhttp/4.11.0';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

function resolveRootPath(rootDir, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(rootDir, text);
}

function escapeM3uAttribute(value = '') {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\r?\n/g, ' ');
}

function escapeM3uName(value = '') {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

function decryptApiBody(bodyText = '', token = '') {
  const input = Buffer.from(String(bodyText || ''), 'base64');
  const suffix = Buffer.from(String(token || Math.floor(Date.now() / 1000)), 'utf8');
  const key = Buffer.concat([CRYPT_PREFIX, suffix]);
  const output = Buffer.alloc(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = input[index] ^ key[index % key.length];
  }
  return output.toString('utf8');
}

async function fetchJson(apiBase, apiPath, timeoutMs = 20000) {
  const url = new URL(apiPath, apiBase).toString();
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': API_USER_AGENT,
      accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`${apiPath}: HTTP ${response.status}`);
  const bodyText = await response.text();
  const token = response.headers.get('t') || response.headers.get('T') || String(Math.floor(Date.now() / 1000));
  return JSON.parse(decryptApiBody(bodyText, token));
}

function sanitizeStream(stream = {}) {
  const headers = stream && typeof stream.headers === 'object' ? stream.headers : {};
  const url = String(stream.url || '').trim();
  const userAgent = String(stream.user_agent || headers['User-Agent'] || headers['user-agent'] || BROWSER_USER_AGENT).trim();
  const referer = String(stream.referer || headers.Referer || headers.referer || '').trim();
  return {
    name: String(stream.name || 'HD').trim(),
    url,
    urlType: Number(stream.url_type || 0),
    userAgent,
    referer,
    isHls: /\.m3u8(?:$|[?#])/i.test(url),
    drmProtected: !!stream.drm
  };
}

async function collectCategories(apiBase) {
  const root = (await fetchJson(apiBase, 'categories')).data || [];
  const categories = [];
  const seen = new Set();

  async function addCategory(category, parentPath = '') {
    const id = category?.id;
    if (id === undefined || id === null || seen.has(String(id))) return;
    seen.add(String(id));
    const name = String(category.name || id).trim();
    const categoryPath = parentPath ? `${parentPath} / ${name}` : name;
    categories.push({ ...category, path: categoryPath, parentPath });
    if (Number(category.child_count || 0) <= 0) return;
    try {
      const children = (await fetchJson(apiBase, `categories/${id}`)).data || [];
      for (const child of children) await addCategory(child, categoryPath);
    } catch (error) {
      categories[categories.length - 1].childrenError = error.message || String(error);
    }
  }

  for (const category of root) await addCategory(category);
  return categories;
}

async function collectChannels(apiBase, categories) {
  const channelsById = new Map();
  const errors = [];
  for (const category of categories) {
    try {
      const channels = (await fetchJson(apiBase, `categories/${category.id}/channels`)).data || [];
      for (const channel of channels) {
        const id = String(channel.id || '');
        if (!id) continue;
        if (!channelsById.has(id)) {
          channelsById.set(id, { ...channel, categories: [] });
        }
        channelsById.get(id).categories.push({ id: category.id, path: category.path });
      }
    } catch (error) {
      errors.push({ categoryId: category.id, categoryPath: category.path, error: error.message || String(error) });
    }
  }
  return { channels: [...channelsById.values()], errors };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return output;
}

async function attachChannelStreams(apiBase, channels) {
  const errors = [];
  const items = await mapWithConcurrency(channels, 8, async (channel) => {
    try {
      const streams = ((await fetchJson(apiBase, `channel/${channel.id}`, 25000)).data || []).map(sanitizeStream);
      return { ...channel, streams };
    } catch (error) {
      errors.push({ channelId: channel.id, channelName: channel.name, error: error.message || String(error) });
      return { ...channel, streams: [] };
    }
  });
  return { channels: items, errors };
}

async function collectEvents(apiBase) {
  const errors = [];
  let events = [];
  try {
    events = (await fetchJson(apiBase, 'events')).data || [];
  } catch (error) {
    return { events, errors: [{ path: 'events', error: error.message || String(error) }] };
  }
  const items = await mapWithConcurrency(events, 4, async (event) => {
    try {
      const streams = ((await fetchJson(apiBase, `event/${event.id}`, 25000)).data || []).map(sanitizeStream);
      return { ...event, streams };
    } catch (error) {
      errors.push({ eventId: event.id, error: error.message || String(error) });
      return { ...event, streams: [] };
    }
  });
  return { events: items, errors };
}

function getExpiryIso(url = '') {
  try {
    const parsed = new URL(url);
    const expiry = Number(parsed.searchParams.get('e') || 0);
    if (!expiry) return '';
    return new Date(expiry * 1000).toISOString();
  } catch {
    return '';
  }
}

function addM3uStream(lines, entry) {
  const stream = entry.stream || {};
  if (stream.drmProtected || !stream.isHls || !stream.url) return false;
  const name = escapeM3uName(entry.title || stream.name || 'Yacine TV');
  const group = escapeM3uAttribute(entry.group || 'Yacine TV');
  const logo = escapeM3uAttribute(entry.logo || '');
  const tvgId = escapeM3uAttribute(entry.tvgId || '');
  lines.push(`#EXTINF:-1 tvg-id="${tvgId}" tvg-logo="${logo}" group-title="${group}",${name}`);
  if (stream.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${stream.userAgent}`);
  if (stream.referer) lines.push(`#EXTVLCOPT:http-referrer=${stream.referer}`);
  lines.push(`#LMS:expires-at=${getExpiryIso(stream.url)}`);
  lines.push(stream.url);
  return true;
}

function buildM3u(channels, events) {
  const lines = [
    '#EXTM3U',
    `# Generated by Light Media Server at ${new Date().toISOString()}`,
    '# Source: Yacine TV API'
  ];
  let entries = 0;
  for (const channel of channels) {
    const category = (channel.categories || [])[0] || {};
    const group = category.path || 'Yacine TV';
    for (const stream of channel.streams || []) {
      entries += addM3uStream(lines, {
        tvgId: `yacine-channel-${channel.id}-${stream.name}`,
        title: `${channel.name || channel.id} - ${stream.name || 'HD'}`,
        group,
        logo: channel.logo || '',
        stream
      }) ? 1 : 0;
    }
  }
  for (const event of events) {
    const team1 = String(event.team_1?.name || '').trim();
    const team2 = String(event.team_2?.name || '').trim();
    const title = [team1, team2].filter(Boolean).join(' vs ') || event.channel || `Event ${event.id}`;
    const group = `Yacine Events / ${event.champions || 'Live'}`;
    const logo = event.team_1?.logo || event.team_2?.logo || '';
    for (const stream of event.streams || []) {
      entries += addM3uStream(lines, {
        tvgId: `yacine-event-${event.id}-${stream.name}`,
        title: `${title} - ${stream.name || 'HD'}`,
        group,
        logo,
        stream
      }) ? 1 : 0;
    }
  }
  return { text: `${lines.join('\n')}\n`, entries };
}

async function refreshYacineTvPlaylist(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const apiBase = String(options.apiBase || DEFAULT_API_BASE);
  const outputPath = resolveRootPath(rootDir, options.outputPath || DEFAULT_OUTPUT_FILE);
  const statusPath = resolveRootPath(rootDir, options.statusPath || DEFAULT_STATUS_FILE);
  const startedAt = new Date().toISOString();

  const categories = await collectCategories(apiBase);
  const channelResult = await collectChannels(apiBase, categories);
  const streamResult = await attachChannelStreams(apiBase, channelResult.channels);
  const eventResult = await collectEvents(apiBase);
  const playlist = buildM3u(streamResult.channels, eventResult.events);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, playlist.text, 'utf8');

  const status = {
    ok: true,
    sourceId: DEFAULT_YACINE_SOURCE_ID,
    apiBase,
    outputPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    categories: categories.length,
    channels: streamResult.channels.length,
    events: eventResult.events.length,
    hlsEntries: playlist.entries,
    errors: {
      categories: channelResult.errors,
      channels: streamResult.errors,
      events: eventResult.errors
    }
  };
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf8');
  return status;
}

if (require.main === module) {
  refreshYacineTvPlaylist({
    rootDir: __dirname,
    outputPath: process.env.YACINE_TV_OUTPUT || DEFAULT_OUTPUT_FILE,
    statusPath: process.env.YACINE_TV_STATUS || DEFAULT_STATUS_FILE,
    apiBase: process.env.YACINE_TV_API_BASE || DEFAULT_API_BASE
  }).then((status) => {
    console.log(JSON.stringify(status, null, 2));
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_YACINE_SOURCE_ID,
  DEFAULT_OUTPUT_FILE,
  DEFAULT_STATUS_FILE,
  refreshYacineTvPlaylist
};
