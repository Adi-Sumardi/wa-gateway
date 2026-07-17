import React, { useEffect, useState } from 'react';
import { Users, UserPlus, Shield, History } from 'lucide-react';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  isActive: boolean;
  createdAt: string;
}

interface AuditLogRow {
  id: string;
  action: string;
  detail: string;
  createdAt: string;
  user: { name: string; email: string };
}

interface PermissionRow {
  key: string;
  label: string;
  category: string;
  grants: { admin: boolean; operator: boolean; viewer: boolean };
}

interface Props {
  backendUrl: string;
  getHeaders: () => Record<string, string>;
  addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  currentUserId: string;
  setConfirmDialog: (dialog: { title: string; message: string; onConfirm: () => void } | null) => void;
}

const ROLE_BADGE: Record<string, string> = {
  admin: 'bg-blue-100 text-blue-800',
  operator: 'bg-primary-container text-on-primary-container',
  viewer: 'bg-zinc-100 text-zinc-600',
};

export default function UsersRolesPage({ backendUrl, getHeaders, addToast, currentUserId, setConfirmDialog }: Props) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [matrix, setMatrix] = useState<PermissionRow[]>([]);
  const [pendingMatrix, setPendingMatrix] = useState<PermissionRow[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('operator');
  const [submitting, setSubmitting] = useState(false);
  const [savingMatrix, setSavingMatrix] = useState(false);

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/users`, { headers: getHeaders() });
      if (res.ok) setUsers(await res.json());
    } catch (err) {
      console.error('Failed to load users:', err);
    }
  };

  const fetchMatrix = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/permissions`, { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        setMatrix(data);
        setPendingMatrix(data);
      }
    } catch (err) {
      console.error('Failed to load permission matrix:', err);
    }
  };

  const fetchAuditLogs = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/audit-logs`, { headers: getHeaders() });
      if (res.ok) setAuditLogs(await res.json());
    } catch (err) {
      console.error('Failed to load audit logs:', err);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchMatrix();
    fetchAuditLogs();
  }, []);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !password) {
      addToast('Name, email, and password are required', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${backendUrl}/api/users`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name, email, password, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');
      addToast(`User "${data.name}" created`, 'success');
      setName('');
      setEmail('');
      setPassword('');
      setRole('operator');
      fetchUsers();
    } catch (err: any) {
      addToast(err.message || 'Failed to create user', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const updateUserField = async (id: string, data: Partial<Pick<UserRow, 'role' | 'isActive'>>) => {
    try {
      const res = await fetch(`${backendUrl}/api/users/${id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to update user');
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...result } : u)));
      addToast('User updated', 'success');
    } catch (err: any) {
      addToast(err.message || 'Failed to update user', 'error');
    }
  };

  const handleToggleActive = (u: UserRow) => {
    if (u.isActive) {
      setConfirmDialog({
        title: 'Deactivate User',
        message: `Are you sure you want to deactivate "${u.name}"? They will no longer be able to log in.`,
        onConfirm: () => {
          setConfirmDialog(null);
          updateUserField(u.id, { isActive: false });
        },
      });
    } else {
      updateUserField(u.id, { isActive: true });
    }
  };

  const toggleMatrixCell = (key: string, matrixRole: 'operator' | 'viewer') => {
    setPendingMatrix((prev) =>
      prev.map((p) => (p.key === key ? { ...p, grants: { ...p.grants, [matrixRole]: !p.grants[matrixRole] } } : p))
    );
  };

  const saveMatrix = async () => {
    setSavingMatrix(true);
    try {
      const updates: { role: string; permissionKey: string; granted: boolean }[] = [];
      pendingMatrix.forEach((p) => {
        (['operator', 'viewer'] as const).forEach((matrixRole) => {
          updates.push({ role: matrixRole, permissionKey: p.key, granted: p.grants[matrixRole] });
        });
      });
      const res = await fetch(`${backendUrl}/api/permissions`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) throw new Error('Failed to save permissions');
      setMatrix(pendingMatrix);
      addToast('Permission matrix saved', 'success');
    } catch (err: any) {
      addToast(err.message || 'Failed to save permissions', 'error');
    } finally {
      setSavingMatrix(false);
    }
  };

  const matrixByCategory = pendingMatrix.reduce<Record<string, PermissionRow[]>>((acc, p) => {
    (acc[p.category] ||= []).push(p);
    return acc;
  }, {});

  const hasMatrixChanges = JSON.stringify(matrix) !== JSON.stringify(pendingMatrix);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-on-surface font-headline-lg">Users & Roles</h2>
        <p className="text-on-surface-variant text-sm mt-1">Manage team access and what each role can do</p>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <UserPlus className="w-5 h-5" /> Add Team Member
        </h3>
        <form onSubmit={handleCreateUser} className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
            className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
            className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'admin' | 'operator' | 'viewer')}
            className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
          >
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="submit"
            disabled={submitting}
            className="md:col-span-4 bg-primary text-on-primary py-3 rounded-xl font-bold disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create User'}
          </button>
        </form>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <Users className="w-5 h-5" /> Team Members
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Email</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-surface-container-lowest transition-colors">
                  <td className="py-3.5 px-4">
                    {u.name}
                    {u.id === currentUserId && <span className="text-on-surface-variant"> (you)</span>}
                  </td>
                  <td className="py-3.5 px-4">{u.email}</td>
                  <td className="py-3.5 px-4">
                    <select
                      value={u.role}
                      onChange={(e) => updateUserField(u.id, { role: e.target.value as UserRow['role'] })}
                      disabled={u.id === currentUserId}
                      className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase ${ROLE_BADGE[u.role]} border-none outline-none disabled:opacity-60`}
                    >
                      <option value="admin">Admin</option>
                      <option value="operator">Operator</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </td>
                  <td className="py-3.5 px-4">
                    <span
                      className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${u.isActive ? 'bg-primary-container text-on-primary-container' : 'bg-zinc-100 text-zinc-600'}`}
                    >
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="py-3.5 px-4">
                    <button
                      onClick={() => handleToggleActive(u)}
                      disabled={u.id === currentUserId}
                      className={`px-3 py-1.5 rounded-xl font-bold text-[10px] uppercase ${u.isActive ? 'bg-error-container text-error' : 'bg-primary-container text-on-primary-container'} disabled:opacity-40`}
                    >
                      {u.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-on-surface-variant">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-sm flex items-center gap-2">
            <Shield className="w-5 h-5" /> Role Permissions
          </h3>
          <button
            onClick={saveMatrix}
            disabled={!hasMatrixChanges || savingMatrix}
            className="bg-primary text-on-primary px-4 py-2 rounded-xl font-bold text-xs disabled:opacity-50"
          >
            {savingMatrix ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Permission</th>
                <th className="py-3 px-4 text-center">Admin</th>
                <th className="py-3 px-4 text-center">Operator</th>
                <th className="py-3 px-4 text-center">Viewer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {Object.entries(matrixByCategory).map(([category, perms]) => (
                <React.Fragment key={category}>
                  <tr>
                    <td colSpan={4} className="pt-4 pb-1 px-4 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                      {category}
                    </td>
                  </tr>
                  {perms.map((p) => (
                    <tr key={p.key} className="hover:bg-surface-container-lowest transition-colors">
                      <td className="py-2.5 px-4">{p.label}</td>
                      <td className="py-2.5 px-4 text-center">
                        <input type="checkbox" checked disabled className="w-4 h-4 accent-primary opacity-60" />
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <input
                          type="checkbox"
                          checked={p.grants.operator}
                          onChange={() => toggleMatrixCell(p.key, 'operator')}
                          className="w-4 h-4 accent-primary"
                        />
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <input
                          type="checkbox"
                          checked={p.grants.viewer}
                          onChange={() => toggleMatrixCell(p.key, 'viewer')}
                          className="w-4 h-4 accent-primary"
                        />
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <History className="w-5 h-5" /> Audit Log
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Time</th>
                <th className="py-3 px-4">User</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {auditLogs.map((log) => (
                <tr key={log.id} className="hover:bg-surface-container-lowest transition-colors">
                  <td className="py-2.5 px-4 font-mono text-on-surface-variant whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                  <td className="py-2.5 px-4">{log.user.name}</td>
                  <td className="py-2.5 px-4 font-mono">{log.action}</td>
                  <td className="py-2.5 px-4 text-on-surface-variant">{log.detail}</td>
                </tr>
              ))}
              {auditLogs.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-on-surface-variant">
                    No audit activity recorded yet.
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
