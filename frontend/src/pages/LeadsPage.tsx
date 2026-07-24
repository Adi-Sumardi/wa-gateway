import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';

type LeadStatus = 'new' | 'contacted' | 'converted' | 'closed';

interface LeadRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  packageInterest: string;
  message: string | null;
  status: LeadStatus;
  notes: string | null;
  createdAt: string;
}

interface Props {
  backendUrl: string;
  getHeaders: () => Record<string, string>;
  addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

const STATUS_STYLES: Record<LeadStatus, string> = {
  new: 'bg-amber-100 text-amber-800',
  contacted: 'bg-primary-container text-on-primary-container',
  converted: 'bg-emerald-100 text-emerald-800',
  closed: 'bg-zinc-100 text-zinc-600',
};

const STATUS_OPTIONS: LeadStatus[] = ['new', 'contacted', 'converted', 'closed'];

export default function LeadsPage({ backendUrl, getHeaders, addToast }: Props) {
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLeads = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/leads`, { headers: getHeaders() });
      if (res.ok) setLeads(await res.json());
    } catch (err) {
      console.error('Failed to load leads:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
  }, []);

  const updateStatus = async (lead: LeadRow, status: LeadStatus) => {
    try {
      const res = await fetch(`${backendUrl}/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('Failed to update lead');
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, status } : l)));
    } catch (err) {
      addToast('Gagal memperbarui status lead', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-on-surface font-headline-lg">Leads</h2>
        <p className="text-on-surface-variant text-sm mt-1">Calon pelanggan yang mengisi form "Hubungi Kami" di landing page</p>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <UserPlus className="w-5 h-5" /> Daftar Leads
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Tanggal</th>
                <th className="py-3 px-4">Nama</th>
                <th className="py-3 px-4">Kontak</th>
                <th className="py-3 px-4">Minat</th>
                <th className="py-3 px-4">Pesan</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {leads.map((lead) => (
                <tr key={lead.id} className="hover:bg-surface-container-lowest transition-colors align-top">
                  <td className="py-2.5 px-4 font-mono text-on-surface-variant whitespace-nowrap">{new Date(lead.createdAt).toLocaleString()}</td>
                  <td className="py-2.5 px-4">{lead.name}</td>
                  <td className="py-2.5 px-4">
                    <div>{lead.phone}</div>
                    {lead.email && <div className="text-on-surface-variant">{lead.email}</div>}
                  </td>
                  <td className="py-2.5 px-4">{lead.packageInterest}</td>
                  <td className="py-2.5 px-4 max-w-xs">{lead.message || '-'}</td>
                  <td className="py-2.5 px-4">
                    <select
                      value={lead.status}
                      onChange={(e) => updateStatus(lead, e.target.value as LeadStatus)}
                      className={`px-2 py-1 rounded-full font-bold text-[9px] uppercase tracking-wider border-none outline-none ${STATUS_STYLES[lead.status]}`}
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {!loading && leads.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-on-surface-variant">
                    Belum ada leads.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
