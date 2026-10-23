import { describe, expect, it } from 'vitest';
import { detectScriptLanguage, foldText, isWeakTitle, slugify, tokenize } from '../../src/core/text.ts';

describe('text folding', () => {
  it('unifies Arabic/Persian letter variants and digits without touching meaning', () => {
    expect(foldText('كتاب')).toBe(foldText('کتاب'));
    expect(foldText('علي')).toBe(foldText('علی'));
    expect(foldText('۱۴۰۳')).toBe('1403');
    expect(foldText('نجوم‌شناسی')).toBe('نجوم شناسی');
  });
  it('detects language by script', () => {
    expect(detectScriptLanguage('Celestial mechanics notes')).toBe('en');
    expect(detectScriptLanguage('گاه‌شماری ایرانی')).toBe('fa');
    expect(detectScriptLanguage('التقويم الهجري')).toBe('ar');
    expect(detectScriptLanguage('تقویم Calendar conversion')).toBe('mixed');
  });
  it('identifies weak titles', () => {
    for (const t of ['Home', 'Login', 'index', '', 'صفحه اصلی', 'Home | Example', 'https://x.com', '12345']) expect(isWeakTitle(t)).toBe(true);
    expect(isWeakTitle('Lunar crescent visibility criteria')).toBe(false);
  });
  it('tokenizes with stopwords removed', () => {
    expect(tokenize('The Python Guide to Orbital Mechanics')).toEqual(['python', 'guide', 'orbital', 'mechanics']);
    expect(tokenize('C++ and C# basics')).toEqual(['c++', 'c#', 'basics']);
  });
  it('slugifies', () => {
    expect(slugify('AI & Data Science')).toBe('ai-and-data-science');
    expect(slugify('تقویم')).toMatch(/^c-/);
  });
});
