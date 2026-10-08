import { createHash } from 'node:crypto';
import { apiError, guard, rawDeviceToken } from '../../server/workspace.js';
import { developer } from '../../server/developer.js';
import ebayDraft from '../../server/ebayDraft.js';
export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const resource = req.query?.resource || 'keys';
    if (resource === 'ebay-draft') return await ebayDraft(req, res);
    if (req.headers.authorization) {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw Object.assign(new Error('API keys are read-only. Writes and key management require the owner session.'), { status: 405 });
      }
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization)?.[1];
      return res.status(200).json(await developer.read(token, resource, req.query || {}));
    }
    guard(req, res, ['GET', 'POST']);
    const token = rawDeviceToken(req);
    if (!token) throw Object.assign(new Error('Open your Card Rails inventory to manage API keys.'), { status: 401 });
    if (resource !== 'keys') throw Object.assign(new Error('A Bearer API key is required for this resource.'), { status: 401 });
    const owner = createHash('sha256').update(token).digest('hex');
    if (req.method === 'GET') return res.status(200).json(await developer.list(owner));
    if (req.body?.action === 'create') return res.status(201).json(await developer.create(owner, req.body));
    if (req.body?.action === 'revoke') return res.status(200).json(await developer.revoke(owner, req.body.id));
    throw Object.assign(new Error('Unknown key-management action.'), { status: 400 });
  } catch (error) { apiError(res, error); }
}
