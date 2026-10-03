import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './user-agent';

describe('describeUserAgent', () => {
  it('reconnaît les navigateurs et systèmes courants', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome · Android');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iOS');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0')).toBe(
      'Firefox · Windows',
    );
    expect(describeUserAgent(null)).toBeNull();
    expect(describeUserAgent('curl/8.0')).toBeNull();
  });
});
