# BRD & SRS — WA Gateway Dashboard (Self-Hosted)
**Codename:** SendaGo — WhatsApp Gateway & Broadcast Platform
**Versi Dokumen:** 1.0
**Tanggal:** 14 Juli 2026
**Basis Teknis:** whatsapp-web.js (unofficial WhatsApp Web client library)

---

# BAGIAN 1 — BUSINESS REQUIREMENT DOCUMENT (BRD)

## 1.1 Latar Belakang

Saat ini tim bergantung pada layanan pihak ketiga (Watzap, Saung WA, Wablas, dsb) untuk mengirim pesan WhatsApp otomatis (notifikasi, broadcast, chatbot sederhana). Layanan ini dikenakan biaya bulanan/per-pesan yang terus bertambah seiring skala penggunaan, dan menimbulkan ketergantungan operasional pada vendor eksternal (vendor lock-in).

Solusi yang diusulkan: membangun **WhatsApp Gateway internal** menggunakan library open-source `whatsapp-web.js`, dilengkapi dashboard web untuk manajemen device, kontak, template, broadcast, dan monitoring — dioperasikan di infrastruktur sendiri.

## 1.2 Tujuan Bisnis

| # | Tujuan | Indikator Keberhasilan |
|---|--------|------------------------|
| BO-1 | Menghilangkan biaya langganan bulanan ke vendor WA gateway pihak ketiga | Biaya operasional WA gateway turun ≥70% dalam 3 bulan setelah go-live |
| BO-2 | Kontrol penuh atas data pesan & kontak (tidak lewat server vendor luar) | 100% data pesan tersimpan di infrastruktur sendiri |
| BO-3 | Fleksibilitas fitur (custom sesuai kebutuhan internal) | Tim bisa menambah fitur baru tanpa bergantung roadmap vendor |
| BO-4 | Operasional mandiri, tidak tergantung uptime pihak ketiga | Uptime gateway ≥95% (self-hosted, dengan risiko yang disadari — lihat 1.5) |

## 1.3 Ruang Lingkup Bisnis

**Termasuk dalam scope:**
- Koneksi multi-nomor WhatsApp (multi-device) via scan QR
- Kirim pesan personal & broadcast (blast) massal dengan jeda anti-spam
- Auto-reply / chatbot sederhana berbasis keyword
- Manajemen kontak & grup kontak (segmentasi)
- Template pesan (termasuk media: gambar, dokumen)
- Webhook untuk integrasi ke sistem lain (CRM, e-commerce, dsb)
- REST API untuk pihak internal (pengganti fungsi API Watzap/SaungWA)
- Dashboard monitoring: status koneksi device, log pengiriman, statistik

**Di luar scope (fase 1):**
- WhatsApp Business API resmi (Cloud API Meta) — dipertimbangkan di fase 2 sebagai jalur resmi untuk use case kritikal
- Fitur pembayaran/payment gateway di dalam chat
- Multi-tenant SaaS untuk dijual ke pihak luar (fase 1 hanya untuk pemakaian internal)

## 1.4 Stakeholder

| Peran | Kepentingan |
|-------|-------------|
| Product Owner / Manajemen | Efisiensi biaya, kontrol data |
| Tim Engineering | Membangun & memelihara sistem |
| Tim Operasional/CS | Pengguna harian dashboard (kirim broadcast, balas chat) |
| Tim Marketing | Broadcast promosi ke pelanggan |
| End-user (pelanggan) | Penerima pesan (tidak berinteraksi langsung dengan sistem) |

## 1.5 Risiko Bisnis & Asumsi Penting

> ⚠️ **Ini bagian paling penting untuk dibaca sebelum lanjut ke development.**

- **Risiko banned nomor:** `whatsapp-web.js` adalah library tidak resmi yang bekerja dengan mengotomasi WhatsApp Web. WhatsApp secara aktif mendeteksi pola otomasi/bot. Nomor bisa kena **banned/limited**, terutama jika dipakai untuk blast volume tinggi ke nomor yang belum pernah chat. Ini bukan skill/bug yang bisa "diperbaiki total" — ini keterbatasan inheren dari pendekatan unofficial.
- **Mitigasi:** gunakan nomor WA Business terpisah dari nomor penting, terapkan rate-limiting & delay antar pesan, hindari kirim ke nomor yang tidak pernah opt-in, siapkan mekanisme reconnect & rotasi nomor.
- **Ketergantungan pada sesi aktif:** sistem butuh HP yang tetap terhubung internet (untuk sesi WA Web), dan server yang menyala 24/7 menjalankan browser headless (Puppeteer) — beda dengan API resmi yang tidak butuh HP menyala.
- **Untuk use case kritikal** (OTP, transaksi finansial, notifikasi legal) — **disarankan tetap pakai WhatsApp Business API resmi**, bukan pendekatan ini. Sistem ini paling cocok untuk broadcast promosi, notifikasi non-kritikal, dan customer service internal skala menengah.
- Asumsi: tim punya kapasitas DevOps untuk maintain VPS/server 24/7.

## 1.6 Ringkasan Biaya vs Vendor Eksternal

| Komponen | Vendor Pihak Ketiga | Self-hosted |
|----------|---------------------|-------------|
| Biaya bulanan | Rp 100rb–1jt+/nomor/bulan | Biaya VPS (~Rp 100–300rb/bulan untuk skala kecil-menengah) |
| Biaya per pesan | Kadang ada | Tidak ada |
| Kontrol data | Di server vendor | Di server sendiri |
| Maintenance | Ditanggung vendor | Ditanggung tim sendiri |
| Risiko banned | Sama-sama ada (tergantung metode vendor) | Ada, mitigasi manual |

---

# BAGIAN 2 — SOFTWARE REQUIREMENT SPECIFICATION (SRS)

## 2.1 Pendahuluan

### 2.1.1 Tujuan Dokumen
Dokumen ini mendefinisikan kebutuhan fungsional dan non-fungsional untuk sistem **SendaGo**, sebuah platform WhatsApp Gateway self-hosted dengan dashboard manajemen.

### 2.1.2 Definisi & Istilah

| Istilah | Definisi |
|---------|----------|
| Device/Session | Satu koneksi nomor WhatsApp yang login via QR code |
| Broadcast/Blast | Pengiriman pesan massal ke banyak kontak sekaligus |
| Webhook | URL callback yang dipanggil sistem saat ada event (pesan masuk, status kirim) |
| API Key | Token otentikasi untuk mengakses REST API dari luar |
| Template | Format pesan siap pakai dengan variabel (contoh: `{{nama}}`) |
| Rate Limiter | Mekanisme jeda antar pengiriman pesan untuk menghindari deteksi spam |

### 2.1.3 Target Pengguna
- **Admin** — kelola user, device, API key, pengaturan global
- **Operator** — kirim broadcast, kelola kontak & template, balas chat
- **Viewer** — hanya lihat laporan/log (read-only)
- **External System** — konsumsi REST API via API Key

## 2.2 Deskripsi Umum Sistem

Sistem terdiri dari 3 komponen utama:
1. **Gateway Engine** — service Node.js yang menjalankan sesi `whatsapp-web.js` per device, mengelola antrian pesan, dan menangani event masuk.
2. **Backend API** — REST API + WebSocket untuk komunikasi dashboard ↔ gateway engine ↔ database.
3. **Dashboard Frontend** — web app untuk operasional harian (kelola device, broadcast, kontak, log).

## 2.3 Kebutuhan Fungsional (Functional Requirements)

### FR-1 Manajemen Device / Sesi WhatsApp
- FR-1.1 Sistem dapat menambahkan device baru dan menampilkan QR code untuk discan
- FR-1.2 Sistem menyimpan sesi login agar tidak perlu scan ulang tiap restart (session persistence)
- FR-1.3 Sistem menampilkan status device real-time: `connecting`, `connected`, `disconnected`, `banned/logged-out`
- FR-1.4 Sistem dapat logout/hapus device
- FR-1.5 Sistem mendukung multi-device (lebih dari 1 nomor WA aktif bersamaan)
- FR-1.6 Sistem auto-reconnect jika koneksi device terputus (dengan batas percobaan)

### FR-2 Manajemen Kontak
- FR-2.1 CRUD data kontak (nama, nomor, tag/label, catatan)
- FR-2.2 Import kontak dari file CSV/XLSX
- FR-2.3 Pengelompokan kontak ke dalam segmen/grup
- FR-2.4 Validasi format nomor sebelum disimpan

### FR-3 Template Pesan
- FR-3.1 CRUD template pesan berisi teks dengan variabel dinamis (`{{nama}}`, `{{no_order}}`, dst)
- FR-3.2 Template mendukung lampiran media (gambar, dokumen, video)
- FR-3.3 Preview template sebelum dikirim

### FR-4 Broadcast / Blast Pesan
- FR-4.1 Kirim pesan ke satu kontak (personal chat) dari dashboard
- FR-4.2 Kirim broadcast ke banyak kontak/segmen sekaligus menggunakan template
- FR-4.3 Personalisasi otomatis (mail-merge) dari data kontak ke variabel template
- FR-4.4 Rate-limiter: jeda acak antar pengiriman (dikonfigurasi admin, misal 5–15 detik) untuk menghindari deteksi spam
- FR-4.5 Penjadwalan broadcast (kirim nanti / recurring)
- FR-4.6 Sistem mencatat status tiap pesan: `queued`, `sent`, `delivered`, `read`, `failed`
- FR-4.7 Sistem dapat menjeda/menghentikan broadcast yang sedang berjalan

### FR-5 Inbox & Auto-Reply
- FR-5.1 Sistem menampilkan pesan masuk secara real-time di dashboard (inbox terpusat semua device)
- FR-5.2 Operator dapat membalas chat langsung dari dashboard
- FR-5.3 Auto-reply berbasis keyword sederhana (rule-based, tanpa AI)
- FR-5.4 (Opsional/fase 2) Integrasi AI untuk auto-reply cerdas

### FR-6 REST API & Webhook
- FR-6.1 Sistem menyediakan REST API untuk kirim pesan (pengganti fungsi API Watzap/SaungWA) dengan otentikasi API Key
- FR-6.2 Sistem memanggil webhook eksternal saat ada event (pesan masuk, status pengiriman berubah)
- FR-6.3 Admin dapat generate/revoke API Key
- FR-6.4 Dokumentasi API tersedia di dashboard

### FR-7 Manajemen User & Role
- FR-7.1 Login dengan email/password (dashboard)
- FR-7.2 Role-based access control: Admin, Operator, Viewer
- FR-7.3 Admin dapat menambah/menghapus user

### FR-8 Dashboard & Laporan
- FR-8.1 Ringkasan statistik: jumlah pesan terkirim/gagal, device aktif, kontak, hari ini/minggu ini/bulan ini
- FR-8.2 Grafik volume pesan dari waktu ke waktu
- FR-8.3 Log aktivitas & audit trail (siapa mengirim apa, kapan)
- FR-8.4 Export laporan ke CSV/Excel

## 2.4 Kebutuhan Non-Fungsional (Non-Functional Requirements)

| Kategori | Kebutuhan |
|----------|-----------|
| **Performa** | Antrian broadcast mampu memproses minimal 1 pesan/5 detik per device tanpa membebani server berlebihan |
| **Skalabilitas** | Arsitektur mendukung penambahan device baru tanpa downtime pada device lain |
| **Keamanan** | Password di-hash (bcrypt/argon2), API Key disimpan ter-enkripsi, komunikasi HTTPS wajib |
| **Reliabilitas** | Sesi WA otomatis reconnect; antrian pesan tidak hilang saat server restart (persistent queue) |
| **Ketersediaan** | Target uptime 95% (dengan catatan risiko unofficial library pada 1.5) |
| **Usability** | Dashboard responsif (desktop-first, tablet-friendly), status device terlihat jelas dalam 1 pandangan |
| **Maintainability** | Kode modular, logging terstruktur untuk debugging sesi WA yang putus |
| **Kepatuhan/Compliance** | Mekanisme opt-out/unsubscribe untuk kontak agar sesuai etika pengiriman pesan massal |

## 2.5 Batasan Sistem (Constraints)

- Bergantung pada stabilitas struktur internal WhatsApp Web — pembaruan dari pihak WhatsApp dapat merusak fungsi library sewaktu-waktu, butuh maintenance berkala
- Satu device = satu instance browser headless → konsumsi resource server bertambah linear dengan jumlah nomor aktif
- Tidak menjamin bebas dari pemblokiran oleh WhatsApp

## 2.6 Alur Utama (High-Level Flow)

```
Admin tambah device → scan QR → device connected
   ↓
Operator upload kontak / pilih segmen
   ↓
Operator pilih/buat template pesan
   ↓
Buat broadcast → sistem antrikan pesan (queue)
   ↓
Gateway Engine kirim pesan satu-satu dengan delay
   ↓
Status per pesan diupdate real-time ke dashboard
   ↓
Pesan masuk dari penerima → tampil di Inbox → webhook terpanggil (jika ada integrasi)
```
