import { useEffect, useState } from 'react';
import { api, hasToken, money, newKey, setToken, toCents } from './api.js';

function useAction() {
  const [msg, setMsg] = useState(null);
  const run = async (fn, okText) => {
    setMsg(null);
    try {
      const r = await fn();
      if (okText) setMsg({ ok: true, text: okText });
      return r;
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };
  return [msg, run];
}
const Msg = ({ msg }) => (msg ? <p className={msg.ok ? 'ok' : 'err'}>{msg.text}</p> : null);

/* ---------------- login / register ---------------- */
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ email: '', fullName: '', password: '' });
  const [msg, run] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (mode === 'register') {
      const ok = await run(() => api('/api/auth/register', { method: 'POST', body: f }), 'Registered. You can log in now.');
      if (ok) setMode('login');
      return;
    }
    const r = await run(() => api('/api/auth/login', { method: 'POST', body: { email: f.email, password: f.password } }));
    if (r) {
      setToken(r.token);
      onAuthed(r.user);
    }
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>{mode === 'login' ? 'Log in' : 'Create account'}</h2>
      {mode === 'register' && <input placeholder="Full name" value={f.fullName} onChange={set('fullName')} required />}
      <input type="email" placeholder="Email" value={f.email} onChange={set('email')} required />
      <input type="password" placeholder={mode === 'register' ? 'Password (min 12 characters)' : 'Password'} value={f.password} onChange={set('password')} required />
      <button>{mode === 'login' ? 'Log in' : 'Register'}</button>
      <Msg msg={msg} />
      <p className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'New here? Register' : 'Have an account? Log in'}
      </p>
    </form>
  );
}

/* ---------------- account holder ---------------- */
function Onboarding({ onDone }) {
  const [app, setApp] = useState(undefined);
  const [f, setF] = useState({ phone: '', address: '', idDocumentRef: '' });
  const [msg, run] = useAction();
  const load = () => api('/api/onboarding/me').then((r) => setApp(r.application));
  useEffect(() => { load(); }, []);
  if (app === undefined) return <p>Loading…</p>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const canSubmit = !app || app.status === 'REJECTED';

  return (
    <div className="card">
      <h2>Account onboarding</h2>
      {app && <p>Status: <b>{app.status}</b>{app.review_note ? ` — ${app.review_note}` : ''}</p>}
      {app?.status === 'APPROVED' && <button onClick={onDone}>Open my account</button>}
      {canSubmit && (
        <form onSubmit={async (e) => { e.preventDefault(); await run(() => api('/api/onboarding', { method: 'POST', body: f }), 'Submitted for review.'); load(); }}>
          <input placeholder="Phone (10-15 digits)" value={f.phone} onChange={set('phone')} required />
          <input placeholder="Address" value={f.address} onChange={set('address')} required />
          <input placeholder="ID document reference (synthetic)" value={f.idDocumentRef} onChange={set('idDocumentRef')} required />
          <button>{app ? 'Resubmit' : 'Submit application'}</button>
        </form>
      )}
      {app?.status === 'PENDING' && <p>An administrator will review your application.</p>}
      <Msg msg={msg} />
    </div>
  );
}

function Holder() {
  const [account, setAccount] = useState(undefined);
  const [txs, setTxs] = useState([]);
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [msg, run] = useAction();

  const load = async () => {
    const a = await api('/api/accounts/me');
    setAccount(a.account);
    if (a.account) setTxs((await api('/api/accounts/me/transactions')).transactions);
  };
  useEffect(() => { load(); }, []);

  if (account === undefined) return <p>Loading…</p>;
  if (!account) return <Onboarding onDone={load} />;

  const move = (kind, extra = {}) =>
    run(async () => {
      await api(`/api/accounts/me/${kind}`, { method: 'POST', headers: { 'Idempotency-Key': newKey() }, body: { amountCents: toCents(amount), ...extra } });
      setAmount('');
      await load();
    }, 'Done.');

  return (
    <>
      <div className="card">
        <h2>My account</h2>
        <p>Account number: <b>{account.accountNumber}</b> ({account.status})</p>
        <p className="big">{money(account.balanceCents)}</p>
        <input type="number" min="0.01" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className="row">
          <button onClick={() => move('deposit')}>Deposit</button>
          <button onClick={() => move('withdraw')}>Withdraw</button>
        </div>
        <input placeholder="Recipient account number (BV…)" value={to} onChange={(e) => setTo(e.target.value)} />
        <button onClick={() => move('transfer', { toAccountNumber: to })}>Transfer</button>
        <Msg msg={msg} />
        <p className="muted">Demo only: synthetic money, no real funds.</p>
      </div>
      <div className="card">
        <h3>Recent transactions</h3>
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Amount</th></tr></thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.createdAt).toLocaleString()}</td>
                <td>{t.kind}</td>
                <td className={t.direction === 'CREDIT' ? 'ok' : 'err'}>{t.direction === 'CREDIT' ? '+' : '-'}{money(t.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------- admin ---------------- */
function AdminOnboarding() {
  const [rows, setRows] = useState([]);
  const [msg, run] = useAction();
  const load = () => api('/api/admin/onboarding?status=PENDING').then((r) => setRows(r.applications));
  useEffect(() => { load(); }, []);
  const decide = async (id, decision) => {
    const note = decision === 'REJECT' ? prompt('Reason for rejection?') || undefined : undefined;
    await run(() => api(`/api/admin/onboarding/${id}/decision`, { method: 'POST', body: { decision, note } }), `Application ${decision.toLowerCase()}d.`);
    load();
  };
  return (
    <div className="card">
      <h3>Pending applications</h3>
      <Msg msg={msg} />
      {rows.length === 0 && <p>Nothing pending.</p>}
      {rows.map((a) => (
        <div key={a.id} className="item">
          <b>{a.full_name}</b> ({a.email})<br />
          {a.phone} · {a.address} · ref {a.id_document_ref}
          <div className="row">
            <button onClick={() => decide(a.id, 'APPROVE')}>Approve</button>
            <button className="danger" onClick={() => decide(a.id, 'REJECT')}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [f, setF] = useState({ email: '', fullName: '', password: '' });
  const [msg, run] = useAction();
  const load = async () => {
    setUsers((await api('/api/admin/users')).users);
    setAccounts((await api('/api/admin/accounts')).accounts);
  };
  useEffect(() => { load(); }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = async (u) => {
    await run(() => api(`/api/admin/users/${u.id}/status`, { method: 'POST', body: { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' } }), 'Updated.');
    load();
  };
  const freeze = async (a) => {
    await run(() => api(`/api/admin/accounts/${a.id}/freeze`, { method: 'POST', body: { frozen: a.status === 'ACTIVE' } }), 'Updated.');
    load();
  };
  return (
    <>
      <div className="card">
        <h3>Users</h3>
        <Msg msg={msg} />
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}><td>{u.email}</td><td>{u.role}</td><td>{u.status}</td>
                <td><button onClick={() => toggle(u)}>{u.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button></td></tr>
            ))}
          </tbody>
        </table>
        <h4>Add another administrator</h4>
        <form onSubmit={async (e) => { e.preventDefault(); await run(() => api('/api/admin/users', { method: 'POST', body: f }), 'Administrator created.'); load(); }}>
          <input placeholder="Full name" value={f.fullName} onChange={set('fullName')} required />
          <input type="email" placeholder="Email" value={f.email} onChange={set('email')} required />
          <input type="password" placeholder="Password (min 12)" value={f.password} onChange={set('password')} required />
          <button>Create admin</button>
        </form>
      </div>
      <div className="card">
        <h3>Accounts</h3>
        <table>
          <thead><tr><th>Number</th><th>Holder</th><th>Balance</th><th>Status</th><th /></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}><td>{a.account_number}</td><td>{a.email}</td><td>{money(a.balance_cents)}</td><td>{a.status}</td>
                <td><button onClick={() => freeze(a)}>{a.status === 'ACTIVE' ? 'Freeze' : 'Unfreeze'}</button></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AdminAudit() {
  const [entries, setEntries] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const [msg, run] = useAction();
  const load = () => run(async () => setEntries((await api('/api/admin/audit?limit=100')).entries));
  useEffect(() => { load(); }, []);
  return (
    <div className="card">
      <h3>Audit log</h3>
      <div className="row">
        <button onClick={load}>Refresh</button>
        <button onClick={async () => setVerdict(await run(() => api('/api/admin/audit/verify')))}>Verify hash chain</button>
      </div>
      {verdict && (
        <p className={verdict.ok ? 'ok' : 'err'}>
          {verdict.ok ? `Chain intact (${verdict.checked} entries checked).` : `TAMPERING DETECTED at entry ${verdict.brokenAtId}.`}
        </p>
      )}
      <Msg msg={msg} />
      <table>
        <thead><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}><td>{e.id}</td><td>{new Date(e.ts).toLocaleString()}</td><td>{e.actor_role ?? '-'}</td><td>{e.action}</td><td>{e.target ?? ''}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Admin() {
  const [tab, setTab] = useState('onboarding');
  return (
    <>
      <div className="row tabs">
        {['onboarding', 'users', 'audit'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'onboarding' && <AdminOnboarding />}
      {tab === 'users' && <AdminUsers />}
      {tab === 'audit' && <AdminAudit />}
    </>
  );
}

/* ---------------- shell ---------------- */
export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(hasToken());

  useEffect(() => {
    if (!hasToken()) return;
    api('/api/auth/me').then((r) => setUser(r.user)).catch(() => setToken(null)).finally(() => setBooting(false));
  }, []);

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* token may already be invalid */ }
    setToken(null);
    setUser(null);
  };

  return (
    <div className="shell">
      <header>
        <h1>BalanceVault</h1>
        {user && <span>{user.fullName} · {user.role} <button onClick={logout}>Log out</button></span>}
      </header>
      {booting ? <p>Loading…</p> : !user ? <AuthScreen onAuthed={setUser} /> : user.role === 'ADMIN' ? <Admin /> : <Holder />}
    </div>
  );
}
