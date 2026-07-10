import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { UpdateChecker, parseImageRef } from '../src/update.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const PAT = 'ghp_supersecretpat';

function updateCfg(over: Partial<ReturnType<typeof updateCfg>> = {}) {
  return {
    imageRef: 'ghcr.io/ctb3/monthly-expense-helper:latest',
    ghcrToken: PAT,
    watchtowerUrl: 'http://watchtower:8080',
    watchtowerToken: 'wt-token',
    currentSha: SHA_A,
    ...over,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

/** fetch mock serving the full GHCR chain for an image whose revision label is `remoteSha`. */
function ghcrFetch(remoteSha: string, opts: { index?: boolean; labels?: boolean } = {}) {
  const { index = false, labels = true } = opts;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/token?')) return jsonRes({ token: 'bearer-tok' });
    if (url.endsWith('/manifests/latest')) {
      if (index) {
        return jsonRes({
          manifests: [
            { digest: 'sha256:attest', platform: { os: 'unknown', architecture: 'unknown' } },
            { digest: 'sha256:amd64manifest', platform: { os: 'linux', architecture: 'amd64' } },
          ],
        });
      }
      return jsonRes({ config: { digest: 'sha256:cfg' } });
    }
    if (url.endsWith('/manifests/sha256:amd64manifest')) {
      return jsonRes({ config: { digest: 'sha256:cfg' } });
    }
    if (url.endsWith('/blobs/sha256:cfg')) {
      return jsonRes({
        config: {
          Labels: labels ? { 'org.opencontainers.image.revision': remoteSha } : {},
        },
      });
    }
    return jsonRes({ error: 'unexpected url' }, 404);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseImageRef', () => {
  it('splits registry, repository, and tag', () => {
    expect(parseImageRef('ghcr.io/ctb3/monthly-expense-helper:latest')).toEqual({
      registry: 'ghcr.io',
      repository: 'ctb3/monthly-expense-helper',
      tag: 'latest',
    });
  });

  it('defaults the tag to latest', () => {
    expect(parseImageRef('ghcr.io/ctb3/app').tag).toBe('latest');
  });
});

describe('UpdateChecker.check', () => {
  it('reports up to date when the remote label matches the running sha', async () => {
    const checker = new UpdateChecker(updateCfg(), ghcrFetch(SHA_A));
    const status = await checker.check();
    expect(status).toMatchObject({
      enabled: true,
      applyEnabled: true,
      currentSha: SHA_A,
      remoteSha: SHA_A,
      updateAvailable: false,
      error: null,
    });
    expect(status.checkedAt).not.toBeNull();
  });

  it('reports an update when the remote label differs', async () => {
    const checker = new UpdateChecker(updateCfg(), ghcrFetch(SHA_B));
    expect((await checker.check()).updateAvailable).toBe(true);
  });

  it('walks an OCI index, skipping attestation manifests', async () => {
    const fetchMock = ghcrFetch(SHA_B, { index: true });
    const checker = new UpdateChecker(updateCfg(), fetchMock);
    expect((await checker.check()).remoteSha).toBe(SHA_B);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(
      'https://ghcr.io/v2/ctb3/monthly-expense-helper/manifests/sha256:amd64manifest',
    );
    expect(urls.some((u) => u.includes('sha256:attest'))).toBe(false);
  });

  it('surfaces a missing revision label as an error, not an update', async () => {
    const checker = new UpdateChecker(updateCfg(), ghcrFetch(SHA_B, { labels: false }));
    const status = await checker.check();
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toBe('remote image has no revision label');
  });

  it('never leaks the PAT into the reported error', async () => {
    const fetchMock = vi.fn(async () => jsonRes({}, 401)) as unknown as typeof fetch;
    const checker = new UpdateChecker(updateCfg(), fetchMock);
    const status = await checker.check();
    expect(status.error).toBe('registry auth failed (401)');
    expect(JSON.stringify(status)).not.toContain(PAT);
  });

  it('coalesces concurrent checks into one registry walk', async () => {
    const fetchMock = ghcrFetch(SHA_A);
    const checker = new UpdateChecker(updateCfg(), fetchMock);
    await Promise.all([checker.check(), checker.check()]);
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/token?'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('checkIfStale skips the registry when a recent result exists', async () => {
    const fetchMock = ghcrFetch(SHA_A);
    const checker = new UpdateChecker(updateCfg(), fetchMock);
    await checker.check();
    const calls = fetchMock.mock.calls.length;
    await checker.checkIfStale();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('is disabled without a token or with a dev sha', async () => {
    const fetchMock = ghcrFetch(SHA_A);
    for (const over of [{ ghcrToken: '' }, { currentSha: 'dev' }, { currentSha: '' }]) {
      const checker = new UpdateChecker(updateCfg(over), fetchMock);
      expect(checker.enabled).toBe(false);
      expect((await checker.check()).enabled).toBe(false);
      await checker.checkIfStale();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('UpdateChecker.apply', () => {
  it('surfaces a watchtower rejection', async () => {
    const fetchMock = vi.fn(async () => jsonRes({}, 401)) as unknown as typeof fetch;
    const checker = new UpdateChecker(updateCfg(), fetchMock);
    expect(await checker.apply()).toEqual({
      applying: false,
      error: 'watchtower rejected update request (401)',
    });
  });

  it('treats silence as the update being applied', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const checker = new UpdateChecker(updateCfg(), fetchMock);
    const pending = checker.apply();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ applying: true });
  });

  it('reports watchtower unreachable on connection failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const checker = new UpdateChecker(updateCfg(), fetchMock);
    expect(await checker.apply()).toEqual({ applying: false, error: 'watchtower unreachable' });
  });

  it('sends the bearer token to watchtower', async () => {
    const fetchMock = vi.fn(async () => jsonRes({})) as unknown as typeof fetch &
      ReturnType<typeof vi.fn>;
    const checker = new UpdateChecker(updateCfg(), fetchMock);
    expect(await checker.apply()).toEqual({ applying: true });
    expect(fetchMock).toHaveBeenCalledWith('http://watchtower:8080/v1/update', {
      method: 'POST',
      headers: { authorization: 'Bearer wt-token' },
    });
  });

  it('refuses when not configured', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const checker = new UpdateChecker(updateCfg({ watchtowerToken: '' }), fetchMock);
    expect(await checker.apply()).toEqual({ applying: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const PASS = 'a-long-enough-passphrase';

function testApp(env: Record<string, string> = {}, fetchMock?: typeof fetch) {
  const config = loadConfig({ DB_PATH: ':memory:', SESSION_TTL_MINUTES: '5', ...env });
  const deps = buildDeps(config, openDb(':memory:'));
  if (fetchMock) deps.update = new UpdateChecker(config.update, fetchMock);
  return { app: buildApp(deps), deps };
}

async function unlock(app: ReturnType<typeof testApp>['app']) {
  const res = await app.inject({ method: 'POST', url: '/api/unlock', payload: { passphrase: PASS } });
  return res.cookies.find((c) => c.name === 'session')!.value;
}

describe('update routes', () => {
  it('gates all update endpoints behind the vault', async () => {
    const { app } = testApp();
    for (const [method, url] of [
      ['GET', '/api/update/status'],
      ['POST', '/api/update/check'],
      ['POST', '/api/update/apply'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('reports disabled and rejects check/apply when unconfigured', async () => {
    const { app } = testApp();
    const session = await unlock(app);
    let res = await app.inject({ method: 'GET', url: '/api/update/status', cookies: { session } });
    expect(res.json()).toMatchObject({ enabled: false, applyEnabled: false, updateAvailable: false });
    res = await app.inject({ method: 'POST', url: '/api/update/check', cookies: { session } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/update/apply', cookies: { session } });
    expect(res.statusCode).toBe(400);
  });

  it('unlock triggers no registry traffic when the feature is disabled', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const { app } = testApp({}, fetchMock);
    await unlock(app);
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('check reports an available update through the API', async () => {
    const { app } = testApp({ GHCR_TOKEN: PAT, GIT_SHA: SHA_A }, ghcrFetch(SHA_B));
    const session = await unlock(app);
    const res = await app.inject({ method: 'POST', url: '/api/update/check', cookies: { session } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updateAvailable: true, remoteSha: SHA_B, currentSha: SHA_A });
  });

  it('apply proxies to watchtower and surfaces rejections as 502', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('watchtower')) return jsonRes({}, 401);
      return jsonRes({});
    }) as unknown as typeof fetch;
    const { app } = testApp({ GHCR_TOKEN: PAT, GIT_SHA: SHA_A, WATCHTOWER_TOKEN: 'wt' }, fetchMock);
    const session = await unlock(app);
    const res = await app.inject({ method: 'POST', url: '/api/update/apply', cookies: { session } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('watchtower rejected update request (401)');
  });
});
