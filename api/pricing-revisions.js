// Stores and retrieves pricing revision history in Vercel Blob
const { put, get } = require('@vercel/blob');
const {
  hasGitHubJsonStore,
  readGitHubJson,
  writeGitHubJson
} = require('../lib/github-json-store');

const PRICING_REVISIONS_PATH = 'pricing-revisions-data.json';

function createRevisionId() {
  return `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseRevisionIndex(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { password, action, pricing } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;

  async function readRevisionsState() {
    if (hasGitHubJsonStore()) {
      try {
        const state = await readGitHubJson(PRICING_REVISIONS_PATH, []);
        return {
          ...state,
          data: Array.isArray(state.data) ? state.data : []
        };
      } catch (_githubError) {
        // Fall through to Blob only if the GitHub runtime store is unreachable.
      }
    }

    let blobError = null;
    try {
      const result = await get(PRICING_REVISIONS_PATH, {
        access: 'public',
        token,
        useCache: false
      });
      if (result) {
        const text = await new Response(result.stream).text();
        const data = JSON.parse(text);
        return { data: Array.isArray(data) ? data : [], storage: 'blob' };
      }
    } catch (error) {
      blobError = error;
    }

    if (blobError) throw blobError;
    return { data: [], storage: 'blob' };
  }

  async function readRevisions() {
    const state = await readRevisionsState();
    return state.data;
  }

  async function writeRevisions(revisions, state = null) {
    if (hasGitHubJsonStore()) {
      const currentState = state || await readGitHubJson(PRICING_REVISIONS_PATH, []);
      await writeGitHubJson(
        PRICING_REVISIONS_PATH,
        revisions,
        currentState.sha || null,
        `Update ${PRICING_REVISIONS_PATH}`
      );
      return;
    }

    await put('pricing-revisions-data.json', JSON.stringify(revisions), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      token
    });
  }

  try {
    if (action === 'save') {
      const state = await readRevisionsState();
      const revisions = state.data;
      revisions.push({ id: createRevisionId(), timestamp: new Date().toISOString(), pricing });
      // Keep last 50 revisions
      if (revisions.length > 50) revisions.splice(0, revisions.length - 50);
      await writeRevisions(revisions, state);
      return res.json({ success: true, revision: revisions.length });
    }

    if (action === 'list') {
      const revisions = await readRevisions();
      const ordered = revisions.map((revision, index) => ({
        id: revision.id || `legacy-${index}`,
        index,
        timestamp: revision.timestamp
      })).reverse();
      return res.json({ revisions: ordered });
    }

    if (action === 'restore') {
      const { revisionId } = req.body;
      const revisions = await readRevisions();
      const revisionIndex = parseRevisionIndex(req.body.revisionIndex);

      const revision =
        (typeof revisionId === 'string' && revisionId
          ? revisions.find((entry, index) => (entry.id || `legacy-${index}`) === revisionId)
          : null) ||
        (revisionIndex !== null && revisionIndex >= 0 && revisionIndex < revisions.length
          ? revisions[revisionIndex]
          : null);

      if (revision) {
        return res.json({ success: true, pricing: revision.pricing });
      }
      // Fallback: try last revision
      if (revisions.length > 0) {
        return res.json({ success: true, pricing: revisions[revisions.length - 1].pricing });
      }
      return res.status(404).json({ error: 'No revisions found' });
    }

    res.status(400).json({ error: 'Invalid action. Use save, list, or restore.' });
  } catch (e) {
    console.error('Pricing revision error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
