import { canPreParse, preParseImage, digestLabel } from '../utils/vision';

const file = (type, size = 1000, name = 'x.jpg') => ({
  type, size, name, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});

describe('vision pre-parser (client)', () => {
  afterEach(() => { global.fetch = undefined; });

  it('accepts the image types Zia can actually read', () => {
    expect(canPreParse(file('image/jpeg'))).toBe(true);
    expect(canPreParse(file('image/png'))).toBe(true);
  });

  it('skips formats Zia cannot read instead of sending them to fail', () => {
    expect(canPreParse(file('application/pdf'))).toBe(false);
    expect(canPreParse(file('image/heic'))).toBe(false);
  });

  it('skips images past the upload ceiling', () => {
    expect(canPreParse(file('image/jpeg', 9 * 1024 * 1024))).toBe(false);
  });

  it('returns the digest when the parse succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ digest: { ok: true, doc_type: 'FIR' } }),
    });
    await expect(preParseImage(file('image/jpeg'))).resolves.toEqual({ ok: true, doc_type: 'FIR' });
  });

  it('never throws when the backend fails — a bad parse must not block sending', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(preParseImage(file('image/jpeg'))).resolves.toBeNull();
  });

  it('returns null on an error response rather than a half-digest', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: 'image too large' }),
    });
    await expect(preParseImage(file('image/jpeg'))).resolves.toBeNull();
  });

  it('labels the chip with what was actually found', () => {
    expect(digestLabel({ ok: true, doc_type: 'Seizure memo' })).toBe('Seizure memo');
    expect(digestLabel({ ok: true, text: 'some text' })).toBe('text read');
    expect(digestLabel({ ok: true, objects: ['car'] })).toBe('car');
    expect(digestLabel({ ok: true })).toBe('no text found');
    expect(digestLabel({ ok: false })).toBe('unreadable');
    expect(digestLabel(null)).toBeNull();
  });
});
