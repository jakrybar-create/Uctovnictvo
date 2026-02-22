// ============ State ============
let categories = [];
let documents = [];
let journalEntries = [];
let pendingFile = null;

// ============ Init ============
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupYearSelectors();
  loadCategories().then(() => {
    loadDashboard();
  });
  setupUpload();
  setupDocumentForm();
  setupJournal();
  setupJournalPdfs();
  setupCategoryManagement();
  createToastContainer();
});

// ============ Toast notifications ============
function createToastContainer() {
  const container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
}

function showToast(message, type = 'success') {
  const container = document.querySelector('.toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============ Navigation ============
function setupNavigation() {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const section = link.dataset.section;
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.getElementById(`section-${section}`).classList.add('active');

      // Refresh data on section switch
      if (section === 'dashboard') loadDashboard();
      if (section === 'documents') loadDocuments();
      if (section === 'journal') loadJournal();
      if (section === 'journal-pdfs') loadJournalPdfs();
      if (section === 'categories') renderCategories();
    });
  });
}

// ============ Year selectors ============
function setupYearSelectors() {
  const currentYear = new Date().getFullYear();
  const selectors = ['stats-year', 'journal-year', 'journal-pdf-year'];

  selectors.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    for (let y = currentYear; y >= currentYear - 10; y--) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      select.appendChild(opt);
    }
  });
}

// ============ API helpers ============
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Chyba servera');
  return data;
}

async function apiUpload(url, formData) {
  const res = await fetch(url, { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Chyba pri nahrávaní');
  return data;
}

// ============ Categories ============
async function loadCategories() {
  categories = await api('/api/categories');
  populateCategorySelects();
}

function populateCategorySelects() {
  const selects = ['doc-category', 'entry-category', 'filter-category'];
  selects.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    const firstOption = select.options[0];
    select.innerHTML = '';
    select.appendChild(firstOption);
    categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = `${cat.name} (MD ${cat.account_md} / D ${cat.account_d})`;
      opt.dataset.md = cat.account_md;
      opt.dataset.d = cat.account_d;
      select.appendChild(opt);
    });
  });
}

// ============ Dashboard ============
async function loadDashboard() {
  const year = document.getElementById('stats-year').value;
  const stats = await api(`/api/stats?year=${year}`);
  document.getElementById('stat-documents').textContent = stats.totalDocuments;
  document.getElementById('stat-entries').textContent = stats.totalEntries;
  document.getElementById('stat-revenue').textContent = formatMoney(stats.totalRevenue);
  document.getElementById('stat-expenses').textContent = formatMoney(stats.totalExpenses);
  document.getElementById('stat-profit').textContent = formatMoney(stats.totalRevenue - stats.totalExpenses);

  const profitEl = document.getElementById('stat-profit').closest('.stat-card');
  profitEl.className = 'stat-card';
  if (stats.totalRevenue - stats.totalExpenses > 0) {
    profitEl.classList.add('revenue');
  } else if (stats.totalRevenue - stats.totalExpenses < 0) {
    profitEl.classList.add('expense');
  }

  if (stats.uncategorized > 0) {
    document.getElementById('stat-uncategorized').textContent = stats.uncategorized;
    document.getElementById('stat-uncategorized-card').style.display = '';
  } else {
    document.getElementById('stat-uncategorized-card').style.display = 'none';
  }
}

document.getElementById('stats-year')?.addEventListener('change', loadDashboard);

// ============ Document Upload ============
function setupUpload() {
  const area = document.getElementById('upload-area');
  const input = document.getElementById('file-input');

  area.addEventListener('click', () => input.click());
  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('dragover');
  });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });
  input.addEventListener('change', () => {
    if (input.files.length) {
      handleFileUpload(input.files[0]);
    }
  });
}

async function handleFileUpload(file) {
  const progress = document.getElementById('upload-progress');
  const result = document.getElementById('upload-result');
  const area = document.getElementById('upload-area');

  progress.style.display = '';
  result.style.display = 'none';

  const fill = progress.querySelector('.progress-fill');
  fill.style.width = '30%';

  try {
    const formData = new FormData();
    formData.append('file', file);

    fill.style.width = '60%';
    const doc = await apiUpload('/api/documents', formData);
    fill.style.width = '100%';

    setTimeout(() => {
      progress.style.display = 'none';
      result.style.display = '';
      document.getElementById('doc-id').value = doc.id;
      document.getElementById('doc-date').value = new Date().toISOString().split('T')[0];
      document.getElementById('doc-amount').value = '';
      document.getElementById('doc-category').value = '';
      document.getElementById('doc-number').value = '';
      document.getElementById('doc-partner').value = '';
      document.getElementById('doc-description').value = '';
      document.getElementById('account-preview').style.display = 'none';
      showToast(`Doklad "${file.name}" nahraný`);
    }, 500);
  } catch (err) {
    progress.style.display = 'none';
    showToast(err.message, 'error');
  }

  // Reset file input
  document.getElementById('file-input').value = '';
}

function setupDocumentForm() {
  const categorySelect = document.getElementById('doc-category');
  categorySelect.addEventListener('change', () => {
    const selected = categorySelect.options[categorySelect.selectedIndex];
    const preview = document.getElementById('account-preview');
    if (selected.value) {
      document.getElementById('preview-md').textContent = selected.dataset.md;
      document.getElementById('preview-d').textContent = selected.dataset.d;
      preview.style.display = '';
    } else {
      preview.style.display = 'none';
    }
  });

  document.getElementById('document-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('doc-id').value;
    try {
      await api(`/api/documents/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          category_id: document.getElementById('doc-category').value || null,
          amount: parseFloat(document.getElementById('doc-amount').value) || null,
          date: document.getElementById('doc-date').value,
          document_number: document.getElementById('doc-number').value,
          partner: document.getElementById('doc-partner').value,
          description: document.getElementById('doc-description').value,
        }),
      });
      showToast('Doklad bol uložený a zaúčtovaný');
      resetUploadForm();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-skip').addEventListener('click', async () => {
    const id = document.getElementById('doc-id').value;
    try {
      await api(`/api/documents/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          description: document.getElementById('doc-description').value,
          date: document.getElementById('doc-date').value,
        }),
      });
      showToast('Doklad bol uložený bez kategórie');
      resetUploadForm();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function resetUploadForm() {
  document.getElementById('upload-result').style.display = 'none';
  document.getElementById('upload-area').style.display = '';
}

// ============ Documents list ============
async function loadDocuments() {
  documents = await api('/api/documents');
  renderDocuments();
}

function renderDocuments() {
  const tbody = document.getElementById('documents-tbody');
  const empty = document.getElementById('documents-empty');
  const filterCat = document.getElementById('filter-category').value;
  const filterSearch = document.getElementById('filter-search').value.toLowerCase();

  let filtered = documents;
  if (filterCat) {
    filtered = filtered.filter(d => String(d.category_id) === filterCat);
  }
  if (filterSearch) {
    filtered = filtered.filter(d =>
      (d.original_name || '').toLowerCase().includes(filterSearch) ||
      (d.partner || '').toLowerCase().includes(filterSearch) ||
      (d.description || '').toLowerCase().includes(filterSearch) ||
      (d.document_number || '').toLowerCase().includes(filterSearch)
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  tbody.innerHTML = filtered.map(d => `
    <tr>
      <td>${d.date || '-'}</td>
      <td>${d.document_number || '-'}</td>
      <td><a href="/uploads/documents/${d.filename}" target="_blank" class="file-link">${d.original_name}</a></td>
      <td>
        ${d.category_name
          ? `<span class="badge badge-categorized">${d.category_name}</span>`
          : `<span class="badge badge-uncategorized">Nezaradený</span>`}
      </td>
      <td>${d.partner || '-'}</td>
      <td>${d.amount ? formatMoney(d.amount) : '-'}</td>
      <td>${d.account_md && d.account_d ? `${d.account_md} / ${d.account_d}` : '-'}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteDocument('${d.id}')">Zmazať</button>
      </td>
    </tr>
  `).join('');
}

async function deleteDocument(id) {
  if (!confirm('Naozaj chcete zmazať tento doklad?')) return;
  try {
    await api(`/api/documents/${id}`, { method: 'DELETE' });
    showToast('Doklad bol zmazaný');
    loadDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('filter-category')?.addEventListener('change', renderDocuments);
document.getElementById('filter-search')?.addEventListener('input', renderDocuments);

// ============ Journal ============
function setupJournal() {
  document.getElementById('journal-year')?.addEventListener('change', loadJournal);
  document.getElementById('journal-month')?.addEventListener('change', loadJournal);

  document.getElementById('btn-add-entry')?.addEventListener('click', () => {
    document.getElementById('modal-entry').style.display = '';
    document.getElementById('entry-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('entry-amount').value = '';
    document.getElementById('entry-md').value = '';
    document.getElementById('entry-d').value = '';
    document.getElementById('entry-number').value = '';
    document.getElementById('entry-partner').value = '';
    document.getElementById('entry-description').value = '';
    document.getElementById('entry-category').value = '';
  });

  document.getElementById('modal-entry-close')?.addEventListener('click', () => {
    document.getElementById('modal-entry').style.display = 'none';
  });

  // Category pre-fill for journal entry
  document.getElementById('entry-category')?.addEventListener('change', (e) => {
    const cat = categories.find(c => c.id === parseInt(e.target.value));
    if (cat) {
      document.getElementById('entry-md').value = cat.account_md;
      document.getElementById('entry-d').value = cat.account_d;
    }
  });

  document.getElementById('entry-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/journal', {
        method: 'POST',
        body: JSON.stringify({
          date: document.getElementById('entry-date').value,
          document_number: document.getElementById('entry-number').value,
          description: document.getElementById('entry-description').value,
          account_md: document.getElementById('entry-md').value,
          account_d: document.getElementById('entry-d').value,
          amount: parseFloat(document.getElementById('entry-amount').value),
          partner: document.getElementById('entry-partner').value,
          category_id: document.getElementById('entry-category').value || null,
        }),
      });
      document.getElementById('modal-entry').style.display = 'none';
      showToast('Zápis bol pridaný do denníka');
      loadJournal();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function loadJournal() {
  const year = document.getElementById('journal-year').value;
  const month = document.getElementById('journal-month').value;
  let url = `/api/journal?year=${year}`;
  if (month) url += `&month=${month}`;

  journalEntries = await api(url);
  renderJournal();
}

function renderJournal() {
  const tbody = document.getElementById('journal-tbody');
  const empty = document.getElementById('journal-empty');
  const totalEl = document.getElementById('journal-total');

  if (journalEntries.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    totalEl.textContent = '0.00';
    return;
  }

  empty.style.display = 'none';
  let total = 0;

  tbody.innerHTML = journalEntries.map((entry, i) => {
    total += entry.amount;
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${entry.date}</td>
        <td>${entry.document_number || '-'}</td>
        <td>${entry.description || entry.category_name || '-'}</td>
        <td>${entry.partner || '-'}</td>
        <td><strong>${entry.account_md}</strong></td>
        <td><strong>${entry.account_d}</strong></td>
        <td>${formatMoney(entry.amount)}</td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="deleteJournalEntry(${entry.id})">Zmazať</button>
        </td>
      </tr>
    `;
  }).join('');

  totalEl.textContent = formatMoney(total);
}

async function deleteJournalEntry(id) {
  if (!confirm('Naozaj chcete zmazať tento zápis?')) return;
  try {
    await api(`/api/journal/${id}`, { method: 'DELETE' });
    showToast('Zápis bol zmazaný');
    loadJournal();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============ Journal PDFs ============
function setupJournalPdfs() {
  const area = document.getElementById('journal-upload-area');
  const input = document.getElementById('journal-file-input');

  area.addEventListener('click', () => input.click());
  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('dragover');
  });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      pendingFile = e.dataTransfer.files[0];
      showJournalUploadForm();
    }
  });
  input.addEventListener('change', () => {
    if (input.files.length) {
      pendingFile = input.files[0];
      showJournalUploadForm();
    }
  });

  document.getElementById('journal-pdf-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pendingFile) return;

    const formData = new FormData();
    formData.append('file', pendingFile);
    formData.append('year', document.getElementById('journal-pdf-year').value);
    formData.append('description', document.getElementById('journal-pdf-desc').value);

    try {
      await apiUpload('/api/journal-pdfs', formData);
      showToast('Účtovný denník bol nahraný');
      pendingFile = null;
      document.getElementById('journal-upload-form').style.display = 'none';
      document.getElementById('journal-file-input').value = '';
      loadJournalPdfs();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function showJournalUploadForm() {
  document.getElementById('journal-upload-form').style.display = '';
  document.getElementById('journal-pdf-desc').value = pendingFile ? `Účtovný denník - ${pendingFile.name}` : '';
}

async function loadJournalPdfs() {
  const pdfs = await api('/api/journal-pdfs');
  const tbody = document.getElementById('journal-pdfs-tbody');
  const empty = document.getElementById('journal-pdfs-empty');

  if (pdfs.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  tbody.innerHTML = pdfs.map(pdf => `
    <tr>
      <td>${pdf.year || '-'}</td>
      <td><a href="/uploads/journals/${pdf.filename}" target="_blank" class="file-link">${pdf.original_name}</a></td>
      <td>${pdf.description || '-'}</td>
      <td>${new Date(pdf.uploaded_at).toLocaleDateString('sk-SK')}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteJournalPdf(${pdf.id})">Zmazať</button>
      </td>
    </tr>
  `).join('');
}

async function deleteJournalPdf(id) {
  if (!confirm('Naozaj chcete zmazať tento denník?')) return;
  try {
    await api(`/api/journal-pdfs/${id}`, { method: 'DELETE' });
    showToast('Denník bol zmazaný');
    loadJournalPdfs();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============ Category management ============
function setupCategoryManagement() {
  document.getElementById('btn-add-category')?.addEventListener('click', () => {
    document.getElementById('modal-category').style.display = '';
    document.getElementById('cat-name').value = '';
    document.getElementById('cat-md').value = '';
    document.getElementById('cat-d').value = '';
    document.getElementById('cat-desc').value = '';
  });

  document.getElementById('modal-category-close')?.addEventListener('click', () => {
    document.getElementById('modal-category').style.display = 'none';
  });

  document.getElementById('category-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('cat-name').value,
          account_md: document.getElementById('cat-md').value,
          account_d: document.getElementById('cat-d').value,
          description: document.getElementById('cat-desc').value,
        }),
      });
      document.getElementById('modal-category').style.display = 'none';
      showToast('Kategória bola pridaná');
      await loadCategories();
      renderCategories();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function renderCategories() {
  const tbody = document.getElementById('categories-tbody');
  tbody.innerHTML = categories.map(cat => `
    <tr>
      <td><strong>${cat.name}</strong></td>
      <td>${cat.account_md}</td>
      <td>${cat.account_d}</td>
      <td>${cat.description || '-'}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteCategory(${cat.id})">Zmazať</button>
      </td>
    </tr>
  `).join('');
}

async function deleteCategory(id) {
  if (!confirm('Naozaj chcete zmazať túto kategóriu?')) return;
  try {
    await api(`/api/categories/${id}`, { method: 'DELETE' });
    showToast('Kategória bola zmazaná');
    await loadCategories();
    renderCategories();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============ Helpers ============
function formatMoney(amount) {
  return new Intl.NumberFormat('sk-SK', {
    style: 'currency',
    currency: 'EUR',
  }).format(amount);
}
