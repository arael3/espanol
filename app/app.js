const DB_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100)
);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  rank INTEGER NOT NULL CHECK(rank > 0),
  spanish_word TEXT NOT NULL CHECK(length(trim(spanish_word)) > 0),
  polish_translation TEXT NOT NULL CHECK(length(trim(polish_translation)) > 0 AND length(polish_translation) <= 1000),
  ipa_word TEXT CHECK(length(ipa_word) <= 255),
  spanish_sentence TEXT CHECK(length(spanish_sentence) <= 2000),
  ipa_sentence TEXT CHECK(length(ipa_sentence) <= 1000),
  polish_sentence TEXT CHECK(length(polish_sentence) <= 2000),
  part_of_speech TEXT CHECK(length(part_of_speech) <= 100),
  gender TEXT CHECK(gender IS NULL OR gender IN ('męski','żeński')),
  image_url TEXT
);
CREATE TABLE user_card_progress (
  card_id INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  interval INTEGER NOT NULL DEFAULT 0 CHECK(interval >= 0),
  repetitions INTEGER NOT NULL DEFAULT 0 CHECK(repetitions >= 0),
  next_review_at TEXT NOT NULL,
  last_reviewed_at TEXT
);
CREATE TABLE review_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  quality INTEGER NOT NULL CHECK(quality IN (1,3,4,5)),
  reviewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cards_rank ON cards(rank, id);
CREATE INDEX idx_cards_spanish ON cards(spanish_word COLLATE NOCASE, id);
CREATE INDEX idx_cards_pos ON cards(part_of_speech, id);
CREATE INDEX idx_cards_gender ON cards(gender, id);
CREATE INDEX idx_cards_category ON cards(category_id, id);
CREATE INDEX idx_progress_review ON user_card_progress(next_review_at);
CREATE INDEX idx_logs_reviewed ON review_logs(reviewed_at DESC);
PRAGMA user_version = 1;
`;

function flashcardsApp() {
  return {
    db: null, SQL: null, fileHandle: null, fileName: '', persistent: false, saveFailed: false, savedHandle: false,
    initMessage: '', initError: '', toast: { text: '', type: '' }, toastTimer: null,
    navItems: [
      { id: 'dashboard', icon: '⌂', label: 'Panel' },
      { id: 'study', icon: '✳', label: 'Nauka' },
      { id: 'cards', icon: '▤', label: 'Fiszki' },
      { id: 'progress', icon: '⌁', label: 'Postępy' },
      { id: 'categories', icon: '▦', label: 'Kategorie' },
      { id: 'data', icon: '↗', label: 'Dane i kopie' }
    ],
    view: 'dashboard', currentLabel: 'Panel', categories: [], cards: [], cardsTotal: 0,
    stats: { total: 0, known: 0, reviews: 0, future: 0 }, recent: [], chartDays: [],
    dueCount: 0, queueCount: 0, maxChart: 1, todayLabel: '', speechAvailable: false,
    search: '', categoryFilter: 'all', sortBy: 'rank', pageNo: 1,
    studyQueue: [], studyCard: null, studyActive: false, answerShown: false, sessionCompleted: 0, sessionTotal: 0,
    cardDialog: false, editingCard: null, previewCard: null,
    cardForm: {}, formErrors: {}, categoryDialog: false, editingCategory: null, categoryName: '', categoryError: '',
    importPreview: null, importSummary: '', importSourceName: '', resetDialog: false, resetPhrase: '',

    async init() {
      this.todayLabel = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()).toUpperCase();
      this.speechAvailable = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
      try {
        this.SQL = window.Alpine?.raw
          ? window.Alpine.raw(await initSqlJs({ locateFile: () => window.SQL_WASM_BLOB_URL }))
          : await initSqlJs({ locateFile: () => window.SQL_WASM_BLOB_URL });
        this.savedHandle = await this.hasSavedHandle();
        this.initMessage = this.SQL ? 'SQLite gotowe — wybierz plik bazy, aby rozpocząć' : '';
      } catch (error) {
        this.initError = `Inicjalizacja SQLite nie powiodła się: ${error.message || error}`;
      }
    },

    get currentTime() { return new Date().toISOString(); },
    showToast(text, type = 'success') {
      this.toast = { text, type };
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toast.text = ''; }, 4200);
    },
    plural(n, one, few, many) {
      const x = Math.abs(n), last = x % 10, lastTwo = x % 100;
      if (x === 1) return one;
      if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
      return many;
    },
    rows(sql, params = []) {
      const stmt = this.db.prepare(sql);
      try { stmt.bind(params); const result = []; while (stmt.step()) result.push(stmt.getAsObject()); return result; }
      finally { stmt.free(); }
    },
    scalar(sql, params = []) { return this.rows(sql, params)[0]; },
    run(sql, params = []) { this.db.run(sql, params); },
    exportDatabase() {
      const bytes = this.db.export();
      this.db.run('PRAGMA foreign_keys = ON');
      return bytes;
    },
    navigate(view) {
      this.view = view;
      this.currentLabel = this.navItems.find(x => x.id === view)?.label || (view === 'data' ? 'Dane i kopie' : view);
      if (!this.db) return;
      if (view === 'cards') this.loadCards();
      this.refreshAll();
    },
    async refreshAll() {
      if (!this.db) return;
      this.loadCategories(); this.loadStats(); this.loadRecent(); this.loadChart();
      if (this.view === 'cards') this.loadCards();
      const queue = this.buildQueue();
      this.dueCount = queue.filter(card => Number(card.is_due) === 1).length;
      this.queueCount = queue.length;
    },
    async openDatabase() {
      if (!this.SQL) { this.showToast('Silnik SQLite nie jest gotowy.', 'error'); return; }
      if (!this.canReplaceDatabase()) return;
      if (window.showOpenFilePicker) {
        try {
          const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Baza SQLite', accept: { 'application/vnd.sqlite3': ['.sqlite', '.sqlite3', '.db'] } }] });
          if (handle) await this.openHandle(handle);
        } catch (error) {
          if (error.name !== 'AbortError') this.showToast(`Nie udało się wybrać pliku: ${error.message || error}`, 'error');
        }
      } else {
        this.showToast('Ta przeglądarka nie obsługuje bezpośredniego dostępu do plików. Wybierz plik przez standardowe okno.', 'info');
        this.$refs.dbInput.click();
      }
    },
    async createDatabase() {
      if (!this.SQL) { this.showToast('Silnik SQLite nie jest gotowy.', 'error'); return; }
      if (!this.canReplaceDatabase()) return;
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: 'fiszki-hiszpanski.sqlite',
            types: [{ description: 'Baza SQLite', accept: { 'application/vnd.sqlite3': ['.sqlite'] } }]
          });
          const db = this.newDatabase();
          this.db = window.Alpine?.raw ? window.Alpine.raw(db) : db;
          this.fileHandle = window.Alpine?.raw ? window.Alpine.raw(handle) : handle;
          this.fileName = handle.name;
          this.persistent = true; this.saveFailed = false;
          let writeError = null, rememberError = null;
          try { await this.writeActiveFile(); }
          catch (error) { this.persistent = false; this.fileHandle = null; writeError = error; }
          if (!writeError) {
            try { await this.rememberHandle(handle); }
            catch (error) { rememberError = error; }
          }
          this.navigate('dashboard'); this.refreshAll();
          if (writeError) this.showToast(`Nie zapisano nowej bazy: ${writeError.message || writeError}. Baza jest tymczasowo w pamięci; pobierz kopię SQLite.`, 'error');
          else if (rememberError) this.showToast(`Baza została utworzona i zapisana, ale nie udało się zapamiętać jej uchwytu: ${rememberError.message || rememberError}`, 'error');
          else if (this.persistent) this.showToast('Utworzono bazę SQLite i zapisano ją na dysku.');
          else this.showToast('Baza działa w pamięci. Pobierz kopię SQLite, aby ją zachować.', 'info');
        } catch (error) {
          if (error.name !== 'AbortError') this.showToast(`Nie udało się utworzyć bazy: ${error.message || error}`, 'error');
        }
      } else {
        try {
          const db = this.newDatabase();
          this.db = window.Alpine?.raw ? window.Alpine.raw(db) : db; this.fileHandle = null; this.fileName = '';
          this.persistent = false; this.saveFailed = false;
          this.navigate('dashboard'); this.refreshAll();
          this.showToast('Baza utworzona w pamięci. Pobierz kopię SQLite, aby zachować ją na dysku.', 'info');
        } catch (error) {
          this.showToast(`Nie udało się utworzyć schematu SQLite: ${error.message || error}`, 'error');
        }
      }
    },
    newDatabase() {
      const db = new this.SQL.Database();
      try {
        db.run('PRAGMA foreign_keys = ON');
        db.run('BEGIN TRANSACTION');
        db.run(DB_SCHEMA);
        db.run('COMMIT');
        return db;
      } catch (error) {
        try { db.run('ROLLBACK'); } catch (rollbackError) { console.error('Nie udało się wycofać tworzenia schematu:', rollbackError); }
        db.close();
        throw error;
      }
    },
    async openSelectedFile(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (!this.canReplaceDatabase()) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const candidate = new this.SQL.Database(bytes);
        this.validateDatabase(candidate);
        this.replaceDatabase(candidate, file.name, null);
        this.showToast('Otworzono bazę SQLite. Wybierz bezpośredni plik, aby włączyć zapis automatyczny.', 'info');
      } catch (error) { this.showToast(`Nie można otworzyć tego pliku jako obsługiwanej bazy: ${error.message || error}`, 'error'); }
    },
    async openHandle(handle) {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      let granted = permission;
      if (permission !== 'granted') granted = await handle.requestPermission({ mode: 'readwrite' });
      if (granted !== 'granted') throw new Error('Odmówiono dostępu do zapisu. Wybierz plik ponownie i udziel uprawnień.');
      const file = await handle.getFile();
      const candidate = new this.SQL.Database(new Uint8Array(await file.arrayBuffer()));
      this.validateDatabase(candidate);
      this.replaceDatabase(candidate, handle.name, handle);
      try {
        await this.rememberHandle(handle);
        this.showToast('Baza SQLite otwarta. Zmiany są zapisywane automatycznie.');
      } catch (error) {
        this.showToast(`Baza otwarta, ale nie udało się zapamiętać uchwytu: ${error.message || error}`, 'error');
      }
    },
    validateDatabase(candidate) {
      const version = candidate.exec('PRAGMA user_version')[0]?.values?.[0]?.[0] ?? 0;
      const tables = candidate.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0]?.values?.flat() || [];
      if (version !== 1 || !['categories', 'cards', 'user_card_progress', 'review_logs'].every(name => tables.includes(name))) {
        candidate.close();
        throw new Error('Plik nie zawiera obsługiwanej bazy Fiszki — Hiszpański (schemat w wersji 1). Nie zmieniono pliku.');
      }
      const requiredColumns = {
        categories: ['id', 'name'],
        cards: ['id', 'category_id', 'rank', 'spanish_word', 'polish_translation', 'ipa_word', 'spanish_sentence', 'ipa_sentence', 'polish_sentence', 'part_of_speech', 'gender', 'image_url'],
        user_card_progress: ['card_id', 'ease_factor', 'interval', 'repetitions', 'next_review_at', 'last_reviewed_at'],
        review_logs: ['id', 'card_id', 'quality', 'reviewed_at', 'created_at']
      };
      for (const [table, columns] of Object.entries(requiredColumns)) {
        const actual = candidate.exec(`PRAGMA table_info(${table})`)[0]?.values?.map(row => row[1]) || [];
        if (!columns.every(column => actual.includes(column))) {
          candidate.close();
          throw new Error(`Baza ma niezgodną strukturę tabeli „${table}”. Nie zmieniono pliku.`);
        }
      }
      candidate.run('PRAGMA foreign_keys = ON');
    },
    canReplaceDatabase() {
      if (!this.db || (this.persistent && !this.saveFailed)) return true;
      if (this.saveFailed) return confirm('Ostatni zapis nie powiódł się. Pobierz kopię SQLite lub spróbuj zapisać ponownie przed zamknięciem bazy. Czy mimo to zamknąć ją i kontynuować?');
      return confirm('Baza ma niezapisane zmiany w pamięci przeglądarki. Najpierw pobierz kopię SQLite. Czy mimo to zamknąć tę bazę i kontynuować?');
    },
    replaceDatabase(candidate, name, handle) {
      if (this.db) this.db.close();
      this.db = window.Alpine?.raw ? window.Alpine.raw(candidate) : candidate;
      this.fileName = name || 'Baza lokalna';
      this.fileHandle = handle && window.Alpine?.raw ? window.Alpine.raw(handle) : handle;
      this.persistent = !!handle; this.saveFailed = false; this.studyActive = false; this.studyQueue = [];
      this.navigate('dashboard'); this.refreshAll();
    },
    async writeActiveFile() {
      if (!this.fileHandle) throw new Error('Brak aktywnego uchwytu pliku.');
      const permission = await this.fileHandle.queryPermission({ mode: 'readwrite' });
      const granted = permission === 'granted' ? permission : await this.fileHandle.requestPermission({ mode: 'readwrite' });
      if (granted !== 'granted') throw new Error('Odmówiono dostępu do zapisu pliku.');
      const writable = await this.fileHandle.createWritable();
      try { await writable.write(this.exportDatabase()); await writable.close(); this.saveFailed = false; }
      catch (error) { try { await writable.abort(); } catch (abortError) { console.error('Nie udało się anulować zapisu pliku:', abortError); } throw error; }
    },
    async mutate(label, action) {
      if (!this.db) { this.showToast('Najpierw otwórz bazę SQLite.', 'error'); return false; }
      const before = this.exportDatabase();
      try {
        this.db.run('BEGIN TRANSACTION');
        action();
        this.db.run('COMMIT');
        if (this.fileHandle) await this.writeActiveFile();
        this.refreshAll();
        if (!this.fileHandle) this.showToast(`${label} — zmiana tylko w pamięci; pobierz kopię SQLite, aby ją zachować.`, 'info');
        else this.showToast(`${label}. Zapisano w pliku SQLite.`);
        return true;
      } catch (error) {
        try { this.db.close(); } catch (closeError) { console.error('Nie udało się zamknąć bazy po błędzie:', closeError); }
        const restored = new this.SQL.Database(before);
        this.db = window.Alpine?.raw ? window.Alpine.raw(restored) : restored;
        this.db.run('PRAGMA foreign_keys = ON');
        if (this.fileHandle) this.saveFailed = true;
        this.refreshAll();
        this.showToast(`Nie udało się wykonać operacji „${label}”: ${error.message || error}. Przywrócono poprzedni stan w pamięci.`, 'error');
        return false;
      }
    },
    async rememberHandle(handle) {
      if (!('indexedDB' in window)) throw new Error('IndexedDB jest niedostępne.');
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('fiszki-file-handles', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('handles');
        request.onerror = () => reject(request.error || new Error('Nie udało się otworzyć IndexedDB.'));
        request.onsuccess = () => {
          const tx = request.result.transaction('handles', 'readwrite');
          tx.objectStore('handles').put(handle, 'last');
          tx.oncomplete = () => { request.result.close(); resolve(); };
          tx.onerror = () => { request.result.close(); reject(tx.error || new Error('Nie udało się zapamiętać uchwytu pliku.')); };
        };
      });
      this.savedHandle = true;
    },
    async getSavedHandle() {
      if (!('indexedDB' in window)) return null;
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('fiszki-file-handles', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('handles');
        request.onerror = () => reject(request.error || new Error('Nie udało się odczytać zapamiętanego pliku.'));
        request.onsuccess = () => {
          const tx = request.result.transaction('handles', 'readonly');
          const get = tx.objectStore('handles').get('last');
          get.onsuccess = () => { const handle = get.result || null; request.result.close(); resolve(handle); };
          get.onerror = () => { request.result.close(); reject(get.error || new Error('Nie udało się odczytać uchwytu pliku.')); };
        };
      });
    },
    async hasSavedHandle() {
      try { return !!(await this.getSavedHandle()); }
      catch (error) { this.initMessage = `Nie można odczytać zapamiętanego dostępu: ${error.message || error}`; return false; }
    },
    async resumeDatabase() {
      try {
        const handle = await this.getSavedHandle();
        if (!handle) { this.savedHandle = false; this.showToast('Nie znaleziono zapamiętanego pliku. Wybierz bazę ponownie.', 'info'); return; }
        await this.openHandle(handle);
      } catch (error) { this.showToast(`Nie można wznowić dostępu do bazy: ${error.message || error}. Wybierz plik ponownie.`, 'error'); }
    },
    async downloadDatabase() {
      try {
        const bytes = this.exportDatabase();
        this.downloadBlob(new Blob([bytes], { type: 'application/vnd.sqlite3' }), 'fiszki-hiszpanski.sqlite');
        this.showToast('Pobrano snapshot SQLite. Aktywny plik nie został zmieniony.');
      } catch (error) { this.showToast(`Nie udało się przygotować kopii SQLite: ${error.message || error}`, 'error'); }
    },
    downloadBlob(blob, name) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = name; link.style.display = 'none';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    },

    loadCategories() {
      this.categories = this.rows('SELECT c.id,c.name,COUNT(cards.id) AS card_count FROM categories c LEFT JOIN cards ON cards.category_id=c.id GROUP BY c.id ORDER BY c.name COLLATE NOCASE,c.id');
    },
    loadCards() {
      if (!this.db) return;
      const allowed = ['rank', 'spanish_word', 'part_of_speech', 'gender', 'category_name'];
      const sort = allowed.includes(this.sortBy) ? this.sortBy : 'rank';
      const where = [], params = [];
      if (this.search.trim()) { where.push('(c.spanish_word LIKE ? COLLATE NOCASE OR c.polish_translation LIKE ? COLLATE NOCASE)'); const q = `%${this.search.trim()}%`; params.push(q, q); }
      if (this.categoryFilter === 'none') where.push('c.category_id IS NULL');
      else if (this.categoryFilter !== 'all') { where.push('c.category_id = ?'); params.push(Number(this.categoryFilter)); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      this.cardsTotal = Number(this.scalar(`SELECT COUNT(*) AS n FROM cards c LEFT JOIN categories cat ON cat.id=c.category_id ${clause}`, params).n);
      const order = sort === 'rank' ? 'c.rank IS NULL,c.rank,c.id' : `${sort === 'category_name' ? 'cat.name' : `c.${sort}`} IS NULL,${sort === 'category_name' ? 'cat.name COLLATE NOCASE' : `c.${sort} COLLATE NOCASE`},c.id`;
      this.cards = this.rows(`SELECT c.*,cat.name AS category_name FROM cards c LEFT JOIN categories cat ON cat.id=c.category_id ${clause} ORDER BY ${order} LIMIT 50 OFFSET ?`, [...params, (this.pageNo - 1) * 50]);
    },
    loadStats() {
      const now = this.currentTime;
      const row = this.scalar(`SELECT (SELECT COUNT(*) FROM cards) AS total,
        (SELECT COUNT(*) FROM user_card_progress WHERE repetitions>0) AS known,
        (SELECT COUNT(*) FROM review_logs) AS reviews,
        (SELECT COUNT(*) FROM user_card_progress WHERE next_review_at>?) AS future`, [now]);
      this.stats = { total: Number(row.total), known: Number(row.known), reviews: Number(row.reviews), future: Number(row.future) };
    },
    loadRecent() {
      this.recent = this.rows(`SELECT l.id,l.quality,l.reviewed_at,c.spanish_word,c.polish_translation FROM review_logs l JOIN cards c ON c.id=l.card_id ORDER BY l.reviewed_at DESC,l.id DESC LIMIT 12`);
    },
    loadChart() {
      const days = [];
      const today = new Date();
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
        const key = d.toISOString().slice(0, 10);
        days.push({ key, label: new Intl.DateTimeFormat('pl-PL', { weekday: 'short', timeZone: 'UTC' }).format(d).replace('.', ''), count: 0 });
      }
      const counts = this.rows('SELECT substr(reviewed_at,1,10) AS day,COUNT(*) AS n FROM review_logs WHERE substr(reviewed_at,1,10)>=? GROUP BY day', [days[0].key]);
      for (const row of counts) { const target = days.find(d => d.key === row.day); if (target) target.count = Number(row.n); }
      this.chartDays = days;
      this.maxChart = Math.max(1, ...days.map(d => d.count));
    },
    buildQueue() {
      if (!this.db) return [];
      return this.rows(`SELECT c.*,cat.name AS category_name,1 AS is_due,p.next_review_at AS due_at
        FROM cards c JOIN user_card_progress p ON p.card_id=c.id
        LEFT JOIN categories cat ON cat.id=c.category_id WHERE p.next_review_at<=?
        UNION ALL
        SELECT c.*,cat.name AS category_name,0 AS is_due,NULL AS due_at
        FROM cards c LEFT JOIN categories cat ON cat.id=c.category_id
        WHERE NOT EXISTS(SELECT 1 FROM user_card_progress p WHERE p.card_id=c.id)
        ORDER BY is_due DESC,due_at,c.rank,c.id`, [this.currentTime]);
    },
    startStudy() {
      this.navigate('study');
      this.studyQueue = this.buildQueue();
      this.studyActive = true; this.answerShown = false; this.sessionCompleted = 0; this.sessionTotal = this.studyQueue.length;
      this.studyCard = this.studyQueue[0] || null;
    },
    endStudy() { this.studyActive = false; this.studyCard = null; this.studyQueue = []; this.answerShown = false; },
    async rateCard(quality) {
      if (!this.studyCard || ![1, 3, 4, 5].includes(quality)) return;
      const card = this.studyCard;
      const now = new Date();
      const reviewedAt = now.toISOString();
      const old = this.scalar('SELECT * FROM user_card_progress WHERE card_id=?', [card.id]);
      const previousEF = old ? Number(old.ease_factor) : 2.5;
      const previousInterval = old ? Number(old.interval) : 0;
      const previousRepetitions = old ? Number(old.repetitions) : 0;
      let repetitions, interval, ease;
      if (quality === 1) { repetitions = 0; interval = 1; ease = Math.max(1.3, previousEF - 0.2); }
      else {
        repetitions = previousRepetitions + 1;
        interval = previousRepetitions === 0 ? 1 : previousRepetitions === 1 ? 6 : Math.round(previousInterval * previousEF);
        const delta = 5 - quality;
        ease = Math.max(1.3, previousEF + 0.1 - delta * (0.08 + delta * 0.02));
      }
      const next = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000).toISOString();
      const ok = await this.mutate('Zapisano ocenę', () => {
        this.run(`INSERT INTO user_card_progress(card_id,ease_factor,interval,repetitions,next_review_at,last_reviewed_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET ease_factor=excluded.ease_factor,interval=excluded.interval,
          repetitions=excluded.repetitions,next_review_at=excluded.next_review_at,last_reviewed_at=excluded.last_reviewed_at`,
          [card.id, ease, interval, repetitions, next, reviewedAt]);
        this.run('INSERT INTO review_logs(card_id,quality,reviewed_at,created_at) VALUES(?,?,?,?)', [card.id, quality, reviewedAt, reviewedAt]);
      });
      if (!ok) return;
      this.studyQueue = this.studyQueue.filter(item => item.id !== card.id);
      this.studyCard = this.studyQueue[0] || null; this.answerShown = false; this.sessionCompleted++;
      if (!this.studyCard) this.studyActive = false;
    },
    speak(text) {
      if (!this.speechAvailable || !text) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'es-ES';
      window.speechSynthesis.speak(utterance);
    },
    qualityLabel(q) { return ({ 1: 'Nie znam', 3: 'Trudne', 4: 'Znam', 5: 'Łatwe' })[q] || '—'; },
    qualityClass(q) { return ({ 1: 'quality-bad', 3: 'quality-hard', 4: 'quality-good', 5: 'quality-easy' })[q] || ''; },
    formatDate(value) { return new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); },

    blankCard() { return { rank: '', spanish_word: '', ipa_word: '', polish_translation: '', spanish_sentence: '', ipa_sentence: '', polish_sentence: '', part_of_speech: '', gender: '', category_id: '', image_url: '' }; },
    viewCard(card) { this.previewCard = card; },
    openCardForm(card = null) {
      this.editingCard = card;
      this.cardForm = card ? { ...this.blankCard(), ...card, category_id: card.category_id == null ? '' : String(card.category_id), rank: String(card.rank) } : this.blankCard();
      this.formErrors = {}; this.cardDialog = true;
    },
    validateCardForm() {
      const form = this.cardForm, errors = {};
      if (!form.spanish_word.trim()) errors.spanish_word = 'Podaj hiszpańskie słowo lub zwrot.';
      if (!form.polish_translation.trim()) errors.polish_translation = 'Podaj polskie tłumaczenie.';
      for (const [key, max] of Object.entries({ ipa_word: 255, polish_translation: 1000, spanish_sentence: 2000, ipa_sentence: 1000, polish_sentence: 2000, part_of_speech: 100 })) if ((form[key] || '').length > max) errors[key] = `Maksymalnie ${max} znaków.`;
      if (form.rank !== '' && (!Number.isSafeInteger(Number(form.rank)) || Number(form.rank) < 1)) errors.rank = 'Pozycja musi być dodatnią liczbą całkowitą.';
      if (form.image_url && !/^https?:\/\//i.test(form.image_url)) errors.image_url = 'Podaj adres rozpoczynający się od http:// lub https://.';
      this.formErrors = errors;
      return Object.keys(errors).length === 0;
    },
    async saveCard() {
      if (!this.validateCardForm()) return;
      const f = this.cardForm;
      const rank = f.rank === '' ? (this.editingCard ? Number(this.editingCard.rank) : Number(this.scalar('SELECT COALESCE(MAX(rank),0)+1 AS n FROM cards').n)) : Number(f.rank);
      const values = [
        f.category_id ? Number(f.category_id) : null, rank, f.spanish_word.trim(), f.polish_translation.trim(),
        f.ipa_word.trim() || null, f.spanish_sentence.trim() || null, f.ipa_sentence.trim() || null,
        f.polish_sentence.trim() || null, f.part_of_speech.trim() || null, f.gender || null, f.image_url.trim() || null
      ];
      const ok = await this.mutate(this.editingCard ? 'Zaktualizowano fiszkę' : 'Dodano fiszkę', () => {
        if (this.editingCard) this.run(`UPDATE cards SET category_id=?,rank=?,spanish_word=?,polish_translation=?,ipa_word=?,spanish_sentence=?,ipa_sentence=?,polish_sentence=?,part_of_speech=?,gender=?,image_url=? WHERE id=?`, [...values, this.editingCard.id]);
        else this.run(`INSERT INTO cards(category_id,rank,spanish_word,polish_translation,ipa_word,spanish_sentence,ipa_sentence,polish_sentence,part_of_speech,gender,image_url) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, values);
      });
      if (ok) { this.cardDialog = false; this.pageNo = 1; this.loadCards(); }
    },
    async deleteCard(card) {
      if (!confirm(`Usunąć fiszkę „${card.spanish_word}”? Jej postępy i historia odpowiedzi również zostaną usunięte.`)) return;
      await this.mutate('Usunięto fiszkę', () => this.run('DELETE FROM cards WHERE id=?', [card.id]));
      this.loadCards();
    },

    openCategoryForm(category = null) {
      this.editingCategory = category; this.categoryName = category?.name || ''; this.categoryError = ''; this.categoryDialog = true;
      this.$nextTick(() => this.$refs.categoryNameInput?.focus());
    },
    async saveCategory() {
      const name = this.categoryName.trim();
      if (!name || name.length > 100) { this.categoryError = 'Nazwa musi zawierać od 1 do 100 znaków.'; return; }
      const duplicate = this.rows('SELECT id,name FROM categories').find(row =>
        row.id !== (this.editingCategory?.id || -1) && row.name.toLocaleLowerCase('pl') === name.toLocaleLowerCase('pl'));
      if (duplicate) { this.categoryError = 'Kategoria o takiej nazwie już istnieje.'; return; }
      const ok = await this.mutate(this.editingCategory ? 'Zmieniono nazwę kategorii' : 'Dodano kategorię', () => {
        if (this.editingCategory) this.run('UPDATE categories SET name=? WHERE id=?', [name, this.editingCategory.id]);
        else this.run('INSERT INTO categories(name) VALUES(?)', [name]);
      });
      if (ok) this.categoryDialog = false;
    },
    async deleteCategory(category) {
      if (!confirm(`Usunąć kategorię „${category.name}”? Fiszki zostaną zachowane bez kategorii.`)) return;
      await this.mutate('Usunięto kategorię', () => this.run('DELETE FROM categories WHERE id=?', [category.id]));
    },
    categorySymbol(name) { return ['✳', '⌁', '☼', '◇', '✦'][[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5]; },
    safeCssUrl(url) { return /^https?:\/\//i.test(url || '') ? url.replace(/["'()\\\n\r]/g, '') : ''; },

    parseCsv(text) {
      const rows = []; let row = [], field = '', quoted = false, line = 1, rowLine = 1;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
          if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
          else if (ch === '"') quoted = false;
          else { field += ch; if (ch === '\n') line++; }
        } else if (ch === '"' && field === '') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          row.push(field); field = '';
          if (row.some(value => value !== '')) rows.push({ values: row, line: rowLine });
          row = []; line++; rowLine = line;
        } else field += ch;
      }
      if (quoted) throw new Error(`Nieprawidłowy CSV: niedomknięty cudzysłów w wierszu ${rowLine}.`);
      row.push(field);
      if (row.some(value => value !== '')) rows.push({ values: row, line: rowLine });
      return rows;
    },
    async prepareImport(event) {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      if (!this.db) { this.showToast('Najpierw otwórz bazę SQLite, aby zaimportować fiszki.', 'error'); return; }
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error('Plik przekracza limit 5 MB.');
        const text = (await file.text()).replace(/^\uFEFF/, '');
        const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
        let parsed;
        if (isCsv) parsed = this.importCsv(text);
        else parsed = this.importJson(text);
        this.classifyImportDuplicates(parsed);
        this.importSourceName = file.name;
        this.importPreview = parsed;
        const duplicateCount = parsed.skipped.filter(x => x.reason === 'Duplikat').length;
        this.importSummary = `${file.name}: ${parsed.items.length - duplicateCount} fiszek do dodania, ${duplicateCount} duplikatów do pominięcia${parsed.skipped.length > duplicateCount ? `, ${parsed.skipped.length - duplicateCount} błędnych wierszy` : ''}.${parsed.fullArchive ? ' Postępy i historia z kopii zostaną dodane tylko do nowych fiszek; istniejące dane nauki nie będą nadpisane.' : ''}`;
      } catch (error) { this.showToast(`Nie można przygotować importu: ${error.message || error}`, 'error'); }
    },
    openImportPicker() {
      if (!this.db) { this.showToast('Najpierw otwórz bazę SQLite, aby zaimportować fiszki.', 'error'); return; }
      if (!this.$refs.importInput) { this.showToast('Nie można otworzyć wyboru pliku importu.', 'error'); return; }
      this.$refs.importInput.click();
    },
    importCsv(text) {
      const rows = this.parseCsv(text);
      if (!rows.length) throw new Error('Plik CSV jest pusty.');
      if (rows.length - 1 > 2000) throw new Error('CSV przekracza limit 2000 wierszy.');
      const headers = rows[0].values.map(x => x.trim());
      const required = ['Word', 'Meaning'];
      for (const name of required) if (!headers.includes(name)) throw new Error(`Brak wymaganej kolumny „${name}”.`);
      const mapping = { Rank: 'rank', Word: 'spanish_word', IPA: 'ipa_word', 'Part of speech': 'part_of_speech', Gender: 'gender', Meaning: 'polish_translation', Example: 'spanish_sentence', 'Example translation': 'polish_sentence', 'IPA sentence': 'ipa_sentence', Category: 'category', 'Image URL': 'image_url' };
      const items = [], skipped = [];
      for (const entry of rows.slice(1)) {
        if (entry.values.length > headers.length) { skipped.push({ line: entry.line, reason: 'Więcej pól niż nagłówków' }); continue; }
        const item = { source_line: entry.line };
        headers.forEach((header, i) => { if (mapping[header]) item[mapping[header]] = (entry.values[i] || '').trim(); });
        const issue = this.validateImportItem(item);
        if (issue) skipped.push({ line: entry.line, word: item.spanish_word || '', reason: issue });
        else items.push(item);
      }
      if (items.length + skipped.length > 2000) throw new Error('CSV przekracza limit 2000 rekordów.');
      return { items, skipped, categories: [], progress: [], review_logs: [] };
    },
    classifyImportDuplicates(preview) {
      const categoryNames = new Map(preview.categories.map(cat => [String(cat.id), cat.name]));
      const known = new Map();
      for (const row of this.rows('SELECT c.spanish_word,c.part_of_speech,c.gender,c.rank,cat.name AS category_name FROM cards c LEFT JOIN categories cat ON cat.id=c.category_id')) {
        known.set(this.duplicateKey(row, row.category_name), row.rank);
      }
      const pending = new Map();
      for (const item of preview.items) {
        const category = item.category || item.category_name || categoryNames.get(String(item.category_id)) || '';
        const key = this.duplicateKey(item, category);
        if (known.has(key)) preview.skipped.push({ line: item.source_line, word: item.spanish_word, existingRank: known.get(key), reason: 'Duplikat' });
        else {
          if (pending.has(key)) preview.skipped.push({ line: item.source_line, word: item.spanish_word, existingRank: pending.get(key), reason: 'Duplikat' });
          else pending.set(key, item.rank || 'nowa pozycja');
        }
      }
    },
    importJson(text) {
      let data;
      try { data = JSON.parse(text); } catch (error) { throw new Error(`JSON nie jest poprawny: ${error.message}`); }
      let list, categories = [], progress = [], review_logs = [];
      if (Array.isArray(data)) list = data;
      else if (data && data.format === 'fiszki-hiszpanski' && data.version === 1 && Array.isArray(data.cards)) {
        if (!Array.isArray(data.categories) || (data.progress != null && !Array.isArray(data.progress)) ||
            (data.review_logs != null && !Array.isArray(data.review_logs))) {
          throw new Error('Pełny eksport ma nieprawidłowe sekcje kategorii, postępów lub historii.');
        }
        list = data.cards; categories = data.categories;
        progress = data.progress || [];
        review_logs = data.review_logs || [];
      } else throw new Error('Oczekiwano listy fiszek lub pełnego eksportu fiszki-hiszpanski w wersji 1.');
      if (list.length > 5000) throw new Error('JSON przekracza limit 5000 fiszek.');
      if (categories.some(cat => !cat || typeof cat.name !== 'string' || !cat.name.trim() || cat.name.trim().length > 100)) {
        throw new Error('Eksport zawiera nieprawidłową nazwę kategorii.');
      }
      const catById = new Map(categories.map(cat => [String(cat.id), cat.name]));
      const cardsById = new Map(list.filter(card => card && card.id != null).map(card => [String(card.id), card]));
      progress = progress.map((record, index) => {
        const card = record && (record.spanish_word ? record : cardsById.get(String(record.card_id)));
        if (!record || !card?.spanish_word || !Number.isFinite(Number(record.ease_factor)) || Number(record.ease_factor) < 1.3 ||
            !Number.isSafeInteger(Number(record.interval)) || Number(record.interval) < 0 ||
            !Number.isSafeInteger(Number(record.repetitions)) || Number(record.repetitions) < 0) {
          throw new Error(`Nieprawidłowy postęp nauki w rekordzie ${index + 1}. Import odrzucono.`);
        }
        const nextReview = this.normalizeImportTimestamp(record.next_review_at);
        const lastReviewed = record.last_reviewed_at ? this.normalizeImportTimestamp(record.last_reviewed_at) : null;
        if (!nextReview || (record.last_reviewed_at && !lastReviewed)) throw new Error(`Nieprawidłowy termin powtórki w rekordzie ${index + 1}. Import odrzucono.`);
        return { ...record, spanish_word: record.spanish_word || card.spanish_word, part_of_speech: record.part_of_speech ?? card.part_of_speech, gender: record.gender ?? card.gender, category: record.category ?? card.category ?? catById.get(String(card.category_id)) ?? '', next_review_at: nextReview, last_reviewed_at: lastReviewed };
      });
      review_logs = review_logs.map((record, index) => {
        const card = record && (record.spanish_word ? record : cardsById.get(String(record.card_id)));
        const reviewedAt = record && this.normalizeImportTimestamp(record.reviewed_at);
        const createdAt = record?.created_at ? this.normalizeImportTimestamp(record.created_at) : reviewedAt;
        if (!record || !card?.spanish_word || ![1, 3, 4, 5].includes(Number(record.quality)) || !reviewedAt || !createdAt) {
          throw new Error(`Nieprawidłowa historia odpowiedzi w rekordzie ${index + 1}. Import odrzucono.`);
        }
        return { ...record, spanish_word: record.spanish_word || card.spanish_word, part_of_speech: record.part_of_speech ?? card.part_of_speech, gender: record.gender ?? card.gender, category: record.category ?? card.category ?? catById.get(String(card.category_id)) ?? '', reviewed_at: reviewedAt, created_at: createdAt };
      });
      const items = [], skipped = [];
      list.forEach((record, index) => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) { skipped.push({ line: index + 1, reason: 'Rekord nie jest obiektem' }); return; }
        const item = { ...record, source_line: index + 1 };
        if (!item.category && item.category_name) item.category = item.category_name;
        if (!item.category && item.category_id != null) item.category = catById.get(String(item.category_id)) || '';
        for (const key of ['spanish_word', 'polish_translation', 'ipa_word', 'spanish_sentence', 'ipa_sentence', 'polish_sentence', 'part_of_speech', 'gender', 'image_url', 'category']) if (item[key] != null) item[key] = String(item[key]);
        if (item.rank != null && item.rank !== '') item.rank = String(item.rank);
        const issue = this.validateImportItem(item);
        if (issue) skipped.push({ line: index + 1, word: item.spanish_word || '', reason: issue });
        else items.push(item);
      });
      return { items, skipped, categories, progress, review_logs, fullArchive: !Array.isArray(data) };
    },
    normalizeImportTimestamp(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    },
    validateImportItem(item) {
      if (!item.spanish_word?.trim()) return 'Brak hiszpańskiego słowa';
      if (!item.polish_translation?.trim()) return 'Brak polskiego tłumaczenia';
      const limits = { polish_translation: 1000, ipa_word: 255, spanish_sentence: 2000, ipa_sentence: 1000, polish_sentence: 2000, part_of_speech: 100, category: 100 };
      for (const [key, limit] of Object.entries(limits)) if ((item[key] || '').length > limit) return `Pole ${key} przekracza limit ${limit} znaków`;
      if (item.rank != null && item.rank !== '' && (!Number.isSafeInteger(Number(item.rank)) || Number(item.rank) < 1)) return 'Pozycja nie jest dodatnią liczbą całkowitą';
      if (item.gender && !['męski', 'żeński'].includes(item.gender)) return 'Nieobsługiwany rodzaj';
      if (item.image_url && !/^https?:\/\//i.test(item.image_url)) return 'Adres obrazka musi zaczynać się od http:// lub https://';
      return null;
    },
    duplicateKey(item, category) {
      return [item.spanish_word.trim().toLocaleLowerCase('es'), (item.part_of_speech || '').trim().toLocaleLowerCase('pl'), item.gender || '', (category || '').trim().toLocaleLowerCase('pl')].join('\u001f');
    },
    async commitImport() {
      const preview = this.importPreview;
      if (!preview) return;
      const ok = await this.mutate('Zakończono import', () => {
        const categoryMap = new Map(this.rows('SELECT id,name FROM categories').map(c => [c.name.toLocaleLowerCase('pl'), c.id]));
        for (const category of preview.categories) {
          const name = String(category.name || '').trim();
          if (name && name.length <= 100 && !categoryMap.has(name.toLocaleLowerCase('pl'))) {
            this.run('INSERT INTO categories(name) VALUES(?)', [name]);
            categoryMap.set(name.toLocaleLowerCase('pl'), Number(this.scalar('SELECT last_insert_rowid() AS id').id));
          }
        }
        const known = new Map();
        const existing = this.rows('SELECT c.spanish_word,c.part_of_speech,c.gender,cat.name AS category_name,c.rank FROM cards c LEFT JOIN categories cat ON cat.id=c.category_id');
        for (const row of existing) known.set(this.duplicateKey(row, row.category_name), row.rank);
        const inserted = new Map();
        let maxRank = Number(this.scalar('SELECT COALESCE(MAX(rank),0) AS n FROM cards').n);
        for (const item of preview.items) {
          const category = (item.category || '').trim();
          const key = this.duplicateKey(item, category);
          if (known.has(key)) {
            if (!preview.skipped.some(row => row.line === item.source_line && row.reason === 'Duplikat')) {
              preview.skipped.push({ line: item.source_line, word: item.spanish_word, existingRank: known.get(key), reason: 'Duplikat' });
            }
            continue;
          }
          let categoryId = null;
          if (category) {
            const normalized = category.toLocaleLowerCase('pl');
            if (!categoryMap.has(normalized)) {
              this.run('INSERT INTO categories(name) VALUES(?)', [category]);
              categoryMap.set(normalized, Number(this.scalar('SELECT last_insert_rowid() AS id').id));
            }
            categoryId = categoryMap.get(normalized);
          }
          const rank = item.rank ? Number(item.rank) : ++maxRank;
          maxRank = Math.max(maxRank, rank);
          this.run(`INSERT INTO cards(category_id,rank,spanish_word,polish_translation,ipa_word,spanish_sentence,ipa_sentence,polish_sentence,part_of_speech,gender,image_url)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [categoryId, rank, item.spanish_word.trim(), item.polish_translation.trim(), item.ipa_word || null, item.spanish_sentence || null, item.ipa_sentence || null, item.polish_sentence || null, item.part_of_speech || null, item.gender || null, item.image_url || null]);
          const id = Number(this.scalar('SELECT last_insert_rowid() AS id').id);
          known.set(key, rank); inserted.set(key, id);
        }
        const resolveCard = record => {
          const category = record.category || record.category_name || '';
          const key = this.duplicateKey(record, category);
          return inserted.get(key) || null;
        };
        for (const record of preview.progress) {
          const cardId = resolveCard(record);
          if (!cardId) continue;
          const p = record;
          if (![Number(p.ease_factor), Number(p.interval), Number(p.repetitions)].every(Number.isFinite) || Number(p.interval) < 0 || Number(p.repetitions) < 0 || !p.next_review_at) continue;
          this.run(`INSERT INTO user_card_progress(card_id,ease_factor,interval,repetitions,next_review_at,last_reviewed_at)
            VALUES(?,?,?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET ease_factor=excluded.ease_factor,interval=excluded.interval,
            repetitions=excluded.repetitions,next_review_at=excluded.next_review_at,last_reviewed_at=excluded.last_reviewed_at`,
            [cardId, Number(p.ease_factor), Number(p.interval), Number(p.repetitions), p.next_review_at, p.last_reviewed_at || null]);
        }
        for (const record of preview.review_logs) {
          const cardId = resolveCard(record), q = Number(record.quality);
          if (!cardId || ![1, 3, 4, 5].includes(q) || !record.reviewed_at) continue;
          this.run('INSERT INTO review_logs(card_id,quality,reviewed_at,created_at) VALUES(?,?,?,?)', [cardId, q, record.reviewed_at, record.created_at || record.reviewed_at]);
        }
      });
      if (ok) {
        const duplicateCount = preview.skipped.filter(row => row.reason === 'Duplikat').length;
        const summary = [`Dodano ${preview.items.length - duplicateCount} ${this.plural(preview.items.length - duplicateCount, 'fiszkę', 'fiszki', 'fiszek')}.`, ...preview.skipped.map(row => `Wiersz ${row.line}${row.word ? ` „${row.word}”` : ''}: ${row.reason}${row.existingRank ? ` (istniejący rank: ${row.existingRank})` : ''}.`)].join('\n');
        this.importPreview = null; this.showToast(summary, preview.skipped.length ? 'info' : 'success');
      }
    },
    exportJson(full) {
      try {
        const categories = this.rows('SELECT id,name FROM categories ORDER BY id');
        const cards = this.rows(`SELECT c.id,c.rank,c.spanish_word,c.polish_translation,c.ipa_word,c.spanish_sentence,c.ipa_sentence,c.polish_sentence,c.part_of_speech,c.gender,c.image_url,c.category_id,cat.name AS category
          FROM cards c LEFT JOIN categories cat ON cat.id=c.category_id ORDER BY c.rank,c.id`);
        const payload = { format: 'fiszki-hiszpanski', version: 1, exported_at: this.currentTime, categories, cards: cards.map(card => ({ ...card, category_name: card.category })) };
        if (full) {
          const cardIndex = new Map(cards.map(card => [card.id, card]));
          payload.progress = this.rows('SELECT * FROM user_card_progress').map(p => {
            const card = cardIndex.get(p.card_id);
            return { ...p, spanish_word: card?.spanish_word, part_of_speech: card?.part_of_speech, gender: card?.gender, category: card?.category };
          });
          payload.review_logs = this.rows('SELECT * FROM review_logs ORDER BY id').map(log => {
            const card = cardIndex.get(log.card_id);
            return { ...log, spanish_word: card?.spanish_word, part_of_speech: card?.part_of_speech, gender: card?.gender, category: card?.category };
          });
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        this.downloadBlob(blob, full ? 'fiszki-hiszpanski-pelna-kopia.json' : 'fiszki-hiszpanski.json');
        this.showToast(full ? 'Pobrano pełną kopię JSON.' : 'Wyeksportowano fiszki i kategorie do JSON.');
      } catch (error) { this.showToast(`Nie udało się wyeksportować JSON: ${error.message || error}`, 'error'); }
    },
    async resetDatabase() {
      if (this.resetPhrase !== 'restart bazy') { this.showToast('Wpisz dokładnie „restart bazy”.', 'error'); return; }
      const ok = await this.mutate('Zresetowano fiszki', () => this.run('DELETE FROM cards'));
      if (ok) { this.resetDialog = false; this.resetPhrase = ''; this.endStudy(); this.showToast('Usunięto fiszki, postępy i historię. Kategorie zachowano.', this.fileHandle ? 'success' : 'info'); }
    }
  };
}
