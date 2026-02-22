const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, initialize } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
initialize();

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

app.post('/api/journal-pdfs', journalUpload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Súbor nebol nahraný.' });
  }
  const { year, description } = req.body;
  const result = db.prepare(
    'INSERT INTO journal_pdfs (filename, original_name, year, description) VALUES (?, ?, ?, ?)'
  ).run(req.file.filename, req.file.originalname, year || null, description || '');

  res.json({
    id: result.lastInsertRowid,
    filename: req.file.filename,
    original_name: req.file.originalname,
    year,
    description,
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

app.listen(PORT, () => {
  console.log(`Účtovníctvo server beží na http://localhost:${PORT}`);
});
