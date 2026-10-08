/** Réglages : priorité environnement > gate.toml > interface, verrous, bornes du contrat. */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseToml } from '../src/config';
import { ipInRange, validRange } from '../src/api/keys';
import { tempDir } from './support/util';

describe('gate.toml', () => {
  it('lit chaînes, nombres, booléens, tableaux, sections et commentaires', () => {
    expect(
      parseToml(`# réglages\nhost = "0.0.0.0"\nport = 9443 # API\nwrite = true\ncors_origins = ["https://a.example", 'https://b.example']\n[gate]\nmetrics = false\n`)
    ).toEqual({ host: '0.0.0.0', port: 9443, write: true, cors_origins: ['https://a.example', 'https://b.example'], 'gate.metrics': false });
    expect(() => parseToml('host 0.0.0.0')).toThrow(/ligne 1/);
  });

  it('environnement > fichier > interface > défaut, et les sources le disent', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'gate.toml'), 'port = 9000\nhost = "0.0.0.0"\n');
    const cfg = loadConfig({ port: 7000, journalDays: 7, metrics: false }, { FILARR_GATE_PORT: '9100' }, dir);
    expect(cfg.settings.port).toBe(9100);
    expect(cfg.sources.port).toBe('env');
    expect(cfg.settings.host).toBe('0.0.0.0');
    expect(cfg.sources.host).toBe('file');
    expect(cfg.settings.journalDays).toBe(7);
    expect(cfg.sources.journalDays).toBe('settings');
    expect(cfg.settings.apiUrl).toBe('https://api.filarr.com');
    expect(cfg.sources.apiUrl).toBe('default');
  });

  it('la relève ne descend jamais sous 300 s, l’écriture est éteinte d’office, le jeton de l’environnement reste en mémoire', () => {
    const cfg = loadConfig({}, { FILARR_GATE_POLL_SECONDS: '10', FILARR_GATE_TOKEN: ' flr_live_x ' }, tempDir());
    expect(cfg.settings.pollSeconds).toBe(300);
    expect(cfg.settings.write).toBe(false);
    expect(cfg.tokenFromEnv).toBe('flr_live_x');
    expect(() => loadConfig({}, { FILARR_GATE_API_URL: 'ftp://x' }, tempDir())).toThrow(/apiUrl/);
  });
});

describe('adresses autorisées', () => {
  it('IPv4, IPv6, IPv4 sur IPv6, plages', () => {
    expect(ipInRange('10.0.4.12', '10.0.4.0/24')).toBe(true);
    expect(ipInRange('10.0.5.12', '10.0.4.0/24')).toBe(false);
    expect(ipInRange('::ffff:10.0.4.12', '10.0.4.0/24')).toBe(true);
    expect(ipInRange('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInRange('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInRange('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(validRange('10.0.0.0/33')).toBe(false);
    expect(validRange('pas une adresse')).toBe(false);
  });
});
