/**
 * Inert parser for Netscape/Chrome bookmark HTML exports.
 *
 * The format is permissive: <DT> and <p> are never closed, attribute quoting
 * varies, and entities appear in titles. This parser tokenizes tags with a
 * regular expression; it never builds a DOM, renders markup, runs scripts,
 * decodes embedded ICON data or contacts any linked site.
 */

export interface ImportedNode {
  /** Stable source id within this file (distinct from Chrome bookmark ids). */
  sourceId: string;
  kind: 'folder' | 'bookmark';
  title: string;
  url?: string;
  /** ms since epoch, when present in the file. */
  dateAdded?: number;
  lastModified?: number;
  /** Firefox exports may carry comma-separated TAGS. */
  tags?: string[];
  description?: string;
  personalToolbar?: boolean;
  children?: ImportedNode[];
}

export interface ImportLimits {
  maxBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxTitleLength: number;
  maxUrlLength: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxNodes: 250_000,
  maxDepth: 64,
  maxTitleLength: 4096,
  maxUrlLength: 65_536,
};

export interface ImportStats {
  bookmarks: number;
  folders: number;
  maxDepth: number;
  /** Raw "<DT><A" and "<DT><H3" occurrences, for cross-checking. */
  rawAnchorTags: number;
  rawFolderHeadings: number;
  emptyUrls: number;
  truncatedTitles: number;
  droppedIcons: number;
  unmatchedCloseTags: number;
  schemes: Record<string, number>;
}

export interface ImportResult {
  root: ImportedNode;
  stats: ImportStats;
  warnings: string[];
}

export type ImportErrorCode = 'not-netscape' | 'too-large' | 'too-many-nodes' | 'too-deep';

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(message: string, code: ImportErrorCode) {
    super(message);
    this.code = code;
  }
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    const name = (m[1] ?? '').toUpperCase();
    out[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
        return String.fromCodePoint(cp);
      }
      return whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseDate(v: string | undefined): number | undefined {
  if (!v || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n > 1e15) return Math.floor(n / 1000); // microseconds
  if (n > 1e12) return n; // already ms
  return n * 1000; // seconds (Chrome/Firefox exports)
}

/** Parse a bookmarks HTML export. Throws ImportError on format or limit violations. */
export function parseNetscapeBookmarks(html: string, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): ImportResult {
  if (html.length > limits.maxBytes) {
    throw new ImportError(`File exceeds ${Math.round(limits.maxBytes / 1048576)} MB limit`, 'too-large');
  }
  const head = html.slice(0, 2048).toUpperCase();
  if (!head.includes('NETSCAPE-BOOKMARK-FILE') && !/<DL[\s>]/.test(head) && !/<DL[\s>]/i.test(html.slice(0, 65536))) {
    throw new ImportError('Not a Netscape/Chrome bookmarks HTML export', 'not-netscape');
  }
  const warnings: string[] = [];
  const stats: ImportStats = {
    bookmarks: 0,
    folders: 0,
    maxDepth: 0,
    rawAnchorTags: (html.match(/<DT>\s*<A[\s>]/gi) ?? []).length,
    rawFolderHeadings: (html.match(/<DT>\s*<H3[\s>]/gi) ?? []).length,
    emptyUrls: 0,
    truncatedTitles: 0,
    droppedIcons: 0,
    unmatchedCloseTags: 0,
    schemes: {},
  };
  let seq = 0;
  const nextId = () => `src-${++seq}`;
  const root: ImportedNode = { sourceId: 'src-root', kind: 'folder', title: '', children: [] };
  const stack: ImportedNode[] = [];
  let pendingFolder: ImportedNode | null = null;
  let open: { node: ImportedNode; tag: 'A' | 'H3' | 'H1'; textStart: number } | null = null;
  let lastItem: ImportedNode | null = null;
  let ddStart = -1;
  let total = 0;
  let rootDlSeen = false;

  const current = (): ImportedNode => stack[stack.length - 1] ?? root;
  const clampTitle = (t: string): string => {
    const s = decodeEntities(t.replace(/\s+/g, ' ').trim());
    if (s.length > limits.maxTitleLength) {
      stats.truncatedTitles++;
      return s.slice(0, limits.maxTitleLength);
    }
    return s;
  };
  const flushDescription = (end: number) => {
    if (ddStart >= 0 && lastItem) {
      const text = clampTitle(html.slice(ddStart, end).replace(/<[^>]*>/g, ''));
      if (text) lastItem.description = text;
    }
    ddStart = -1;
  };

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toUpperCase();
    const attrsRaw = m[3] ?? '';
    const tagStart = m.index;
    const tagEnd = TAG_RE.lastIndex;

    if (ddStart >= 0 && (tag === 'DT' || tag === 'DL' || tag === 'HR')) flushDescription(tagStart);

    if (open) {
      if (closing && tag === open.tag) {
        const title = clampTitle(html.slice(open.textStart, tagStart).replace(/<[^>]*>/g, ''));
        open.node.title = title;
        if (open.tag === 'H3') pendingFolder = open.node;
        open = null;
      }
      continue; // ignore markup inside titles
    }

    if (!closing && tag === 'A') {
      const attrs = parseAttributes(attrsRaw);
      if (attrs.ICON || attrs.ICON_URI) stats.droppedIcons++;
      const node: ImportedNode = { sourceId: nextId(), kind: 'bookmark', title: '' };
      const href = decodeEntities(attrs.HREF ?? '').trim();
      if (href) {
        node.url = href.length > limits.maxUrlLength ? href.slice(0, limits.maxUrlLength) : href;
        const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase() ?? '(none)';
        stats.schemes[scheme] = (stats.schemes[scheme] ?? 0) + 1;
      } else stats.emptyUrls++;
      const added = parseDate(attrs.ADD_DATE);
      if (added) node.dateAdded = added;
      const mod = parseDate(attrs.LAST_MODIFIED);
      if (mod) node.lastModified = mod;
      if (attrs.TAGS) node.tags = attrs.TAGS.split(',').map((t) => decodeEntities(t.trim())).filter(Boolean);
      current().children!.push(node);
      stats.bookmarks++;
      lastItem = node;
      open = { node, tag: 'A', textStart: tagEnd };
      if (++total > limits.maxNodes) throw new ImportError(`More than ${limits.maxNodes} nodes`, 'too-many-nodes');
    } else if (!closing && tag === 'H3') {
      const attrs = parseAttributes(attrsRaw);
      const node: ImportedNode = { sourceId: nextId(), kind: 'folder', title: '', children: [] };
      const added = parseDate(attrs.ADD_DATE);
      if (added) node.dateAdded = added;
      const mod = parseDate(attrs.LAST_MODIFIED);
      if (mod) node.lastModified = mod;
      if (attrs.PERSONAL_TOOLBAR_FOLDER?.toLowerCase() === 'true') node.personalToolbar = true;
      current().children!.push(node);
      stats.folders++;
      lastItem = node;
      open = { node, tag: 'H3', textStart: tagEnd };
      if (++total > limits.maxNodes) throw new ImportError(`More than ${limits.maxNodes} nodes`, 'too-many-nodes');
    } else if (!closing && tag === 'H1') {
      // Document heading ("Bookmarks"): becomes the root title, not a folder.
      open = { node: root, tag: 'H1', textStart: tagEnd };
    } else if (!closing && tag === 'DL') {
      if (pendingFolder) {
        stack.push(pendingFolder);
        pendingFolder = null;
      } else if (stack.length === 0 && !rootDlSeen) {
        rootDlSeen = true; // top-level list belongs to the root
        stack.push(root);
      } else {
        // A list with no heading: keep its items in the current folder.
        stack.push(current());
      }
      const depth = stack.filter((n) => n !== root).length;
      if (depth > limits.maxDepth) throw new ImportError(`Nesting deeper than ${limits.maxDepth}`, 'too-deep');
      stats.maxDepth = Math.max(stats.maxDepth, depth);
    } else if (closing && tag === 'DL') {
      pendingFolder = null;
      if (stack.length) stack.pop();
      else stats.unmatchedCloseTags++;
    } else if (!closing && tag === 'DD') {
      ddStart = tagEnd;
    }
  }
  if (open) warnings.push('File ended inside an unterminated title.');
  if (ddStart >= 0) flushDescription(html.length);
  if (stats.rawAnchorTags !== stats.bookmarks) {
    warnings.push(`Parsed ${stats.bookmarks} bookmarks but found ${stats.rawAnchorTags} "<DT><A" tags.`);
  }
  if (stats.rawFolderHeadings !== stats.folders) {
    warnings.push(`Parsed ${stats.folders} folders but found ${stats.rawFolderHeadings} "<DT><H3" headings.`);
  }
  if (stats.unmatchedCloseTags) warnings.push(`${stats.unmatchedCloseTags} unmatched </DL> tags were ignored.`);
  return { root, stats, warnings };
}
export const parseBookmarksHtml = parseNetscapeBookmarks;

/** Flatten imported tree to bookmarks with folder paths (for analysis). */
export function flattenImported(root: ImportedNode): Array<{ node: ImportedNode; path: string[]; depth: number }> {
  const out: Array<{ node: ImportedNode; path: string[]; depth: number }> = [];
  const walk = (n: ImportedNode, path: string[]) => {
    for (const c of n.children ?? []) {
      if (c.kind === 'bookmark') out.push({ node: c, path, depth: path.length });
      else walk(c, [...path, c.title]);
    }
  };
  walk(root, []);
  return out;
}
