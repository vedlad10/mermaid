// check-boundaries.mjs — enforces the "events-only, no cross-module coupling" rule
// (ai-revenue-cycle-implementation-roadmap.md §3–5; architecture-risk-review.md §5).
//
// The rule the docs demand be *enforced, not remembered*: a module may import from itself,
// from `@mermaid/shared`, and from `platform/*` — but NEVER from a sibling module. Cross-module
// interaction happens only through domain events. A rushed `import { x } from '@mermaid/claims'`
// inside the verification module quietly removes the ability to split services later, so we fail
// CI on it.
//
// Zero dependencies (Node stdlib only), by doctrine — runs anywhere `node` runs.
//
// Usage: node platform/tools/check-boundaries.mjs   (exit 1 on any violation)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES_DIR = join(ROOT, 'modules');

const moduleNames = readdirSync(MODULES_DIR).filter((d) => {
  try { return statSync(join(MODULES_DIR, d)).isDirectory(); } catch { return false; }
});

/** Recursively collect .ts/.mjs/.js source files under a directory (skipping node_modules/dist). */
function sources(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) sources(full, acc);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) acc.push(full);
  }
  return acc;
}

// Match `from '...'` and `import('...')` / `require('...')` specifiers.
const SPECIFIER = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;

const violations = [];

for (const self of moduleNames) {
  const others = moduleNames.filter((m) => m !== self);
  const dir = join(MODULES_DIR, self);
  let files = [];
  try { files = sources(dir); } catch { continue; }

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[1];
      for (const other of others) {
        const byPackage = spec === `@mermaid/${other}` || spec.startsWith(`@mermaid/${other}/`);
        const byRelative = spec.includes(`modules/${other}/`) || spec.includes(`/${other}/`) && spec.includes('..');
        if (byPackage || byRelative) {
          violations.push({ file: file.slice(ROOT.length + 1), spec, self, other });
        }
      }
    }
  }
}

// ── Layering (M10) ─────────────────────────────────────────────────────────────────────────────
//
// The rule above stops modules coupling SIDEWAYS. This one stops the stack inverting:
//
//     packages/shared  ←  platform/*  ←  modules/*  ←  apps/*
//
// Dependencies point left. Nothing pointing right is legitimate, and each inversion is quietly
// expensive in a different way: `platform/db` importing a module would make the persistence layer
// un-reusable and would make a service split circular; `@mermaid/shared` importing platform would
// drag a Postgres pool into every pure-function test in the repository.
//
// This was listed as known debt (HANDOFF §10, medium #3) — nothing would have caught it, and by the
// time something does the fix is a refactor rather than a one-line revert.
const LAYERS = [
  { dir: 'packages', name: 'packages/shared', forbidden: ['platform', 'modules', 'apps'] },
  { dir: 'platform', name: 'platform/*', forbidden: ['modules', 'apps'] },
  { dir: 'modules', name: 'modules/*', forbidden: ['apps'] },
];

/** The workspace package names that live under each top-level directory. */
const packagesUnder = (dir) => {
  try {
    return readdirSync(join(ROOT, dir)).filter((d) => {
      try { return statSync(join(ROOT, dir, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
};

const layerViolations = [];

for (const layer of LAYERS) {
  let files = [];
  try { files = sources(join(ROOT, layer.dir)); } catch { continue; }
  // A layer's own tooling may read the whole tree — that is what this file is.
  files = files.filter((f) => !f.includes(join('platform', 'tools')));

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[1];
      for (const forbiddenDir of layer.forbidden) {
        const hitByPath = spec.includes(`${forbiddenDir}/`) && spec.startsWith('.');
        const hitByPackage = packagesUnder(forbiddenDir).some(
          (pkg) => spec === `@mermaid/${pkg}` || spec.startsWith(`@mermaid/${pkg}/`)
        );
        if (hitByPath || hitByPackage) {
          layerViolations.push({ file: file.slice(ROOT.length + 1), spec, from: layer.name, to: forbiddenDir });
        }
      }
    }
  }
}

if (violations.length || layerViolations.length) {
  if (violations.length) {
    console.error('✖ Module-boundary violations (cross-module imports are forbidden — use domain events):\n');
    for (const v of violations) {
      console.error(`  ${v.file}`);
      console.error(`    module "${v.self}" imports from module "${v.other}" via '${v.spec}'`);
    }
  }
  if (layerViolations.length) {
    console.error('\n✖ Layering violations (dependencies point one way: shared ← platform ← modules ← apps):\n');
    for (const v of layerViolations) {
      console.error(`  ${v.file}`);
      console.error(`    ${v.from} imports from ${v.to}/ via '${v.spec}'`);
    }
  }
  console.error(
    `\n${violations.length + layerViolations.length} violation(s). See docs/MODULE-BOUNDARIES.md.`
  );
  process.exit(1);
}

console.log(
  `✔ Module boundaries clean — ${moduleNames.length} module(s), no cross-module imports, no layer inversions.`
);
