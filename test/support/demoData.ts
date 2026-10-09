/**
 * Trois bases de démonstration (Clients, Commandes, Catalogue), pour les essais
 * et le banc local. Commandes vise Clients par une relation ; Clients en lit
 * l'envers (rétrolien) et en tire un agrégat ; Catalogue vise une base de
 * fournisseurs qui N'EST PAS ouverte à l'accès (contrat § 8).
 */

import type { DbProperty, DbRow, DbView } from '../../packages/core/src/types';
import type { NewStore } from './mockFilarr';

export const CLIENTS_DB = 'db-clients-demo';
export const COMMANDES_DB = 'db-commandes-demo';
export const CATALOGUE_DB = 'db-catalogue-demo';
export const FOURNISSEURS_DB = 'db-fournisseurs-ferme';

const statut = [
  { id: 'o_prospect', label: 'Prospect', color: 'gray' },
  { id: 'o_client', label: 'Client', color: 'green' },
  { id: 'o_perdu', label: 'Perdu', color: 'red' },
];

export const clientsProps: DbProperty[] = [
  { id: 'p_nom', name: 'Nom', type: 'text' },
  { id: 'p_ville', name: 'Ville', type: 'text' },
  // L'option par défaut d'une ligne neuve, comme « Nouvelle ligne » dans Filarr.
  { id: 'p_statut', name: 'Statut', type: 'select', options: statut, defaultOptionId: 'o_prospect' },
  { id: 'p_ca', name: 'CA', type: 'number', numberFormat: 'euro' },
  { id: 'p_contact', name: 'Dernier contact', type: 'date' },
  { id: 'p_cmds', name: 'Commandes', type: 'relation', targetDbId: COMMANDES_DB, direction: 'in', sourcePropertyId: 'c_client' },
  { id: 'p_total', name: 'Total commandé', type: 'rollup', viaPropertyId: 'p_cmds', targetPropertyId: 'c_montant', aggregate: 'sum' },
];

export const commandesProps: DbProperty[] = [
  { id: 'c_numero', name: 'Numéro', type: 'text' },
  { id: 'c_client', name: 'Client', type: 'relation', targetDbId: CLIENTS_DB, single: true },
  { id: 'c_date', name: 'Date', type: 'date' },
  { id: 'c_montant', name: 'Montant', type: 'number' },
  { id: 'c_payee', name: 'Payée', type: 'checkbox' },
];

export const catalogueProps: DbProperty[] = [
  { id: 'k_produit', name: 'Produit', type: 'text' },
  { id: 'k_prix', name: 'Prix', type: 'number' },
  { id: 'k_stock', name: 'Stock', type: 'number' },
  { id: 'k_fourn', name: 'Fournisseur', type: 'relation', targetDbId: FOURNISSEURS_DB },
  { id: 'k_nb', name: 'Nb fournisseurs', type: 'rollup', viaPropertyId: 'k_fourn', aggregate: 'count' },
];

const created = '2026-09-01T08:00:00.000Z';

export const clientsRows: DbRow[] = [
  { id: 'r_acme', cells: { p_nom: 'Acme', p_ville: 'Lyon', p_statut: 'o_client', p_ca: 12500, p_contact: '2026-10-03' }, createdAt: created },
  { id: 'r_globex', cells: { p_nom: 'Globex', p_ville: 'Nantes', p_statut: 'o_client', p_ca: 9800, p_contact: '2026-09-28' }, createdAt: created },
  { id: 'r_initech', cells: { p_nom: 'Initech', p_ville: 'Lille', p_statut: 'o_prospect', p_contact: '2026-08-07' }, createdAt: created },
  { id: 'r_umbrella', cells: { p_nom: 'Umbrella', p_ville: 'Paris', p_statut: 'o_perdu', p_ca: 1200, p_contact: '2026-05-12' }, createdAt: created },
];

export const commandesRows: DbRow[] = [
  { id: 'r_c1', cells: { c_numero: 'C-2026-1181', c_client: ['r_acme'], c_date: '2026-10-01', c_montant: 1240.5, c_payee: true }, createdAt: created },
  { id: 'r_c2', cells: { c_numero: 'C-2026-1182', c_client: ['r_globex'], c_date: '2026-10-02', c_montant: 860, c_payee: false }, createdAt: created },
  { id: 'r_c3', cells: { c_numero: 'C-2026-1183', c_client: ['r_acme'], c_date: '2026-10-05', c_montant: 300, c_payee: true }, createdAt: created },
];

export const catalogueRows: DbRow[] = [
  { id: 'r_k1', cells: { k_produit: 'Table chêne', k_prix: 890, k_stock: 4, k_fourn: ['f_bois'] }, createdAt: created },
  { id: 'r_k2', cells: { k_produit: 'Chaise', k_prix: 120, k_stock: 31, k_fourn: ['f_bois', 'f_metal'] }, createdAt: created },
];

export const clientsViews: DbView[] = [
  { id: 'v_tous', name: 'Tous les clients', type: 'table', filters: [], sorts: [{ propertyId: 'p_nom', direction: 'asc' }] },
  {
    id: 'v_actifs',
    name: 'Clients actifs',
    type: 'table',
    filters: [{ id: 'f1', propertyId: 'p_statut', op: 'is', value: 'o_client' }],
    sorts: [{ propertyId: 'p_ca', direction: 'desc' }],
    hiddenPropertyIds: ['p_cmds', 'p_total'],
  },
  {
    id: 'v_relancer',
    name: 'À relancer',
    type: 'table',
    filters: [{ id: 'f2', propertyId: 'p_contact', op: 'before', value: '2026-08-08' }],
    sorts: [],
  },
];

export const commandesViews: DbView[] = [
  { id: 'v_cmd', name: 'Toutes les commandes', type: 'table', filters: [], sorts: [{ propertyId: 'c_date', direction: 'desc' }] },
  {
    id: 'v_ville',
    name: 'Chiffre par ville',
    type: 'query',
    filters: [],
    sorts: [],
    query: {
      sql: 'SELECT c.ville, count(*) AS commandes, sum(o.montant) AS chiffre FROM commandes AS o JOIN clients AS c ON o.client_id = c.id GROUP BY c.ville ORDER BY chiffre DESC',
    },
  },
];

export const demoStores: NewStore[] = [
  { dbId: CLIENTS_DB, title: 'Clients', properties: clientsProps, rows: clientsRows, views: clientsViews },
  { dbId: COMMANDES_DB, title: 'Commandes', properties: commandesProps, rows: commandesRows, views: commandesViews },
  {
    dbId: CATALOGUE_DB,
    title: 'Catalogue',
    properties: catalogueProps,
    rows: catalogueRows,
    views: [{ id: 'v_cat', name: 'Catalogue', type: 'table', filters: [], sorts: [] }],
  },
];
