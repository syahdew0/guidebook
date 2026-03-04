# Guidebook Web App

Aplikasi guidebook web dengan fitur:

- Login wajib (username + password)
- Role-based access:
  - `admin`: kelola level 2 & level 3, edit, simpan, unduh PDF
  - `user`: preview saja, unduh PDF
- Struktur 3 level:
  - Level 1: workspace (contoh `PSG DOCS`)
  - Level 2: guidebook (contoh `OTP Guidebook`, `Airbnb Guidebook`)
  - Level 3: sub dokumen (contoh `Clocking Karyawan`, `Cuti Karyawan`)
- Editor rich text (heading, bold, italic, underline, list, link, align, warna, image)
- Download dokumen PDF (termasuk gambar dan format inline dasar)

## Jalankan aplikasi

1. Install dependency:

```bash
npm install
```

2. Jalankan server:

```bash
npm start
```

3. Buka browser:

```text
http://localhost:3000
```

## Default akun

- Admin: `admin / admin123`
- User: `user / user123`

## Penyimpanan data

Aplikasi mendukung 2 mode penyimpanan otomatis:

- **MySQL**: jika env MySQL diisi
- **File JSON** (`data/guidebook.json`): fallback jika env MySQL tidak diisi

Saat startup, server akan log mode aktif pada `Storage mode`.

## Konfigurasi MySQL

Pilih salah satu:

- `MYSQL_URL`
- atau kombinasi:
  - `MYSQL_HOST`
  - `MYSQL_PORT` (opsional, default `3306`)
  - `MYSQL_USER`
  - `MYSQL_PASSWORD` (opsional)
  - `MYSQL_DATABASE`
  - `MYSQL_POOL_SIZE` (opsional, default `10`)

Contoh:

```bash
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=secret
MYSQL_DATABASE=guidebook_db
```

Atau:

```bash
MYSQL_URL=mysql://root:secret@127.0.0.1:3306/guidebook_db
```

Tabel akan dibuat otomatis saat server start.

Jika perlu init manual, gunakan:

- [database/init.sql](/Users/itgroup/Documents/program_code/guidebook/database/init.sql)

## Environment variable lain

- `PORT`
- `SESSION_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `USER_USERNAME`
- `USER_PASSWORD`

## Deploy Production (Docker)

1. Copy file env production:

```bash
cp .env.production.example .env.production
```

2. Edit `.env.production` lalu wajib ganti:
- `SESSION_SECRET`
- `ADMIN_PASSWORD`
- `USER_PASSWORD`
- `MYSQL_PASSWORD`
- `MYSQL_ROOT_PASSWORD`

3. Jalankan container:

```bash
docker compose up -d --build
```

4. Verifikasi aplikasi:

```bash
docker compose logs -f app
```

Pastikan log menampilkan:
- `Guidebook app running at http://localhost:3000`
- `Storage mode : MySQL`

5. Health check:

```bash
curl http://localhost:3000/healthz
```

Jika sukses, output:

```json
{"ok":true}
```
