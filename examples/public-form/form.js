// The request a public web form sends to Filarr Gate to add one row (browser and Node 20+).
//
// The key used here can ONLY create rows in ONE database ("create" right, nothing else): if
// someone copies it out of the page, they can add rows, not read or change anything. Never put
// a key that reads or writes more in a web page.

// region request
/** Builds the request that adds a contact request to the "clients" database. */
export function contactRequest(gateUrl, formKey, fields) {
  return {
    url: `${gateUrl}/v1/clients`,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${formKey}`, 'Content-Type': 'application/json' },
      // Only the fields of the form; the gate refuses unknown fields (400 unknown_field)
      body: JSON.stringify({ nom: String(fields.nom).slice(0, 200), ville: String(fields.ville ?? '').slice(0, 100) }),
    },
  };
}
// endregion
