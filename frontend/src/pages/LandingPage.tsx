import React, { useEffect, useState } from 'react';
import { CheckCircle2, Coins, Radio, Flame, Server, X } from 'lucide-react';

type ProductType = 'ai_credit' | 'broadcast_quota' | 'warmer_slot';

interface BundleItemRow {
  productType: ProductType;
  quotaAmount: number;
}

interface BundleRow {
  id: string;
  name: string;
  description: string | null;
  priceRp: number;
  isActive: boolean;
  items: BundleItemRow[];
}

interface Props {
  backendUrl: string;
}

const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  ai_credit: 'koin AI Bot',
  broadcast_quota: 'pesan broadcast',
  warmer_slot: 'slot WA Warmer',
};

const formatRp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

const loadSnapScript = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if ((window as any).snap) return resolve();
    const isProd = (import.meta as any).env?.VITE_MIDTRANS_IS_PRODUCTION === 'true';
    const script = document.createElement('script');
    script.src = isProd ? 'https://app.midtrans.com/snap/snap.js' : 'https://app.sandbox.midtrans.com/snap/snap.js';
    script.setAttribute('data-client-key', (import.meta as any).env?.VITE_MIDTRANS_CLIENT_KEY || '');
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Midtrans payment script'));
    document.body.appendChild(script);
  });
};

export default function LandingPage({ backendUrl }: Props) {
  const [bundles, setBundles] = useState<BundleRow[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const [showRegister, setShowRegister] = useState(false);
  const [pendingBundle, setPendingBundle] = useState<BundleRow | null>(null);
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [processing, setProcessing] = useState(false);

  const [showLeadModal, setShowLeadModal] = useState(false);
  const [leadName, setLeadName] = useState('');
  const [leadPhone, setLeadPhone] = useState('');
  const [leadEmail, setLeadEmail] = useState('');
  const [leadMessage, setLeadMessage] = useState('');
  const [submittingLead, setSubmittingLead] = useState(false);

  useEffect(() => {
    fetch(`${backendUrl}/api/bundle-packages`)
      .then((res) => (res.ok ? res.json() : []))
      .then(setBundles)
      .catch(() => setBundles([]));
  }, [backendUrl]);

  useEffect(() => {
    const flash = sessionStorage.getItem('flashMessage');
    if (flash) {
      setNotice({ type: 'success', text: flash });
      sessionStorage.removeItem('flashMessage');
    }
  }, []);

  const startBundleCheckout = async (bundle: BundleRow, tokenOverride?: string) => {
    setProcessing(true);
    try {
      const token = tokenOverride || localStorage.getItem('token');
      const res = await fetch(`${backendUrl}/api/bundle-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ bundleId: bundle.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal membuat order');

      await loadSnapScript();
      (window as any).snap.pay(data.token, {
        onSuccess: () => { window.location.href = '/'; },
        onPending: () => { window.location.href = '/'; },
        onError: () => setNotice({ type: 'error', text: 'Pembayaran gagal, silakan coba lagi.' }),
        onClose: () => { window.location.href = '/'; },
      });
    } catch (err: any) {
      setNotice({ type: 'error', text: err.message || 'Gagal memulai pembayaran' });
    } finally {
      setProcessing(false);
    }
  };

  const handleBeliSekarang = (bundle: BundleRow) => {
    const token = localStorage.getItem('token');
    if (token) {
      startBundleCheckout(bundle, token);
    } else {
      setPendingBundle(bundle);
      setShowRegister(true);
    }
  };

  const handleRegisterAndBuy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regName || !regEmail || !regPassword || regPassword.length < 8) {
      setNotice({ type: 'error', text: 'Isi nama, email, dan password (minimal 8 karakter) dengan benar' });
      return;
    }
    setProcessing(true);
    try {
      const res = await fetch(`${backendUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: regName, email: regEmail, phone: regPhone, password: regPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal mendaftar');

      localStorage.setItem('token', data.token);
      setShowRegister(false);
      if (pendingBundle) {
        await startBundleCheckout(pendingBundle, data.token);
      } else {
        window.location.href = '/';
      }
    } catch (err: any) {
      setNotice({ type: 'error', text: err.message || 'Gagal mendaftar' });
      setProcessing(false);
    }
  };

  const handleSubmitLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leadName || !leadPhone) {
      setNotice({ type: 'error', text: 'Isi nama dan nomor WhatsApp dengan benar' });
      return;
    }
    setSubmittingLead(true);
    try {
      const res = await fetch(`${backendUrl}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: leadName,
          phone: leadPhone,
          email: leadEmail || undefined,
          packageInterest: 'paket_pasangin',
          message: leadMessage || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal mengirim');

      setShowLeadModal(false);
      setLeadName('');
      setLeadPhone('');
      setLeadEmail('');
      setLeadMessage('');
      setNotice({ type: 'success', text: 'Terima kasih! Tim kami akan segera menghubungi Anda via WhatsApp.' });
    } catch (err: any) {
      setNotice({ type: 'error', text: err.message || 'Gagal mengirim, silakan coba lagi' });
    } finally {
      setSubmittingLead(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-container text-on-surface font-body-md">
      {notice && (
        <div className={`fixed top-4 right-4 left-4 md:left-auto md:w-96 z-50 rounded-2xl px-5 py-4 shadow-xl flex items-start justify-between gap-3 ${
          notice.type === 'success' ? 'bg-primary-container text-on-primary-container' : notice.type === 'error' ? 'bg-error-container text-error' : 'bg-surface-container-high text-on-surface'
        }`}>
          <p className="text-sm font-semibold">{notice.text}</p>
          <button onClick={() => setNotice(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Header */}
      <div className="max-w-5xl mx-auto px-6 pt-6 flex justify-end">
        <button
          onClick={() => { window.location.href = '/login'; }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm border border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-high transition-colors"
        >
          Login
        </button>
      </div>

      {/* Hero */}
      <div className="max-w-5xl mx-auto px-6 pt-10 pb-10 text-center space-y-4">
        <h1 className="text-4xl md:text-5xl font-bold font-headline-lg text-on-surface">SendaGo WhatsApp Gateway</h1>
        <p className="text-lg text-on-surface-variant max-w-2xl mx-auto">
          Kirim broadcast, jaga reputasi nomor WhatsApp Anda dengan Warmer, dan balas chat otomatis pakai AI - semua dalam satu platform.
        </p>
      </div>

      {/* Offers */}
      <div className="max-w-5xl mx-auto px-6 pb-20 grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Paket Coba */}
        <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-3xl p-8 shadow-lg space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center">
              <Coins className="w-6 h-6 text-on-primary-container" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Paket Coba</h2>
              <p className="text-xs text-on-surface-variant">Cara termurah untuk mencoba semua fitur</p>
            </div>
          </div>

          {bundles.length === 0 ? (
            <p className="text-sm text-on-surface-variant py-6">Paket sedang tidak tersedia, coba lagi nanti.</p>
          ) : (
            bundles.map((bundle) => (
              <div key={bundle.id} className="space-y-4">
                {bundle.description && <p className="text-sm text-on-surface-variant">{bundle.description}</p>}
                <ul className="space-y-2">
                  {bundle.items.map((item, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                      <span>Dapat {item.quotaAmount} {PRODUCT_TYPE_LABEL[item.productType]}</span>
                    </li>
                  ))}
                </ul>
                <div className="pt-2">
                  <p className="text-3xl font-bold text-primary">{formatRp(bundle.priceRp)}</p>
                  <button
                    onClick={() => handleBeliSekarang(bundle)}
                    disabled={processing}
                    className="mt-3 w-full bg-primary text-on-primary py-3 rounded-xl font-bold disabled:opacity-50"
                  >
                    {processing ? 'Memproses...' : 'Beli Sekarang'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Paket Pasangin */}
        <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-3xl p-8 shadow-lg space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-secondary-container flex items-center justify-center">
              <Server className="w-6 h-6 text-on-secondary-container" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Paket Pasangin</h2>
              <p className="text-xs text-on-surface-variant">Kami setup semuanya untuk Anda</p>
            </div>
          </div>

          <ul className="space-y-2">
            {[
              'Gratis server VPS 2 vCPU / 4GB RAM selama 1 tahun',
              'Gratis domain .id selama 1 tahun',
              'Gratis instalasi & konfigurasi aplikasi',
              'Gratis token OpenAI senilai $20',
              'Pendampingan setup device WhatsApp pertama',
            ].map((item) => (
              <li key={item} className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                <span>{item}</span>
              </li>
            ))}
          </ul>

          <div className="pt-2">
            <p className="text-3xl font-bold text-secondary">Rp 4.999.000</p>
            <p className="text-xs text-on-surface-variant mt-1">Sekali bayar</p>
            <button
              onClick={() => setShowLeadModal(true)}
              className="mt-3 w-full bg-secondary text-on-secondary py-3 rounded-xl font-bold"
            >
              Hubungi Kami
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 pb-16 flex flex-wrap justify-center gap-8 text-on-surface-variant text-sm">
        <div className="flex items-center gap-2"><Radio className="w-4 h-4" /> Broadcast massal</div>
        <div className="flex items-center gap-2"><Flame className="w-4 h-4" /> WA Warmer anti-banned</div>
        <div className="flex items-center gap-2"><Coins className="w-4 h-4" /> AI Auto-Reply Bot</div>
      </div>

      {/* Register + checkout modal */}
      {showRegister && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-3xl p-8 w-full max-w-md space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold">Daftar & Beli {pendingBundle?.name}</h3>
              <button onClick={() => setShowRegister(false)}><X className="w-5 h-5" /></button>
            </div>
            <p className="text-xs text-on-surface-variant">Buat akun gratis dalam beberapa detik, lalu lanjut ke pembayaran.</p>
            <form onSubmit={handleRegisterAndBuy} className="space-y-3">
              <input
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                placeholder="Nama lengkap"
                className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant rounded-xl outline-none text-sm"
              />
              <input
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
                placeholder="Email"
                type="email"
                className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant rounded-xl outline-none text-sm"
              />
              <input
                value={regPhone}
                onChange={(e) => setRegPhone(e.target.value)}
                placeholder="Nomor WhatsApp"
                className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant rounded-xl outline-none text-sm"
              />
              <input
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                placeholder="Password (minimal 8 karakter)"
                type="password"
                className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant rounded-xl outline-none text-sm"
              />
              <button type="submit" disabled={processing} className="w-full bg-primary text-on-primary py-3 rounded-xl font-bold disabled:opacity-50">
                {processing ? 'Memproses...' : 'Daftar & Lanjut Bayar'}
              </button>
              <p className="text-[10px] text-on-surface-variant text-center">
                Sudah punya akun? Login dulu di halaman utama, lalu kembali ke sini untuk beli.
              </p>
            </form>
          </div>
        </div>
      )}

      {/* Lead capture modal */}
      {showLeadModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-container-lowest rounded-3xl p-8 w-full max-w-md space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold">Hubungi Kami</h3>
              <button onClick={() => setShowLeadModal(false)}><X className="w-5 h-5" /></button>
            </div>
            <p className="text-xs text-on-surface-variant">Isi data Anda, tim kami akan follow up via WhatsApp untuk Paket Pasangin.</p>
            <form onSubmit={handleSubmitLead} className="space-y-3">
              <input
                value={leadName}
                onChange={(e) => setLeadName(e.target.value)}
                placeholder="Nama lengkap"
                className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant rounded-xl outline-none text-sm"
              />
              <input
                value={leadPhone}
                onChange={(e) => setLeadPhone(e.target.value)}
                placeholder="Nomor WhatsApp"
                className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant rounded-xl outline-none text-sm"
              />
              <input
                value={leadEmail}
                onChange={(e) => setLeadEmail(e.target.value)}
                placeholder="Email (opsional)"
                type="email"
                className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant rounded-xl outline-none text-sm"
              />
              <textarea
                value={leadMessage}
                onChange={(e) => setLeadMessage(e.target.value)}
                placeholder="Pesan (opsional)"
                rows={3}
                className="w-full px-4 py-3 bg-surface-container-low border border-outline-variant rounded-xl outline-none text-sm resize-none"
              />
              <button type="submit" disabled={submittingLead} className="w-full bg-secondary text-on-secondary py-3 rounded-xl font-bold disabled:opacity-50">
                {submittingLead ? 'Mengirim...' : 'Kirim'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
