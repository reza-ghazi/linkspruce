/** Synthetic bookmark fixtures (never derived from private data). */
import { applyEdit, emptyTaxonomy, freeze, type Taxonomy } from '../../src/core/taxonomy/taxonomy.ts';
import type { FakeBookmarks } from './fake-chrome.ts';

export const SYNTHETIC: Array<{ path: string[]; title: string; url: string }> = [
  { path: ['Old', 'Python'], title: 'Orbital mechanics with Python (poliastro)', url: 'https://docs.poliastro.example/en/stable/' },
  { path: ['Old', 'Python'], title: 'Python tutorial for beginners', url: 'https://learn-python.example/tutorial/' },
  { path: ['Old', 'Misc'], title: 'Lunar crescent visibility criteria (Yallop)', url: 'https://crescent.example/yallop' },
  { path: ['Old', 'Misc'], title: 'رؤیت هلال ماه شوال', url: 'https://hilal.example.ir/shawwal' },
  { path: ['Old', 'Misc'], title: 'Persian calendar conversion algorithm', url: 'https://calendars.example/persian-conversion' },
  { path: ['Old', 'Astro'], title: 'Lunar occultation predictions', url: 'https://occult.example.org/predictions' },
  { path: ['Old', 'Astro'], title: 'Daily horoscope and zodiac signs', url: 'https://stars-say.example/horoscope' },
  { path: ['Old', 'RE'], title: 'California real estate license exam prep', url: 'https://re-exam.example/ca' },
  { path: ['Old', 'RE'], title: 'Home', url: 'https://agency.example/' },
  { path: ['Old'], title: 'Number theory lecture notes: primes and congruences', url: 'https://math.example.edu/nt/notes.pdf' },
];

/** A small approved taxonomy used across integration tests. */
export function testTaxonomy(now = 1): Taxonomy {
  let t = emptyTaxonomy('tax_test', now);
  const add = (name: string, parentId: string | null, conceptKeys: string[], id: string) => {
    t = applyEdit(t, { op: 'add', input: { id, name, parentId, conceptKeys, definition: `${name}.` } }, now);
  };
  add('Computing & Software', null, ['computing'], 'cat_computing');
  add('Programming Languages', 'cat_computing', ['prog-lang'], 'cat_proglang');
  add('Astronomy & Space Science', null, ['astronomy'], 'cat_astronomy');
  add('Celestial Mechanics', 'cat_astronomy', ['celestial-mech'], 'cat_celmech');
  add('Observational Astronomy', 'cat_astronomy', ['observational'], 'cat_observing');
  add('Calendars & Timekeeping', null, ['calendars'], 'cat_calendars');
  add('Calendar Conversion', 'cat_calendars', ['cal-algorithms'], 'cat_calconv');
  add('Crescent Visibility', 'cat_calendars', ['religious-time'], 'cat_crescent');
  add('Philosophy & Religions', null, ['philosophy-religion'], 'cat_philrel');
  add('Astrology & Esoteric', 'cat_philrel', ['esoteric'], 'cat_esoteric');
  add('Real Estate', null, ['real-estate', 're-practice'], 'cat_realestate');
  add('Mathematics', null, ['math'], 'cat_math');
  add('Number Theory', 'cat_math', ['number-theory'], 'cat_numtheory');
  return freeze(t, now);
}

export async function seed(bm: FakeBookmarks, items = SYNTHETIC): Promise<string[]> {
  const ids: string[] = [];
  for (const it of items) {
    const parent = await bm.ensurePath(it.path);
    ids.push((await bm.create({ parentId: parent, title: it.title, url: it.url })).id);
  }
  return ids;
}
