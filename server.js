const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const { db, initialize } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure upload directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const documentsDir = path.join(uploadsDir, 'documents');
const journalsDir = path.join(uploadsDir, 'journals');
for (const dir of [uploadsDir, documentsDir, journalsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Multer config for documents
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, documentsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});

const documentUpload = multer({
  storage: documentStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Nepodporovaný formát súboru. Povolené: PDF, JPG, PNG, GIF, WEBP'));
    }
  },
});

// Multer config for journal PDFs
const journalStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, journalsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'journal_' + Date.now() + ext);
  },
});

const journalUpload = multer({
  storage: journalStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') {
      cb(null, true);
    } else {
      cb(new Error('Účtovný denník je možné nahrať len vo formáte PDF.'));
    }
  },
});

// ============ API ROUTES ============

// Get all categories
app.get('/api/categories', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(categories);
});

// Add custom category
app.post('/api/categories', (req, res) => {
  const { name, account_md, account_d, description } = req.body;
  if (!name || !account_md || !account_d) {
    return res.status(400).json({ error: 'Názov, účet MD a účet D sú povinné.' });
  }
  try {
    const result = db.prepare(
      'INSERT INTO categories (name, account_md, account_d, description) VALUES (?, ?, ?, ?)'
    ).run(name, account_md, account_d, description || '');
    res.json({ id: result.lastInsertRowid, name, account_md, account_d, description });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Kategória s týmto názvom už existuje.' });
    }
    res.status(500).json({ error: 'Chyba pri ukladaní kategórie.' });
  }
});

// Delete category
app.delete('/api/categories/:id', (req, res) => {
  const used = db.prepare('SELECT COUNT(*) as cnt FROM documents WHERE category_id = ?').get(req.params.id);
  if (used.cnt > 0) {
    return res.status(400).json({ error: 'Kategóriu nie je možné vymazať, je priradená k dokladom.' });
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Upload document
app.post('/api/documents', documentUpload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Súbor nebol nahraný.' });
  }
  const id = path.parse(req.file.filename).name;
  db.prepare(
    'INSERT INTO documents (id, filename, original_name) VALUES (?, ?, ?)'
  ).run(id, req.file.filename, req.file.originalname);

  res.json({
    id,
    filename: req.file.filename,
    original_name: req.file.originalname,
  });
});

// Get all documents
app.get('/api/documents', (req, res) => {
  const documents = db.prepare(`
    SELECT d.*, c.name as category_name, c.account_md, c.account_d
    FROM documents d
    LEFT JOIN categories c ON d.category_id = c.id
    ORDER BY d.created_at DESC
  `).all();
  res.json(documents);
});

// Update document (assign category, add details)
app.put('/api/documents/:id', (req, res) => {
  const { category_id, description, amount, date, partner, document_number } = req.body;
  db.prepare(`
    UPDATE documents
    SET category_id = ?, description = ?, amount = ?, date = ?, partner = ?, document_number = ?
    WHERE id = ?
  `).run(category_id || null, description || '', amount || null, date || null, partner || '', document_number || '', req.params.id);

  // Auto-create journal entry if category and amount are provided
  if (category_id && amount) {
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(category_id);
    if (category) {
      // Remove existing auto-entries for this document
      db.prepare('DELETE FROM journal_entries WHERE document_id = ?').run(req.params.id);

      db.prepare(`
        INSERT INTO journal_entries (document_id, date, document_number, description, account_md, account_d, amount, partner, category_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        date || new Date().toISOString().split('T')[0],
        document_number || '',
        description || category.name,
        category.account_md,
        category.account_d,
        amount,
        partner || '',
        category_id
      );
    }
  }

  const doc = db.prepare(`
    SELECT d.*, c.name as category_name, c.account_md, c.account_d
    FROM documents d
    LEFT JOIN categories c ON d.category_id = c.id
    WHERE d.id = ?
  `).get(req.params.id);

  res.json(doc);
});

// Delete document
app.delete('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (doc) {
    const filepath = path.join(documentsDir, doc.filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    db.prepare('DELETE FROM journal_entries WHERE document_id = ?').run(req.params.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  }
  res.json({ success: true });
});

// ============ Journal entries ============

app.get('/api/journal', (req, res) => {
  const { year, month } = req.query;
  let query = `
    SELECT je.*, c.name as category_name
    FROM journal_entries je
    LEFT JOIN categories c ON je.category_id = c.id
  `;
  const params = [];

  if (year) {
    query += ' WHERE strftime(\'%Y\', je.date) = ?';
    params.push(year);
    if (month) {
      query += ' AND strftime(\'%m\', je.date) = ?';
      params.push(month.padStart(2, '0'));
    }
  }

  query += ' ORDER BY je.date ASC, je.id ASC';
  const entries = db.prepare(query).all(...params);
  res.json(entries);
});

// Manual journal entry
app.post('/api/journal', (req, res) => {
  const { date, document_number, description, account_md, account_d, amount, partner, category_id } = req.body;
  if (!date || !account_md || !account_d || !amount) {
    return res.status(400).json({ error: 'Dátum, účty MD/D a suma sú povinné.' });
  }
  const result = db.prepare(`
    INSERT INTO journal_entries (date, document_number, description, account_md, account_d, amount, partner, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, document_number || '', description || '', account_md, account_d, amount, partner || '', category_id || null);

  res.json({ id: result.lastInsertRowid });
});

// Delete journal entry
app.delete('/api/journal/:id', (req, res) => {
  db.prepare('DELETE FROM journal_entries WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============ Journal PDF uploads ============

// ============ PDF parsing helpers ============

function parseJournalPdf(text, year) {
  const entries = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Try to detect table rows with accounting journal data
  // Common patterns: date (DD.MM.YYYY), account numbers (3-digit), amounts
  const dateRegex = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
  const amountRegex = /(\d[\d\s]*[\d])[,.](\d{2})\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip header lines and separator lines
    if (!dateRegex.test(line)) continue;

    const dateMatch = line.match(dateRegex);
    if (!dateMatch) continue;

    const day = dateMatch[1].padStart(2, '0');
    const month = dateMatch[2].padStart(2, '0');
    const parsedYear = dateMatch[3];
    const date = `${parsedYear}-${month}-${day}`;

    // Validate it's a reasonable date
    const dateObj = new Date(date);
    if (isNaN(dateObj.getTime())) continue;

    // Extract all 3-digit account numbers from the line
    // Account numbers are typically 0xx-9xx (Slovak chart of accounts)
    const accountMatches = [];
    const accountRegex = /\b([0-9]{3})\b/g;
    let accMatch;
    // Get position after date to look for accounts
    const afterDate = line.substring(line.indexOf(dateMatch[0]) + dateMatch[0].length);
    while ((accMatch = accountRegex.exec(afterDate)) !== null) {
      const num = parseInt(accMatch[1]);
      // Filter to valid Slovak account classes (0xx-9xx)
      // But exclude numbers that are clearly not accounts (e.g. year parts)
      if (num >= 10 && num <= 999 && accMatch[1] !== parsedYear.substring(1)) {
        accountMatches.push(accMatch[1]);
      }
    }

    // Extract amounts - look for numbers with 2 decimal places
    const amounts = [];
    const amtRegex = /(\d[\d\s]*)[\,\.](\d{2})(?:\s|$|[^\d])/g;
    let amtMatch;
    while ((amtMatch = amtRegex.exec(afterDate)) !== null) {
      const numStr = amtMatch[1].replace(/\s/g, '');
      const amount = parseFloat(numStr + '.' + amtMatch[2]);
      if (amount > 0 && amount < 100000000) {
        amounts.push(amount);
      }
    }

    // We need at least 2 account numbers and 1 amount
    if (accountMatches.length >= 2 && amounts.length >= 1) {
      // Try to extract document number - typically alphanumeric before or after the date
      let docNumber = '';
      const docMatch = line.match(/\b([A-Za-z]{1,5}[-\/]?\d{1,10})\b/);
      if (docMatch) {
        docNumber = docMatch[1];
      }

      // Extract description - text between known patterns
      let description = '';
      // Look for text that's not a number, date or account
      const parts = afterDate.split(/\s{2,}|\t/);
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.length > 3 &&
            !amountRegex.test(trimmed) &&
            !/^\d{3}$/.test(trimmed) &&
            !/^\d+$/.test(trimmed)) {
          description = trimmed;
          break;
        }
      }

      entries.push({
        date,
        document_number: docNumber,
        description: description || '',
        account_md: accountMatches[0],
        account_d: accountMatches[1],
        amount: amounts[0],
        partner: '',
      });
    }
  }

  // If line-by-line parsing didn't work well, try multi-line block parsing
  if (entries.length === 0) {
    // Some PDFs have data spread across multiple lines per entry
    // Try to find blocks starting with a date
    let currentEntry = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const dateMatch = line.match(dateRegex);

      if (dateMatch) {
        // Save previous entry if valid
        if (currentEntry && currentEntry.account_md && currentEntry.account_d && currentEntry.amount) {
          entries.push(currentEntry);
        }

        const day = dateMatch[1].padStart(2, '0');
        const month = dateMatch[2].padStart(2, '0');
        const parsedYear = dateMatch[3];

        currentEntry = {
          date: `${parsedYear}-${month}-${day}`,
          document_number: '',
          description: '',
          account_md: '',
          account_d: '',
          amount: 0,
          partner: '',
        };

        // Try to get doc number from same line
        const docMatch = line.match(/\b([A-Za-z]{1,5}[-\/]?\d{1,10})\b/);
        if (docMatch) currentEntry.document_number = docMatch[1];
      }

      if (!currentEntry) continue;

      // Look for account numbers in current line
      const accNums = [];
      const accRegex2 = /\b(\d{3})\b/g;
      let m;
      while ((m = accRegex2.exec(line)) !== null) {
        const num = parseInt(m[1]);
        if (num >= 10 && num <= 999) accNums.push(m[1]);
      }
      if (accNums.length >= 2 && !currentEntry.account_md) {
        currentEntry.account_md = accNums[0];
        currentEntry.account_d = accNums[1];
      } else if (accNums.length === 1) {
        if (!currentEntry.account_md) currentEntry.account_md = accNums[0];
        else if (!currentEntry.account_d) currentEntry.account_d = accNums[0];
      }

      // Look for amount
      const amtMatch2 = line.match(/(\d[\d\s]*)[\,\.](\d{2})(?:\s|$|[^\d])/);
      if (amtMatch2 && !currentEntry.amount) {
        const numStr = amtMatch2[1].replace(/\s/g, '');
        currentEntry.amount = parseFloat(numStr + '.' + amtMatch2[2]);
      }

      // Look for description text
      if (!currentEntry.description && line.length > 5) {
        const cleaned = line.replace(dateRegex, '').replace(/\b\d{3}\b/g, '').replace(/\d[\d\s]*[\,\.]\d{2}/g, '').trim();
        if (cleaned.length > 3) {
          currentEntry.description = cleaned;
        }
      }
    }
    // Don't forget the last entry
    if (currentEntry && currentEntry.account_md && currentEntry.account_d && currentEntry.amount) {
      entries.push(currentEntry);
    }
  }

  return entries;
}

app.post('/api/journal-pdfs', journalUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Súbor nebol nahraný.' });
  }
  const { year, description } = req.body;
  const result = db.prepare(
    'INSERT INTO journal_pdfs (filename, original_name, year, description) VALUES (?, ?, ?, ?)'
  ).run(req.file.filename, req.file.originalname, year || null, description || '');

  const pdfId = result.lastInsertRowid;

  // Try to parse journal entries from PDF
  let parsedCount = 0;
  let rawText = '';
  let parsedEntries = [];
  try {
    const pdfBuffer = fs.readFileSync(path.join(journalsDir, req.file.filename));
    const pdfData = await pdfParse(pdfBuffer);
    rawText = pdfData.text;
    parsedEntries = parseJournalPdf(pdfData.text, year);

    if (parsedEntries.length > 0) {
      const insertEntry = db.transaction((rows) => {
        for (const entry of rows) {
          db.prepare(`
            INSERT INTO journal_entries (date, document_number, description, account_md, account_d, amount, partner)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(entry.date, entry.document_number, entry.description, entry.account_md, entry.account_d, entry.amount, entry.partner);
        }
      });
      insertEntry(parsedEntries);
      parsedCount = parsedEntries.length;
    }
  } catch (parseErr) {
    console.error('Chyba pri parsovaní PDF:', parseErr.message);
  }

  res.json({
    id: pdfId,
    filename: req.file.filename,
    original_name: req.file.originalname,
    year,
    description,
    parsed_entries: parsedCount,
    raw_text_preview: rawText.substring(0, 3000),
    sample_parsed: parsedEntries.slice(0, 5),
  });
});

app.get('/api/journal-pdfs', (req, res) => {
  const pdfs = db.prepare('SELECT * FROM journal_pdfs ORDER BY year DESC, uploaded_at DESC').all();
  res.json(pdfs);
});

app.delete('/api/journal-pdfs/:id', (req, res) => {
  const pdf = db.prepare('SELECT * FROM journal_pdfs WHERE id = ?').get(req.params.id);
  if (pdf) {
    const filepath = path.join(journalsDir, pdf.filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    db.prepare('DELETE FROM journal_pdfs WHERE id = ?').run(req.params.id);
  }
  res.json({ success: true });
});

// ============ Súvaha (Balance Sheet) - Úč POD 1-01 ============

// Helper: get account balances for a year
function getAccountBalances(year) {
  const debits = db.prepare(
    "SELECT account_md as account, SUM(amount) as total FROM journal_entries WHERE strftime('%Y', date) = ? GROUP BY account_md"
  ).all(year);
  const credits = db.prepare(
    "SELECT account_d as account, SUM(amount) as total FROM journal_entries WHERE strftime('%Y', date) = ? GROUP BY account_d"
  ).all(year);
  const balances = {};
  for (const r of debits) {
    if (!balances[r.account]) balances[r.account] = { debit: 0, credit: 0 };
    balances[r.account].debit = r.total;
  }
  for (const r of credits) {
    if (!balances[r.account]) balances[r.account] = { debit: 0, credit: 0 };
    balances[r.account].credit = r.total;
  }
  return balances;
}

// Helper: sum debit balances for given account prefixes
function sumDebit(balances, prefixes) {
  let total = 0;
  for (const [acc, bal] of Object.entries(balances)) {
    if (prefixes.some(p => acc.startsWith(p))) {
      total += bal.debit;
    }
  }
  return total;
}

// Helper: sum credit balances for given account prefixes
function sumCredit(balances, prefixes) {
  let total = 0;
  for (const [acc, bal] of Object.entries(balances)) {
    if (prefixes.some(p => acc.startsWith(p))) {
      total += bal.credit;
    }
  }
  return total;
}

// Helper: net balance (debit - credit) for given account prefixes
function netBalance(balances, prefixes) {
  return sumDebit(balances, prefixes) - sumCredit(balances, prefixes);
}

// Helper: net credit balance (credit - debit) for given account prefixes
function netCreditBalance(balances, prefixes) {
  return sumCredit(balances, prefixes) - sumDebit(balances, prefixes);
}

// Build standard aktíva rows with Brutto/Korekcia/Netto
function buildAktivaRows(balances) {
  const rows = {};
  const val = (prefixes) => sumDebit(balances, prefixes);
  const kor = (prefixes) => sumCredit(balances, prefixes);

  // A.I. Dlhodobý nehmotný majetok - detail rows
  rows[4]  = { b: val(['012']), k: kor(['072']), n: 0 };
  rows[5]  = { b: val(['013']), k: kor(['073']), n: 0 };
  rows[6]  = { b: val(['014']), k: kor(['074']), n: 0 };
  rows[7]  = { b: val(['015']), k: kor(['075']), n: 0 };
  rows[8]  = { b: val(['019']), k: kor(['079']), n: 0 };
  rows[9]  = { b: val(['041']), k: kor(['091']), n: 0 };
  rows[10] = { b: val(['051']), k: kor(['095']), n: 0 };

  // A.II. Dlhodobý hmotný majetok - detail rows
  rows[12] = { b: val(['031']), k: 0, n: 0 };
  rows[13] = { b: val(['021']), k: kor(['081']), n: 0 };
  rows[14] = { b: val(['022']), k: kor(['082']), n: 0 };
  rows[15] = { b: val(['025']), k: kor(['085']), n: 0 };
  rows[16] = { b: val(['026']), k: kor(['086']), n: 0 };
  rows[17] = { b: val(['029', '032']), k: kor(['089']), n: 0 };
  rows[18] = { b: val(['042']), k: kor(['094']), n: 0 };
  rows[19] = { b: val(['052']), k: 0, n: 0 };
  rows[20] = { b: val(['097']), k: kor(['098']), n: 0 };

  // A.III. Dlhodobý finančný majetok - detail rows
  rows[22] = { b: val(['061']), k: kor(['096']), n: 0 };
  rows[23] = { b: val(['062']), k: 0, n: 0 };
  rows[24] = { b: val(['063']), k: kor(['096']), n: 0 };
  rows[25] = { b: val(['065']), k: 0, n: 0 };
  rows[26] = { b: val(['066']), k: 0, n: 0 };
  rows[27] = { b: val(['067']), k: 0, n: 0 };
  rows[28] = { b: val(['069']), k: 0, n: 0 };
  rows[29] = { b: val(['06x']), k: 0, n: 0 }; // placeholder
  rows[30] = { b: val(['043']), k: 0, n: 0 };
  rows[31] = { b: val(['053']), k: 0, n: 0 };
  rows[32] = { b: val(['054']), k: 0, n: 0 };

  // B.I. Zásoby - detail rows
  rows[35] = { b: val(['112']), k: kor(['191']), n: 0 };
  rows[36] = { b: val(['121', '122']), k: kor(['192']), n: 0 };
  rows[37] = { b: val(['123']), k: kor(['193']), n: 0 };
  rows[38] = { b: val(['124']), k: kor(['195']), n: 0 };
  rows[39] = { b: val(['132', '133']), k: kor(['196']), n: 0 };
  rows[40] = { b: val(['314']), k: 0, n: 0 };

  // B.II. Dlhodobé pohľadávky - simplified
  rows[42] = { b: netBalance(balances, ['311']) > 0 ? 0 : 0, k: 0, n: 0 };
  rows[43] = { b: 0, k: 0, n: 0 };
  rows[44] = { b: 0, k: 0, n: 0 };
  rows[45] = { b: 0, k: 0, n: 0 };
  rows[46] = { b: 0, k: 0, n: 0 };
  rows[47] = { b: 0, k: 0, n: 0 };
  rows[48] = { b: 0, k: 0, n: 0 };
  rows[49] = { b: 0, k: 0, n: 0 };
  rows[50] = { b: 0, k: 0, n: 0 };
  rows[51] = { b: 0, k: 0, n: 0 };
  rows[52] = { b: 0, k: 0, n: 0 };

  // B.III. Krátkodobé pohľadávky - detail rows
  const r311net = netBalance(balances, ['311']);
  const r312net = netBalance(balances, ['312']);
  const r313net = netBalance(balances, ['313']);
  const r315net = netBalance(balances, ['315']);
  rows[54] = { b: Math.max(0, r311net) + Math.max(0, r312net) + Math.max(0, r313net) + Math.max(0, r315net), k: kor(['391']), n: 0 };
  rows[55] = { b: 0, k: 0, n: 0 };
  rows[56] = { b: Math.max(0, netBalance(balances, ['335'])), k: 0, n: 0 };
  rows[57] = { b: Math.max(0, netBalance(balances, ['336'])), k: 0, n: 0 };
  const r341net = netBalance(balances, ['341']);
  const r342net = netBalance(balances, ['342']);
  const r343net = netBalance(balances, ['343']);
  const r345net = netBalance(balances, ['345']);
  rows[58] = { b: Math.max(0, r341net) + Math.max(0, r342net) + Math.max(0, r343net) + Math.max(0, r345net), k: 0, n: 0 };
  rows[59] = { b: 0, k: 0, n: 0 };
  rows[60] = { b: Math.max(0, netBalance(balances, ['355'])), k: 0, n: 0 };
  rows[61] = { b: Math.max(0, netBalance(balances, ['358'])), k: 0, n: 0 };
  rows[62] = { b: 0, k: 0, n: 0 };
  rows[63] = { b: 0, k: 0, n: 0 };
  rows[64] = { b: 0, k: 0, n: 0 };
  rows[65] = { b: Math.max(0, netBalance(balances, ['378', '373', '375', '376'])), k: 0, n: 0 };

  // B.IV. Krátkodobý finančný majetok
  rows[67] = { b: val(['251']), k: kor(['291']), n: 0 };
  rows[68] = { b: val(['253']), k: kor(['293']), n: 0 };
  rows[69] = { b: val(['256']), k: kor(['296']), n: 0 };
  rows[70] = { b: val(['257']), k: 0, n: 0 };

  // B.V. Finančné účty
  rows[72] = { b: val(['211', '213']), k: 0, n: 0 };
  rows[73] = { b: val(['221']), k: 0, n: 0 };

  // C. Časové rozlíšenie
  rows[75] = { b: val(['381']), k: 0, n: 0 };
  rows[76] = { b: val(['382']), k: 0, n: 0 };
  rows[77] = { b: val(['385']), k: 0, n: 0 };

  // Calculate Netto for all detail rows
  for (const key of Object.keys(rows)) {
    rows[key].n = rows[key].b - rows[key].k;
  }

  // Subtotals
  const sumR = (ids) => {
    const result = { b: 0, k: 0, n: 0 };
    for (const id of ids) {
      if (rows[id]) { result.b += rows[id].b; result.k += rows[id].k; result.n += rows[id].n; }
    }
    return result;
  };

  rows[3]  = sumR([4,5,6,7,8,9,10]);           // A.I. DNM súčet
  rows[11] = sumR([12,13,14,15,16,17,18,19,20]); // A.II. DHM súčet
  rows[21] = sumR([22,23,24,25,26,27,28,29,30,31,32]); // A.III. DFM súčet
  rows[2]  = sumR([3,11,21]);                    // A. Neobežný majetok
  rows[34] = sumR([35,36,37,38,39,40]);          // B.I. Zásoby súčet
  rows[41] = sumR([42,43,44,45,46,47,48,49,50,51,52]); // B.II. Dlhodobé pohľadávky
  rows[53] = sumR([54,55,56,57,58,59,60,61,62,63,64,65]); // B.III. Krátkodobé pohľadávky
  rows[66] = sumR([67,68,69,70]);                // B.IV. Krátkodobý fin. majetok
  rows[71] = sumR([72,73]);                      // B.V. Finančné účty
  rows[33] = sumR([34,41,53,66,71]);             // B. Obežný majetok
  rows[74] = sumR([75,76,77]);                   // C. Časové rozlíšenie
  rows[1]  = sumR([2,33,74]);                    // SPOLU MAJETOK

  return rows;
}

// Build standard pasíva rows
function buildPasivaRows(balances, year) {
  const rows = {};
  const nc = (prefixes) => netCreditBalance(balances, prefixes);

  // A.I. Základné imanie
  rows[81] = nc(['411']);
  rows[82] = nc(['419']);
  rows[83] = -Math.max(0, netBalance(balances, ['353']));
  rows[84] = -Math.max(0, netBalance(balances, ['252']));

  // A.II - A.VI
  rows[85] = nc(['412']);
  rows[86] = nc(['413']);
  rows[88] = nc(['421']);
  rows[89] = nc(['422', '427']);
  rows[91] = nc(['423']);
  rows[92] = nc(['427']);
  rows[94] = nc(['414']);
  rows[95] = nc(['415']);
  rows[96] = nc(['416']);
  rows[98] = nc(['428']);
  rows[99] = -Math.max(0, netBalance(balances, ['429']));

  // A.VIII. VH za účtovné obdobie - calculated from revenue - expenses
  const expenses = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM journal_entries WHERE strftime('%Y', date) = ? AND account_md LIKE '5%'"
  ).get(year).total;
  const revenue = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM journal_entries WHERE strftime('%Y', date) = ? AND account_d LIKE '6%'"
  ).get(year).total;
  rows[100] = revenue - expenses;

  // B.I. Dlhodobé záväzky
  rows[103] = nc(['479']);
  rows[104] = 0;
  rows[105] = nc(['471']);
  rows[106] = nc(['472']);
  rows[107] = nc(['473', '474']);
  rows[108] = 0;
  rows[109] = 0;
  rows[110] = 0;
  rows[111] = nc(['475']);
  rows[112] = nc(['476']);
  rows[113] = 0;
  rows[114] = 0;
  rows[115] = 0;
  rows[116] = 0;
  rows[117] = nc(['481']);

  // B.II. Dlhodobé rezervy
  rows[119] = nc(['451']);
  rows[120] = nc(['459']);

  // B.III. Dlhodobé bankové úvery
  rows[121] = nc(['461']);

  // B.IV. Krátkodobé záväzky
  const r321nc = nc(['321']);
  const r322nc = nc(['322']);
  const r324nc = nc(['324']);
  const r325nc = nc(['325']);
  rows[123] = r321nc + r322nc + r324nc + r325nc;
  rows[124] = 0;
  rows[125] = nc(['364', '365', '366', '367', '368']);
  rows[126] = 0;
  rows[127] = 0;
  rows[128] = nc(['331', '333']);
  rows[129] = nc(['336']);
  const r341nc = nc(['341']);
  const r342nc = nc(['342']);
  const r343nc = nc(['343']);
  const r345nc = nc(['345']);
  const r346nc = nc(['346']);
  const r347nc = nc(['347']);
  rows[130] = r341nc + r342nc + r343nc + r345nc + r346nc + r347nc;
  rows[131] = 0;
  rows[132] = nc(['379']);
  rows[133] = 0;
  rows[134] = 0;
  rows[135] = 0;

  // B.V. Krátkodobé rezervy
  rows[137] = nc(['323']);
  rows[138] = nc(['459']);

  // B.VI. Bežné bankové úvery
  rows[139] = nc(['231', '232', '221']);
  // Only include 221 if it has credit balance (overdraft)
  const r221net = netBalance(balances, ['221']);
  rows[139] = r221net < 0 ? -r221net : nc(['231', '232']);

  // B.VII. Krátkodobé finančné výpomoci
  rows[140] = nc(['241', '249']);

  // C. Časové rozlíšenie
  rows[142] = nc(['383']);
  rows[143] = nc(['384']);

  // Subtotals
  rows[80]  = (rows[81] || 0) + (rows[82] || 0) + (rows[83] || 0) + (rows[84] || 0); // A.I.
  rows[87]  = (rows[88] || 0) + (rows[89] || 0); // A.IV.
  rows[90]  = (rows[91] || 0) + (rows[92] || 0); // A.V.
  rows[93]  = (rows[94] || 0) + (rows[95] || 0) + (rows[96] || 0); // A.VI.
  rows[97]  = (rows[98] || 0) + (rows[99] || 0); // A.VII.
  rows[79]  = (rows[80] || 0) + (rows[85] || 0) + (rows[86] || 0) + (rows[87] || 0) + (rows[90] || 0) + (rows[93] || 0) + (rows[97] || 0) + (rows[100] || 0); // A. Vlastné imanie
  rows[102] = [103,104,105,106,107,108,109,110,111,112,113,114,115,116,117].reduce((s, i) => s + (rows[i] || 0), 0); // B.I.
  rows[118] = (rows[119] || 0) + (rows[120] || 0); // B.II.
  rows[122] = [123,124,125,126,127,128,129,130,131,132,133,134,135].reduce((s, i) => s + (rows[i] || 0), 0); // B.IV.
  rows[136] = (rows[137] || 0) + (rows[138] || 0); // B.V.
  rows[101] = (rows[102] || 0) + (rows[118] || 0) + (rows[121] || 0) + (rows[122] || 0) + (rows[136] || 0) + (rows[139] || 0) + (rows[140] || 0); // B. Záväzky
  rows[141] = (rows[142] || 0) + (rows[143] || 0); // C.
  rows[78]  = (rows[79] || 0) + (rows[101] || 0) + (rows[141] || 0); // SPOLU

  return rows;
}

app.get('/api/balance-sheet', (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();
  const prevYear = (parseInt(year) - 1).toString();

  const currentBalances = getAccountBalances(year);
  const prevBalances = getAccountBalances(prevYear);

  const aktivaCurrent = buildAktivaRows(currentBalances);
  const aktivaPrev = buildAktivaRows(prevBalances);
  const pasivaCurrent = buildPasivaRows(currentBalances, year);
  const pasivaPrev = buildPasivaRows(prevBalances, prevYear);

  // Define row structure for frontend
  const aktivaStructure = [
    { row: 1,  label: '',       name: 'SPOLU MAJETOK',                                    type: 'total' },
    { row: 2,  label: 'A.',     name: 'Neobežný majetok',                                 type: 'group' },
    { row: 3,  label: 'A.I.',   name: 'Dlhodobý nehmotný majetok súčet',                  type: 'subgroup' },
    { row: 4,  label: 'A.I.1.', name: 'Aktivované náklady na vývoj (012)',                 type: 'detail' },
    { row: 5,  label: 'A.I.2.', name: 'Softvér (013)',                                    type: 'detail' },
    { row: 6,  label: 'A.I.3.', name: 'Oceniteľné práva (014)',                           type: 'detail' },
    { row: 7,  label: 'A.I.4.', name: 'Goodwill (015)',                                   type: 'detail' },
    { row: 8,  label: 'A.I.5.', name: 'Ostatný dlhodobý nehmotný majetok (019)',          type: 'detail' },
    { row: 9,  label: 'A.I.6.', name: 'Obstarávaný dlhodobý nehmotný majetok (041)',      type: 'detail' },
    { row: 10, label: 'A.I.7.', name: 'Poskytnuté preddavky na DNM (051)',                type: 'detail' },
    { row: 11, label: 'A.II.',  name: 'Dlhodobý hmotný majetok súčet',                    type: 'subgroup' },
    { row: 12, label: 'A.II.1.', name: 'Pozemky (031)',                                   type: 'detail' },
    { row: 13, label: 'A.II.2.', name: 'Stavby (021)',                                    type: 'detail' },
    { row: 14, label: 'A.II.3.', name: 'Samostatné hnuteľné veci a súbory (022)',         type: 'detail' },
    { row: 15, label: 'A.II.4.', name: 'Pestovateľské celky trvalých porastov (025)',     type: 'detail' },
    { row: 16, label: 'A.II.5.', name: 'Základné stádo a ťažné zvieratá (026)',           type: 'detail' },
    { row: 17, label: 'A.II.6.', name: 'Ostatný dlhodobý hmotný majetok (029, 032)',      type: 'detail' },
    { row: 18, label: 'A.II.7.', name: 'Obstarávaný dlhodobý hmotný majetok (042)',       type: 'detail' },
    { row: 19, label: 'A.II.8.', name: 'Poskytnuté preddavky na DHM (052)',               type: 'detail' },
    { row: 20, label: 'A.II.9.', name: 'Opravná položka k nadobudnutému majetku (097)',   type: 'detail' },
    { row: 21, label: 'A.III.', name: 'Dlhodobý finančný majetok súčet',                  type: 'subgroup' },
    { row: 22, label: 'A.III.1.', name: 'Podielové CP v prepojených ÚJ (061)',            type: 'detail' },
    { row: 23, label: 'A.III.2.', name: 'Podielové CP s podielovou účasťou (062)',        type: 'detail' },
    { row: 24, label: 'A.III.3.', name: 'Ostatné realizovateľné CP a podiely (063)',      type: 'detail' },
    { row: 25, label: 'A.III.4.', name: 'Pôžičky prepojeným ÚJ (065)',                   type: 'detail' },
    { row: 26, label: 'A.III.5.', name: 'Pôžičky v rámci podielovej účasti (066)',        type: 'detail' },
    { row: 27, label: 'A.III.6.', name: 'Ostatné pôžičky (067)',                          type: 'detail' },
    { row: 28, label: 'A.III.7.', name: 'Dlhové cenné papiere a ostatný DFM (069)',       type: 'detail' },
    { row: 29, label: 'A.III.8.', name: 'Pôžičky a ostatný DFM - spriaz. osoby',         type: 'detail' },
    { row: 30, label: 'A.III.9.', name: 'Obstarávaný dlhodobý finančný majetok (043)',    type: 'detail' },
    { row: 31, label: 'A.III.10.', name: 'Poskytnuté preddavky na DFM (053)',             type: 'detail' },
    { row: 32, label: 'A.III.11.', name: 'Posk. preddavky na DFM - spriaz. osoby (054)', type: 'detail' },
    { row: 33, label: 'B.',     name: 'Obežný majetok',                                   type: 'group' },
    { row: 34, label: 'B.I.',   name: 'Zásoby súčet',                                     type: 'subgroup' },
    { row: 35, label: 'B.I.1.', name: 'Materiál (112, 119)',                              type: 'detail' },
    { row: 36, label: 'B.I.2.', name: 'Nedokončená výroba a polotovary (121, 122)',       type: 'detail' },
    { row: 37, label: 'B.I.3.', name: 'Výrobky (123)',                                    type: 'detail' },
    { row: 38, label: 'B.I.4.', name: 'Zvieratá (124)',                                   type: 'detail' },
    { row: 39, label: 'B.I.5.', name: 'Tovar (132, 133, 139)',                            type: 'detail' },
    { row: 40, label: 'B.I.6.', name: 'Poskytnuté preddavky na zásoby (314A)',            type: 'detail' },
    { row: 41, label: 'B.II.',  name: 'Dlhodobé pohľadávky súčet',                        type: 'subgroup' },
    { row: 42, label: 'B.II.1.', name: 'Pohľadávky z obchodného styku - dlhodobé',       type: 'detail' },
    { row: 43, label: 'B.II.2.', name: 'Čistá hodnota zákazky',                          type: 'detail' },
    { row: 44, label: 'B.II.3.', name: 'Ostatné pohľadávky voči prepojeným ÚJ',          type: 'detail' },
    { row: 45, label: 'B.II.4.', name: 'Ost. pohľ. v rámci podielovej účasti',           type: 'detail' },
    { row: 46, label: 'B.II.5.', name: 'Pohľadávky voči spoločníkom a združeniu',        type: 'detail' },
    { row: 47, label: 'B.II.6.', name: 'Pohľ. z derivátových operácií',                  type: 'detail' },
    { row: 48, label: 'B.II.7.', name: 'Iné pohľadávky',                                 type: 'detail' },
    { row: 49, label: 'B.II.8.', name: 'Odložená daňová pohľadávka',                     type: 'detail' },
    { row: 50, label: 'B.II.9.', name: 'Pohľ. z derivátových operácií - spriaz.',        type: 'detail' },
    { row: 51, label: 'B.II.10.', name: 'Iné pohľadávky - spriaz. osoby',                type: 'detail' },
    { row: 52, label: 'B.II.11.', name: 'Pohľadávky z ručenia',                          type: 'detail' },
    { row: 53, label: 'B.III.', name: 'Krátkodobé pohľadávky súčet',                      type: 'subgroup' },
    { row: 54, label: 'B.III.1.', name: 'Pohľadávky z obchodného styku (311-315)',        type: 'detail' },
    { row: 55, label: 'B.III.2.', name: 'Čistá hodnota zákazky',                         type: 'detail' },
    { row: 56, label: 'B.III.3.', name: 'Ostatné pohľ. voči prepojeným ÚJ (335A)',       type: 'detail' },
    { row: 57, label: 'B.III.4.', name: 'Ost. pohľ. v rámci podielovej účasti (336A)',   type: 'detail' },
    { row: 58, label: 'B.III.5.', name: 'Pohľadávky voči spoločníkom (341-345A)',        type: 'detail' },
    { row: 59, label: 'B.III.6.', name: 'Sociálne poistenie (336A)',                     type: 'detail' },
    { row: 60, label: 'B.III.7.', name: 'Daňové pohľadávky a dotácie (341-345A)',        type: 'detail' },
    { row: 61, label: 'B.III.8.', name: 'Pohľ. z derivátových operácií (373A)',          type: 'detail' },
    { row: 62, label: 'B.III.9.', name: 'Iné pohľadávky (378A)',                         type: 'detail' },
    { row: 63, label: 'B.III.10.', name: 'Pohľ. z deriv. operácií - spriaz.',            type: 'detail' },
    { row: 64, label: 'B.III.11.', name: 'Iné pohľadávky - spriaz. osoby',              type: 'detail' },
    { row: 65, label: 'B.III.12.', name: 'Pohľadávky z ručenia',                        type: 'detail' },
    { row: 66, label: 'B.IV.',  name: 'Krátkodobý finančný majetok súčet',                type: 'subgroup' },
    { row: 67, label: 'B.IV.1.', name: 'Krátkodobý fin. majetok v prepoj. ÚJ (251)',    type: 'detail' },
    { row: 68, label: 'B.IV.2.', name: 'Krátk. fin. majetok - podielová účasť (253)',   type: 'detail' },
    { row: 69, label: 'B.IV.3.', name: 'Vlastné akcie a vlastné obchodné podiely (256)', type: 'detail' },
    { row: 70, label: 'B.IV.4.', name: 'Ostatný krátkodobý finančný majetok (257)',      type: 'detail' },
    { row: 71, label: 'B.V.',   name: 'Finančné účty',                                    type: 'subgroup' },
    { row: 72, label: 'B.V.1.', name: 'Peniaze (211, 213)',                               type: 'detail' },
    { row: 73, label: 'B.V.2.', name: 'Účty v bankách (221)',                             type: 'detail' },
    { row: 74, label: 'C.',     name: 'Časové rozlíšenie',                                type: 'group' },
    { row: 75, label: 'C.1.',   name: 'Náklady budúcich období dlhodobé (381)',           type: 'detail' },
    { row: 76, label: 'C.2.',   name: 'Komplexné náklady budúcich období (382)',          type: 'detail' },
    { row: 77, label: 'C.3.',   name: 'Príjmy budúcich období (385)',                     type: 'detail' },
  ];

  const pasivaStructure = [
    { row: 78,  label: '',        name: 'SPOLU VLASTNÉ IMANIE A ZÁVÄZKY',                 type: 'total' },
    { row: 79,  label: 'A.',      name: 'Vlastné imanie',                                  type: 'group' },
    { row: 80,  label: 'A.I.',    name: 'Základné imanie súčet',                           type: 'subgroup' },
    { row: 81,  label: 'A.I.1.',  name: 'Základné imanie (411)',                           type: 'detail' },
    { row: 82,  label: 'A.I.2.',  name: 'Zmena základného imania +/- 419',                type: 'detail' },
    { row: 83,  label: 'A.I.3.',  name: 'Pohľadávky za upísané vlastné imanie (-/353)',   type: 'detail' },
    { row: 84,  label: 'A.I.4.',  name: 'Vlastné akcie a vlastné obchodné podiely',       type: 'detail' },
    { row: 85,  label: 'A.II.',   name: 'Emisné ážio (412)',                               type: 'detail' },
    { row: 86,  label: 'A.III.',  name: 'Ostatné kapitálové fondy (413)',                  type: 'detail' },
    { row: 87,  label: 'A.IV.',   name: 'Zákonné rezervné fondy',                         type: 'subgroup' },
    { row: 88,  label: 'A.IV.1.', name: 'Zákonný rezervný fond a nedeliteľný fond (421)', type: 'detail' },
    { row: 89,  label: 'A.IV.2.', name: 'Rezervný fond na vlastné akcie (422, 427)',      type: 'detail' },
    { row: 90,  label: 'A.V.',    name: 'Ostatné fondy zo zisku',                         type: 'subgroup' },
    { row: 91,  label: 'A.V.1.',  name: 'Štatutárne fondy (423)',                         type: 'detail' },
    { row: 92,  label: 'A.V.2.',  name: 'Ostatné fondy (427)',                            type: 'detail' },
    { row: 93,  label: 'A.VI.',   name: 'Oceňovacie rozdiely z precenenia súčet',         type: 'subgroup' },
    { row: 94,  label: 'A.VI.1.', name: 'Oceňovacie rozdiely z precenenia majetku (414)', type: 'detail' },
    { row: 95,  label: 'A.VI.2.', name: 'Oceňovacie rozdiely z kapitálových účastín (415)', type: 'detail' },
    { row: 96,  label: 'A.VI.3.', name: 'Oceňovacie rozdiely z precenenia pri zlúčení (416)', type: 'detail' },
    { row: 97,  label: 'A.VII.',  name: 'Výsledok hospodárenia minulých rokov',           type: 'subgroup' },
    { row: 98,  label: 'A.VII.1.', name: 'Nerozdelený zisk minulých rokov (428)',         type: 'detail' },
    { row: 99,  label: 'A.VII.2.', name: 'Neuhradená strata minulých rokov (-429)',       type: 'detail' },
    { row: 100, label: 'A.VIII.', name: 'Výsledok hospodárenia za účtovné obdobie (+/-)', type: 'detail' },
    { row: 101, label: 'B.',      name: 'Záväzky',                                         type: 'group' },
    { row: 102, label: 'B.I.',    name: 'Dlhodobé záväzky súčet',                         type: 'subgroup' },
    { row: 103, label: 'B.I.1.',  name: 'Dlhodobé záväzky z obchodného styku (479A)',     type: 'detail' },
    { row: 104, label: 'B.I.2.',  name: 'Čistá hodnota zákazky',                         type: 'detail' },
    { row: 105, label: 'B.I.3.',  name: 'Ostatné záväzky voči prepojeným ÚJ (471)',      type: 'detail' },
    { row: 106, label: 'B.I.4.',  name: 'Ost. záväzky v rámci podielovej účasti (472)',   type: 'detail' },
    { row: 107, label: 'B.I.5.',  name: 'Ostatné dlhodobé záväzky (473, 474)',            type: 'detail' },
    { row: 108, label: 'B.I.6.',  name: 'Dlhodobé prijaté preddavky',                    type: 'detail' },
    { row: 109, label: 'B.I.7.',  name: 'Dlhodobé zmenky na úhradu',                     type: 'detail' },
    { row: 110, label: 'B.I.8.',  name: 'Vydané dlhopisy',                                type: 'detail' },
    { row: 111, label: 'B.I.9.',  name: 'Záväzky zo sociálneho fondu (472)',              type: 'detail' },
    { row: 112, label: 'B.I.10.', name: 'Iné dlhodobé záväzky (479A)',                   type: 'detail' },
    { row: 113, label: 'B.I.11.', name: 'Dlhodobé záväzky z deriv. operácií',            type: 'detail' },
    { row: 114, label: 'B.I.12.', name: 'Dlhodobé záväzky - spriaz. osoby',              type: 'detail' },
    { row: 115, label: 'B.I.13.', name: 'Dlhodobé záväzky z ručenia',                    type: 'detail' },
    { row: 116, label: 'B.I.14.', name: 'Záväzky z derivátov - dlhodobé spriaz.',        type: 'detail' },
    { row: 117, label: 'B.I.15.', name: 'Odložený daňový záväzok (481)',                  type: 'detail' },
    { row: 118, label: 'B.II.',   name: 'Dlhodobé rezervy',                               type: 'subgroup' },
    { row: 119, label: 'B.II.1.', name: 'Zákonné rezervy (451)',                          type: 'detail' },
    { row: 120, label: 'B.II.2.', name: 'Ostatné rezervy (459)',                          type: 'detail' },
    { row: 121, label: 'B.III.',  name: 'Dlhodobé bankové úvery (461)',                   type: 'detail' },
    { row: 122, label: 'B.IV.',   name: 'Krátkodobé záväzky súčet',                       type: 'subgroup' },
    { row: 123, label: 'B.IV.1.', name: 'Záväzky z obchodného styku (321-325)',           type: 'detail' },
    { row: 124, label: 'B.IV.2.', name: 'Čistá hodnota zákazky',                         type: 'detail' },
    { row: 125, label: 'B.IV.3.', name: 'Ostatné záv. voči prepojeným ÚJ (361-368)',     type: 'detail' },
    { row: 126, label: 'B.IV.4.', name: 'Ost. záväzky v rámci podielovej účasti',        type: 'detail' },
    { row: 127, label: 'B.IV.5.', name: 'Záväzky voči spoločníkom a združeniu',          type: 'detail' },
    { row: 128, label: 'B.IV.6.', name: 'Záväzky voči zamestnancom (331, 333)',           type: 'detail' },
    { row: 129, label: 'B.IV.7.', name: 'Záväzky zo sociálneho poistenia (336)',          type: 'detail' },
    { row: 130, label: 'B.IV.8.', name: 'Daňové záväzky a dotácie (341-347)',             type: 'detail' },
    { row: 131, label: 'B.IV.9.', name: 'Záväzky z derivátových operácií (373A)',         type: 'detail' },
    { row: 132, label: 'B.IV.10.', name: 'Iné záväzky (379)',                             type: 'detail' },
    { row: 133, label: 'B.IV.11.', name: 'Krátkodobé záväzky z fin. vzťahov',            type: 'detail' },
    { row: 134, label: 'B.IV.12.', name: 'Krátkodobé záväzky - spriaz. osoby',           type: 'detail' },
    { row: 135, label: 'B.IV.13.', name: 'Krátkodobé záväzky z ručenia',                 type: 'detail' },
    { row: 136, label: 'B.V.',    name: 'Krátkodobé rezervy',                             type: 'subgroup' },
    { row: 137, label: 'B.V.1.',  name: 'Zákonné rezervy (323A)',                         type: 'detail' },
    { row: 138, label: 'B.V.2.',  name: 'Ostatné rezervy (323A, 459A)',                   type: 'detail' },
    { row: 139, label: 'B.VI.',   name: 'Bežné bankové úvery (221A, 231, 232)',           type: 'detail' },
    { row: 140, label: 'B.VII.',  name: 'Krátkodobé finančné výpomoci (241, 249)',        type: 'detail' },
    { row: 141, label: 'C.',      name: 'Časové rozlíšenie',                               type: 'group' },
    { row: 142, label: 'C.1.',    name: 'Výdavky budúcich období (383)',                   type: 'detail' },
    { row: 143, label: 'C.2.',    name: 'Výnosy budúcich období (384)',                    type: 'detail' },
  ];

  // Combine data for frontend
  const aktivaData = aktivaStructure.map(s => ({
    ...s,
    brutto: aktivaCurrent[s.row] ? aktivaCurrent[s.row].b : 0,
    korekcia: aktivaCurrent[s.row] ? aktivaCurrent[s.row].k : 0,
    netto: aktivaCurrent[s.row] ? aktivaCurrent[s.row].n : 0,
    prevNetto: aktivaPrev[s.row] ? aktivaPrev[s.row].n : 0,
  }));

  const pasivaData = pasivaStructure.map(s => ({
    ...s,
    current: pasivaCurrent[s.row] || 0,
    prev: pasivaPrev[s.row] || 0,
  }));

  res.json({ aktiva: aktivaData, pasiva: pasivaData, year, prevYear });
});

// ============ Výkaz ziskov a strát (P&L) ============

app.get('/api/profit-loss', (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();

  // Get all expense entries (class 5) - debit side
  const expenseDebits = db.prepare(`
    SELECT account_md as account, SUM(amount) as total
    FROM journal_entries
    WHERE strftime('%Y', date) = ? AND account_md LIKE '5%'
    GROUP BY account_md
    ORDER BY account_md
  `).all(year);

  // Get expense credits (corrections/reversals)
  const expenseCredits = db.prepare(`
    SELECT account_d as account, SUM(amount) as total
    FROM journal_entries
    WHERE strftime('%Y', date) = ? AND account_d LIKE '5%'
    GROUP BY account_d
    ORDER BY account_d
  `).all(year);

  // Get all revenue entries (class 6) - credit side
  const revenueCredits = db.prepare(`
    SELECT account_d as account, SUM(amount) as total
    FROM journal_entries
    WHERE strftime('%Y', date) = ? AND account_d LIKE '6%'
    GROUP BY account_d
    ORDER BY account_d
  `).all(year);

  // Get revenue debits (corrections/reversals)
  const revenueDebits = db.prepare(`
    SELECT account_md as account, SUM(amount) as total
    FROM journal_entries
    WHERE strftime('%Y', date) = ? AND account_md LIKE '6%'
    GROUP BY account_md
    ORDER BY account_md
  `).all(year);

  const accountNames = {
    '50': 'Spotrebované nákupy',
    '501': 'Spotreba materiálu',
    '502': 'Spotreba energie',
    '503': 'Spotreba ostatných neskladovateľných dodávok',
    '504': 'Predaný tovar',
    '51': 'Služby',
    '511': 'Opravy a údržba',
    '512': 'Cestovné',
    '513': 'Náklady na reprezentáciu',
    '518': 'Ostatné služby',
    '52': 'Osobné náklady',
    '521': 'Mzdové náklady',
    '524': 'Zákonné sociálne poistenie',
    '525': 'Ostatné sociálne poistenie',
    '527': 'Zákonné sociálne náklady',
    '53': 'Dane a poplatky',
    '531': 'Daň z motorových vozidiel',
    '532': 'Daň z nehnuteľností',
    '538': 'Ostatné dane a poplatky',
    '54': 'Iné prevádzkové náklady',
    '541': 'Zostatková cena predaného DM',
    '543': 'Dary',
    '544': 'Zmluvné pokuty a penále',
    '545': 'Ostatné pokuty a penále',
    '546': 'Odpis pohľadávky',
    '548': 'Ostatné náklady na prevádzkovú činnosť',
    '55': 'Odpisy a OP k DM',
    '551': 'Odpisy DNM a DHM',
    '557': 'Zúčtovanie oprávky k opravnej položke k DNM',
    '56': 'Finančné náklady',
    '561': 'Predané cenné papiere a podiely',
    '562': 'Úroky',
    '563': 'Kurzové straty',
    '568': 'Ostatné finančné náklady',
    '59': 'Dane z príjmov',
    '591': 'Daň z príjmov - splatná',
    '592': 'Daň z príjmov - odložená',
    '60': 'Tržby za vlastné výkony',
    '601': 'Tržby za vlastné výrobky',
    '602': 'Tržby z predaja služieb',
    '604': 'Tržby za tovar',
    '61': 'Zmeny stavu vnútroorganizačných zásob',
    '611': 'Zmena stavu nedokončenej výroby',
    '612': 'Zmena stavu polotovarov',
    '613': 'Zmena stavu výrobkov',
    '62': 'Aktivácia',
    '621': 'Aktivácia materiálu a tovaru',
    '622': 'Aktivácia vnútroorganizačných služieb',
    '623': 'Aktivácia dlhodobého nehmotného majetku',
    '624': 'Aktivácia dlhodobého hmotného majetku',
    '64': 'Iné prevádzkové výnosy',
    '641': 'Tržby z predaja DM',
    '642': 'Tržby z predaja materiálu',
    '644': 'Zmluvné pokuty a penále',
    '645': 'Ostatné pokuty a penále',
    '646': 'Výnosy z odpísaných pohľadávok',
    '648': 'Ostatné výnosy z prevádzkovej činnosti',
    '66': 'Finančné výnosy',
    '661': 'Tržby z predaja cenných papierov',
    '662': 'Úroky',
    '663': 'Kurzové zisky',
    '668': 'Ostatné finančné výnosy',
  };

  // Build expense balances
  const expenseMap = {};
  for (const row of expenseDebits) {
    expenseMap[row.account] = (expenseMap[row.account] || 0) + row.total;
  }
  for (const row of expenseCredits) {
    expenseMap[row.account] = (expenseMap[row.account] || 0) - row.total;
  }

  // Build revenue balances
  const revenueMap = {};
  for (const row of revenueCredits) {
    revenueMap[row.account] = (revenueMap[row.account] || 0) + row.total;
  }
  for (const row of revenueDebits) {
    revenueMap[row.account] = (revenueMap[row.account] || 0) - row.total;
  }

  const naklady = Object.entries(expenseMap)
    .filter(([, val]) => val !== 0)
    .map(([account, balance]) => ({
      account,
      name: accountNames[account] || `Účet ${account}`,
      balance,
    }))
    .sort((a, b) => a.account.localeCompare(b.account));

  const vynosy = Object.entries(revenueMap)
    .filter(([, val]) => val !== 0)
    .map(([account, balance]) => ({
      account,
      name: accountNames[account] || `Účet ${account}`,
      balance,
    }))
    .sort((a, b) => a.account.localeCompare(b.account));

  const nakladyTotal = naklady.reduce((sum, n) => sum + n.balance, 0);
  const vynosyTotal = vynosy.reduce((sum, v) => sum + v.balance, 0);
  const vysledok = vynosyTotal - nakladyTotal;

  res.json({ naklady, vynosy, nakladyTotal, vynosyTotal, vysledok, year });
});

// ============ Dashboard stats ============

app.get('/api/stats', (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();

  const totalDocuments = db.prepare(
    "SELECT COUNT(*) as cnt FROM documents WHERE strftime('%Y', created_at) = ?"
  ).get(year).cnt;

  const totalEntries = db.prepare(
    "SELECT COUNT(*) as cnt FROM journal_entries WHERE strftime('%Y', date) = ?"
  ).get(year).cnt;

  const totalExpenses = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM journal_entries WHERE strftime('%Y', date) = ? AND account_md LIKE '5%'"
  ).get(year).total;

  const totalRevenue = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM journal_entries WHERE strftime('%Y', date) = ? AND account_d LIKE '6%'"
  ).get(year).total;

  const uncategorized = db.prepare(
    'SELECT COUNT(*) as cnt FROM documents WHERE category_id IS NULL'
  ).get().cnt;

  res.json({ totalDocuments, totalEntries, totalExpenses, totalRevenue, uncategorized, year });
});

// Error handling for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Súbor je príliš veľký.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`Účtovníctvo server beží na http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Chyba pri inicializácii databázy:', err);
  process.exit(1);
});
