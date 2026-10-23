import { describe, expect, it } from 'vitest';
import { flattenImported, ImportError, parseNetscapeBookmarks } from '../../src/core/netscape.ts';

const SAMPLE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000100" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.org/a?x=1&amp;y=2" ADD_DATE="1700000001" ICON="data:image/png;base64,AAAA">A &amp; B &lt;tag&gt; &#1578;</A>
        <DT><H3>Nested</H3>
        <DL><p>
            <DT><A HREF=https://unquoted.example/ ADD_DATE=1700000002>Unquoted</A>
            <DD>A description
        </DL><p>
        <DT><A HREF="javascript:void(0)">Bookmarklet <b>bold</b></A>
    </DL><p>
    <DT><A HREF="https://other.example/">Top-level other</A>
</DL><p>`;

describe('Netscape bookmark import', () => {
  it('parses hierarchy, order, dates, entities and omitted closing tags', () => {
    const r = parseNetscapeBookmarks(SAMPLE);
    expect(r.root.title).toBe('Bookmarks');
    expect(r.stats).toMatchObject({ bookmarks: 4, folders: 2, rawAnchorTags: 4, rawFolderHeadings: 2, droppedIcons: 1, unmatchedCloseTags: 0 });
    expect(r.warnings).toEqual([]);
    const bar = r.root.children![0]!;
    expect(bar).toMatchObject({ kind: 'folder', title: 'Bookmarks bar', personalToolbar: true, dateAdded: 1_700_000_000_000 });
    const a = bar.children![0]!;
    expect(a).toMatchObject({ title: 'A & B <tag> ت', url: 'https://example.org/a?x=1&y=2', dateAdded: 1_700_000_001_000 });
    expect(bar.children![1]!.children![0]).toMatchObject({ title: 'Unquoted', url: 'https://unquoted.example/', description: 'A description' });
    expect(bar.children![2]!.title).toBe('Bookmarklet bold');
    expect(r.root.children![1]!.title).toBe('Top-level other');
    const flat = flattenImported(r.root);
    expect(flat.map((f) => f.path.join('/'))).toEqual(['Bookmarks bar', 'Bookmarks bar/Nested', 'Bookmarks bar', '']);
    expect(new Set(flat.map((f) => f.node.sourceId)).size).toBe(4);
  });
  it('assigns stable source ids across parses', () => {
    const a = flattenImported(parseNetscapeBookmarks(SAMPLE).root).map((f) => f.node.sourceId);
    const b = flattenImported(parseNetscapeBookmarks(SAMPLE).root).map((f) => f.node.sourceId);
    expect(a).toEqual(b);
  });
  it('rejects non-bookmark files and enforces limits', () => {
    expect(() => parseNetscapeBookmarks('<html><body>hello</body></html>')).toThrow(ImportError);
    expect(() => parseNetscapeBookmarks(SAMPLE, { maxBytes: 100, maxNodes: 1e6, maxDepth: 64, maxTitleLength: 4096, maxUrlLength: 65536 })).toThrow(/limit/);
    expect(() => parseNetscapeBookmarks(SAMPLE, { maxBytes: 1e9, maxNodes: 3, maxDepth: 64, maxTitleLength: 4096, maxUrlLength: 65536 })).toThrow(/nodes/);
    const deep = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>' + '<DT><H3>f</H3><DL>'.repeat(70) + '</DL>'.repeat(71);
    expect(() => parseNetscapeBookmarks(deep)).toThrow(/deeper/);
  });
  it('does not execute or interpret embedded script markup', () => {
    const evil = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://x.example/">&lt;img src=x onerror=alert(1)&gt;<script>alert(2)</script></A></DL>';
    const r = parseNetscapeBookmarks(evil);
    expect(r.root.children![0]!.title).toBe('<img src=x onerror=alert(1)>alert(2)');
  });
});
