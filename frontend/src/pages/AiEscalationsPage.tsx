import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, CheckCircle2 } from 'lucide-react';

type EscalationStatus = 'open' | 'resolved';
type EscalationReason = 'ai_error' | 'ai_uncertain' | 'delivery_failed';

interface EscalationRow {
  id: string;
  question: string;
  reason: EscalationReason;
  detail: string | null;
  status: EscalationStatus;
  createdAt: string;
  resolvedAt: string | null;
  device: { label: string };
  contact: { name: string; phoneNumber: string };
}

interface Props {
  backendUrl: string;
  getHeaders: () => Record<string, string>;
  addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  canManage: boolean;
  onResolved?: () => void;
}

const REASON_LABELS: Record<EscalationReason, string> = {
  ai_error: 'AI gagal (teknis)',
  ai_uncertain: 'AI tidak yakin',
  delivery_failed: 'Gagal terkirim',
};

const REASON_STYLES: Record<EscalationReason, string> = {
  ai_error: 'bg-error-container text-error',
  ai_uncertain: 'bg-amber-100 text-amber-800',
  delivery_failed: 'bg-zinc-100 text-zinc-600',
};

export default function AiEscalationsPage({ backendUrl, getHeaders, addToast, canManage, onResolved }: Props) {
  const [escalations, setEscalations] = useState<EscalationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<EscalationStatus>('open');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchEscalations = async (targetPage = 1, status = statusFilter) => {
    setLoading(true);
    try {
      const res = await fetch(`${backendUrl}/api/ai-escalations?page=${targetPage}&limit=25&status=${status}`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setEscalations(data.escalations);
        setPage(data.page);
        setTotalPages(data.totalPages);
        setTotal(data.total);
      }
    } catch (err) {
      console.error('Failed to load AI escalations:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEscalations(1, statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const goToPage = (p: number) => {
    if (p < 1 || p > totalPages) return;
    fetchEscalations(p, statusFilter);
  };

  const resolve = async (row: EscalationRow) => {
    try {
      const res = await fetch(`${backendUrl}/api/ai-escalations/${row.id}/resolve`, {
        method: 'POST',
        headers: getHeaders(),
      });
      if (!res.ok) throw new Error('Failed to resolve');
      setEscalations((prev) => prev.filter((e) => e.id !== row.id));
      setTotal((prev) => Math.max(0, prev - 1));
      onResolved?.();
      addToast('Ditandai selesai ditangani.', 'success');
    } catch (err) {
      addToast('Gagal menandai escalation sebagai selesai', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-on-surface font-headline-lg">AI Escalations</h2>
        <p className="text-on-surface-variant text-sm mt-1">Percakapan yang tidak bisa dijawab AI Bot dan perlu ditangani manusia</p>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="font-bold text-sm flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" /> Daftar Escalation <span className="text-on-surface-variant font-normal">({total})</span>
          </h3>
          <div className="flex gap-2">
            {(['open', 'resolved'] as EscalationStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider transition-colors ${statusFilter === s ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant border border-outline-variant/50'}`}
              >
                {s === 'open' ? 'Belum ditangani' : 'Selesai'}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Tanggal</th>
                <th className="py-3 px-4">Device</th>
                <th className="py-3 px-4">Kontak</th>
                <th className="py-3 px-4">Pertanyaan</th>
                <th className="py-3 px-4">Alasan</th>
                {statusFilter === 'open' && canManage && <th className="py-3 px-4">Aksi</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {escalations.map((row) => (
                <tr key={row.id} className="hover:bg-surface-container-lowest transition-colors align-top">
                  <td className="py-2.5 px-4 font-mono text-on-surface-variant whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td>
                  <td className="py-2.5 px-4">{row.device.label}</td>
                  <td className="py-2.5 px-4">
                    <div>{row.contact.name}</div>
                    <div className="text-on-surface-variant">{row.contact.phoneNumber}</div>
                  </td>
                  <td className="py-2.5 px-4 max-w-xs">{row.question}</td>
                  <td className="py-2.5 px-4">
                    <span className={`px-2 py-1 rounded-full font-bold text-[9px] uppercase tracking-wider ${REASON_STYLES[row.reason]}`}>
                      {REASON_LABELS[row.reason]}
                    </span>
                  </td>
                  {statusFilter === 'open' && canManage && (
                    <td className="py-2.5 px-4">
                      <button
                        onClick={() => resolve(row)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary-container text-on-primary-container font-bold text-[11px] hover:opacity-90 active:scale-95 transition-all"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Selesai
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!loading && escalations.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-on-surface-variant">
                    {statusFilter === 'open' ? 'Tidak ada escalation yang perlu ditangani.' : 'Belum ada riwayat.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2 text-xs">
            <span className="text-on-surface-variant">Halaman {page} dari {totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => goToPage(page - 1)} disabled={page <= 1} className="p-2 rounded-xl bg-surface-container-lowest border border-outline-variant/50 disabled:opacity-40">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => goToPage(page + 1)} disabled={page >= totalPages} className="p-2 rounded-xl bg-surface-container-lowest border border-outline-variant/50 disabled:opacity-40">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
