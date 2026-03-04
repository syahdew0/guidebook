const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');

function loadDotEnvFromFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf-8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      return;
    }

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
}

loadDotEnvFromFile();

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const DATA_DIR = path.join(__dirname, 'data');
const GUIDEBOOK_FILE = path.join(DATA_DIR, 'guidebook.json');
const GUIDEBOOK_STORE_KEY = 'main';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const USER_USERNAME = process.env.USER_USERNAME || 'user';
const USER_PASSWORD = process.env.USER_PASSWORD || 'user123';

const users = [
  {
    username: ADMIN_USERNAME,
    role: 'admin',
    passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10)
  },
  {
    username: USER_USERNAME,
    role: 'user',
    passwordHash: bcrypt.hashSync(USER_PASSWORD, 10)
  }
];

function createMySqlPool() {
  const hasMysqlConfig =
    !!process.env.MYSQL_URL ||
    (!!process.env.MYSQL_HOST && !!process.env.MYSQL_USER && !!process.env.MYSQL_DATABASE);

  if (!hasMysqlConfig) {
    return null;
  }

  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (error) {
    throw new Error('MYSQL config terdeteksi tapi dependency `mysql2` belum terpasang. Jalankan: npm install');
  }

  if (process.env.MYSQL_URL) {
    return mysql.createPool(process.env.MYSQL_URL);
  }

  return mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10)
  });
}

const mysqlPool = createMySqlPool();
let initPromise = null;

function buildDefaultGuidebook() {
  const now = new Date().toISOString();
  return {
    title: 'PSG DOCS',
    books: [
      {
        id: 'otp-guidebook',
        title: 'OTP Guidebook',
        docs: [
          {
            id: 'doc-clock-karyawan',
            title: 'Clocking Karyawan',
            contentHtml:
              '<h1>Clocking Karyawan</h1><p>Isi panduan clocking karyawan. Admin bisa mengedit dokumen ini.</p>',
            updatedAt: now
          }
        ]
      }
    ],
    updatedAt: now
  };
}

function stripHtml(value) {
  return (value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return (value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#65279;|&#xfeff;/gi, '')
    .replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function readAttr(attrs, attrName) {
  const match = (attrs || '').match(new RegExp(`${attrName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? match[2] : '';
}

function extractAlign(attrs) {
  const className = readAttr(attrs, 'class');
  if (className.includes('ql-align-center')) {
    return 'center';
  }
  if (className.includes('ql-align-right')) {
    return 'right';
  }
  return 'left';
}

function extractImagePercent(attrs) {
  const dataWidth = Number.parseInt(readAttr(attrs, 'data-width'), 10);
  if (!Number.isNaN(dataWidth) && dataWidth >= 10 && dataWidth <= 100) {
    return dataWidth;
  }

  const widthAttr = readAttr(attrs, 'width');
  const widthMatch = (widthAttr || '').match(/(\d+)\s*%/);
  if (widthMatch) {
    return Math.max(10, Math.min(100, Number.parseInt(widthMatch[1], 10)));
  }

  const styleAttr = readAttr(attrs, 'style');
  const styleMatch = (styleAttr || '').match(/width:\s*(\d+)\s*%/i);
  if (styleMatch) {
    return Math.max(10, Math.min(100, Number.parseInt(styleMatch[1], 10)));
  }

  return 100;
}

function ensurePageSpace(pdf, requiredHeight) {
  const bottomLimit = pdf.page.height - pdf.page.margins.bottom;
  if (pdf.y + requiredHeight > bottomLimit) {
    pdf.addPage();
  }
}

function fetchRemoteBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects while downloading image'));
      return;
    }

    const transport = url.startsWith('https://') ? https : http;
    const request = transport.get(url, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        const nextUrl = new URL(location, url).toString();
        response.resume();
        resolve(fetchRemoteBuffer(nextUrl, redirectCount + 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Failed to download image: HTTP ${statusCode}`));
        return;
      }

      const chunks = [];
      let totalLength = 0;
      response.on('data', (chunk) => {
        totalLength += chunk.length;
        if (totalLength > 15 * 1024 * 1024) {
          request.destroy(new Error('Image too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('Image download timeout'));
    });
  });
}

async function resolveImageBuffer(src) {
  if (!src) {
    return null;
  }

  const compactSrc = src.replace(/\s+/g, '');
  const isBase64Image = /^data:image\/[a-z0-9+.-]+(?:;[a-z0-9+.-]+=[^;,]+)*;base64,/i.test(compactSrc);
  if (isBase64Image) {
    const base64Data = compactSrc.replace(
      /^data:image\/[a-z0-9+.-]+(?:;[a-z0-9+.-]+=[^;,]+)*;base64,/i,
      ''
    );
    return Buffer.from(base64Data, 'base64');
  }

  if (/^https?:\/\//i.test(compactSrc)) {
    return fetchRemoteBuffer(compactSrc);
  }

  return null;
}

async function renderImageToPdf(pdf, imgAttrs, inheritedAlign = 'left') {
  const src = readAttr(imgAttrs, 'src');
  if (!src) {
    return;
  }

  let buffer;
  let openedImage;
  try {
    buffer = await resolveImageBuffer(src);
    if (!buffer) {
      return;
    }
    openedImage = pdf.openImage(buffer);
  } catch (error) {
    return;
  }
  if (!openedImage || !openedImage.width || !openedImage.height) {
    return;
  }

  const percent = extractImagePercent(imgAttrs);
  const contentWidth = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
  const drawWidth = Math.max(40, contentWidth * (percent / 100));
  const drawHeight = (openedImage.height / openedImage.width) * drawWidth;
  ensurePageSpace(pdf, drawHeight + 10);

  const align = extractAlign(imgAttrs) || inheritedAlign;
  let drawX = pdf.page.margins.left;
  if (align === 'center') {
    drawX = pdf.page.margins.left + (contentWidth - drawWidth) / 2;
  } else if (align === 'right') {
    drawX = pdf.page.margins.left + (contentWidth - drawWidth);
  }

  const drawY = pdf.y;
  pdf.image(buffer, drawX, drawY, { width: drawWidth });
  pdf.y = drawY + drawHeight + 10;
}

function renderTextToPdf(pdf, text, tag, align = 'left') {
  const raw = text || '';
  if (!raw.trim()) {
    return;
  }

  let fontSize = 12;
  if (tag === 'h1') {
    fontSize = 22;
  } else if (tag === 'h2') {
    fontSize = 18;
  } else if (tag === 'h3') {
    fontSize = 16;
  }

  const inlineSegments = [];
  const stack = [{ bold: false, italic: false, underline: false }];
  const tokenRegex = /(<\/?[a-z0-9]+(?:\s[^>]*)?>)|([^<]+)/gi;
  let tokenMatch;

  while ((tokenMatch = tokenRegex.exec(raw)) !== null) {
    const tagToken = tokenMatch[1];
    const textToken = tokenMatch[2];

    if (textToken) {
      const top = stack[stack.length - 1];
      const normalizedText = decodeHtmlEntities(textToken);
      if (normalizedText) {
        inlineSegments.push({
          text: normalizedText,
          bold: top.bold,
          italic: top.italic,
          underline: top.underline
        });
      }
      continue;
    }

    if (!tagToken) {
      continue;
    }

    const lowerTag = tagToken.toLowerCase();
    if (lowerTag === '<br>' || lowerTag === '<br/>' || lowerTag === '<br />') {
      inlineSegments.push({ text: '\n', bold: false, italic: false, underline: false });
      continue;
    }

    const isClosing = /^<\//.test(lowerTag);
    const tagNameMatch = lowerTag.match(/^<\/?([a-z0-9]+)/);
    const tagName = tagNameMatch ? tagNameMatch[1] : '';
    if (!tagName) {
      continue;
    }

    if (isClosing) {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    const current = stack[stack.length - 1];
    const next = {
      bold: current.bold || tagName === 'strong' || tagName === 'b',
      italic: current.italic || tagName === 'em' || tagName === 'i',
      underline: current.underline || tagName === 'u'
    };
    stack.push(next);
  }

  if (inlineSegments.length === 0) {
    return;
  }

  const drawOptions = { align };
  inlineSegments.forEach((segment, index) => {
    let fontName = 'Helvetica';
    if (segment.bold && segment.italic) {
      fontName = 'Helvetica-BoldOblique';
    } else if (segment.bold) {
      fontName = 'Helvetica-Bold';
    } else if (segment.italic) {
      fontName = 'Helvetica-Oblique';
    }

    pdf
      .fillColor('black')
      .font(fontName)
      .fontSize(fontSize)
      .text(segment.text, {
        ...drawOptions,
        underline: segment.underline,
        continued: index < inlineSegments.length - 1
      });
  });

  pdf.moveDown(tag.startsWith('h') ? 0.5 : 0.2);
}

async function renderHtmlToPdf(pdf, html) {
  const blockRegex = /<(h1|h2|h3|p|li|blockquote|div|pre|ol|ul)[^>]*>[\s\S]*?<\/\1>|<img[^>]*>/gi;
  const blocks = (html || '').match(blockRegex) || [];
  let renderedImageCount = 0;

  if (blocks.length === 0) {
    renderTextToPdf(pdf, html, 'p', 'left');
    return;
  }

  for (const block of blocks) {
    const imageOnlyMatch = block.match(/^<img([^>]*)>$/i);
    if (imageOnlyMatch) {
      await renderImageToPdf(pdf, imageOnlyMatch[1], 'left');
      renderedImageCount += 1;
      continue;
    }

    const blockMatch = block.match(/^<(h1|h2|h3|p|li|blockquote|div|pre|ol|ul)([^>]*)>([\s\S]*?)<\/\1>$/i);
    if (!blockMatch) {
      return;
    }

    const [, tag, attrs, innerHtml] = blockMatch;
    const normalizedTag = tag.toLowerCase();
    const align = extractAlign(attrs);
    const parts = innerHtml.split(/(<img[^>]*>)/gi).filter(Boolean);

    if (normalizedTag === 'ol' || normalizedTag === 'ul') {
      const items = innerHtml.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
      for (const [index, liHtml] of items.entries()) {
        const liMatch = liHtml.match(/^<li([^>]*)>([\s\S]*?)<\/li>$/i);
        if (!liMatch) {
          continue;
        }

        const [, liAttrs, liInner] = liMatch;
        const liAlign = extractAlign(liAttrs) || align;
        const liParts = liInner.split(/(<img[^>]*>)/gi).filter(Boolean);
        const marker = normalizedTag === 'ol' ? `${index + 1}. ` : '- ';
        let textStarted = false;

        for (const part of liParts) {
          const liImgMatch = part.match(/^<img([^>]*)>$/i);
          if (liImgMatch) {
            await renderImageToPdf(pdf, liImgMatch[1], liAlign);
            renderedImageCount += 1;
          } else {
            const text = textStarted ? part : `${marker}${part}`;
            textStarted = true;
            renderTextToPdf(pdf, text, 'li', liAlign);
          }
        }
      }
      continue;
    }

    for (const part of parts) {
      const imgPartMatch = part.match(/^<img([^>]*)>$/i);
      if (imgPartMatch) {
        await renderImageToPdf(pdf, imgPartMatch[1], align);
        renderedImageCount += 1;
      } else {
        const withBullet = normalizedTag === 'li' ? `- ${part}` : part;
        renderTextToPdf(pdf, withBullet, normalizedTag, align);
      }
    }
  }

  if (renderedImageCount === 0 && /<img\b/i.test(html || '')) {
    const imageMatches = (html || '').match(/<img[^>]*>/gi) || [];
    for (const imageTag of imageMatches) {
      const match = imageTag.match(/^<img([^>]*)>$/i);
      if (!match) {
        continue;
      }
      await renderImageToPdf(pdf, match[1], 'left');
    }
  }
}

function slugify(input) {
  return (input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function migrateLegacyData(data) {
  if (Array.isArray(data.books)) {
    return data;
  }

  const now = new Date().toISOString();
  const workspaceTitle = 'PSG DOCS';
  const bookTitle = data.title || 'OTP Guidebook';

  let docs = [];
  if (Array.isArray(data.docs) && data.docs.length > 0) {
    docs = data.docs;
  } else {
    const legacyContent = data.content || '';
    const contentHtml = `<h1>${bookTitle}</h1><p>${legacyContent.replace(/\n+/g, '</p><p>')}</p>`;
    docs = [
      {
        id: slugify(bookTitle) || `doc-${Date.now()}`,
        title: bookTitle,
        contentHtml,
        updatedAt: data.updatedAt || now
      }
    ];
  }

  return {
    title: workspaceTitle,
    books: [
      {
        id: slugify(bookTitle) || `book-${Date.now()}`,
        title: bookTitle,
        docs
      }
    ],
    updatedAt: data.updatedAt || now
  };
}

async function ensureMysqlSchema() {
  if (!mysqlPool) {
    return;
  }

  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS guidebook_store (
      store_key VARCHAR(64) PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function readRawPayload() {
  if (mysqlPool) {
    const [rows] = await mysqlPool.query('SELECT payload FROM guidebook_store WHERE store_key = ?', [GUIDEBOOK_STORE_KEY]);
    if (!rows.length) {
      return null;
    }
    return JSON.parse(rows[0].payload);
  }

  if (!fs.existsSync(GUIDEBOOK_FILE)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(GUIDEBOOK_FILE, 'utf-8'));
}

async function writeRawPayload(payload) {
  if (mysqlPool) {
    await mysqlPool.query(
      `INSERT INTO guidebook_store (store_key, payload)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP`,
      [GUIDEBOOK_STORE_KEY, JSON.stringify(payload)]
    );
    return;
  }

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(GUIDEBOOK_FILE, JSON.stringify(payload, null, 2));
}

async function ensureDataInitialized() {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (mysqlPool) {
      await ensureMysqlSchema();
    }

    const current = await readRawPayload();
    if (!current) {
      await writeRawPayload(buildDefaultGuidebook());
    }
  })();

  return initPromise;
}

async function loadGuidebook() {
  await ensureDataInitialized();
  const raw = await readRawPayload();
  const normalized = migrateLegacyData(raw || buildDefaultGuidebook());

  if (!raw || !Array.isArray(raw.books)) {
    await writeRawPayload(normalized);
  }

  return normalized;
}

async function saveGuidebook(payload) {
  await ensureDataInitialized();
  await writeRawPayload(payload);
}

async function sendPdfResponse(res, title, updatedAt, contentHtml) {
  const safeFilename = (title || 'guidebook').replace(/\s+/g, '-').toLowerCase();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);

  const pdf = new PDFDocument({ margin: 50 });
  pdf.pipe(res);

  pdf.fontSize(22).text(title || 'Guidebook', { underline: true });
  pdf.moveDown();
  pdf
    .fontSize(10)
    .fillColor('gray')
    .text(`Terakhir diupdate: ${new Date(updatedAt || Date.now()).toLocaleString()}`);
  pdf.moveDown(1.5);

  await renderHtmlToPdf(pdf, contentHtml || '<p>-</p>');
  pdf.end();
}

function findBookById(guidebook, id) {
  return (guidebook.books || []).find((book) => book.id === id);
}

function findDocById(guidebook, id) {
  for (const book of guidebook.books || []) {
    const doc = (book.docs || []).find((item) => item.id === id);
    if (doc) {
      return { doc, book };
    }
  }
  return { doc: null, book: null };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).render('error', {
        message: 'Akses ditolak. Anda tidak memiliki izin untuk membuka halaman ini.'
      });
    }
    return next();
  };
}

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (IS_PROD) {
  app.set('trust proxy', 1);
}
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'guidebook-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD
    }
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

app.get('/', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  return res.redirect('/guidebook');
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/guidebook');
  }
  return res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const found = users.find((u) => u.username === username);

  if (!found || !bcrypt.compareSync(password, found.passwordHash)) {
    return res.status(401).render('login', { error: 'Username atau password salah.' });
  }

  req.session.user = {
    username: found.username,
    role: found.role
  };

  return res.redirect('/guidebook');
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get(
  '/guidebook',
  requireAuth,
  asyncHandler(async (req, res) => {
    const guidebook = await loadGuidebook();
    const books = guidebook.books || [];
    const selectedBookId = req.query.book || (books[0] && books[0].id);
    const selectedBook = findBookById(guidebook, selectedBookId) || books[0] || null;
    return res.render('guidebook-index', {
      guidebook,
      books,
      selectedBook,
      docs: selectedBook ? selectedBook.docs || [] : [],
      isAdmin: req.session.user.role === 'admin'
    });
  })
);

app.post(
  '/guidebook/books',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const guidebook = await loadGuidebook();
    const title = (req.body.title || '').trim() || 'Guidebook Baru';
    const now = new Date().toISOString();
    const idBase = slugify(title) || `book-${Date.now()}`;
    let id = idBase;
    let suffix = 1;
    while ((guidebook.books || []).some((book) => book.id === id)) {
      id = `${idBase}-${suffix}`;
      suffix += 1;
    }

    guidebook.books = guidebook.books || [];
    guidebook.books.push({ id, title, docs: [] });
    guidebook.updatedAt = now;

    await saveGuidebook(guidebook);
    return res.redirect(`/guidebook?book=${id}`);
  })
);

app.post(
  '/guidebook/books/:bookId/docs',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const guidebook = await loadGuidebook();
    const selectedBook = findBookById(guidebook, req.params.bookId);
    if (!selectedBook) {
      return res.status(404).render('error', { message: 'Guidebook level 2 tidak ditemukan.' });
    }

    const title = (req.body.title || '').trim() || 'Dokumen Baru';
    const now = new Date().toISOString();
    const idBase = slugify(title) || `doc-${Date.now()}`;

    let id = idBase;
    let suffix = 1;
    while ((selectedBook.docs || []).some((doc) => doc.id === id)) {
      id = `${idBase}-${suffix}`;
      suffix += 1;
    }

    selectedBook.docs = selectedBook.docs || [];
    selectedBook.docs.push({
      id,
      title,
      contentHtml: `<h1>${title}</h1><p>Mulai tulis isi dokumen di sini.</p>`,
      updatedAt: now
    });
    guidebook.updatedAt = now;

    await saveGuidebook(guidebook);
    return res.redirect(`/guidebook/docs/${id}`);
  })
);

app.get(
  '/guidebook/docs/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const guidebook = await loadGuidebook();
    const { doc: selectedDoc, book: parentBook } = findDocById(guidebook, req.params.id);

    if (!selectedDoc) {
      return res.status(404).render('error', { message: 'Dokumen tidak ditemukan.' });
    }

    return res.render('guidebook-doc', {
      guidebook,
      doc: selectedDoc,
      parentBook,
      isAdmin: req.session.user.role === 'admin',
      saved: req.query.saved === '1',
      books: guidebook.books || []
    });
  })
);

app.post(
  '/guidebook/docs/:id/save',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const guidebook = await loadGuidebook();
    const { doc: selectedDoc } = findDocById(guidebook, req.params.id);

    if (!selectedDoc) {
      return res.status(404).render('error', { message: 'Dokumen tidak ditemukan.' });
    }

    const nextTitle = (req.body.title || '').trim() || selectedDoc.title;
    const nextContentHtml = (req.body.contentHtml || '<p></p>').replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '');

    selectedDoc.title = nextTitle;
    selectedDoc.contentHtml = nextContentHtml;
    selectedDoc.updatedAt = new Date().toISOString();
    guidebook.updatedAt = selectedDoc.updatedAt;

    await saveGuidebook(guidebook);
    return res.redirect(`/guidebook/docs/${selectedDoc.id}?saved=1`);
  })
);

app.get(
  '/guidebook/docs/:id/pdf',
  requireAuth,
  asyncHandler(async (req, res) => {
    const guidebook = await loadGuidebook();
    const { doc: selectedDoc } = findDocById(guidebook, req.params.id);

    if (!selectedDoc) {
      return res.status(404).render('error', { message: 'Dokumen tidak ditemukan.' });
    }

    await sendPdfResponse(res, selectedDoc.title, selectedDoc.updatedAt, selectedDoc.contentHtml);
  })
);

app.post(
  '/guidebook/docs/:id/pdf',
  requireAuth,
  asyncHandler(async (req, res) => {
    const guidebook = await loadGuidebook();
    const { doc: selectedDoc } = findDocById(guidebook, req.params.id);

    if (!selectedDoc) {
      return res.status(404).render('error', { message: 'Dokumen tidak ditemukan.' });
    }

    // Admin dapat mengunduh PDF langsung dari isi editor terkini (belum disimpan pun bisa).
    const requestedTitle = (req.body.title || '').trim();
    const requestedHtml = (req.body.contentHtml || '').trim();
    const isAdmin = req.session.user && req.session.user.role === 'admin';

    const title = isAdmin && requestedTitle ? requestedTitle : selectedDoc.title;
    const contentHtml = isAdmin && requestedHtml ? requestedHtml : selectedDoc.contentHtml;
    const updatedAt = isAdmin && requestedHtml ? new Date().toISOString() : selectedDoc.updatedAt;

    await sendPdfResponse(res, title, updatedAt, contentHtml);
  })
);

app.use((req, res) => {
  res.status(404).render('error', { message: 'Halaman tidak ditemukan.' });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) {
    return next(error);
  }
  return res.status(500).render('error', { message: 'Terjadi kesalahan internal server.' });
});

(async () => {
  try {
    await ensureDataInitialized();
    app.listen(PORT, () => {
      console.log(`Guidebook app running at http://localhost:${PORT}`);
      console.log(`Storage mode : ${mysqlPool ? 'MySQL' : 'File JSON'}`);
      console.log(`Admin login  : ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
      console.log(`User login   : ${USER_USERNAME} / ${USER_PASSWORD}`);
    });
  } catch (error) {
    console.error('Gagal inisialisasi aplikasi:', error);
    process.exit(1);
  }
})();
