/**
 * Cale de plateforme pour le cœur recopié de Filarr.
 *
 * Dans l'application, `types.ts` et `formulaEngine.ts` importent la configuration
 * i18next du bureau. La boîte noire n'a pas d'interface traduite par i18next : le
 * cœur n'y lit que `t(clé, { defaultValue, ...variables })` et `language`. Cette
 * cale rend le texte par défaut, avec ses variables `{{nom}}` remplacées.
 */

type Options = { defaultValue?: unknown } & Record<string, unknown>;

const i18n = {
  language: 'fr',
  t(key: string, options?: Options): string {
    const fallback = options?.defaultValue;
    const text = typeof fallback === 'string' ? fallback : key;
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
      const value = options?.[name];
      return value === undefined || value === null ? whole : String(value);
    });
  },
};

export default i18n;
