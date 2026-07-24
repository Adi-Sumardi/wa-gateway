import React, { useEffect, useState } from 'react';
import { Coins, ShoppingCart, PackagePlus } from 'lucide-react';

interface PackageRow {
  id: string;
  name: string;
  coins: number;
  priceRp: number;
  isActive: boolean;
}

interface OrderRow {
  id: string;
  coins: number;
  priceRp: number;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  createdAt: string;
  package: { name: string };
}

interface Props {
  backendUrl: string;
  getHeaders: () => Record<string, string>;
  addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  role: string;
  aiCreditBalance: number;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  paid: 'bg-primary-container text-on-primary-container',
  failed: 'bg-red-100 text-error',
  expired: 'bg-zinc-100 text-zinc-600',
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

export default function TopUpPage({ backendUrl, getHeaders, addToast, role, aiCreditBalance }: Props) {
  const [packages, setPackages] = useState<PackageRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [buyingId, setBuyingId] = useState<string | null>(null);

  const [pkgName, setPkgName] = useState('');
  const [pkgCoins, setPkgCoins] = useState('');
  const [pkgPrice, setPkgPrice] = useState('');
  const [creatingPkg, setCreatingPkg] = useState(false);

  const fetchPackages = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/credit-packages`, { headers: getHeaders() });
      if (res.ok) setPackages(await res.json());
    } catch (err) {
      console.error('Failed to load credit packages:', err);
    }
  };

  const fetchOrders = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/credit-orders/me`, { headers: getHeaders() });
      if (res.ok) setOrders(await res.json());
    } catch (err) {
      console.error('Failed to load credit orders:', err);
    }
  };

  useEffect(() => {
    fetchPackages();
    fetchOrders();
  }, []);

  const handleBuy = async (pkg: PackageRow) => {
    setBuyingId(pkg.id);
    try {
      const res = await fetch(`${backendUrl}/api/credit-orders`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ packageId: pkg.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create order');

      await loadSnapScript();
      (window as any).snap.pay(data.token, {
        onSuccess: () => addToast('Pembayaran berhasil! Saldo akan otomatis diperbarui.', 'success'),
        onPending: () => addToast('Pembayaran sedang diproses.', 'info'),
        onError: () => addToast('Pembayaran gagal.', 'error'),
        onClose: () => addToast('Pembayaran dibatalkan.', 'info'),
      });
      fetchOrders();
    } catch (err: any) {
      addToast(err.message || 'Gagal memulai pembayaran', 'error');
    } finally {
      setBuyingId(null);
    }
  };

  const handleCreatePackage = async (e: React.FormEvent) => {
    e.preventDefault();
    const coins = Number(pkgCoins);
    const priceRp = Number(pkgPrice);
    if (!pkgName || !coins || coins <= 0 || !priceRp || priceRp <= 0) {
      addToast('Isi nama, jumlah koin, dan harga dengan benar', 'error');
      return;
    }
    setCreatingPkg(true);
    try {
      const res = await fetch(`${backendUrl}/api/credit-packages`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name: pkgName, coins, priceRp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create package');
      addToast(`Paket "${data.name}" dibuat`, 'success');
      setPkgName('');
      setPkgCoins('');
      setPkgPrice('');
      fetchPackages();
    } catch (err: any) {
      addToast(err.message || 'Failed to create package', 'error');
    } finally {
      setCreatingPkg(false);
    }
  };

  const toggleActive = async (pkg: PackageRow) => {
    try {
      const res = await fetch(`${backendUrl}/api/credit-packages/${pkg.id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ isActive: !pkg.isActive }),
      });
      if (!res.ok) throw new Error('Failed to update package');
      setPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, isActive: !p.isActive } : p)));
    } catch (err) {
      addToast('Failed to update package', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-on-surface font-headline-lg">Top Up Koin AI</h2>
        <p className="text-on-surface-variant text-sm mt-1">Isi saldo koin untuk penggunaan AI Auto-Reply Bot</p>
      </div>

      {role !== 'admin' && (
        <div className="bg-primary-container/40 border border-primary/30 rounded-2xl p-6 flex items-center justify-between">
          <span className="font-bold text-on-surface">Saldo Koin Saat Ini</span>
          <span className="text-2xl font-bold text-primary flex items-center gap-2">🪙 {aiCreditBalance}</span>
        </div>
      )}

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <ShoppingCart className="w-5 h-5" /> Pilih Paket
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {packages.filter((p) => p.isActive).map((pkg) => (
            <div key={pkg.id} className="border border-outline-variant/50 rounded-xl p-4 bg-surface-container-lowest text-center space-y-2">
              <p className="font-bold text-on-surface">{pkg.name}</p>
              <p className="text-2xl font-bold text-primary">🪙 {pkg.coins}</p>
              <p className="text-xs text-on-surface-variant">{formatRp(pkg.priceRp)}</p>
              <button
                onClick={() => handleBuy(pkg)}
                disabled={buyingId === pkg.id}
                className="w-full bg-primary text-on-primary py-2 rounded-xl font-bold text-xs disabled:opacity-50"
              >
                {buyingId === pkg.id ? 'Memproses...' : 'Beli'}
              </button>
            </div>
          ))}
          {packages.filter((p) => p.isActive).length === 0 && (
            <p className="text-on-surface-variant text-sm col-span-3 text-center py-4">Belum ada paket tersedia.</p>
          )}
        </div>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <Coins className="w-5 h-5" /> Riwayat Pembelian
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Tanggal</th>
                <th className="py-3 px-4">Paket</th>
                <th className="py-3 px-4">Koin</th>
                <th className="py-3 px-4">Harga</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-surface-container-lowest transition-colors">
                  <td className="py-2.5 px-4 font-mono text-on-surface-variant whitespace-nowrap">{new Date(o.createdAt).toLocaleString()}</td>
                  <td className="py-2.5 px-4">{o.package.name}</td>
                  <td className="py-2.5 px-4 font-mono">🪙 {o.coins}</td>
                  <td className="py-2.5 px-4 font-mono">{formatRp(o.priceRp)}</td>
                  <td className="py-2.5 px-4">
                    <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${STATUS_STYLES[o.status]}`}>{o.status}</span>
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-on-surface-variant">
                    Belum ada riwayat pembelian.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {role === 'admin' && (
        <>
          <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <PackagePlus className="w-5 h-5" /> Buat Paket Baru
            </h3>
            <form onSubmit={handleCreatePackage} className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
              <input
                value={pkgName}
                onChange={(e) => setPkgName(e.target.value)}
                placeholder="Nama paket"
                className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
              />
              <input
                value={pkgCoins}
                onChange={(e) => setPkgCoins(e.target.value)}
                placeholder="Jumlah koin"
                type="number"
                min="1"
                className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
              />
              <input
                value={pkgPrice}
                onChange={(e) => setPkgPrice(e.target.value)}
                placeholder="Harga (Rp)"
                type="number"
                min="1"
                className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
              />
              <button type="submit" disabled={creatingPkg} className="bg-primary text-on-primary py-3 rounded-xl font-bold disabled:opacity-50">
                {creatingPkg ? 'Membuat...' : 'Buat Paket'}
              </button>
            </form>
          </div>

          <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
            <h3 className="font-bold text-sm">Semua Paket</h3>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                    <th className="py-3 px-4">Nama</th>
                    <th className="py-3 px-4">Koin</th>
                    <th className="py-3 px-4">Harga</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/20 font-medium">
                  {packages.map((pkg) => (
                    <tr key={pkg.id} className="hover:bg-surface-container-lowest transition-colors">
                      <td className="py-2.5 px-4">{pkg.name}</td>
                      <td className="py-2.5 px-4 font-mono">🪙 {pkg.coins}</td>
                      <td className="py-2.5 px-4 font-mono">{formatRp(pkg.priceRp)}</td>
                      <td className="py-2.5 px-4">
                        <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${pkg.isActive ? 'bg-primary-container text-on-primary-container' : 'bg-zinc-100 text-zinc-600'}`}>
                          {pkg.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <button
                          onClick={() => toggleActive(pkg)}
                          className={`px-3 py-1.5 rounded-xl font-bold text-[10px] uppercase ${pkg.isActive ? 'bg-error-container text-error' : 'bg-primary-container text-on-primary-container'}`}
                        >
                          {pkg.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
