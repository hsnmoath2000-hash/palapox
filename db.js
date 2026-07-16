const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const initSqlJs = require('sql.js');

let SQLPromise = null;
async function getSQL() {
  if (!SQLPromise) {
    const sqlJsMain = require.resolve('sql.js');
    const sqlJsDir = path.dirname(sqlJsMain);
    SQLPromise = initSqlJs({
      locateFile: (file) => path.join(sqlJsDir, file)
    });
  }
  return SQLPromise;
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const LOCK_TIMEOUT_MS = 15000;
const LOCK_STALE_MS = 120000;
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SAVE_RETRY_ATTEMPTS = 5;
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

function isSqliteDatabaseBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= SQLITE_HEADER.length && buffer.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
}

function sqliteErrorLooksRecoverable(error) {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return (
    message.includes('disk i/o error') ||
    message.includes('database is locked') ||
    message.includes('database table is locked') ||
    message.includes('database is busy') ||
    message.includes('file is not a database') ||
    message.includes('database disk image is malformed') ||
    message.includes('unsupported file format') ||
    message.includes('not a database')
  );
}

function sleepMs(ms) {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

function withDatabaseFileLock(file, fn, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockDir = `${file}.lock`;
  const startedAt = Date.now();
  let locked = false;

  while (!locked) {
    try {
      fs.mkdirSync(lockDir);
      locked = true;
      try {
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString()
        }, null, 2), 'utf8');
      } catch {}
    } catch (error) {
      let lockAge = 0;
      try { lockAge = Date.now() - fs.statSync(lockDir).mtimeMs; } catch {}
      if (lockAge > LOCK_STALE_MS) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for database lock: ${file}`);
      }
      sleepMs(75);
    }
  }

  try {
    return fn();
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
  }
}

function readDatabaseFile(file) {
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return fs.readFileSync(file);
    } catch (error) {
      lastError = error;
      sleepMs(20 * attempt);
    }
  }
  throw lastError;
}

function replaceFileWithRetry(source, destination) {
  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      sleepMs(Math.min(1000, 80 * attempt));
    }
  }
  throw lastError;
}

function writeBufferDurably(file, buffer) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'w');
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function validateSqliteBuffer(SQL, buffer, label) {
  if (!isSqliteDatabaseBuffer(buffer)) {
    throw new Error(`Refusing to use invalid SQLite data for ${label}`);
  }
  let probe = null;
  try {
    probe = new SQL.Database(buffer);
    const rows = probe.exec('PRAGMA quick_check;');
    const result = rows?.[0]?.values?.[0]?.[0];
    if (result !== 'ok') throw new Error(`SQLite quick check failed: ${result || 'unknown'}`);
  } finally {
    try { probe?.close(); } catch {}
  }
}

function shouldRefreshBackup(file) {
  const backupFile = `${file}.bak`;
  if (!fs.existsSync(file)) return false;
  if (!fs.existsSync(backupFile)) return true;
  try {
    return Date.now() - fs.statSync(backupFile).mtimeMs > BACKUP_MIN_INTERVAL_MS;
  } catch {
    return true;
  }
}

function restoreBackupIfPossible(SQL, file, reason = '') {
  const backupFile = `${file}.bak`;
  if (!fs.existsSync(backupFile)) return false;
  try {
    const backupBuffer = fs.readFileSync(backupFile);
    validateSqliteBuffer(SQL, backupBuffer, backupFile);
    fs.copyFileSync(backupFile, file);
    const details = reason ? ` (${reason})` : '';
    console.warn(`[database] تم استرجاع نسخة احتياطية سليمة: ${backupFile} -> ${file}${details}`);
    return true;
  } catch (error) {
    console.warn(`[database] تعذر استرجاع النسخة الاحتياطية ${backupFile}: ${error.message}`);
    return false;
  }
}

function writeSqliteFileAtomically(SQL, file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  validateSqliteBuffer(SQL, buffer, file);
  withDatabaseFileLock(file, () => {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const tmpFile = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeBufferDurably(tmpFile, buffer);
      validateSqliteBuffer(SQL, fs.readFileSync(tmpFile), tmpFile);
      if (shouldRefreshBackup(file)) {
        try { fs.copyFileSync(file, `${file}.bak`); } catch {}
      }
      replaceFileWithRetry(tmpFile, file);
    } finally {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    }
  });
}

async function acquireLockAsync(file, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockDir = `${file}.lock`;
  const startedAt = Date.now();
  while (true) {
    try {
      await fsp.mkdir(lockDir);
      try {
        await fsp.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString()
        }, null, 2), 'utf8');
      } catch {}
      return lockDir;
    } catch (error) {
      let lockAge = 0;
      try {
        const stat = await fsp.stat(lockDir);
        lockAge = Date.now() - stat.mtimeMs;
      } catch {}
      if (lockAge > LOCK_STALE_MS) {
        try { await fsp.rm(lockDir, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for database lock: ${file}`);
      }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  }
}

async function renameFileWithRetryAsync(source, destination) {
  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, 80 * attempt)));
    }
  }
  throw lastError;
}

async function writeSqliteFileAtomicallyAsync(SQL, file, buffer) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  validateSqliteBuffer(SQL, buffer, file);
  const lockDir = await acquireLockAsync(file);
  const dir = path.dirname(file);
  const base = path.basename(file);
  const tmpFile = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = await fsp.open(tmpFile, 'w');
    await fd.write(buffer);
    await fd.sync();
    await fd.close();
    
    const tmpBuffer = await fsp.readFile(tmpFile);
    validateSqliteBuffer(SQL, tmpBuffer, tmpFile);
    
    if (shouldRefreshBackup(file)) {
      try { await fsp.copyFile(file, `${file}.bak`); } catch {}
    }
    await renameFileWithRetryAsync(tmpFile, file);
  } finally {
    try { if (fs.existsSync(tmpFile)) await fsp.unlink(tmpFile); } catch {}
    try { await fsp.rm(lockDir, { recursive: true, force: true }); } catch {}
  }
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function quarantineDatabaseFile(file, reason = '') {
  if (!file || !fs.existsSync(file)) return null;
  const dir = path.dirname(file);
  const backupDir = path.join(dir, 'recovered-corrupt-databases');
  fs.mkdirSync(backupDir, { recursive: true });
  const baseName = path.basename(file);
  let backupFile = path.join(backupDir, `${baseName}.${safeTimestamp()}.corrupt`);
  let suffix = 1;
  while (fs.existsSync(backupFile)) {
    backupFile = path.join(backupDir, `${baseName}.${safeTimestamp()}-${suffix}.corrupt`);
    suffix += 1;
  }
  try {
    fs.renameSync(file, backupFile);
  } catch {
    fs.copyFileSync(file, backupFile);
    fs.unlinkSync(file);
  }
  const details = reason ? ` (${reason})` : '';
  console.warn(`[database] تم عزل قاعدة بيانات تالفة وإنشاء واحدة جديدة: ${file} -> ${backupFile}${details}`);
  return backupFile;
}

function openDatabaseOrFresh(SQL, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) return new SQL.Database();
  const stat = fs.statSync(file);
  if (!stat.size) {
    if (restoreBackupIfPossible(SQL, file, 'empty file')) return openDatabaseOrFresh(SQL, file);
    quarantineDatabaseFile(file, 'empty file');
    return new SQL.Database();
  }
  const buffer = readDatabaseFile(file);
  if (!isSqliteDatabaseBuffer(buffer)) {
    if (restoreBackupIfPossible(SQL, file, 'invalid sqlite header')) return openDatabaseOrFresh(SQL, file);
    quarantineDatabaseFile(file, 'invalid sqlite header');
    return new SQL.Database();
  }
  try {
    validateSqliteBuffer(SQL, buffer, file);
    return new SQL.Database(buffer);
  } catch (error) {
    if (!sqliteErrorLooksRecoverable(error)) throw error;
    if (restoreBackupIfPossible(SQL, file, error.message)) return openDatabaseOrFresh(SQL, file);
    quarantineDatabaseFile(file, error.message);
    return new SQL.Database();
  }
}

class SqliteFile {
  constructor(SQL, db, file, schemaSql = '', afterOpen = null) {
    this.SQL = SQL;
    this.db = db;
    this.file = file;
    this.schemaSql = schemaSql || '';
    this.afterOpen = afterOpen || null;
    this.recovering = false;
    this.lastLoadedMtimeMs = fs.existsSync(file) ? (fs.statSync(file).mtimeMs || Date.now()) : 0;
    
    // Non-blocking save queues
    this.dirty = false;
    this.pendingSaveTimeout = null;
    this.isSavingAsync = false;
  }
  replaceDatabase(db) {
    const oldDb = this.db;
    this.db = db;
    try { oldDb?.close(); } catch {}
    this.lastLoadedMtimeMs = fs.existsSync(this.file) ? (fs.statSync(this.file).mtimeMs || Date.now()) : Date.now();
  }
  applySchemaAndMigrations() {
    if (this.schemaSql) execStatements(this, this.schemaSql);
    if (this.afterOpen) this.afterOpen(this);
  }
  recoverFromError(error, context = 'database operation') {
    if (!sqliteErrorLooksRecoverable(error)) throw error;
    if (this.recovering) throw error;

    let lastError = error;
    this.recovering = true;
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          sleepMs(120 * attempt);
          const db = openDatabaseOrFresh(this.SQL, this.file);
          this.replaceDatabase(db);
          this.applySchemaAndMigrations();
          console.warn(`[database] تم التعافي من خطأ قاعدة البيانات أثناء ${context}: ${error.message}`);
          return true;
        } catch (recoverError) {
          lastError = recoverError;
          console.warn(`[database] فشلت محاولة التعافي (${attempt}/2) أثناء ${context}: ${recoverError.message}`);
        }
      }
    } finally {
      this.recovering = false;
    }
    throw lastError;
  }
  reloadIfChanged(force = false) {
    if (!this.file || !fs.existsSync(this.file)) return false;
    const now = Date.now();
    if (!force && this.lastStatTime && (now - this.lastStatTime < 1000)) return false;
    this.lastStatTime = now;
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return false;
    }
    const diskMtime = stat.mtimeMs || 0;
    if (!force && (!diskMtime || diskMtime <= this.lastLoadedMtimeMs)) return false;
    let freshDb = null;
    try {
      const buffer = readDatabaseFile(this.file);
      if (!isSqliteDatabaseBuffer(buffer)) {
        console.warn(`[database] تم تجاهل إعادة تحميل ملف غير مكتمل أو غير صالح مؤقتًا: ${this.file}`);
        return false;
      }
      freshDb = new this.SQL.Database(buffer);
    } catch (error) {
      if (!sqliteErrorLooksRecoverable(error)) throw error;
      console.warn(`[database] تعذر إعادة تحميل قاعدة البيانات مؤقتًا: ${this.file}: ${error.message}`);
      return false;
    }
    try { this.db.close(); } catch {}
    this.db = freshDb;
    this.lastLoadedMtimeMs = diskMtime;
    return true;
  }
  run(sql, params = []) {
    try {
      this.db.run(sql, params);
      return this;
    } catch (error) {
      this.recoverFromError(error, 'write');
      this.db.run(sql, params);
      return this;
    }
  }
  exec(sql) {
    try {
      return this.db.exec(sql);
    } catch (error) {
      this.recoverFromError(error, 'exec');
      return this.db.exec(sql);
    }
  }
  transaction(fn) {
    this.run('BEGIN');
    try {
      const v = fn(this);
      this.run('COMMIT');
      return v;
    } catch (e) {
      try { this.run('ROLLBACK'); } catch {}
      throw e;
    }
  }
  get(sql, params = []) {
    this.reloadIfChanged();
    const readOne = () => {
      let stmt = null;
      try {
        stmt = this.db.prepare(sql, params);
        return stmt.step() ? stmt.getAsObject() : null;
      } finally {
        try { stmt?.free(); } catch {}
      }
    };
    try {
      return readOne();
    } catch (error) {
      if (!sqliteErrorLooksRecoverable(error)) throw error;
      console.warn(`[database] إعادة محاولة قراءة قاعدة البيانات بعد خطأ: ${error.message}`);
      try {
        this.recoverFromError(error, 'read one');
        return readOne();
      } catch (retryError) {
        if (!sqliteErrorLooksRecoverable(retryError)) throw retryError;
        console.warn(`[database] تم تجاهل قراءة فاشلة بعد التعافي للحفاظ على استمرار السيرفر: ${retryError.message}`);
        return null;
      }
    }
  }
  all(sql, params = []) {
    this.reloadIfChanged();
    const readRows = () => {
      let stmt = null;
      const rows = [];
      try {
        stmt = this.db.prepare(sql, params);
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        try { stmt?.free(); } catch {}
      }
    };
    try {
      return readRows();
    } catch (error) {
      if (!sqliteErrorLooksRecoverable(error)) throw error;
      console.warn(`[database] إعادة محاولة قراءة قاعدة البيانات بعد خطأ: ${error.message}`);
      try {
        this.recoverFromError(error, 'read rows');
        return readRows();
      } catch (retryError) {
        if (!sqliteErrorLooksRecoverable(retryError)) throw retryError;
        console.warn(`[database] تم تجاهل قراءة قائمة فاشلة بعد التعافي للحفاظ على استمرار السيرفر: ${retryError.message}`);
        return [];
      }
    }
  }
  tableExists(name) {
    const row = this.get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name]);
    return !!row;
  }
  scheduleSave() {
    this.dirty = true;
    if (this.pendingSaveTimeout !== null) return;
    
    this.pendingSaveTimeout = setTimeout(() => {
      this.pendingSaveTimeout = null;
      if (this.dirty && !this.isSavingAsync) {
        this.saveAsync().catch(err => {
          console.error(`[database] background save failed for ${this.file}:`, err);
        });
      }
    }, 1000); // 1-second debounce delay
  }
  async saveAsync() {
    this.isSavingAsync = true;
    this.dirty = false;
    let lastError = null;
    let buffer;
    try {
      buffer = Buffer.from(this.db.export());
    } catch (exportError) {
      this.isSavingAsync = false;
      this.dirty = true;
      throw exportError;
    }
    for (let attempt = 1; attempt <= SAVE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await writeSqliteFileAtomicallyAsync(this.SQL, this.file, buffer);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!sqliteErrorLooksRecoverable(error) || attempt === SAVE_RETRY_ATTEMPTS) break;
        console.warn(`[database] background save retry (${attempt}/${SAVE_RETRY_ATTEMPTS}): ${this.file}: ${error.message}`);
        try {
          this.recoverFromError(error, 'save async');
          buffer = Buffer.from(this.db.export());
        } catch (recoverError) {
          lastError = recoverError;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(1500, 120 * attempt)));
      }
    }
    this.isSavingAsync = false;
    if (lastError) {
      this.dirty = true;
      throw lastError;
    }
    try {
      this.lastLoadedMtimeMs = fs.existsSync(this.file) ? (fs.statSync(this.file).mtimeMs || Date.now()) : Date.now();
    } catch {}
    if (this.dirty) {
      this.scheduleSave();
    }
  }
  flushSync() {
    if (this.pendingSaveTimeout !== null) {
      clearTimeout(this.pendingSaveTimeout);
      this.pendingSaveTimeout = null;
    }
    let lastError = null;
    for (let attempt = 1; attempt <= SAVE_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const buffer = Buffer.from(this.db.export());
        writeSqliteFileAtomically(this.SQL, this.file, buffer);
        lastError = null;
        this.dirty = false;
        break;
      } catch (error) {
        lastError = error;
        if (!sqliteErrorLooksRecoverable(error) || attempt === SAVE_RETRY_ATTEMPTS) break;
        console.warn(`[database] retry sync save (${attempt}/${SAVE_RETRY_ATTEMPTS}): ${this.file}: ${error.message}`);
        try { this.recoverFromError(error, 'save sync'); } catch (recoverError) { lastError = recoverError; break; }
        sleepMs(Math.min(1500, 120 * attempt));
      }
    }
    if (lastError) throw lastError;
    this.lastLoadedMtimeMs = fs.existsSync(this.file) ? (fs.statSync(this.file).mtimeMs || Date.now()) : Date.now();
  }
  save(forceSync = false) {
    if (forceSync) {
      this.flushSync();
    } else {
      this.scheduleSave();
    }
  }
  close() {
    if (this.pendingSaveTimeout !== null) {
      clearTimeout(this.pendingSaveTimeout);
      this.pendingSaveTimeout = null;
    }
    try { this.db.close(); } catch {}
  }
}

function execStatements(wrapper, sql) {
  const parts = String(sql)
    .split(/;\s*(?:\n|$)/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const stmt of parts) {
    wrapper.exec(stmt + ';');
  }
}

async function openSqliteFile(file, schemaSql, afterOpen) {
  const SQL = await getSQL();
  const db = openDatabaseOrFresh(SQL, file);
  const wrapper = new SqliteFile(SQL, db, file, schemaSql, afterOpen);
  try {
    wrapper.applySchemaAndMigrations();
    wrapper.save();
    return wrapper;
  } catch (error) {
    try { wrapper.close(); } catch {}
    if (!sqliteErrorLooksRecoverable(error)) throw error;
    quarantineDatabaseFile(file, error.message);
    const freshWrapper = new SqliteFile(SQL, new SQL.Database(), file, schemaSql, afterOpen);
    freshWrapper.applySchemaAndMigrations();
    freshWrapper.save();
    return freshWrapper;
  }
}

const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  last_login_at TEXT,
  device_id TEXT,
  auth_type TEXT NOT NULL DEFAULT 'password'
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT,
  poster TEXT,
  subtitle TEXT,
  href TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, type, item_id)
);
CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  title TEXT,
  poster TEXT,
  subtitle TEXT,
  href TEXT,
  stream_url TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, type, item_id)
);
CREATE TABLE IF NOT EXISTS history (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT,
  poster TEXT,
  subtitle TEXT,
  href TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, type, item_id)
);
CREATE TABLE IF NOT EXISTS preferences (
  user_id TEXT PRIMARY KEY,
  json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device_id ON users(device_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, updated_at DESC);
`;

const MEDIA_SCHEMA = `
CREATE TABLE IF NOT EXISTS media_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  library_id TEXT NOT NULL,
  library_name TEXT,
  poster TEXT,
  top_folder TEXT,
  folder_path TEXT,
  folder_tree_json TEXT,
  media_folder TEXT,
  created_at TEXT,
  updated_at TEXT,
  added_at TEXT,
  path TEXT,
  stream_url TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_type_added ON media_items(type, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_type_updated ON media_items(type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_library_type ON media_items(library_id, type);
CREATE INDEX IF NOT EXISTS idx_media_folder ON media_items(type, folder_path);
CREATE INDEX IF NOT EXISTS idx_media_title ON media_items(type, title);
CREATE TABLE IF NOT EXISTS folder_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  library_id TEXT,
  parent_path TEXT,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  poster TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  child_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  added_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_folder_nodes_parent ON folder_nodes(type, library_id, parent_path, name);
CREATE INDEX IF NOT EXISTS idx_folder_nodes_path ON folder_nodes(type, library_id, path);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  source_name TEXT,
  title TEXT,
  logo TEXT,
  url TEXT,
  now_playing_json TEXT,
  group_title TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(source_id, title);
CREATE TABLE IF NOT EXISTS channel_overrides (
  channel_id TEXT PRIMARY KEY,
  source_id TEXT,
  original_title TEXT,
  original_logo TEXT,
  title TEXT,
  logo TEXT,
  group_title TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  notes TEXT,
  stream_settings_json TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_overrides_source ON channel_overrides(source_id);
CREATE TABLE IF NOT EXISTS channel_group_overrides (
  source_id TEXT NOT NULL DEFAULT '',
  original_group_title TEXT NOT NULL DEFAULT '',
  title TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER,
  notes TEXT,
  updated_at TEXT,
  PRIMARY KEY(source_id, original_group_title)
);
CREATE INDEX IF NOT EXISTS idx_channel_group_overrides_source ON channel_group_overrides(source_id);
CREATE TABLE IF NOT EXISTS football_matches (
  id TEXT PRIMARY KEY,
  competition TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_at TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  home_score INTEGER,
  away_score INTEGER,
  venue TEXT,
  round TEXT,
  headline TEXT,
  summary TEXT,
  details TEXT,
  news_json TEXT NOT NULL DEFAULT '[]',
  linked_channel_id TEXT,
  linked_channel_title TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_football_matches_status ON football_matches(visible, status, kickoff_at);
CREATE INDEX IF NOT EXISTS idx_football_matches_competition ON football_matches(visible, competition, kickoff_at);
CREATE TABLE IF NOT EXISTS football_news (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  source TEXT,
  image TEXT,
  published_at TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_football_news_published ON football_news(published_at DESC, updated_at DESC);
CREATE TABLE IF NOT EXISTS football_profiles (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'club',
  name TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  url TEXT,
  image TEXT,
  source TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_football_profiles_type ON football_profiles(visible, type, priority DESC, name);
CREATE TABLE IF NOT EXISTS libraries_meta (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  updated_at TEXT,
  item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function ensureAppDbMigrations(db) {
  const columns = db.all('PRAGMA table_info(users)');
  const names = new Set(columns.map(col => String(col.name || '').toLowerCase()));
  if (!names.has('device_id')) db.exec("ALTER TABLE users ADD COLUMN device_id TEXT;");
  if (!names.has('auth_type')) db.exec("ALTER TABLE users ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password';");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device_id ON users(device_id);');
}

function ensureMediaDbMigrations(db) {
  if (!db.tableExists('folder_nodes')) {
    db.exec(`CREATE TABLE IF NOT EXISTS folder_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      library_id TEXT,
      parent_path TEXT,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      poster TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      added_at TEXT
    );`);
  }
  const channelColumns = db.all('PRAGMA table_info(channels)');
  const channelNames = new Set(channelColumns.map(col => String(col.name || '').toLowerCase()));
  if (!channelNames.has('group_title')) db.exec('ALTER TABLE channels ADD COLUMN group_title TEXT;');
  if (!channelNames.has('hidden')) db.exec('ALTER TABLE channels ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;');
  if (!channelNames.has('sort_order')) db.exec('ALTER TABLE channels ADD COLUMN sort_order INTEGER;');
  const channelGroupRows = db.all("SELECT id, raw_json FROM channels WHERE group_title IS NULL OR TRIM(group_title) = ''");
  for (const row of channelGroupRows) {
    try {
      const item = JSON.parse(row.raw_json || '{}');
      const groupTitle = String(item.groupTitle || '').trim();
      if (groupTitle) db.run('UPDATE channels SET group_title = ? WHERE id = ?', [groupTitle, row.id]);
    } catch {}
  }
  db.exec(`CREATE TABLE IF NOT EXISTS channel_overrides (
    channel_id TEXT PRIMARY KEY,
    source_id TEXT,
    original_title TEXT,
    original_logo TEXT,
    title TEXT,
    logo TEXT,
    group_title TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER,
    notes TEXT,
    stream_settings_json TEXT,
    updated_at TEXT
  );`);
  const channelOverrideColumns = db.all('PRAGMA table_info(channel_overrides)');
  const channelOverrideNames = new Set(channelOverrideColumns.map(col => String(col.name || '').toLowerCase()));
  if (!channelOverrideNames.has('stream_settings_json')) db.exec('ALTER TABLE channel_overrides ADD COLUMN stream_settings_json TEXT;');
  db.exec(`CREATE TABLE IF NOT EXISTS channel_group_overrides (
    source_id TEXT NOT NULL DEFAULT '',
    original_group_title TEXT NOT NULL DEFAULT '',
    title TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER,
    notes TEXT,
    updated_at TEXT,
    PRIMARY KEY(source_id, original_group_title)
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_folder_nodes_parent ON folder_nodes(type, library_id, parent_path, name);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_folder_nodes_path ON folder_nodes(type, library_id, path);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_channels_visible ON channels(source_id, hidden, sort_order, title);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(hidden, group_title, sort_order, title);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_channel_overrides_source ON channel_overrides(source_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_channel_group_overrides_source ON channel_group_overrides(source_id);');
  db.exec(`CREATE TABLE IF NOT EXISTS football_matches (
    id TEXT PRIMARY KEY,
    competition TEXT,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    kickoff_at TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    home_score INTEGER,
    away_score INTEGER,
    venue TEXT,
    round TEXT,
    headline TEXT,
    summary TEXT,
    details TEXT,
    news_json TEXT NOT NULL DEFAULT '[]',
    linked_channel_id TEXT,
    linked_channel_title TEXT,
    visible INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_football_matches_status ON football_matches(visible, status, kickoff_at);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_football_matches_competition ON football_matches(visible, competition, kickoff_at);');
  db.exec(`CREATE TABLE IF NOT EXISTS football_news (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT,
    url TEXT,
    source TEXT,
    image TEXT,
    published_at TEXT,
    raw_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT,
    updated_at TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_football_news_published ON football_news(published_at DESC, updated_at DESC);');
  db.exec(`CREATE TABLE IF NOT EXISTS football_profiles (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'club',
    name TEXT NOT NULL,
    title TEXT,
    summary TEXT,
    url TEXT,
    image TEXT,
    source TEXT,
    visible INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_football_profiles_type ON football_profiles(visible, type, priority DESC, name);');
}

async function openAppDb(rootDir) {
  return openSqliteFile(path.join(rootDir, 'data', 'app.sqlite'), APP_SCHEMA, ensureAppDbMigrations);
}
async function openMediaDb(rootDir) {
  return openSqliteFile(path.join(rootDir, 'data', 'media.sqlite'), MEDIA_SCHEMA, ensureMediaDbMigrations);
}
async function openRuntimeDb(rootDir) {
  return openSqliteFile(path.join(rootDir, 'data', 'runtime.sqlite'), RUNTIME_SCHEMA);
}

module.exports = { getSQL, openAppDb, openMediaDb, openRuntimeDb, sqliteErrorLooksRecoverable };
