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
  try {
    const pdfBuffer = fs.readFileSync(path.join(journalsDir, req.file.filename));
    const pdfData = await pdfParse(pdfBuffer);
    const entries = parseJournalPdf(pdfData.text, year);

    if (entries.length > 0) {
      const insertEntry = db.transaction((rows) => {
        for (const entry of rows) {
          db.prepare(`
            INSERT INTO journal_entries (date, document_number, description, account_md, account_d, amount, partner)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(entry.date, entry.document_number, entry.description, entry.account_md, entry.account_d, entry.amount, entry.partner);
        }
      });
      insertEntry(entries);
      parsedCount = entries.length;
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

// ============ Súvaha (Balance Sheet) ============

app.get('/api/balance-sheet', (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();

  // Get debit totals per account (when account appears as MD)
  const debits = db.prepare(`
    SELECT account_md as account, SUM(amount) as total
    FROM journal_entries
    WHERE strftime('%Y', date) = ?
    GROUP BY account_md
  `).all(year);

  // Get credit totals per account (when account appears as D)
  const credits = db.prepare(`
    SELECT account_d as account, SUM(amount) as total
    FROM journal_entries
    WHERE strftime('%Y', date) = ?
    GROUP BY account_d
  `).all(year);

  // Build account balances
  const balances = {};
  for (const row of debits) {
    if (!balances[row.account]) balances[row.account] = { debit: 0, credit: 0 };
    balances[row.account].debit = row.total;
  }
  for (const row of credits) {
    if (!balances[row.account]) balances[row.account] = { debit: 0, credit: 0 };
    balances[row.account].credit = row.total;
  }

  // Classify accounts for balance sheet (classes 0-4)
  const accountNames = {
    '01': 'Dlhodobý nehmotný majetok',
    '02': 'Dlhodobý hmotný majetok - odpisovaný',
    '03': 'Dlhodobý hmotný majetok - neodpisovaný',
    '04': 'Obstaranie dlhodobého majetku',
    '05': 'Poskytnuté preddavky na DM',
    '07': 'Oprávky k DNM',
    '08': 'Oprávky k DHM',
    '09': 'Opravné položky k DM',
    '11': 'Materiál',
    '12': 'Zásoby vlastnej výroby',
    '13': 'Tovar',
    '19': 'Opravné položky k zásobám',
    '21': 'Peniaze (pokladňa)',
    '22': 'Účty v bankách',
    '23': 'Bežné bankové úvery',
    '24': 'Krátkodobý finančný majetok',
    '25': 'Krátkodobý finančný majetok',
    '26': 'Prevody medzi finančnými účtami',
    '29': 'Opravné položky k fin. majetku',
    '31': 'Pohľadávky',
    '32': 'Záväzky',
    '33': 'Zúčtovanie so zamestnancami',
    '34': 'Zúčtovanie daní a dotácií',
    '35': 'Pohľadávky voči spoločníkom',
    '36': 'Záväzky voči spoločníkom',
    '37': 'Iné pohľadávky a záväzky',
    '38': 'Časové rozlíšenie',
    '39': 'Opravné položky k pohľadávkam',
    '41': 'Základné imanie a kapitálové fondy',
    '42': 'Fondy tvorené zo zisku',
    '43': 'Výsledok hospodárenia',
    '45': 'Rezervy',
    '46': 'Dlhodobé bankové úvery',
    '47': 'Dlhodobé záväzky',
    '48': 'Odložený daňový záväzok',
    '49': 'Opravné položky ku kapitálu',
  };

  const classNames = {
    '0': 'Dlhodobý majetok',
    '1': 'Zásoby',
    '2': 'Finančné účty',
    '3': 'Zúčtovacie vzťahy',
    '4': 'Kapitálové účty a dlhodobé záväzky',
  };

  // Separate into aktíva and pasíva
  // Assets (aktíva): classes 0-3 accounts with typical debit balance
  // Liabilities (pasíva): classes 3-4 accounts with typical credit balance
  const aktiva = [];
  const pasiva = [];
  let aktivaTotal = 0;
  let pasivaTotal = 0;

  // Asset accounts (debit balance is positive)
  const assetAccounts = ['0', '1', '2'];
  // Passive accounts (credit balance is positive)
  const passiveAccounts = ['4'];
  // Class 3 - mixed, determined by prefix
  const assetPrefixes3 = ['31', '33', '35', '37', '38'];  // Receivables side
  const passivePrefixes3 = ['32', '33', '34', '36', '37', '38']; // Payables side

  for (const [account, bal] of Object.entries(balances)) {
    const cls = account[0];
    const prefix = account.substring(0, 2);
    if (!['0', '1', '2', '3', '4'].includes(cls)) continue;

    const net = bal.debit - bal.credit;
    if (net === 0) continue;

    const groupName = accountNames[prefix] || classNames[cls] || `Účet ${prefix}x`;
    const entry = { account, name: groupName, debit: bal.debit, credit: bal.credit, balance: Math.abs(net) };

    if (assetAccounts.includes(cls)) {
      // Assets - show debit balance
      if (net > 0) {
        aktiva.push({ ...entry, balance: net });
        aktivaTotal += net;
      } else {
        // Contra account (e.g. oprávky) - still show in aktiva but negative
        aktiva.push({ ...entry, balance: net });
        aktivaTotal += net;
      }
    } else if (passiveAccounts.includes(cls)) {
      // Liabilities/equity - show credit balance
      pasiva.push({ ...entry, balance: -net });
      pasivaTotal += -net;
    } else if (cls === '3') {
      // Class 3 - determine by balance direction and typical classification
      if (net > 0) {
        // Debit balance = receivable (aktíva)
        aktiva.push({ ...entry, balance: net });
        aktivaTotal += net;
      } else {
        // Credit balance = payable (pasíva)
        pasiva.push({ ...entry, balance: -net });
        pasivaTotal += -net;
      }
    }
  }

  // Add profit/loss to pasíva
  const expenses = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM journal_entries WHERE strftime('%Y', date) = ? AND account_md LIKE '5%'"
  ).get(year).total;
  const revenue = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM journal_entries WHERE strftime('%Y', date) = ? AND account_d LIKE '6%'"
  ).get(year).total;
  const profit = revenue - expenses;
  if (profit !== 0) {
    pasiva.push({ account: '431', name: 'Výsledok hospodárenia bežného roka', debit: 0, credit: 0, balance: profit });
    pasivaTotal += profit;
  }

  // Sort
  aktiva.sort((a, b) => a.account.localeCompare(b.account));
  pasiva.sort((a, b) => a.account.localeCompare(b.account));

  res.json({ aktiva, pasiva, aktivaTotal, pasivaTotal, year });
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
