import translations from '../data/translations.json';

export type Lang = 'de' | 'en';
export const LANGS: Lang[] = ['de', 'en'];
export const DEFAULT_LANG: Lang = 'de';

type Dict = typeof translations['de'];

export function t(lang: Lang, key: keyof Dict): string {
  const dict = (translations as Record<Lang, Dict>)[lang] ?? translations[DEFAULT_LANG];
  return dict[key] ?? key;
}

export function isLang(value: string | null | undefined): value is Lang {
  return value === 'de' || value === 'en';
}

export { translations };
