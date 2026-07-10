import type { Config } from './config.js';

export interface UpdateStatus {
  enabled: boolean;
  applyEnabled: boolean;
  currentSha: string | null;
  remoteSha: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

export interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
}

/** Split `registry/owner/name[:tag]`. The first path component is always the registry host. */
export function parseImageRef(ref: string): ImageRef {
  const slash = ref.indexOf('/');
  const registry = slash === -1 ? '' : ref.slice(0, slash);
  let rest = slash === -1 ? ref : ref.slice(slash + 1);
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon !== -1 && !rest.slice(colon + 1).includes('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { registry, repository: rest, tag };
}

const REVISION_LABEL = 'org.opencontainers.image.revision';

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// Error whose message is safe to store/serve: hand-built strings only,
// never headers, tokens, URLs, or response bodies (see redact.ts philosophy).
class CheckError extends Error {}

interface ManifestDoc {
  manifests?: Array<{ digest: string; platform?: { os?: string; architecture?: string } }>;
  config?: { digest?: string };
}

export class UpdateChecker {
  readonly enabled: boolean;
  private remoteSha: string | null = null;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: Config['update'],
    private fetchFn: typeof fetch = fetch,
  ) {
    this.enabled = Boolean(cfg.ghcrToken && cfg.currentSha && cfg.currentSha !== 'dev');
  }

  get status(): UpdateStatus {
    return {
      enabled: this.enabled,
      applyEnabled: this.enabled && Boolean(this.cfg.watchtowerToken),
      currentSha: this.cfg.currentSha || null,
      remoteSha: this.remoteSha,
      updateAvailable:
        this.enabled && this.remoteSha !== null && this.remoteSha !== this.cfg.currentSha,
      checkedAt: this.checkedAt,
      error: this.error,
    };
  }

  /** Force a registry check; concurrent callers share one in-flight request. */
  async check(): Promise<UpdateStatus> {
    if (!this.enabled) return this.status;
    if (!this.inFlight) {
      this.inFlight = this.doCheck().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Fire-and-forget check unless a recent result exists (used on unlock). */
  async checkIfStale(maxAgeMs = 10 * 60_000): Promise<void> {
    if (!this.enabled) return;
    if (this.checkedAt && Date.now() - Date.parse(this.checkedAt) < maxAgeMs) return;
    await this.check().catch(() => undefined);
  }

  /**
   * Ask the watchtower sidecar to pull + recreate this container. Watchtower
   * handles the request synchronously and kills this very process partway
   * through, so the response usually never arrives — a ~5s silence is success.
   */
  async apply(): Promise<{ applying: boolean; error?: string }> {
    if (!this.status.applyEnabled) return { applying: false };
    const req = this.fetchFn(`${this.cfg.watchtowerUrl}/v1/update`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.watchtowerToken}` },
    });
    // The socket error when the container dies mid-response must not surface.
    req.catch(() => undefined);
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5000).unref();
    });
    const winner = await Promise.race([
      req.then(
        (res) => res,
        () => 'unreachable' as const,
      ),
      timeout,
    ]);
    if (winner === 'timeout') return { applying: true };
    if (winner === 'unreachable') return { applying: false, error: 'watchtower unreachable' };
    if (!winner.ok) {
      return { applying: false, error: `watchtower rejected update request (${winner.status})` };
    }
    return { applying: true };
  }

  startAutoCheck(intervalMs = 6 * 3600_000): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async doCheck(): Promise<UpdateStatus> {
    try {
      this.remoteSha = await this.fetchRemoteSha();
      this.error = null;
    } catch (err) {
      this.remoteSha = null;
      this.error = err instanceof CheckError ? err.message : 'update check failed (network)';
    }
    this.checkedAt = new Date().toISOString();
    return this.status;
  }

  private async fetchRemoteSha(): Promise<string> {
    const { registry, repository, tag } = parseImageRef(this.cfg.imageRef);
    // GHCR token exchange: username is arbitrary, PAT goes in the password slot.
    const basic = Buffer.from(`token:${this.cfg.ghcrToken}`).toString('base64');
    const tokenRes = await this.fetchFn(
      `https://${registry}/token?service=${registry}&scope=repository:${repository}:pull`,
      { headers: { authorization: `Basic ${basic}` } },
    );
    if (!tokenRes.ok) throw new CheckError(`registry auth failed (${tokenRes.status})`);
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) throw new CheckError('registry auth returned no token');

    const headers = { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT };
    const manifestUrl = (ref: string) => `https://${registry}/v2/${repository}/manifests/${ref}`;
    let res = await this.fetchFn(manifestUrl(tag), { headers });
    if (!res.ok) throw new CheckError(`registry manifest fetch failed (${res.status})`);
    let manifest = (await res.json()) as ManifestDoc;

    // Multi-arch index (or provenance attestations): pick our platform's manifest.
    if (Array.isArray(manifest.manifests)) {
      const arch = process.arch === 'x64' ? 'amd64' : process.arch;
      const entry =
        manifest.manifests.find(
          (m) => m.platform?.os === 'linux' && m.platform?.architecture === arch,
        ) ?? manifest.manifests.find((m) => m.platform?.os !== 'unknown');
      if (!entry) throw new CheckError('no platform manifest in image index');
      res = await this.fetchFn(manifestUrl(entry.digest), { headers });
      if (!res.ok) throw new CheckError(`registry platform manifest fetch failed (${res.status})`);
      manifest = (await res.json()) as ManifestDoc;
    }

    const configDigest = manifest.config?.digest;
    if (!configDigest) throw new CheckError('image manifest has no config digest');
    const blobRes = await this.fetchFn(`https://${registry}/v2/${repository}/blobs/${configDigest}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!blobRes.ok) throw new CheckError(`registry config fetch failed (${blobRes.status})`);
    const blob = (await blobRes.json()) as { config?: { Labels?: Record<string, string> } };
    const sha = blob.config?.Labels?.[REVISION_LABEL];
    if (!sha) throw new CheckError('remote image has no revision label');
    return sha;
  }
}
