import React, { useEffect, useState } from 'react';
import { Coins, ShoppingCart, PackagePlus } from 'lucide-react';

type ProductType = 'ai_credit' | 'broadcast_quota' | 'warmer_slot';

interface PackageRow {
  id: string;
  productType: ProductType;
  name: string;
  quotaAmount: number;
  priceRp: number;
  isActive: boolean;
}

interface OrderRow {
  id: string;
  quotaAmount: number;
  priceRp: number;
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
  createdAt: string;
  snapToken: string | null;
  package: { name: string; productType: ProductType };
}

interface Props {
  backendUrl: string;
  getHeaders: () => Record<string, string>;
  addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  role: string;
  aiCreditBalance: number;
  broadcastQuotaMonthly: number;
  maxWarmerSessions: number;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  paid: 'bg-primary-container text-on-primary-container',
  failed: 'bg-red-100 text-error',
  expired: 'bg-zinc-100 text-zinc-600',
  cancelled: 'bg-zinc-100 text-zinc-600',
};

const PRODUCT_TABS: { key: ProductType; label: string }[] = [
  { key: 'ai_credit', label: 'Koin AI' },
  { key: 'broadcast_quota', label: 'Kuota Broadcast' },
  { key: 'warmer_slot', label: 'Slot Warmer' },
];

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

export default function TopUpPage({ backendUrl, getHeaders, addToast, role, aiCreditBalance, broadcastQuotaMonthly, maxWarmerSessions }: Props) {
  const [activeType, setActiveType] = useState<ProductType>('ai_credit');
  const [packages, setPackages] = useState<PackageRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);

  const [pkgProductType, setPkgProductType] = useState<ProductType>('ai_credit');
  const [pkgName, setPkgName] = useState('');
  const [pkgQuota, setPkgQuota] = useState('');
  const [pkgPrice, setPkgPrice] = useState('');
  const [creatingPkg, setCreatingPkg] = useState(false);

  const [editingPkgId, setEditingPkgId] = useState<string | null>(null);
  const [editPkgName, setEditPkgName] = useState('');
  const [editPkgQuota, setEditPkgQuota] = useState('');
  const [editPkgPrice, setEditPkgPrice] = useState('');
  const [savingPkg, setSavingPkg] = useState(false);

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

  const handlePayAgain = async (order: OrderRow) => {
    if (!order.snapToken) {
      addToast('Token pembayaran sudah kedaluwarsa. Silakan batalkan dan beli ulang.', 'error');
      return;
    }
    setPayingOrderId(order.id);
    try {
      await loadSnapScript();
      (window as any).snap.pay(order.snapToken, {
        onSuccess: () => addToast('Pembayaran berhasil! Saldo akan otomatis diperbarui.', 'success'),
        onPending: () => addToast('Pembayaran sedang diproses.', 'info'),
        onError: () => addToast('Pembayaran gagal.', 'error'),
        onClose: () => addToast('Pembayaran dibatalkan.', 'info'),
      });
    } catch (err: any) {
      addToast(err.message || 'Gagal membuka halaman pembayaran', 'error');
    } finally {
      setPayingOrderId(null);
    }
  };

  const handleCancelOrder = async (order: OrderRow) => {
    setCancellingOrderId(order.id);
    try {
      const res = await fetch(`${backendUrl}/api/credit-orders/${order.id}/cancel`, {
        method: 'POST',
        headers: getHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel order');
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: 'cancelled' } : o)));
      addToast('Order dibatalkan', 'success');
    } catch (err: any) {
      addToast(err.message || 'Failed to cancel order', 'error');
    } finally {
      setCancellingOrderId(null);
    }
  };

  const handleCreatePackage = async (e: React.FormEvent) => {
    e.preventDefault();
    const quotaAmount = Number(pkgQuota);
    const priceRp = Number(pkgPrice);
    if (!pkgName || !quotaAmount || quotaAmount <= 0 || !priceRp || priceRp <= 0) {
      addToast('Isi nama, jumlah, dan harga dengan benar', 'error');
      return;
    }
    setCreatingPkg(true);
    try {
      const res = await fetch(`${backendUrl}/api/credit-packages`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name: pkgName, productType: pkgProductType, quotaAmount, priceRp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create package');
      addToast(`Paket "${data.name}" dibuat`, 'success');
      setPkgName('');
      setPkgQuota('');
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

  const openEditPackage = (pkg: PackageRow) => {
    setEditingPkgId(pkg.id);
    setEditPkgName(pkg.name);
    setEditPkgQuota(String(pkg.quotaAmount));
    setEditPkgPrice(String(pkg.priceRp));
  };

  const saveEditPackage = async (id: string) => {
    const quotaAmount = Number(editPkgQuota);
    const priceRp = Number(editPkgPrice);
    if (!editPkgName || !quotaAmount || quotaAmount <= 0 || !priceRp || priceRp <= 0) {
      addToast('Isi nama, jumlah, dan harga dengan benar', 'error');
      return;
    }
    setSavingPkg(true);
    try {
      const res = await fetch(`${backendUrl}/api/credit-packages/${id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ name: editPkgName, quotaAmount, priceRp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update package');
      setPackages((prev) => prev.map((p) => (p.id === id ? { ...p, ...data } : p)));
      addToast('Paket diperbarui', 'success');
      setEditingPkgId(null);
    } catch (err: any) {
      addToast(err.message || 'Failed to update package', 'error');
    } finally {
      setSavingPkg(false);
    }
  };

  const balanceForTab: Record<ProductType, { label: string; value: string }> = {
    ai_credit: { label: 'Saldo Koin AI Saat Ini', value: `🪙 ${aiCreditBalance}` },
    broadcast_quota: { label: 'Kuota Broadcast Bulan Ini', value: `${broadcastQuotaMonthly} pesan` },
    warmer_slot: { label: 'Slot Sesi WA Warmer', value: `${maxWarmerSessions} slot` },
  };

  const visiblePackages = packages.filter((p) => p.productType === activeType);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-on-surface font-headline-lg">Top Up</h2>
        <p className="text-on-surface-variant text-sm mt-1">Isi koin AI, kuota broadcast, atau slot WA Warmer</p>
      </div>

      <div className="flex gap-2">
        {PRODUCT_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveType(tab.key)}
            className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider ${activeType === tab.key ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant border border-outline-variant/30'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {role !== 'admin' && (
        <div className="bg-primary-container/40 border border-primary/30 rounded-2xl p-6 flex items-center justify-between">
          <span className="font-bold text-on-surface">{balanceForTab[activeType].label}</span>
          <span className="text-2xl font-bold text-primary">{balanceForTab[activeType].value}</span>
        </div>
      )}

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <ShoppingCart className="w-5 h-5" /> Pilih Paket
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {visiblePackages.filter((p) => p.isActive).map((pkg) => (
            <div key={pkg.id} className="border border-outline-variant/50 rounded-xl p-4 bg-surface-container-lowest text-center space-y-2">
              <p className="font-bold text-on-surface">{pkg.name}</p>
              <p className="text-2xl font-bold text-primary">
                {pkg.productType === 'ai_credit' ? '🪙 ' : ''}{pkg.quotaAmount}
                {pkg.productType === 'broadcast_quota' ? ' pesan' : pkg.productType === 'warmer_slot' ? ' slot' : ''}
              </p>
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
          {visiblePackages.filter((p) => p.isActive).length === 0 && (
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
                <th className="py-3 px-4">Jumlah</th>
                <th className="py-3 px-4">Harga</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-surface-container-lowest transition-colors">
                  <td className="py-2.5 px-4 font-mono text-on-surface-variant whitespace-nowrap">{new Date(o.createdAt).toLocaleString()}</td>
                  <td className="py-2.5 px-4">{o.package.name}</td>
                  <td className="py-2.5 px-4 font-mono">{o.quotaAmount}</td>
                  <td className="py-2.5 px-4 font-mono">{formatRp(o.priceRp)}</td>
                  <td className="py-2.5 px-4">
                    <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${STATUS_STYLES[o.status]}`}>{o.status}</span>
                  </td>
                  <td className="py-2.5 px-4">
                    {o.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handlePayAgain(o)}
                          disabled={payingOrderId === o.id}
                          className="px-3 py-1.5 bg-primary text-on-primary rounded-xl font-bold text-[10px] uppercase disabled:opacity-50"
                        >
                          Bayar Lagi
                        </button>
                        <button
                          onClick={() => handleCancelOrder(o)}
                          disabled={cancellingOrderId === o.id}
                          className="px-3 py-1.5 bg-error-container text-error rounded-xl font-bold text-[10px] uppercase disabled:opacity-50"
                        >
                          Batalkan
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-on-surface-variant">
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
            <form onSubmit={handleCreatePackage} className="grid grid-cols-1 md:grid-cols-5 gap-4 text-xs">
              <select
                value={pkgProductType}
                onChange={(e) => setPkgProductType(e.target.value as ProductType)}
                className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
              >
                {PRODUCT_TABS.map((tab) => (
                  <option key={tab.key} value={tab.key}>{tab.label}</option>
                ))}
              </select>
              <input
                value={pkgName}
                onChange={(e) => setPkgName(e.target.value)}
                placeholder="Nama paket"
                className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
              />
              <input
                value={pkgQuota}
                onChange={(e) => setPkgQuota(e.target.value)}
                placeholder="Jumlah"
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
                    <th className="py-3 px-4">Tipe</th>
                    <th className="py-3 px-4">Nama</th>
                    <th className="py-3 px-4">Jumlah</th>
                    <th className="py-3 px-4">Harga</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/20 font-medium">
                  {packages.map((pkg) => (
                    <React.Fragment key={pkg.id}>
                      <tr className="hover:bg-surface-container-lowest transition-colors">
                        <td className="py-2.5 px-4 text-on-surface-variant">{PRODUCT_TABS.find((t) => t.key === pkg.productType)?.label}</td>
                        <td className="py-2.5 px-4">{pkg.name}</td>
                        <td className="py-2.5 px-4 font-mono">{pkg.quotaAmount}</td>
                        <td className="py-2.5 px-4 font-mono">{formatRp(pkg.priceRp)}</td>
                        <td className="py-2.5 px-4">
                          <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${pkg.isActive ? 'bg-primary-container text-on-primary-container' : 'bg-zinc-100 text-zinc-600'}`}>
                            {pkg.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 flex gap-2">
                          <button
                            onClick={() => (editingPkgId === pkg.id ? setEditingPkgId(null) : openEditPackage(pkg))}
                            className="px-3 py-1.5 bg-primary-container text-on-primary-container rounded-xl font-bold text-[10px] uppercase"
                          >
                            {editingPkgId === pkg.id ? 'Close' : 'Edit'}
                          </button>
                          <button
                            onClick={() => toggleActive(pkg)}
                            className={`px-3 py-1.5 rounded-xl font-bold text-[10px] uppercase ${pkg.isActive ? 'bg-error-container text-error' : 'bg-primary-container text-on-primary-container'}`}
                          >
                            {pkg.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </td>
                      </tr>
                      {editingPkgId === pkg.id && (
                        <tr>
                          <td colSpan={6} className="p-4 bg-surface-container-lowest">
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                              <input
                                value={editPkgName}
                                onChange={(e) => setEditPkgName(e.target.value)}
                                placeholder="Nama paket"
                                className="w-full px-3 py-2.5 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                              />
                              <input
                                value={editPkgQuota}
                                onChange={(e) => setEditPkgQuota(e.target.value)}
                                placeholder="Jumlah"
                                type="number"
                                min="1"
                                className="w-full px-3 py-2.5 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                              />
                              <input
                                value={editPkgPrice}
                                onChange={(e) => setEditPkgPrice(e.target.value)}
                                placeholder="Harga (Rp)"
                                type="number"
                                min="1"
                                className="w-full px-3 py-2.5 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                              />
                              <button
                                onClick={() => saveEditPackage(pkg.id)}
                                disabled={savingPkg}
                                className="bg-primary text-on-primary py-2.5 rounded-xl font-bold disabled:opacity-50"
                              >
                                {savingPkg ? 'Saving...' : 'Save Changes'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  {packages.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-on-surface-variant">
                        Belum ada paket.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
