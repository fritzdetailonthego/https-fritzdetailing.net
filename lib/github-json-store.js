const DEFAULT_GITHUB_DATA_BRANCH = 'data-store';
const REPOSITORY_METADATA_TTL_MS = 5 * 60 * 1000;
let repositoryPrivacyCache = null;

function getGitHubConfig() {
  const token = process.env.GITHUB_DATA_TOKEN;
  const repo = process.env.GITHUB_DATA_REPO;

  if (!token && !repo) {
    return null;
  }

  if (
    !token ||
    !repo ||
    process.env.BLOB_READ_WRITE_TOKEN ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
  ) {
    return { token, repo, invalid: true };
  }

  return { token, repo };
}

function hasGitHubJsonStore() {
  return Boolean(getGitHubConfig());
}

function getGitHubDataPath(path) {
  return path.includes('/') ? path : `data/${path}`;
}

function getGitHubDataBranch() {
  return process.env.GITHUB_DATA_BRANCH || DEFAULT_GITHUB_DATA_BRANCH;
}

function createGitHubError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function assertPrivateGitHubRepository(config) {
  if (config.invalid) {
    throw createGitHubError(
      503,
      'Private GitHub data storage is configured incorrectly.',
      'GITHUB_JSON_INVALID_REPOSITORY'
    );
  }

  const now = Date.now();
  if (
    repositoryPrivacyCache &&
    repositoryPrivacyCache.repo === config.repo &&
    now - repositoryPrivacyCache.checkedAt < REPOSITORY_METADATA_TTL_MS
  ) {
    if (repositoryPrivacyCache.isPrivate) return;
    throw createGitHubError(
      503,
      'Customer data storage requires a private GitHub repository.',
      'GITHUB_JSON_REPOSITORY_NOT_PRIVATE'
    );
  }

  const apiUrl = `https://api.github.com/repos/${encodeURIComponentPath(config.repo)}`;
  const response = await fetch(apiUrl, {
    headers: getGitHubHeaders(config.token),
    cache: 'no-store'
  });
  if (!response.ok) {
    throw createGitHubError(
      response.status,
      'Could not verify that the GitHub data repository is private.',
      'GITHUB_JSON_PRIVACY_CHECK_FAILED'
    );
  }

  const metadata = await response.json();
  const isPrivate = metadata && metadata.private === true;
  repositoryPrivacyCache = { repo: config.repo, isPrivate, checkedAt: now };
  if (!isPrivate) {
    throw createGitHubError(
      503,
      'Customer data storage requires a private GitHub repository.',
      'GITHUB_JSON_REPOSITORY_NOT_PRIVATE'
    );
  }
}

async function readGitHubJson(path, fallbackValue) {
  const config = getGitHubConfig();
  if (!config) {
    return {
      configured: false,
      storage: 'github',
      data: cloneJson(fallbackValue),
      sha: null
    };
  }
  await assertPrivateGitHubRepository(config);

  const filePath = getGitHubDataPath(path);
  const branch = getGitHubDataBranch();
  const apiUrl = `https://api.github.com/repos/${config.repo}/contents/${encodeURIComponentPath(filePath)}?ref=${encodeURIComponent(branch)}`;
  const response = await fetch(apiUrl, {
    headers: getGitHubHeaders(config.token),
    cache: 'no-store'
  });

  if (response.status === 404) {
    return {
      configured: true,
      storage: 'github',
      data: cloneJson(fallbackValue),
      sha: null,
      path: filePath,
      branch
    };
  }

  if (!response.ok) {
    throw createGitHubError(
      response.status,
      'GitHub JSON storage is temporarily unavailable. Please try again.',
      'GITHUB_JSON_READ_FAILED'
    );
  }

  const metadata = await response.json();
  const content = typeof metadata.content === 'string' ? metadata.content.replace(/\s/g, '') : '';
  const text = Buffer.from(content, 'base64').toString('utf8');

  return {
    configured: true,
    storage: 'github',
    data: JSON.parse(text),
    sha: metadata.sha || null,
    path: filePath,
    branch
  };
}

async function writeGitHubJson(path, data, sha, message) {
  const config = getGitHubConfig();
  if (!config) {
    throw createGitHubError(503, 'GitHub JSON storage is not configured.', 'GITHUB_JSON_NOT_CONFIGURED');
  }
  await assertPrivateGitHubRepository(config);

  const filePath = getGitHubDataPath(path);
  const branch = getGitHubDataBranch();
  const apiUrl = `https://api.github.com/repos/${config.repo}/contents/${encodeURIComponentPath(filePath)}`;
  const response = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      ...getGitHubHeaders(config.token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `${message || `Update ${filePath}`} [skip ci]`,
      content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    })
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    const detailMessage = details && details.message ? details.message : '';
    const isConflict =
      response.status === 409 ||
      (response.status === 422 && /sha|already exists|does not match/i.test(detailMessage));
    const error = createGitHubError(
      response.status,
      isConflict
        ? 'The schedule was updated at the same time. Please try again.'
        : 'GitHub JSON storage is temporarily unavailable. Please try again.',
      isConflict ? 'GITHUB_JSON_CONFLICT' : 'GITHUB_JSON_WRITE_FAILED'
    );
    error.githubMessage = detailMessage;
    throw error;
  }

  const result = await response.json();
  return {
    storage: 'github',
    sha: result && result.content ? result.content.sha : null,
    path: filePath,
    branch
  };
}

function isGitHubJsonConflict(error) {
  return (
    error &&
    (error.code === 'GITHUB_JSON_CONFLICT' ||
      error.statusCode === 409 ||
      error.status === 409 ||
      error.statusCode === 422 ||
      error.status === 422)
  );
}

function getGitHubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'fritz-detailing-site'
  };
}

function encodeURIComponentPath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  hasGitHubJsonStore,
  isGitHubJsonConflict,
  readGitHubJson,
  writeGitHubJson
};
