// migration-checksum-history.mjs — the one-time record of migrations whose TEXT changed after they
// were applied, and why that was allowed.
//
// ── READ THIS BEFORE ADDING AN ENTRY ─────────────────────────────────────────────────────────────
// Migrations are immutable once applied. `migrate.mjs` enforces that with a checksum and refuses to
// run when a file's text no longer matches what was recorded — the guard exists because an edited
// migration means the database in front of you and the database a colleague rebuilt from scratch
// have silently different schemas.
//
// This file is the ONLY exception, and it is narrow by construction: each entry names BOTH the exact
// prior checksum and the exact replacement. A repair fires only when the recorded row hashes to
// `from` AND the file on disk hashes to `to`. So an entry cannot bless a later edit — a later edit
// produces neither hash — and it cannot be left lying around as a permanent licence to modify that
// file. It authorises one transition and then does nothing forever.
//
// Adding an entry is a schema-level decision, not a way around a failing migrate. The bar is: the
// edit provably changed no DDL and no data — otherwise write a new migration.
//
// ── THE ONE ENTRY (NEW-02) ───────────────────────────────────────────────────────────────────────
// At commit 2aea728, eighteen migration files each opened `BEGIN;` and closed `COMMIT;`. The runner
// applies the whole pending set in ONE transaction and takes `pg_advisory_xact_lock` inside it, and
// `client.query()` sends multi-statement SQL over the simple query protocol — so each file's
// `COMMIT` ended the RUNNER's transaction, releasing the lock and destroying the atomicity the
// design depends on (see sql-transaction-control.mjs for the full account).
//
// The fix strips those statements from the files. The statements were transaction control and
// nothing else: no DDL, no DML, no data. Every database that had already applied them holds exactly
// the schema the stripped files produce — the difference is who owns the transaction, which is a
// property of the run, not of the result.
//
// The `from` checksums are the pre-strip file contents, and they were verified against the recorded
// `_migrations` rows of the live database before the strip was made. Anyone can reproduce them:
//
//     git show 2aea728:platform/db/migrations/0001_conventions.sql | sha256sum
//
// Nothing should ever be added here for a reason that cannot be checked that way.

/**
 * `id` → `{ from, to }`. The runner repairs a recorded checksum of `from` to `to`, and only when
 * the file on disk actually hashes to `to`. Every other mismatch is an edited migration and fatal.
 */
export const SUPERSEDED_CHECKSUMS = new Map([
  [1, { from: '2cbf8c6b4ffcd95063a8375c0720365872b499cfcddc48d4ef1817f362a6e8df', to: 'd5b96bf6c0bc3478fe5f24f8a891584c5350fc066d3acd1608577abd6f49dda5' }],
  [2, { from: '7c016c055d6cd5b77f899e0879e422c6eab571f287701c8da1a9c68639501b38', to: '979e11086fcd6e74cf26edf2f96865a7768f8b006bd3649651a1fe9a73e60500' }],
  [3, { from: '1a55342fe20ebfd29d66cbd41623b01cd8ec428a50ba1d7b888b11c727186b59', to: '45ef0f78b1b8d819f7b3b860ed411064b94aedaf06fa303f2029a265886edde2' }],
  [4, { from: '6ca899731d7aa39d7f18dcb92335fab6934531445e0e6c6f7225394bf743cb0a', to: '981ebe7f933626cf6f15a462ef9e8587f0bb840ab3043953293387da4d7f4f0b' }],
  [5, { from: '326ec52860c6dc6d5bc888289639096e0210cbe71dbf77778208218a821c136e', to: '7c494c6ac95f2311afeecfcab0ef852ed8706c90b389ed94830ed5c0c460fe6d' }],
  [6, { from: 'fdbb3dab4d9b3b9c32ae1b9e930156c6243b2c358a2aedc59baecdb426e55de4', to: '1f6edb3143d029510772669a08c9cab5cff83c267c84cfa95d8f6ad1f38ce239' }],
  [7, { from: '21696c6edcfbe9513edbee07a46d7091606d835fe16e5c60212d8e6b94cc3c69', to: 'd0ba45d9b0112ec2442c314299e5a410eaee2dd20f449b95782724515d874c3b' }],
  [8, { from: '87a59ad24124065d7dc06b68a446781a52d4a1b59c00b92cdcb833625b302153', to: '2c1dd9c917a4318c680f2750fa30714dc41dc2248067b4792707937b59bccb7b' }],
  [9, { from: '84fafc463e386b94734fec2863e2729eac7d67e7c41621b20ad6806e32224dee', to: '5e5a2c9f27e09ffda7cfa2b66a8a886136ee93083702cf6d9a56462b7073b35b' }],
  [10, { from: '52cba83fd60ad11cc6e6d8d5d327d48326da1c1b2e1cb40502839604627125d1', to: '3685ae093a7f53718ade06cc714f3c1752fe2dfaab7568f1bd4a7fd903184024' }],
  [11, { from: '39a8dd0ba7c783e413da5989f015cf4fd84e9019b7272ef91859d5b534ab5f7d', to: 'e1f7c0335a31ef87d1fde8e8ed0af949afccfce65081733d1de098fe9622a26b' }],
  [12, { from: '8ab5e9be8bbc07b58c92dfde8388ccd9aae49abc85796e0130fa8cd2824ccdb4', to: '1fe7b1e36f2933e00ff216011b3fff3fd441b2aac5a69f6023b928e8572b44ae' }],
  [13, { from: '07aa967e208a248d4b598c1e9db05dd7c8724095609007e52abcfb76ee492c00', to: '2ab8e4200caf3d5024ea8ecfbde49fd4054444307611ab269c6b7685890c80d1' }],
  [14, { from: '569c934014030a2e893dd1b5052a2e0d63e800f602e56f732998e938612210ff', to: 'e18a445234595a485d546fb85502f5b0db45f0e24631d08e9a6eb6458a771e15' }],
  [15, { from: '2b2d8e11ed1303699c21af0f801561d8bad5dfaee3bb4dd1aedfc59cdc744a1c', to: '65fc66f469df9a807439c7e23d9255edb9285e088cf464dad869e80b8e7642e8' }],
  [16, { from: 'bcf47bff4b2d1c52854098599c26d0d69117c5404f9b90af7fa05fcf6f3f1e8b', to: '93cbb4745544c6f5cb952a0d0b55feadb62df59dba19ff03783a59d630fbfa2e' }],
  [19, { from: 'ed6b57416bb8a7d19886978c05e8bd5a0c19f8ba5ff7f1ad9ab3c6b8e1c6c7dc', to: '5d3be393c70e36cceeef322b8c672a92ff1182c699fe974b664406380f8cf128' }],
  [20, { from: '5547a2b7df9b3e0d03d7d8a7b8c24f8011d932278f308e8a1d11f65431593f6d', to: '4f571861f07e5452d9a798385fdb087d34beca8fce2376e853237e9f348a25a7' }],
]);
