/**
 * Deterministic synthetic bookmark library generator (no private data).
 * Produces a multilingual, multi-subject tree with realistic noise:
 * duplicates, tracking variants, weak titles, platform-hosted items,
 * misleading folders and deep nesting.
 */
export interface SynthItem {
  path: string[];
  title: string;
  url: string;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS: Array<{ folder: string; weight: number; titles: string[]; hosts: string[] }> = [
  { folder: 'Programming', weight: 12, titles: ['Python tutorial: {x}', 'Rust ownership guide {x}', 'TypeScript generics {x}', 'Linux kernel notes {x}', 'Docker and Kubernetes deployment {x}', 'Algorithm design: dynamic programming {x}'], hosts: ['dev-notes.example', 'code-guide.example', 'github.com'] },
  { folder: 'AI', weight: 8, titles: ['Deep learning with PyTorch {x}', 'Prompt engineering for LLMs {x}', 'Neural networks explained {x}', 'SQL database indexing {x}'], hosts: ['ml-blog.example', 'huggingface.co', 'ai-papers.example'] },
  { folder: 'Astronomy', weight: 10, titles: ['Celestial mechanics: {x}', 'Orbital mechanics lecture {x}', 'Ephemeris computation (VSOP87) {x}', 'Telescope observing guide {x}', 'Lunar occultation predictions {x}', 'Exoplanet discovery {x}'], hosts: ['astro-notes.example', 'ssd.jpl.nasa.gov', 'sky.example'] },
  { folder: 'Calendars', weight: 6, titles: ['Persian calendar conversion {x}', 'Julian day number algorithm {x}', 'Leap seconds and UTC {x}', 'Lunar crescent visibility {x}', 'رؤیت هلال {x}', 'تبدیل تاریخ {x}', 'التقويم الهجري {x}'], hosts: ['calendars.example', 'taqvim.example.ir', 'time.example'] },
  { folder: 'Math', weight: 9, titles: ['Number theory: primes {x}', 'Linear algebra eigenvalues {x}', 'Probability and statistics {x}', 'Integer factorization GNFS {x}', 'Riemann zeta function {x}'], hosts: ['math.example.edu', 'oeis.org', 'youtube.com'] },
  { folder: 'History', weight: 6, titles: ['Achaemenid empire {x}', 'Cuneiform tablets {x}', 'Archaeology excavation report {x}', 'Museum collection {x}', 'تاریخ ایران باستان {x}'], hosts: ['history.example', 'museum.example.org', 'wikipedia.org'] },
  { folder: 'Literature', weight: 6, titles: ['دیوان حافظ {x}', 'Shahnameh of Ferdowsi {x}', 'Persian poetry anthology {x}', 'Dictionary of etymology {x}', 'لغت نامه دهخدا {x}'], hosts: ['poetry.example.ir', 'ganjoor.net', 'dict.example'] },
  { folder: 'Religion', weight: 4, titles: ['Comparative religion: Zoroastrianism {x}', 'Avesta translation {x}', 'Daily horoscope {x}', 'Philosophy of mind {x}'], hosts: ['religion.example', 'texts.example', 'stars-say.example'] },
  { folder: 'Real Estate', weight: 7, titles: ['Real estate license exam {x}', 'Escrow checklist {x}', 'Property listing {x}', 'Mortgage calculator {x}', 'Realtor CRM tips {x}'], hosts: ['realty.example', 'zillow.com', 're-exam.example'] },
  { folder: 'Earth', weight: 5, titles: ['Geodesy and map projections {x}', 'Earthquake seismology {x}', 'QGIS tutorial {x}', 'Physics of optics {x}'], hosts: ['geo.example', 'usgs.gov', 'qgis.org'] },
  { folder: 'Life', weight: 6, titles: ['Hiking trails {x}', 'Chess openings {x}', 'Travel guide {x}', 'Recipe: {x}', 'Film photography {x}', 'Music theory {x}'], hosts: ['life.example', 'lichess.org', 'trails.example'] },
  { folder: 'Misc', weight: 5, titles: ['Home', 'Login', 'Untitled', 'Index of /files', 'Welcome {x}', 'Document {x}'], hosts: ['misc.example', 'drive.google.com', 'portal.example'] },
];

export function generateLibrary(count = 25_000, seed = 42): SynthItem[] {
  const r = rng(seed);
  const total = SUBJECTS.reduce((s, x) => s + x.weight, 0);
  const pick = () => {
    let v = r() * total;
    for (const s of SUBJECTS) if ((v -= s.weight) <= 0) return s;
    return SUBJECTS[0]!;
  };
  const out: SynthItem[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 100 && r() < 0.05) {
      // duplicate (identical or tracking variant), sometimes in another folder
      const src = out[Math.floor(r() * out.length)]!;
      const variant = r() < 0.4 ? `${src.url}${src.url.includes('?') ? '&' : '?'}utm_source=newsletter` : src.url;
      out.push({ path: r() < 0.5 ? src.path : ['Imported', `Batch ${Math.floor(r() * 20)}`], title: src.title, url: variant });
      continue;
    }
    const s = pick();
    // Misleading folder 8% of the time.
    const folderSubject = r() < 0.08 ? pick() : s;
    const depth = Math.floor(r() * 4);
    const path = [folderSubject.folder, ...Array.from({ length: depth }, (_, d) => `${folderSubject.folder} ${d + 1}-${Math.floor(r() * 6)}`)];
    const title = s.titles[Math.floor(r() * s.titles.length)]!.replace('{x}', `part ${i}`);
    const host = s.hosts[Math.floor(r() * s.hosts.length)]!;
    out.push({ path, title, url: `https://${host}/${s.folder.toLowerCase().replace(/\s+/g, '-')}/${i}` });
  }
  return out;
}
