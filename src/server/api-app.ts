import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { del as deleteBlob, get as getBlob, head as headBlob, put as putBlob } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import {
  ORGANIZATIONS,
  getOrgByCode,
} from '../config/org-config.ts';
import { getCentralDb, getOrgDb, initializeAllDatabases } from '../lib/turso.ts';
import type {
  AuthUser,
  OrganizationProfile,
  OrgPost,
  ProposalSubmission,
  SubmissionQueueItem,
} from '../types/portal.ts';

const MAX_PROPOSAL_SIZE_BYTES = 25 * 1024 * 1024;

function rejectIfBlobIsUnconfigured(res: Response): boolean {
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) return false;
  res.status(503).json({
    error: 'Blob uploads are not configured. Set BLOB_READ_WRITE_TOKEN in the server environment and restart the server.',
  });
  return true;
}

interface AuthenticatedRequest extends Request {
  authUser?: AuthUser | null;
  authError?: string;
  authStatus?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeJwtPart(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new Error('Invalid token encoding.');
  }
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
}

function verifyPhpAuthToken(token: string, secret: string): AuthUser {
  if (token.length > 4096) {
    throw new Error('Token is too large.');
  }

  const [encodedHeader, encodedPayload, encodedSignature, ...extraParts] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extraParts.length > 0) {
    throw new Error('Malformed token.');
  }

  const header = decodeJwtPart(encodedHeader);
  const claims = decodeJwtPart(encodedPayload);
  if (!isRecord(header) || header.alg !== 'HS256' || header.typ !== 'JWT' || !isRecord(claims)) {
    throw new Error('Unsupported token.');
  }

  const suppliedSignature = Buffer.from(encodedSignature, 'base64url');
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new Error('Invalid token signature.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== 'ptc-php-auth' ||
    claims.aud !== 'ptc-org' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat > now + 30 ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 3600 ||
    typeof claims.sub !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(claims.sub) ||
    typeof claims.email !== 'string' ||
    claims.email.length > 254 ||
    !claims.email.includes('@') ||
    typeof claims.name !== 'string' ||
    claims.name.trim().length === 0 ||
    claims.name.length > 120
  ) {
    throw new Error('Invalid or expired token claims.');
  }

  if (claims.role === 'cessca' && claims.orgCode === null) {
    return {
      uid: claims.sub,
      email: claims.email,
      displayName: claims.name,
      role: 'cessca',
      orgCode: null,
    };
  }

  if (claims.role === 'president' && typeof claims.orgCode === 'string') {
    const org = getOrgByCode(claims.orgCode);
    if (org && org.code === claims.orgCode) {
      return {
        uid: claims.sub,
        email: claims.email,
        displayName: claims.name,
        role: 'president',
        orgCode: org.code,
      };
    }
  }

  throw new Error('Invalid token role.');
}

function getAuthCookie(req: Request): string | null {
  const cookies = req.headers.cookie?.split(';') ?? [];
  const cookie = cookies.find((part) => part.trim().startsWith('ptc_auth='));
  return cookie ? cookie.trim().slice('ptc_auth='.length) : null;
}

function resolvePortalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  req.authUser = null;
  const token = getAuthCookie(req);
  if (!token) return next();

  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    req.authStatus = 503;
    req.authError = 'AUTH_JWT_SECRET must be configured with at least 32 characters.';
    return next();
  }

  try {
    req.authUser = verifyPhpAuthToken(token, secret);
  } catch {
    req.authStatus = 401;
    req.authError = 'Your sign-in session is invalid or expired. Please sign in again.';
  }
  return next();
}

function mapRowToOrganizationProfile(
  row?: Record<string, unknown>
): OrganizationProfile {
  return {
    bannerDataUrl: row?.banner_data_url ? String(row.banner_data_url) : null,
    avatarDataUrl: row?.avatar_data_url ? String(row.avatar_data_url) : null,
    aboutText: row?.about_text ? String(row.about_text) : '',
    organizationName: row?.organization_name ? String(row.organization_name) : '',
    organizationShortName: row?.organization_short_name
      ? String(row.organization_short_name)
      : '',
    presidentName: row?.president_name ? String(row.president_name) : '',
    facebookUrl:
      row?.facebook_url === null || row?.facebook_url === undefined
        ? null
        : String(row.facebook_url),
  };
}

async function getOrganizationNames(orgCode: string) {
  const org = getOrgByCode(orgCode);
  if (!org) throw new Error(`Unknown organization code: ${orgCode}`);
  const result = await getOrgDb(org.code).execute(
    'SELECT organization_name, organization_short_name, president_name FROM organization_profile WHERE id = 1'
  );
  const row = result.rows[0];
  return {
    fullName: row?.organization_name ? String(row.organization_name) : org.fullName,
    shortName: row?.organization_short_name
      ? String(row.organization_short_name)
      : org.shortName,
    presidentName: row?.president_name ? String(row.president_name) : org.president,
  };
}

async function incrementPortalLiveVersion() {
  await getCentralDb().execute(
    'UPDATE portal_live_version SET version = version + 1 WHERE id = 1'
  );
}

function parsePostImageUrls(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (imageUrl): imageUrl is string => typeof imageUrl === 'string' && imageUrl.length > 0
      );
    }
  } catch {
    // Older posts store a single image URL as plain text.
  }
  return [value];
}

function mapRowToOrgPost(
  row: Record<string, unknown>,
  orgCode: string,
  names?: { fullName: string; shortName: string }
): OrgPost {
  const org = getOrgByCode(orgCode);
  const imageUrls = parsePostImageUrls(row.image_url);
  return {
    id: String(row.id),
    letterRef: String(row.letter_ref),
    orgCode: String(row.org_code),
    orgShortName: names?.shortName ?? org?.shortName ?? orgCode.toUpperCase(),
    orgFullName: names?.fullName ?? org?.fullName ?? orgCode.toUpperCase(),
    authorName: String(row.author_name),
    title: String(row.title),
    eventDate: String(row.event_date),
    caption: String(row.caption),
    imageUrl: imageUrls.length === 1 ? imageUrls[0] : null,
    imageUrls,
    status: String(row.status) as OrgPost['status'],
    feedback: row.feedback ? String(row.feedback) : null,
    likesCount: Number(row.likes_count ?? 0),
    createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
  };
}

function mapRowToQueueItem(row: Record<string, unknown>): SubmissionQueueItem {
  const imageUrls = parsePostImageUrls(row.image_url);
  return {
    id: String(row.id),
    letterRef: String(row.letter_ref),
    orgCode: String(row.org_code),
    orgShortName: String(row.org_short_name),
    orgFullName: String(row.org_full_name),
    presidentName: String(row.president_name),
    title: String(row.title),
    eventDate: String(row.event_date),
    caption: String(row.caption),
    imageUrl: imageUrls[0] ?? null,
    status: String(row.status) as SubmissionQueueItem['status'],
    feedback: row.feedback ? String(row.feedback) : null,
    submittedAt: String(row.submitted_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
  };
}

function mapRowToProposal(row: Record<string, unknown>): ProposalSubmission {
  return {
    id: String(row.id),
    orgCode: String(row.org_code),
    orgShortName: String(row.org_short_name),
    orgFullName: String(row.org_full_name),
    presidentName: String(row.president_name),
    title: String(row.title),
    message: String(row.message),
    fileName: String(row.file_name),
    contentType: String(row.content_type),
    fileSize: Number(row.file_size),
    submittedAt: String(row.submitted_at),
    status: String(row.status) as ProposalSubmission['status'],
    feedback: row.feedback ? String(row.feedback) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
  };
}

function safeDownloadName(fileName: string): string {
  return fileName.replace(/[\r\n"\\/]/g, '_').slice(0, 255) || 'proposal-file';
}

const INLINE_PROPOSAL_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function getInlineProposalContentType(value: unknown): string | null {
  const contentType = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return INLINE_PROPOSAL_CONTENT_TYPES.has(contentType) ? contentType : null;
}

function isValidProposalPath(pathname: string, requiredPrefix: string): boolean {
  return (
    pathname.startsWith(requiredPrefix) &&
    !pathname.split('/').some((segment) => segment === '.' || segment === '..') &&
    !pathname.includes('\\')
  );
}

export async function createApiApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(resolvePortalAuth);
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (
      req.path === '/health' ||
      req.path === '/auth/login' ||
      req.path === '/auth/me' ||
      req.path === '/auth/logout'
    ) {
      return next();
    }

    void initializeAllDatabases()
      .then(() => next())
      .catch((error: unknown) => {
        console.error('Failed to initialize portal databases:', error);
        res.status(503).json({ error: 'Portal databases are unavailable.' });
      });
  });

  // Health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/updates/version', async (_req: Request, res: Response) => {
    try {
      const result = await getCentralDb().execute(
        'SELECT version FROM portal_live_version WHERE id = 1'
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ version: Number(result.rows[0]?.version ?? 0) });
    } catch (error) {
      console.error('Failed to read live update version:', error);
      return res.status(500).json({ error: 'Unable to check for live updates.' });
    }
  });

  // Auth: Proxy credentials to PHP, then keep the signed session cookie on the portal origin.
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const origin = req.get('origin');
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== req.get('host')) {
      return res.status(403).json({ error: 'Sign-in requests must come from the portal site.' });
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      password.length < 1 ||
      password.length > 1024
    ) {
      return res.status(400).json({ error: 'Enter a valid email address and password.' });
    }

    const phpAuthUrl = process.env.PHP_AUTH_URL?.trim().replace(/\/+$/, '');
    const secret = process.env.AUTH_JWT_SECRET;
    if (!phpAuthUrl || !secret || Buffer.byteLength(secret, 'utf8') < 32) {
      return res.status(503).json({
        error: 'PHP_AUTH_URL and a matching AUTH_JWT_SECRET of at least 32 characters must be configured.',
      });
    }

    let endpoint: URL;
    try {
      endpoint = new URL(`${phpAuthUrl}/login.php`);
    } catch {
      return res.status(503).json({ error: 'PHP_AUTH_URL is not a valid URL.' });
    }
    if (
      (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') ||
      !['http:', 'https:'].includes(endpoint.protocol)
    ) {
      return res.status(503).json({ error: 'The PHP authentication service must use HTTPS in production.' });
    }

    let phpResponse: Awaited<ReturnType<typeof fetch>>;
    try {
      phpResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      console.error('PHP authentication service request failed:', error);
      return res.status(503).json({ error: 'The PHP authentication service is unavailable.' });
    }

    const phpData: unknown = await phpResponse.json().catch(() => null);
    if (!isRecord(phpData)) {
      console.error('PHP authentication service returned an invalid response.');
      return res.status(502).json({ error: 'The PHP authentication service returned an invalid response.' });
    }
    if (!phpResponse.ok) {
      const status = [400, 401, 403].includes(phpResponse.status)
        ? phpResponse.status
        : 503;
      const message =
        typeof phpData.error === 'string'
          ? phpData.error
          : status === 401
            ? 'Invalid email or password.'
            : 'Unable to sign in.';
      return res.status(status).json({ error: message });
    }

    if (typeof phpData.token !== 'string') {
      console.error('PHP authentication service response did not contain a token.');
      return res.status(502).json({ error: 'The PHP authentication service returned an invalid response.' });
    }

    let user: AuthUser;
    try {
      user = verifyPhpAuthToken(phpData.token, secret);
    } catch (error) {
      console.error('PHP authentication service returned an invalid token:', error);
      return res.status(502).json({ error: 'The portal could not verify the PHP authentication response.' });
    }

    res.cookie('ptc_auth', phpData.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 1000,
    });
    return res.json({ user });
  });

  // Auth: Verify the PHP-issued session cookie and expose its portal role.
  app.get('/api/auth/me', (req: AuthenticatedRequest, res) => {
    if (req.authError) {
      return res.status(req.authStatus ?? 503).json({ user: null, error: req.authError });
    }
    res.json({ user: req.authUser ?? null });
  });

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.clearCookie('ptc_auth', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
    res.status(204).end();
  });

  // Upload event image (accepts base64 data URL from FileReader)
  app.post('/api/upload', async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.authUser || (req.authUser.role !== 'president' && req.authUser.role !== 'cessca')) {
        return res.status(403).json({ error: 'Only authenticated organization officers may upload media.' });
      }
      const dataUrl = String(req.body?.dataUrl ?? '');
      const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Invalid image format. Please upload a PNG, JPG, or WebP image.' });
      }
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.byteLength > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image must be 5 MB or smaller.' });
      }
      return res.json({ url: dataUrl });
    } catch (error) {
      console.error('Upload error:', error);
      return res.status(500).json({ error: 'Failed to upload image.' });
    }
  });

  // List all 12 organizations with live counts from their isolated libSQL databases
  app.get('/api/organizations', async (_req: Request, res: Response) => {
    try {
      const organizations = await Promise.all(
        ORGANIZATIONS.map(async (org) => {
          const db = getOrgDb(org.code);
          const result = await db.execute(`
            SELECT
              (SELECT COUNT(*) FROM posts WHERE status = 'approved') AS approved_count,
              (SELECT COUNT(*) FROM posts WHERE status = 'pending') AS pending_count,
              (SELECT MAX(created_at) FROM posts WHERE status = 'approved') AS latest_post_at,
              profile.avatar_data_url,
              profile.updated_at,
              profile.about_text,
              profile.organization_name,
              profile.organization_short_name,
              profile.president_name,
              profile.facebook_url
            FROM (SELECT 1) AS singleton
            LEFT JOIN organization_profile AS profile ON profile.id = 1
          `);
          const row = result.rows[0];
          return {
            ...org,
            fullName: row?.organization_name
              ? String(row.organization_name)
              : org.fullName,
            shortName: row?.organization_short_name
              ? String(row.organization_short_name)
              : org.shortName,
            president: row?.president_name ? String(row.president_name) : org.president,
            aboutText: row?.about_text ? String(row.about_text) : '',
            facebookUrl:
              row?.facebook_url === null || row?.facebook_url === undefined
                ? org.facebookUrl
                : String(row.facebook_url),
            approvedCount: Number(row?.approved_count ?? 0),
            pendingCount: Number(row?.pending_count ?? 0),
            latestPostAt: row?.latest_post_at ? String(row.latest_post_at) : null,
            avatarUrl: row?.avatar_data_url
              ? `/api/organizations/${org.code}/profile/avatar?v=${encodeURIComponent(
                  String(row.updated_at ?? '')
                )}`
              : null,
          };
        })
      );
      return res.json({ organizations });
    } catch (error) {
      console.error('Failed to fetch organizations:', error);
      return res.status(500).json({ error: 'Failed to load organizations.' });
    }
  });

  // Global approved feed across all 12 isolated organization databases
  app.get('/api/feed', async (req: Request, res: Response) => {
    try {
      const orgFilter = String(req.query.org ?? '').trim().toLowerCase();
      const targetOrgs = orgFilter
        ? ORGANIZATIONS.filter((o) => o.code === orgFilter)
        : ORGANIZATIONS;

      const allPosts: OrgPost[] = [];
      for (const org of targetOrgs) {
        const db = getOrgDb(org.code);
        const result = await db.execute(
          "SELECT * FROM posts WHERE status = 'approved' ORDER BY created_at DESC"
        );
        const names = await getOrganizationNames(org.code);
        for (const row of result.rows) {
          allPosts.push(
            mapRowToOrgPost(row as unknown as Record<string, unknown>, org.code, names)
          );
        }
      }

      allPosts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return res.json({ posts: allPosts });
    } catch (error) {
      console.error('Failed to load global feed:', error);
      return res.status(500).json({ error: 'Failed to load global feed.' });
    }
  });

  // Public approved posts for a specific organization
  app.get('/api/organizations/:code/posts', async (req: Request, res: Response) => {
    try {
      const org = getOrgByCode(String(req.params.code));
      if (!org) {
        return res.status(404).json({ error: 'Organization not found.' });
      }
      const db = getOrgDb(org.code);
      const result = await db.execute(
        "SELECT * FROM posts WHERE status = 'approved' ORDER BY created_at DESC"
      );
      const names = await getOrganizationNames(org.code);
      const posts = result.rows.map((row) =>
        mapRowToOrgPost(row as unknown as Record<string, unknown>, org.code, names)
      );
      return res.json({
        organization: { ...org, fullName: names.fullName, shortName: names.shortName },
        posts,
      });
    } catch (error) {
      console.error('Failed to load organization posts:', error);
      return res.status(500).json({ error: 'Failed to load organization posts.' });
    }
  });

  app.get('/api/organizations/:code/profile', async (req: Request, res: Response) => {
    try {
      const org = getOrgByCode(String(req.params.code));
      if (!org) {
        return res.status(404).json({ error: 'Organization not found.' });
      }

      const db = getOrgDb(org.code);
      const result = await db.execute(
        'SELECT banner_data_url, avatar_data_url, about_text, organization_name, organization_short_name, president_name, facebook_url FROM organization_profile WHERE id = 1'
      );
      const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
      return res.json({ profile: mapRowToOrganizationProfile(row) });
    } catch (error) {
      console.error('Failed to load organization profile:', error);
      return res.status(500).json({ error: 'Failed to load organization profile.' });
    }
  });

  app.get('/api/organizations/:code/profile/avatar', async (req: Request, res: Response) => {
    try {
      const org = getOrgByCode(String(req.params.code));
      if (!org) {
        return res.status(404).json({ error: 'Organization not found.' });
      }

      const db = getOrgDb(org.code);
      const result = await db.execute(
        'SELECT avatar_data_url FROM organization_profile WHERE id = 1'
      );
      const dataUrl = result.rows[0]?.avatar_data_url;
      if (!dataUrl) {
        return res.status(404).json({ error: 'Organization profile image not found.' });
      }
      const match = String(dataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) {
        throw new Error(`Stored profile image for ${org.code} has an invalid data URL.`);
      }

      res.setHeader('Content-Type', `image/${match[1]}`);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(Buffer.from(match[2], 'base64'));
    } catch (error) {
      console.error('Failed to load organization avatar:', error);
      return res.status(500).json({ error: 'Failed to load organization profile image.' });
    }
  });

  app.put(
    '/api/organizations/:code/profile/:asset',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const org = getOrgByCode(String(req.params.code));
        if (!org) {
          return res.status(404).json({ error: 'Organization not found.' });
        }

        const user = req.authUser;
        if (!user) {
          return res.status(401).json({ error: 'Please sign in as an organization officer.' });
        }
        if (user.role !== 'president' || user.orgCode !== org.code) {
          return res.status(403).json({ error: 'Only this organization’s officer can edit its profile.' });
        }

        const asset = String(req.params.asset);
        if (asset === 'about') {
          const aboutText: unknown = req.body?.aboutText;
          if (typeof aboutText !== 'string' || aboutText.length > 2000) {
            return res.status(400).json({ error: 'About must be text with a maximum of 2000 characters.' });
          }

          const db = getOrgDb(org.code);
          await db.execute({
            sql: `INSERT INTO organization_profile (id, about_text, updated_at)
                  VALUES (1, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    about_text = excluded.about_text,
                    updated_at = excluded.updated_at`,
            args: [aboutText.trim(), new Date().toISOString()],
          });
          await incrementPortalLiveVersion();
          const result = await db.execute(
            'SELECT banner_data_url, avatar_data_url, about_text, organization_name, organization_short_name, president_name, facebook_url FROM organization_profile WHERE id = 1'
          );
          const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
          return res.json({ profile: mapRowToOrganizationProfile(row) });
        }

        if (asset === 'facebook') {
          const facebookUrl: unknown = req.body?.facebookUrl;
          if (typeof facebookUrl !== 'string' || facebookUrl.length > 500) {
            return res.status(400).json({ error: 'Provide a Facebook page URL up to 500 characters.' });
          }

          const normalizedUrl = facebookUrl.trim();
          if (normalizedUrl) {
            try {
              const parsedUrl = new URL(normalizedUrl);
              if (
                parsedUrl.protocol !== 'https:' ||
                (parsedUrl.hostname !== 'facebook.com' &&
                  !parsedUrl.hostname.endsWith('.facebook.com')) ||
                parsedUrl.username ||
                parsedUrl.password
              ) {
                throw new Error('Invalid Facebook page URL.');
              }
            } catch {
              return res.status(400).json({ error: 'Enter a valid HTTPS Facebook page URL.' });
            }
          }

          const db = getOrgDb(org.code);
          await db.execute({
            sql: `INSERT INTO organization_profile (id, facebook_url, updated_at)
                  VALUES (1, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    facebook_url = excluded.facebook_url,
                    updated_at = excluded.updated_at`,
            args: [normalizedUrl, new Date().toISOString()],
          });
          await incrementPortalLiveVersion();
          const result = await db.execute(
            'SELECT banner_data_url, avatar_data_url, about_text, organization_name, organization_short_name, president_name, facebook_url FROM organization_profile WHERE id = 1'
          );
          const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
          return res.json({ profile: mapRowToOrganizationProfile(row) });
        }

        if (asset === 'name') {
          const organizationName: unknown = req.body?.organizationName;
          const organizationShortName: unknown = req.body?.organizationShortName;
          const presidentName: unknown = req.body?.presidentName;
          if (
            typeof organizationName !== 'string' ||
            typeof organizationShortName !== 'string' ||
            typeof presidentName !== 'string' ||
            organizationName.trim().length < 2 ||
            organizationName.trim().length > 120 ||
            organizationShortName.trim().length < 2 ||
            organizationShortName.trim().length > 40 ||
            presidentName.trim().length < 2 ||
            presidentName.trim().length > 100
          ) {
            return res.status(400).json({
              error:
                'Enter an organization name (2–120 characters), short name (2–40 characters), and president name (2–100 characters).',
            });
          }

          const fullName = organizationName.trim();
          const shortName = organizationShortName.trim();
          const currentPresidentName = presidentName.trim();
          const db = getOrgDb(org.code);
          await db.execute({
            sql: `INSERT INTO organization_profile (
                    id, organization_name, organization_short_name, president_name, updated_at
                  ) VALUES (1, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    organization_name = excluded.organization_name,
                    organization_short_name = excluded.organization_short_name,
                    president_name = excluded.president_name,
                    updated_at = excluded.updated_at`,
            args: [fullName, shortName, currentPresidentName, new Date().toISOString()],
          });
          await getCentralDb().execute({
            sql: `UPDATE cessca_queue
                  SET org_full_name = ?, org_short_name = ?, president_name = ?
                  WHERE org_code = ?`,
            args: [fullName, shortName, currentPresidentName, org.code],
          });
          await incrementPortalLiveVersion();
          const profileResult = await db.execute(
            'SELECT banner_data_url, avatar_data_url, about_text, organization_name, organization_short_name, president_name, facebook_url FROM organization_profile WHERE id = 1'
          );
          const row = profileResult.rows[0] as unknown as Record<string, unknown> | undefined;
          return res.json({ profile: mapRowToOrganizationProfile(row) });
        }

        const column =
          asset === 'banner'
            ? 'banner_data_url'
            : asset === 'avatar'
              ? 'avatar_data_url'
              : null;
        if (!column) {
          return res.status(404).json({ error: 'Profile image type not found.' });
        }

        const dataUrl: unknown = req.body?.dataUrl;
        if (dataUrl !== null && typeof dataUrl !== 'string') {
          return res.status(400).json({ error: 'Provide an image data URL or null to remove it.' });
        }
        if (typeof dataUrl === 'string') {
          const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
          if (!match) {
            return res.status(400).json({ error: 'Use a PNG, JPEG, or WebP image.' });
          }
          const imageBytes = Buffer.from(match[2], 'base64');
          if (
            imageBytes.byteLength === 0 ||
            imageBytes.byteLength > 5 * 1024 * 1024 ||
            imageBytes.toString('base64') !== match[2]
          ) {
            return res.status(400).json({ error: 'Image must be valid and 5 MB or smaller.' });
          }
        }

        const db = getOrgDb(org.code);
        await db.execute({
          sql: `INSERT INTO organization_profile (id, ${column}, updated_at)
                VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  ${column} = excluded.${column},
                  updated_at = excluded.updated_at`,
          args: [dataUrl, new Date().toISOString()],
        });
        await incrementPortalLiveVersion();
        const result = await db.execute(
          'SELECT banner_data_url, avatar_data_url, about_text, organization_name, organization_short_name, president_name, facebook_url FROM organization_profile WHERE id = 1'
        );
        const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
        return res.json({ profile: mapRowToOrganizationProfile(row) });
      } catch (error) {
        console.error('Failed to update organization profile:', error);
        return res.status(500).json({ error: 'Failed to update organization profile.' });
      }
    }
  );

  // Officer-only: View all submissions (pending, approved, rejected) for their assigned org
  app.get('/api/organizations/:code/submissions', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const org = getOrgByCode(String(req.params.code));
      if (!org) {
        return res.status(404).json({ error: 'Organization not found.' });
      }
      const user = req.authUser;
      if (!user) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      if (user.role !== 'cessca' && (user.role !== 'president' || user.orgCode !== org.code)) {
        return res.status(403).json({
          error: `Access restricted strictly to ${org.shortName} officer (${org.president}) or CESSCA.`,
        });
      }

      const db = getOrgDb(org.code);
      const result = await db.execute('SELECT * FROM posts ORDER BY created_at DESC');
      const names = await getOrganizationNames(org.code);
      const submissions = result.rows.map((row) =>
        mapRowToOrgPost(row as unknown as Record<string, unknown>, org.code, names)
      );
      return res.json({ submissions });
    } catch (error) {
      console.error('Failed to load submissions:', error);
      return res.status(500).json({ error: 'Failed to load submissions.' });
    }
  });

  // Organization officers publish announcements immediately to their public feeds.
  app.post('/api/organizations/:code/posts', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const org = getOrgByCode(String(req.params.code));
      if (!org) {
        return res.status(404).json({ error: 'Organization not found.' });
      }
      const user = req.authUser;
      if (!user) {
        return res.status(401).json({ error: 'Please sign in as this organization’s officer to publish.' });
      }
      if (user.role !== 'president' || user.orgCode !== org.code) {
        return res.status(403).json({
          error: `Only this organization’s officer can publish announcements.`,
        });
      }

      const title = String(req.body?.title ?? '').trim();
      const eventDate = String(req.body?.eventDate ?? '').trim();
      const caption = String(req.body?.caption ?? '').trim();
      if (req.body?.imageUrls !== undefined && !Array.isArray(req.body.imageUrls)) {
        return res.status(400).json({ error: 'Images must be provided as a list.' });
      }
      const submittedImages: unknown[] = Array.isArray(req.body?.imageUrls)
        ? req.body.imageUrls
        : req.body?.imageUrl
          ? [req.body.imageUrl]
          : [];
      if (submittedImages.length > 5) {
        return res.status(400).json({ error: 'An announcement can include up to 5 images.' });
      }
      const imageUrls: string[] = [];
      for (const imageUrl of submittedImages) {
        if (typeof imageUrl !== 'string') {
          return res.status(400).json({ error: 'Each image must be a valid image upload.' });
        }
        const match = imageUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
        if (match) {
          const imageSize = Buffer.from(match[2], 'base64').byteLength;
          if (imageSize === 0 || imageSize > 5 * 1024 * 1024) {
            return res.status(400).json({ error: 'Each image must be larger than 0 bytes and no larger than 5 MB.' });
          }
        } else {
          let blobUrl: URL;
          try {
            blobUrl = new URL(imageUrl);
          } catch {
            return res.status(400).json({ error: 'Each attachment must be an uploaded image.' });
          }
          const pathname = blobUrl.pathname.slice(1);
          const requiredPrefix = `posts/${org.code}/${user.uid}/`;
          if (
            blobUrl.protocol !== 'https:' ||
            !isValidProposalPath(pathname, requiredPrefix)
          ) {
            return res.status(400).json({ error: 'Each image must belong to this organization officer.' });
          }
          const blob = await headBlob(pathname);
          if (
            blob.url !== imageUrl ||
            !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.contentType ?? '') ||
            blob.size <= 0 ||
            blob.size > 5 * 1024 * 1024
          ) {
            return res.status(400).json({ error: 'Each attachment must be a PNG, JPG, WebP, or GIF image no larger than 5 MB.' });
          }
        }
        imageUrls.push(imageUrl);
      }
      const imageUrl =
        imageUrls.length === 0
          ? null
          : imageUrls.length === 1
            ? imageUrls[0]
            : JSON.stringify(imageUrls);

      if (!title || title.length < 3 || title.length > 160) {
        return res.status(400).json({ error: 'Event title must be between 3 and 160 characters.' });
      }
      if (!eventDate) {
        return res.status(400).json({ error: 'Event date is required.' });
      }
      if (!caption || caption.length < 10 || caption.length > 3000) {
        return res.status(400).json({ error: 'Caption must be between 10 and 3000 characters.' });
      }

      const id = `post_${org.code}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const randomNum = Math.floor(1000 + Math.random() * 9000);
      const letterRef = `POST-${new Date().getFullYear()}-${randomNum}`;
      const now = new Date().toISOString();
      const names = await getOrganizationNames(org.code);

      const orgDb = getOrgDb(org.code);
      await orgDb.execute({
        sql: `INSERT INTO posts (
          id, letter_ref, org_code, author_name, title, event_date, caption, image_url, status, feedback, likes_count, created_at, reviewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', NULL, 0, ?, NULL)`,
        args: [id, letterRef, org.code, names.presidentName, title, eventDate, caption, imageUrl, now],
      });

      await incrementPortalLiveVersion();
      return res.status(201).json({
        post: {
          id,
          letterRef,
          orgCode: org.code,
          orgShortName: names.shortName,
          orgFullName: names.fullName,
          authorName: names.presidentName,
          title,
          eventDate,
          caption,
          imageUrl: imageUrls.length === 1 ? imageUrls[0] : null,
          imageUrls,
          status: 'approved',
          feedback: null,
          likesCount: 0,
          createdAt: now,
          reviewedAt: null,
        } satisfies OrgPost,
      });
    } catch (error) {
      console.error('Failed to submit post:', error);
      return res.status(500).json({ error: 'Failed to publish announcement.' });
    }
  });

  // Organization officers may withdraw submissions or remove their approved announcements.
  app.delete('/api/organizations/:code/posts/:postId', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const org = getOrgByCode(String(req.params.code));
      if (!org) {
        return res.status(404).json({ error: 'Organization not found.' });
      }
      const user = req.authUser;
      if (!user || user.role !== 'president' || user.orgCode !== org.code) {
        return res.status(403).json({ error: 'Only this organization’s officer can remove its announcements.' });
      }

      const postId = String(req.params.postId);
      const orgDb = getOrgDb(org.code);
      const existing = await orgDb.execute({
        sql: 'SELECT status FROM posts WHERE id = ? LIMIT 1',
        args: [postId],
      });
      const existingPost = existing.rows[0];
      if (!existingPost) {
        return res.status(404).json({ error: 'Announcement not found.' });
      }

      const status = String(existingPost.status);
      if (!['pending', 'rejected', 'approved'].includes(status)) {
        return res.status(409).json({ error: 'This announcement cannot be removed.' });
      }

      const deletion = await orgDb.execute({
        sql: 'DELETE FROM posts WHERE id = ? AND status = ?',
        args: [postId, status],
      });
      if (deletion.rowsAffected === 0) {
        return res.status(409).json({ error: 'The announcement changed before it could be removed.' });
      }
      const centralDb = getCentralDb();
      await centralDb.execute({ sql: 'DELETE FROM cessca_queue WHERE id = ?', args: [postId] });

      await incrementPortalLiveVersion();
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to delete post:', error);
      return res.status(500).json({ error: 'Failed to delete submission.' });
    }
  });

  app.post('/api/posts/upload', async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (rejectIfBlobIsUnconfigured(res)) return;
      const user = req.authUser;
      if (!user || user.role !== 'president' || !user.orgCode) {
        return res.status(403).json({ error: 'Only an authenticated organization officer may upload post images.' });
      }

      const pathname = String(req.body?.pathname ?? '').trim();
      const requiredPrefix = `posts/${user.orgCode}/${user.uid}/`;
      if (!isValidProposalPath(pathname, requiredPrefix)) {
        return res.status(400).json({ error: 'Invalid post image upload path.' });
      }

      const dataUrl = String(req.body?.dataUrl ?? '');
      const match = dataUrl.match(
        /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/
      );
      if (!match) {
        return res.status(400).json({ error: 'Choose a PNG, JPEG, WebP, or GIF image.' });
      }

      const image = Buffer.from(match[2], 'base64');
      if (image.byteLength === 0 || image.byteLength > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Images must be larger than 0 bytes and no larger than 5 MB.' });
      }

      const blob = await putBlob(pathname, image, {
        access: 'public',
        contentType: match[1],
      });
      return res.json({ url: blob.url });
    } catch (error) {
      console.error('Failed to upload post image to Vercel Blob:', error);
      return res.status(502).json({ error: 'Failed to store image in Vercel Blob.' });
    }
  });

  app.post('/api/proposals/upload', async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (rejectIfBlobIsUnconfigured(res)) return;
      const body = req.body as HandleUploadBody;
      const result = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          const user = req.authUser;
          if (!user || user.role !== 'president' || !user.orgCode) {
            throw new Error('Only an authenticated organization officer may upload proposal files.');
          }
          const requiredPrefix = `proposals/${user.orgCode}/${user.uid}/`;
          if (!isValidProposalPath(pathname, requiredPrefix)) {
            throw new Error('Invalid proposal upload path.');
          }
          return {
            maximumSizeInBytes: MAX_PROPOSAL_SIZE_BYTES,
            addRandomSuffix: true,
          };
        },
      });
      return res.json(result);
    } catch (error) {
      console.error('Proposal upload authorization failed:', error);
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Unable to authorize this proposal upload.',
      });
    }
  });

  app.post('/api/proposals', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser;
      if (!user || user.role !== 'president' || !user.orgCode) {
        return res.status(403).json({ error: 'Only an authenticated organization officer may submit a proposal.' });
      }

      const org = getOrgByCode(user.orgCode);
      if (!org) {
        return res.status(403).json({ error: 'Your officer account is not assigned to a valid organization.' });
      }
      const title = String(req.body?.title ?? '').trim();
      const message = String(req.body?.message ?? '').trim();
      const submittedFileName = String(req.body?.fileName ?? '').trim();
      const fileName = safeDownloadName(submittedFileName);
      const pathname = String(req.body?.pathname ?? '').trim();
      const expectedPrefix = `proposals/${org.code}/${user.uid}/`;

      if (title.length < 3 || title.length > 160) {
        return res.status(400).json({ error: 'Proposal title must be between 3 and 160 characters.' });
      }
      if (message.length > 2000) {
        return res.status(400).json({ error: 'Proposal message must be 2000 characters or fewer.' });
      }
      if (!submittedFileName || submittedFileName.length > 255) {
        return res.status(400).json({ error: 'Choose a file with a valid name.' });
      }
      if (!isValidProposalPath(pathname, expectedPrefix)) {
        return res.status(400).json({ error: 'The uploaded file does not belong to this organization officer.' });
      }

      const blob = await headBlob(pathname);
      if (blob.size <= 0 || blob.size > MAX_PROPOSAL_SIZE_BYTES) {
        return res.status(400).json({ error: 'Proposal files must be larger than 0 bytes and no larger than 25 MB.' });
      }

      const id = `proposal_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const submittedAt = new Date().toISOString();
      const names = await getOrganizationNames(org.code);
      try {
        await getCentralDb().execute({
          sql: `INSERT INTO proposal_submissions (
            id, org_code, org_short_name, org_full_name, president_name, submitted_by_uid,
            title, message, file_name, pathname, content_type, file_size, submitted_at,
            status, feedback, reviewed_at, reviewed_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
          args: [
            id,
            org.code,
            names.shortName,
            names.fullName,
            names.presidentName,
            user.uid,
            title,
            message,
            fileName,
            pathname,
            blob.contentType || 'application/octet-stream',
            blob.size,
            submittedAt,
          ],
        });
      } catch (error) {
        try {
          await deleteBlob(pathname);
        } catch (cleanupError) {
          console.error('Failed to clean up an unrecorded proposal blob:', cleanupError);
        }
        throw error;
      }
      await incrementPortalLiveVersion();
      return res.status(201).json({
        proposal: {
          id,
          orgCode: org.code,
          orgShortName: names.shortName,
          orgFullName: names.fullName,
          presidentName: names.presidentName,
          title,
          message,
          fileName,
          contentType: blob.contentType || 'application/octet-stream',
          fileSize: blob.size,
          submittedAt,
          status: 'pending',
          feedback: null,
          reviewedAt: null,
          reviewedBy: null,
        } satisfies ProposalSubmission,
      });
    } catch (error) {
      console.error('Failed to save proposal submission:', error);
      return res.status(500).json({ error: 'Failed to send proposal to CESSCA.' });
    }
  });

  app.get('/api/cessca/proposals', async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (req.authUser?.role !== 'cessca') {
        return res.status(403).json({ error: 'CESSCA administrator privileges required.' });
      }
      const result = await getCentralDb().execute(
        'SELECT * FROM proposal_submissions ORDER BY submitted_at DESC'
      );
      return res.json({
        proposals: result.rows.map((row) =>
          mapRowToProposal(row as unknown as Record<string, unknown>)
        ),
      });
    } catch (error) {
      console.error('Failed to load proposal submissions:', error);
      return res.status(500).json({ error: 'Failed to load proposal files.' });
    }
  });

  app.post('/api/cessca/proposals/:id/review', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser;
      if (!user || user.role !== 'cessca') {
        return res.status(403).json({ error: 'CESSCA administrator privileges required.' });
      }

      const id = String(req.params.id);
      const action = String(req.body?.action ?? '').trim().toLowerCase();
      const feedback = String(req.body?.feedback ?? '').trim();
      if (action !== 'approve' && action !== 'reject') {
        return res.status(400).json({ error: 'Action must be either approve or reject.' });
      }
      if (action === 'reject' && feedback.length < 4) {
        return res.status(400).json({ error: 'Please provide clear feedback when rejecting a submission.' });
      }

      const central = getCentralDb();
      const existing = await central.execute({
        sql: 'SELECT status FROM proposal_submissions WHERE id = ? LIMIT 1',
        args: [id],
      });
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Proposal submission not found.' });
      }
      if (String(existing.rows[0].status) !== 'pending') {
        return res.status(409).json({ error: 'This submission has already been reviewed.' });
      }

      const status = action === 'approve' ? 'approved' : 'rejected';
      const reviewedAt = new Date().toISOString();
      const resolvedFeedback =
        feedback || (action === 'approve' ? 'Approved by CESSCA.' : null);
      const update = await central.execute({
        sql: `UPDATE proposal_submissions
              SET status = ?, feedback = ?, reviewed_at = ?, reviewed_by = ?
              WHERE id = ? AND status = 'pending'`,
        args: [status, resolvedFeedback, reviewedAt, user.displayName, id],
      });
      if (update.rowsAffected === 0) {
        return res.status(409).json({ error: 'This submission has already been reviewed.' });
      }
      await incrementPortalLiveVersion();

      const updated = await central.execute({
        sql: 'SELECT * FROM proposal_submissions WHERE id = ? LIMIT 1',
        args: [id],
      });
      return res.json({
        proposal: mapRowToProposal(updated.rows[0] as unknown as Record<string, unknown>),
      });
    } catch (error) {
      console.error('Proposal review error:', error);
      return res.status(500).json({ error: 'Failed to process proposal review.' });
    }
  });

  app.get('/api/cessca/proposals/:id/file', async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (req.authUser?.role !== 'cessca') {
        return res.status(403).json({ error: 'CESSCA administrator privileges required.' });
      }
      const result = await getCentralDb().execute({
        sql: 'SELECT file_name, pathname, content_type FROM proposal_submissions WHERE id = ? LIMIT 1',
        args: [String(req.params.id)],
      });
      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ error: 'Proposal file not found.' });
      }
      const blob = await getBlob(String(row.pathname), { access: 'private' });
      if (!blob || blob.statusCode !== 200) {
        return res.status(404).json({ error: 'The stored proposal file is no longer available.' });
      }
      const fileName = safeDownloadName(String(row.file_name));
      const fallbackFileName = fileName.replace(/[^\x20-\x7E]/g, '_');
      const inlineContentType = getInlineProposalContentType(row.content_type);
      res.setHeader('Content-Type', inlineContentType ?? 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `${inlineContentType ? 'inline' : 'attachment'}; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return Readable.fromWeb(
        blob.stream as Parameters<typeof Readable.fromWeb>[0]
      ).pipe(res);
    } catch (error) {
      console.error('Failed to download proposal file:', error);
      return res.status(500).json({ error: 'Failed to download proposal file.' });
    }
  });

  app.delete('/api/cessca/proposals/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (req.authUser?.role !== 'cessca') {
        return res.status(403).json({ error: 'CESSCA administrator privileges required.' });
      }
      const central = getCentralDb();
      const result = await central.execute({
        sql: 'SELECT pathname FROM proposal_submissions WHERE id = ? LIMIT 1',
        args: [String(req.params.id)],
      });
      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ error: 'Proposal submission not found.' });
      }

      await deleteBlob(String(row.pathname));
      await central.execute({
        sql: 'DELETE FROM proposal_submissions WHERE id = ?',
        args: [String(req.params.id)],
      });
      await incrementPortalLiveVersion();
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to delete proposal submission:', error);
      return res.status(500).json({ error: 'Failed to delete proposal submission and its file.' });
    }
  });

  // Public reaction toggle on approved posts
  app.post('/api/posts/:orgCode/:postId/like', async (req: Request, res: Response) => {
    try {
      const org = getOrgByCode(String(req.params.orgCode));
      if (!org) {
        return res.status(404).json({ error: 'Organization not found.' });
      }
      const delta = req.body?.unlike ? -1 : 1;
      const orgDb = getOrgDb(org.code);
      const update = await orgDb.execute({
        sql: `UPDATE posts
              SET likes_count = MAX(0, likes_count + ?)
              WHERE id = ? AND status = 'approved'`,
        args: [delta, String(req.params.postId)],
      });
      if (update.rowsAffected > 0) {
        await incrementPortalLiveVersion();
      }
      const updated = await orgDb.execute({
        sql: 'SELECT likes_count FROM posts WHERE id = ? LIMIT 1',
        args: [String(req.params.postId)],
      });
      return res.json({ likesCount: Number(updated.rows[0]?.likes_count ?? 0) });
    } catch (error) {
      console.error('Like error:', error);
      return res.status(500).json({ error: 'Failed to update reaction.' });
    }
  });

  // CESSCA Super Admin: List incoming submission queue across all 12 organizations
  app.get('/api/cessca/queue', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser;
      if (!user || user.role !== 'cessca') {
        return res.status(403).json({ error: 'CESSCA Super Administrator privileges required.' });
      }

      const statusFilter = String(req.query.status ?? '').trim().toLowerCase();
      const central = getCentralDb();
      const result =
        statusFilter && statusFilter !== 'all'
          ? await central.execute({
              sql: 'SELECT * FROM cessca_queue WHERE status = ? ORDER BY submitted_at DESC',
              args: [statusFilter],
            })
          : await central.execute('SELECT * FROM cessca_queue ORDER BY submitted_at DESC');

      const items = result.rows.map((row) =>
        mapRowToQueueItem(row as unknown as Record<string, unknown>)
      );
      return res.json({ items });
    } catch (error) {
      console.error('Failed to load CESSCA queue:', error);
      return res.status(500).json({ error: 'Failed to load CESSCA moderation queue.' });
    }
  });

  app.delete('/api/cessca/queue/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (req.authUser?.role !== 'cessca') {
        return res.status(403).json({ error: 'CESSCA Super Administrator privileges required.' });
      }

      const id = String(req.params.id);
      const central = getCentralDb();
      const result = await central.execute({
        sql: 'SELECT org_code FROM cessca_queue WHERE id = ? LIMIT 1',
        args: [id],
      });
      const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
      if (!row) {
        return res.status(404).json({ error: 'Record not found.' });
      }

      const org = getOrgByCode(String(row.org_code));
      if (!org) {
        console.error(`Pending request ${id} has an unknown organization code.`);
        return res.status(500).json({ error: 'The request has an invalid organization.' });
      }

      await getOrgDb(org.code).execute({
        sql: 'DELETE FROM posts WHERE id = ?',
        args: [id],
      });
      await central.execute({
        sql: 'DELETE FROM cessca_queue WHERE id = ?',
        args: [id],
      });

      await incrementPortalLiveVersion();
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to delete CESSCA record:', error);
      return res.status(500).json({ error: 'Failed to delete the record.' });
    }
  });

  // CESSCA Super Admin: Approve or Reject a submission letter
  app.post('/api/cessca/review/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser;
      if (!user || user.role !== 'cessca') {
        return res.status(403).json({ error: 'CESSCA Super Administrator privileges required.' });
      }

      const id = String(req.params.id);
      const action = String(req.body?.action ?? '').trim().toLowerCase();
      const feedback = String(req.body?.feedback ?? '').trim();

      if (action !== 'approve' && action !== 'reject') {
        return res.status(400).json({ error: 'Action must be either approve or reject.' });
      }
      if (action === 'reject' && feedback.length < 4) {
        return res.status(400).json({ error: 'Please provide clear feedback when rejecting a submission.' });
      }

      const central = getCentralDb();
      const existing = await central.execute({
        sql: 'SELECT * FROM cessca_queue WHERE id = ? LIMIT 1',
        args: [id],
      });

      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Submission letter not found.' });
      }
      if (String(existing.rows[0].status) !== 'pending') {
        return res.status(409).json({ error: 'This letter has already been reviewed.' });
      }

      const orgCode = String(existing.rows[0].org_code);
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      const now = new Date().toISOString();
      const resolvedFeedback =
        feedback || (action === 'approve' ? 'Approved by CESSCA for publication.' : null);

      // Update central CESSCA moderation record
      await central.execute({
        sql: `UPDATE cessca_queue
              SET status = ?, feedback = ?, reviewed_at = ?, reviewed_by = ?
              WHERE id = ?`,
        args: [newStatus, resolvedFeedback, now, user.displayName, id],
      });

      // Synchronously update the organization's isolated 1-to-1 libSQL database
      const orgDb = getOrgDb(orgCode);
      await orgDb.execute({
        sql: `UPDATE posts
              SET status = ?, feedback = ?, reviewed_at = ?
              WHERE id = ?`,
        args: [newStatus, resolvedFeedback, now, id],
      });

      await incrementPortalLiveVersion();
      const updated = await central.execute({
        sql: 'SELECT * FROM cessca_queue WHERE id = ? LIMIT 1',
        args: [id],
      });

      return res.json({
        item: mapRowToQueueItem(updated.rows[0] as unknown as Record<string, unknown>),
      });
    } catch (error) {
      console.error('Review error:', error);
      return res.status(500).json({ error: 'Failed to process review decision.' });
    }
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  return app;
}
