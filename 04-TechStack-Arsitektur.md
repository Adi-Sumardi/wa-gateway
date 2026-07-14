# Tech Stack & Arsitektur — SendaGo WA Gateway

## 1. Arsitektur Tingkat Tinggi

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│  Dashboard (Web) │◄────►│   Backend API      │◄────►│  Gateway Engine      │
│  React/Next.js    │ REST │  Node.js/NestJS   │ Redis│  whatsapp-web.js     │
│  + WebSocket       │  WS  │  + Socket.io      │ Queue│  (1 proses/device)   │
└─────────────────┘      └──────────────────┘      └─────────────────────┘
                                   │                          │
                                   ▼                          ▼
                          ┌────────────────┐         ┌─────────────────┐
                          │  PostgreSQL     │         │  Session Store    │
                          │  (data utama)   │         │  (Redis/S3/Mongo) │
                          └────────────────┘         └─────────────────┘
                                   │
                                   ▼
                          ┌────────────────┐
                          │  BullMQ + Redis │
                          │  (antrian pesan)│
                          └────────────────┘
```

**Kenapa dipisah jadi Backend API vs Gateway Engine (bukan satu proses)?**
Karena tiap sesi `whatsapp-web.js` menjalankan instance browser headless (Puppeteer) yang berat & rawan crash. Kalau digabung dengan API utama, satu sesi WA yang crash bisa menjatuhkan seluruh backend. Dipisah supaya lebih stabil dan gampang di-restart/scale per device.

## 2. Rekomendasi Tech Stack

### 2.1 Gateway Engine (inti WA)
| Komponen | Pilihan | Alasan |
|---|---|---|
| Runtime | Node.js 20 LTS | Wajib, karena `whatsapp-web.js` adalah library Node.js |
| Library WA | `whatsapp-web.js` | Sesuai kebutuhan awal (unofficial, gratis) |
| Automation engine | Puppeteer (bundled) | Dipakai internal oleh whatsapp-web.js |
| Process manager | PM2 | Auto-restart tiap proses device kalau crash, monitoring resource |
| Containerisasi per device | Docker | Isolasi resource, gampang scale/restart tiap sesi tanpa ganggu sesi lain |
| Session persistence | `RemoteAuth` (whatsapp-web.js) + MongoDB/S3 | Supaya sesi tidak hilang saat container restart (tidak perlu scan ulang QR) |

### 2.2 Backend API
| Komponen | Pilihan | Alasan |
|---|---|---|
| Framework | NestJS (TypeScript) | Struktur modular, cocok untuk sistem dengan banyak domain (device, broadcast, contact, dst), built-in dependency injection |
| Alternatif ringan | Express.js + TypeScript | Kalau tim mau lebih simpel/cepat setup |
| Database utama | PostgreSQL | Relasional, cocok untuk data terstruktur (kontak, broadcast, log) dengan relasi jelas |
| ORM | Prisma | Type-safe, migration mudah, cocok dipakai bareng TypeScript |
| Queue & rate-limiting | BullMQ + Redis | Untuk antrian broadcast dengan delay/jeda anti-spam, retry otomatis kalau gagal |
| Realtime update | Socket.io | Update status device & pesan masuk real-time ke dashboard tanpa polling |
| Autentikasi | JWT + refresh token | Standar untuk session dashboard & API Key terpisah untuk akses eksternal |
| Validasi | class-validator / Zod | Validasi input API |

### 2.3 Dashboard Frontend
| Komponen | Pilihan | Alasan |
|---|---|---|
| Framework | Next.js (React) | SSR untuk performa awal, ekosistem besar, mudah cari developer |
| Styling | Tailwind CSS | Cepat untuk membangun UI konsisten sesuai desain |
| Komponen UI | shadcn/ui | Komponen siap pakai, mudah dikustomisasi (tabel, modal, dsb) |
| State/data fetching | TanStack Query (React Query) | Cocok untuk data yang sering update (status device, log) |
| Grafik | Recharts / Chart.js | Untuk visualisasi volume pesan & statistik |
| Realtime client | socket.io-client | Terima update device/pesan real-time |

### 2.4 Infrastruktur & DevOps
| Komponen | Pilihan | Alasan |
|---|---|---|
| Hosting | VPS (mis. skala kecil-menengah) dengan minimal 4 vCPU / 8GB RAM untuk 5 device aktif | Tiap sesi Puppeteer cukup memakan RAM (~150–300MB/sesi) |
| Reverse proxy | Nginx + Let's Encrypt (HTTPS wajib) | Keamanan komunikasi dashboard↔API |
| Orkestrasi | Docker Compose (skala kecil) → bisa naik ke Kubernetes kalau device makin banyak | Docker Compose cukup untuk fase awal |
| Monitoring | Grafana + Prometheus, atau lebih ringan: Uptime Kuma | Pantau uptime tiap device & resource server |
| Log terstruktur | Pino/Winston + kirim ke file/Loki | Debug sesi WA yang putus |
| Backup | Backup terjadwal PostgreSQL + session store | Antisipasi data hilang |

## 3. Estimasi Kebutuhan Resource (Panduan Kasar)

| Jumlah Device Aktif | RAM Disarankan | vCPU Disarankan |
|---|---|---|
| 1–3 device | 4 GB | 2 vCPU |
| 4–8 device | 8 GB | 4 vCPU |
| 9–15 device | 16 GB | 6–8 vCPU |

> Catatan: karena tiap device = 1 instance Chromium headless, resource bertambah **linear**, bukan sekadar tambah storage. Ini beda jauh dengan API resmi WhatsApp Business yang tidak butuh browser instance per nomor.

## 4. Rekomendasi Urutan Development (MVP → Lanjutan)

**Fase 1 — MVP (fokus mengganti fungsi dasar Watzap/SaungWA):**
1. Gateway Engine: koneksi 1 device, kirim/terima pesan dasar
2. Backend API: endpoint kirim pesan + webhook masuk
3. Dashboard: halaman device (QR scan) + kirim pesan manual + log dasar

**Fase 2 — Broadcast & Kontak:**
4. Manajemen kontak & import CSV
5. Template pesan + broadcast dengan rate-limiter
6. Dashboard statistik & grafik

**Fase 3 — Skala & Operasional:**
7. Multi-device, auto-reconnect, role & permission
8. Inbox terpusat + auto-reply keyword
9. Monitoring & alerting (device disconnect notification ke Telegram/email admin)

**Fase 4 — Pertimbangan Jangka Panjang:**
10. Evaluasi migrasi use case kritikal (OTP, transaksi) ke WhatsApp Business API resmi, sementara broadcast promosi tetap di self-hosted gateway
