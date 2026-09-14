import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, ApiError } from './client.js';

function respondWith(status, body, { raw = false } = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : raw ? body : JSON.stringify(body)),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  test('sends JSON on the same origin, so the session cookie rides along', async () => {
    const fetchMock = respondWith(201, { course: { id: 'c1' } });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.createCourse({ name: 'Lab' })).resolves.toEqual({ course: { id: 'c1' } });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/courses');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ name: 'Lab' });
  });

  test('turns an error response into an ApiError carrying the server message and field details', async () => {
    const details = [{ field: 'name', message: 'Required' }];
    vi.stubGlobal('fetch', respondWith(400, { error: { message: 'Validation failed', details } }));

    const err = await api.createCourse({}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Validation failed');
    expect(err.details).toEqual(details);
  });

  test('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', respondWith(502, '<html>Bad gateway</html>', { raw: true }));
    const err = await api.me().catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Request failed (502)');
  });

  test('explains an unreachable server instead of surfacing a raw network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await api.me().catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Could not reach the server/);
  });

  test('an empty successful response resolves to null', async () => {
    vi.stubGlobal('fetch', respondWith(200, undefined));
    await expect(api.logout()).resolves.toBeNull();
  });
});
