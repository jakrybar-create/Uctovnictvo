const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'accounting.db');
let sqlDb = null;
let inTransaction = false;

function save() {
  if (sqlDb) {
    const data = sqlDb.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }
}

const db = {
  prepare(sql) {
    return {
      get(...params) {
        const stmt = sqlDb.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        let result = null;
        if (stmt.step()) {
          result = stmt.getAsObject();
        }
        stmt.free();
        return result;
      },
      all(...params) {
        const results = [];
        const stmt = sqlDb.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
      run(...params) {
        sqlDb.run(sql, params);
        const res = sqlDb.exec("SELECT last_insert_rowid()");
        const lastInsertRowid = res.length > 0 ? res[0].values[0][0] : 0;
        const changes = sqlDb.getRowsModified();
        if (!inTransaction) save();
        return { lastInsertRowid, changes };
      }
    };
  },

  exec(sql) {
    sqlDb.exec(sql);
    if (!inTransaction) save();
  },

  transaction(fn) {
    return (...args) => {
      sqlDb.run('BEGIN');
      inTransaction = true;
      try {
        const result = fn(...args);
        sqlDb.run('COMMIT');
        inTransaction = false;
        save();
        return result;
      } catch (err) {
        sqlDb.run('ROLLBACK');
        inTransaction = false;
        throw err;
      }
    };
  }
};

async function initialize() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }

  sqlDb.run('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      account_md TEXT NOT NULL,
      account_d TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      category_id INTEGER,
      description TEXT,
      amount REAL,
      date TEXT,
      partner TEXT,
      document_number TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT,
      date TEXT NOT NULL,
      document_number TEXT,
      description TEXT,
      account_md TEXT NOT NULL,
      account_d TEXT NOT NULL,
      amount REAL NOT NULL,
      partner TEXT,
      category_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (document_id) REFERENCES documents(id),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS journal_pdfs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      year INTEGER,
      description TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const count = db.prepare('SELECT COUNT(*) as cnt FROM categories').get();
  if (count.cnt === 0) {
    const insert = db.prepare(
      'INSERT INTO categories (name, account_md, account_d, description) VALUES (?, ?, ?, ?)'
    );

    const categories = [
      ['Prijaté faktúry - materiál', '501', '321', 'Nákup materiálu od dodávateľov'],
      ['Prijaté faktúry - služby', '518', '321', 'Prijaté služby od dodávateľov'],
      ['Prijaté faktúry - energia', '502', '321', 'Elektrina, plyn, voda'],
      ['Prijaté faktúry - opravy', '511', '321', 'Opravy a údržba'],
      ['Prijaté faktúry - cestovné', '512', '321', 'Cestovné náhrady'],
      ['Prijaté faktúry - reprezentácia', '513', '321', 'Náklady na reprezentáciu'],
      ['Vydané faktúry - tovar', '311', '604', 'Tržby z predaja tovaru'],
      ['Vydané faktúry - služby', '311', '602', 'Tržby z predaja služieb'],
      ['Vydané faktúry - výrobky', '311', '601', 'Tržby z predaja výrobkov'],
      ['Pokladňa - príjem', '211', '311', 'Príjem do pokladne od odberateľov'],
      ['Pokladňa - výdaj', '501', '211', 'Výdaj z pokladne za materiál'],
      ['Pokladňa - výdaj služby', '518', '211', 'Výdaj z pokladne za služby'],
      ['Banka - príjem', '221', '311', 'Príjem na bankový účet'],
      ['Banka - výdaj dodávateľom', '321', '221', 'Úhrada dodávateľských faktúr z banky'],
      ['Banka - výdaj dane', '341', '221', 'Úhrada daní z bankového účtu'],
      ['Banka - výdaj poistné', '336', '221', 'Úhrada poistného z banky'],
      ['Mzdy - hrubé mzdy', '521', '331', 'Hrubé mzdy zamestnancov'],
      ['Mzdy - odvody zamestnávateľ', '524', '336', 'Odvody do poisťovní za zamestnávateľa'],
      ['Mzdy - výplata', '331', '221', 'Výplata miezd zamestnancom'],
      ['Odpisy - dlhodobý majetok', '551', '081', 'Odpisy dlhodobého hmotného majetku'],
      ['Odpisy - nehmotný majetok', '551', '071', 'Odpisy dlhodobého nehmotného majetku'],
      ['Daň z príjmov', '591', '341', 'Daň z príjmov právnických osôb'],
      ['DPH - na vstupe', '343', '321', 'DPH na vstupe z prijatých faktúr'],
      ['DPH - na výstupe', '311', '343', 'DPH na výstupe z vydaných faktúr'],
      ['Interný doklad', '5XX', '3XX', 'Ostatné interné účtovné doklady'],
    ];

    const insertMany = db.transaction((cats) => {
      for (const cat of cats) {
        insert.run(...cat);
      }
    });

    insertMany(categories);
  }
}

module.exports = { db, initialize };
