import { useEffect, useState } from 'react';
import { request, downloadJson } from '../services/api.js';
import './developer.css';
const date = value => value ? new Date(value).toLocaleString('en-GB') : '—';
function status(key) {
  return key.revokedAt ? 'Revoked' : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? 'Expired' : 'Active';
}
export function Developer({ ready }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(''), [scopes, setScopes] = useState(['inventory:read']), [expiry, setExpiry] = useState('90');
  const [created, setCreated] = useState(null), [resource, setResource] = useState('inventory'), [result, setResult] = useState(null), [notice, setNotice] = useState('');
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    request('developer').then(next => { if (!cancelled) setData(next); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [ready]);
  async function run(work) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch(e) { setError(e.message); } finally { setBusy(false); }
  }
  async function create(event) {
    event.preventDefault();
    await run(async () => {
      const next = await request('developer', { action: 'create', name, scopes, expiresInDays: expiry === 'none' ? null : Number(expiry) });
      setCreated(next); setResult(null); setName('');
      setData(await request('developer'));
    });
  }
  async function revoke(key) {
    await run(async () => {
      setData(await request('developer', { action: 'revoke', id: key.id }));
      if (created?.key.id === key.id) { setCreated(null); setResult(null); }
      setNotice(`${key.name} revoked. Its API access has ended.`);
    });
  }
  async function test() {
    await run(async () => {
      const response = await fetch(`/api/v1/developer?resource=${resource}&limit=10`, { credentials: 'omit', headers: { Authorization: `Bearer ${created.secret}` } });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'API request failed.');
      setResult(json); setData(await request('developer'));
    });
  }
  const endpoint = `${location.origin}/api/v1/developer`;
  const curl = `curl '${endpoint}?resource=${resource}&limit=50' \\\n  -H "Authorization: Bearer $CARDRAILS_API_KEY"`;
  return <section className="developer-area">
    <div className="developer-heading"><div><p className="kicker">Card Rails · Developer</p><h1>Build with your inventory.</h1><p>Read your saved cards, physical locations and stock book through the Card Rails API.</p></div><span className="developer-readonly">Read-only API · v1</span></div>
    {error && <p role="alert" className="scan-alert">{error}</p>}
    {notice && <p role="status" className="developer-notice">{notice}</p>}
    {!data && <p role="status">{ready ? 'Loading your API keys…' : 'Loading your inventory…'}</p>}
    <div className="developer-grid">
      <article className="developer-panel"><h2>Create an API key</h2><p>Choose the data this integration can read. Keys cannot change stock or publish listings.</p>
        <form onSubmit={create}>
          <label>Key name<input aria-label="API key name" required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="Name your integration" disabled={busy || !data} /></label>
          <fieldset><legend>Permissions</legend>{(data?.scopes || ['inventory:read', 'book:read']).map(scope => <label className="developer-check" key={scope}><input type="checkbox" checked={scopes.includes(scope)} disabled={busy} onChange={e => setScopes(previous => e.target.checked ? [...previous, scope] : previous.filter(x => x !== scope))} />{scope === 'inventory:read' ? 'Inventory, collection and physical locations' : 'Stock book and recorded sales'}<code>{scope}</code></label>)}</fieldset>
          <label>Expiry<select aria-label="API key expiry" value={expiry} disabled={busy} onChange={e => setExpiry(e.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="none">No expiry</option></select></label>
          <button className="btn btn-primary" disabled={busy || !data || !scopes.length}>Create read-only key</button>
        </form>
      </article>
      <article className="developer-panel"><h2>Connect your application</h2><p>Send the key as a Bearer token from your server. Keep it out of public client code.</p><dl><dt>Base endpoint</dt><dd><code>{endpoint}</code></dd><dt>Authentication</dt><dd><code>Authorization: Bearer $CARDRAILS_API_KEY</code></dd><dt>Pagination</dt><dd>limit: 1–100 (default 50) · offset: 0 or greater</dd></dl><p>Set CARDRAILS_API_KEY to your own key, then run:</p>
        <label>Resource<select aria-label="API resource" value={resource} onChange={e => { setResource(e.target.value); setResult(null); }}>{(data?.resources || []).map(entry => <option key={entry.resource} value={entry.resource}>{entry.resource}</option>)}</select></label>
        <pre>{curl}</pre><p>401: invalid, expired or revoked key · 403: missing permission · 405: writes refused.</p>
      </article>
    </div>
    {created && <article className="developer-panel developer-secret" role="status"><h2>Save your new key</h2><p>This is the only time the complete key is shown. Copy it before closing this panel.</p><label>API key<input aria-label="New API key" readOnly value={created.secret} spellCheck={false} autoComplete="off" /></label><div className="row-actions"><button className="btn btn-small" disabled={busy} onClick={() => run(async () => { await navigator.clipboard.writeText(created.secret); setNotice('API key copied.'); })}>Copy key</button><button className="btn btn-small" disabled={busy} onClick={test}>Test read API</button><button className="btn btn-small" disabled={busy} onClick={() => { setCreated(null); setResult(null); }}>I saved the key</button></div>
      {result && <div><h3>Live API response</h3><pre className="developer-response" aria-label="Live API response">{JSON.stringify(result, null, 2)}</pre><button className="btn btn-small" onClick={() => downloadJson(result, `cardrails-${resource}.json`)}>Download response</button></div>}
    </article>}
    <article className="developer-panel"><div className="developer-panel-title"><h2>Your API keys</h2><button className="btn btn-small" disabled={busy || !data} onClick={() => run(async () => setData(await request('developer')))}>Refresh keys</button></div><div className="developer-table-wrap"><table className="developer-table"><thead><tr><th>Name / key</th><th>Permissions</th><th>Status</th><th>Created / expires</th><th>Last used</th><th>Requests</th><th>Action</th></tr></thead><tbody>{data?.keys.length === 0 && <tr><td colSpan={7}>No API keys yet. Create one for your integration above.</td></tr>}{data?.keys.map(key => <tr key={key.id}><td><b>{key.name}</b><small><code>{key.prefix}</code></small></td><td>{key.scopes.map(scope => <small key={scope}><code>{scope}</code></small>)}</td><td><span className={'developer-status ' + status(key).toLowerCase()}>{status(key)}</span></td><td><small>{date(key.createdAt)}</small><small>{key.expiresAt ? date(key.expiresAt) : 'No expiry'}</small></td><td>{key.lastUsedAt ? date(key.lastUsedAt) : 'Never used'}</td><td>{key.requestCount}</td><td>{status(key) === 'Active' && <button className="btn btn-small" disabled={busy} onClick={() => revoke(key)}>Revoke {key.name}</button>}</td></tr>)}</tbody></table></div></article>
    <article className="developer-panel"><div className="developer-panel-title"><h2>API reference</h2><button className="btn btn-small" disabled={!data} onClick={() => downloadJson({ version: '1', endpoint, authentication: 'Bearer', methods: ['GET'], resources: data.resources, pagination: { limit: '1..100', offset: '0 or greater' } }, 'cardrails-api-reference.json')}>Download reference</button></div><div className="developer-reference">{data?.resources.map(entry => <div key={entry.resource}><h3>GET <code>?resource={entry.resource}</code></h3><span>{entry.scope || 'Any active key'}</span><p>{entry.description}</p></div>)}</div><p>Responses contain your own saved data. Empty inventory and sales return empty arrays. Photos remain private; hasScanPhoto reports whether a saved scan exists.</p><p>Your key belongs to this inventory. Manage it from the owner browser or your paired phone. Revocation applies to subsequent requests immediately.</p></article>
  </section>;
}
