import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkTarget } from '../../frontend/src/lib/linkTarget.js';
describe('link targets', () => {
  it('resolves file, sandbox, encoded spaces, relative paths and source locations', () => {
    assert.equal(linkTarget('file:///tmp/My%20File.md').path, '/tmp/My File.md');
    assert.equal(linkTarget('file://localhost/tmp/file.md').path, '/tmp/file.md');
    assert.equal(linkTarget('sandbox:/mnt/data/report.pdf').path, '/mnt/data/report.pdf');
    assert.equal(linkTarget('../report.md', '/projects/boat/drafts').path, '/projects/boat/report.md');
    assert.equal(linkTarget('/tmp/main.ts:12:4').line, 12);
    assert.equal(linkTarget('/tmp/main.ts#L20').line, 20);
    assert.equal(linkTarget('/feather2/api/file?path=%2Ftmp%2Fa.md', null, '/feather2').path, '/tmp/a.md');
  });
  it('preserves web links and rejects executable schemes', () => {
    for (const x of ['https://example.com/a', '//example.com/a', 'mailto:hi@example.com']) assert.equal(linkTarget(x).kind, 'web');
    for (const x of ['javascript:alert(1)', 'javascript%3Aalert(1)', '/api/file?path=javascript%3Aalert(1)', 'data:text/html,test', 'vbscript:x', 'file://server/a', 'java\nscript:x']) assert.equal(linkTarget(x).kind, 'invalid');
    assert.equal(linkTarget('#section').kind, 'anchor');
  });
});
