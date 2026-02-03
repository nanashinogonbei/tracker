/**
 * corsAndSignature.js
 *
 * ① Per-project CORS origin validation
 *      – Each Project document carries an `allowedOrigins` array.
 *      – SDK-facing endpoints call `isAllowedTrackingOrigin(origin, project)`.
 *      – Admin/auth endpoints honour the env-level ALLOWED_ORIGINS list
 *        (unchanged, kept in security.js → getCorsOptions).
 *
 * ② HMAC request signing for SDK → server communication
 *      – The SDK signs every outbound POST with HMAC-SHA256 over
 *        `<timestamp>.<projectId>.<url>` using the project's apiKey as the key.
 *      – The server re-derives the expected signature from the same apiKey
 *        (fetched from the DB) and compares with timing-safe comparison.
 *      – A configurable clock-skew window (default 5 min) protects against
 *        replay attacks.
 *
 * Environment variables consumed:
 *   SIGNING_WINDOW_MS (optional) – replay-attack window in ms (default 300000).
 */

const crypto = require('crypto');
const Project = require('../models/Project');

// ─── 1. Per-project origin validation ────────────────────────────────────────

/**
 * Returns true when `origin` is permitted for the given project.
 * Falls back to the global ALLOWED_ORIGINS env var when the project has no
 * explicit list.  In development (no global list) everything is allowed.
 *
 * @param {string|undefined} origin  – Origin header value
 * @param {object|null}      project – Mongoose Project document (or null)
 * @returns {boolean}
 */
/**
 * Origin を正規化する。末尾スラッシュを除去・小文字化する。
 * Origin ヘッダー自体はスラッシュを含まないことが仕様だが、
 * allowedOrigins に誤りで入った場合にも対応する。
 */
function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().replace(/\/+$/, '').toLowerCase();
}

function isAllowedTrackingOrigin(origin, project) {
  if (!origin) return true; // same-origin / server-side

  const normalizedOrigin = normalizeOrigin(origin);

  // Project-level allowlist
  if (project && Array.isArray(project.allowedOrigins) && project.allowedOrigins.length > 0) {
    console.log(`[CORS] Checking origin "${origin}" (normalized: "${normalizedOrigin}") against project ${project._id} allowedOrigins:`, JSON.stringify(project.allowedOrigins));

    const matched = project.allowedOrigins.some(allowed => {
      const normalizedAllowed = normalizeOrigin(allowed);

      // 完全一致（正規化済み）
      if (normalizedOrigin === normalizedAllowed) return true;

      // Wildcard sub-domain: "https://*.example.com"
      if (allowed.startsWith('https://*.') || allowed.startsWith('http://*.')) {
        const baseDomain = allowed.replace(/^https?:\/\/\*/, ''); // ".example.com"
        try {
          const originHost = new URL(origin).hostname;
          return originHost.endsWith(baseDomain) || originHost === baseDomain.slice(1);
        } catch (_) {
          return false;
        }
      }
      return false;
    });

    if (!matched) {
      console.warn(`[CORS] Origin "${origin}" did not match any entry in allowedOrigins for project ${project._id}`);
    }
    return matched;
  }

  // allowedOrigins が空の場合はログに明示する
  console.warn(`[CORS] Project ${project?._id || 'unknown'} has empty allowedOrigins. Falling back to global ALLOWED_ORIGINS env.`);

  // Global fallback
  const globalOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : [];

  if (globalOrigins.length === 0) {
    console.warn(`[CORS] Global ALLOWED_ORIGINS is also empty. NODE_ENV=${process.env.NODE_ENV}. ${process.env.NODE_ENV === 'production' ? 'BLOCKING.' : 'Allowing (dev).'}`);
    return process.env.NODE_ENV !== 'production';
  }

  return globalOrigins.includes(origin);
}

/**
 * Returns a `cors` origin-callback bound to the request's resolved project.
 * @param {object} req – Express request (req.resolvedProject may be set)
 */
function corsOriginCallback(req) {
  return function (origin, cb) {
    const allowed = isAllowedTrackingOrigin(origin, req.resolvedProject || null);
    if (allowed) {
      cb(null, origin || true);
    } else {
      console.warn(`[CORS] Blocked origin "${origin}" for project ${req.resolvedProject?._id || 'unknown'}`);
      cb(null, false);
    }
  };
}

/**
 * Middleware: resolves Project from req.body.projectId or req.params.projectId
 * and attaches it to req.resolvedProject.  Must run BEFORE the per-request
 * cors() call so the origin check has project context.
 */
async function projectLookupMiddleware(req, res, next) {
  try {
    const projectId = req.body?.projectId || req.params?.projectId;
    if (projectId) {
      const project = await Project.findById(projectId);
      if (project) {
        req.resolvedProject = project;
      }
    }
  } catch (_) { /* continue without project */ }
  next();
}

// ─── 2. HMAC request signing ─────────────────────────────────────────────────

const SIGNING_WINDOW_MS = parseInt(process.env.SIGNING_WINDOW_MS, 10) || 300_000; // 5 min

/**
 * Canonical payload: `<timestamp>.<projectId>.<url>`
 * SDK and server must agree on this exactly.
 */
function buildSignaturePayload(timestamp, projectId, url) {
  return `${timestamp}.${projectId}.${url}`;
}

/**
 * Compute HMAC-SHA256 signature.
 *
 * キー = project.apiKey
 *   SDK側: Web Crypto API で apiKey を直接キーとして使用
 *   サーバー側: Node crypto で同じ apiKey を使用
 *
 * @param {string|number} timestamp
 * @param {string}        projectId
 * @param {string}        url
 * @param {string}        apiKey  – the project's apiKey (from DB)
 * @returns {string} hex signature
 */
function computeSignature(timestamp, projectId, url, apiKey) {
  const payload = buildSignaturePayload(timestamp, projectId, url);
  return crypto
    .createHmac('sha256', apiKey)
    .update(payload)
    .digest('hex');
}

/**
 * Express middleware: verifies HMAC signature on incoming SDK requests.
 *
 * Required body fields: projectId, url, _ts, _sig
 *
 * Handles the sendBeacon edge-case where body may arrive empty but rawBody
 * contains the JSON (because sendBeacon sends as Blob).
 */
async function verifySignature(req, res, next) {
  let data = req.body || {};

  // sendBeacon → body が空, rawBody がある場合に再パース
  if ((!data || Object.keys(data).length === 0) && req.rawBody) {
    try {
      data = JSON.parse(req.rawBody);
      req.body = data;
    } catch (_) { /* fallthrough */ }
  }

  const { projectId, _ts, _sig, url } = data;

  // ── 必須フィールドチェック ──
  if (!projectId || !_ts || !_sig || !url) {
    return res.status(401).json({
      error: 'Missing signature fields',
      code: 'SIGNATURE_MISSING'
    });
  }

  // ── リプレイ攻撃ウィンドウチェック ──
  const now = Date.now();
  const ts = Number(_ts);
  if (isNaN(ts) || Math.abs(now - ts) > SIGNING_WINDOW_MS) {
    console.warn(`[Signature] Timestamp out of window: ts=${_ts}, now=${now}, diff=${now - ts}ms`);
    return res.status(401).json({
      error: 'Request timestamp out of allowed window',
      code: 'SIGNATURE_EXPIRED'
    });
  }

  // ── Project & apiKey 取得 ──
  let project = req.resolvedProject;
  if (!project) {
    try {
      project = await Project.findById(projectId);
    } catch (_) { /* fallthrough */ }
  }

  if (!project || !project.apiKey) {
    console.warn(`[Signature] Project not found or has no apiKey: ${projectId}`);
    return res.status(401).json({
      error: 'Invalid project',
      code: 'SIGNATURE_INVALID'
    });
  }

  // ── 署名検証 ──
  const expectedSig = computeSignature(ts, projectId, url, project.apiKey);

  // 長さが異なる場合は timingSafeEqual でエラーになるため事前にチェック
  if (typeof _sig !== 'string' || _sig.length !== expectedSig.length) {
    console.warn(`[Signature] Signature length mismatch for project ${projectId}`);
    return res.status(401).json({
      error: 'Invalid request signature',
      code: 'SIGNATURE_INVALID'
    });
  }

  try {
    if (!crypto.timingSafeEqual(Buffer.from(_sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      console.warn(`[Signature] Verification failed for project ${projectId}`);
      return res.status(401).json({
        error: 'Invalid request signature',
        code: 'SIGNATURE_INVALID'
      });
    }
  } catch (_) {
    return res.status(401).json({
      error: 'Invalid request signature',
      code: 'SIGNATURE_INVALID'
    });
  }

  req.signatureVerified = true;
  req.resolvedProject = project;
  next();
}

/** Alias for impression-log route – identical logic, exists for route clarity */
const verifyImpressionSignature = verifySignature;

module.exports = {
  // Origin helpers
  isAllowedTrackingOrigin,
  corsOriginCallback,
  projectLookupMiddleware,

  // Signing helpers
  buildSignaturePayload,
  computeSignature,
  verifySignature,
  verifyImpressionSignature,
  SIGNING_WINDOW_MS
};