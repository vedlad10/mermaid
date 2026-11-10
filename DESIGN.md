# Mermaid — visual world

**Direction: pinned by the user's brief, not rolled.** Linear × Bloomberg × Stripe, for dental
revenue-cycle management. Precise, calm, intelligent, financial, technical, alive.

> This file describes what `apps/web/public/styles.css` actually ships. Where the two ever
> disagree, the stylesheet is right and this file is a bug — it has been one before, and a spec
> that quietly stops matching the product is worse than no spec, because it is read as authority.

## The thesis
The screen is an **instrument panel**, not a dashboard. A dashboard reports; an instrument shows a
system running. Mermaid watches a revenue cycle continuously, so the interface's job is to make that
motion legible: the data draws the picture, and colour is almost absent from it.

The anti-reference is the thing this category always ships — a grid of coloured KPI cards over a
white page. The audit found the incumbent had **189 KPI card instances and 4 SVG elements**. The
redesign inverts that ratio. Note that the anti-reference is the *cards*, not the white: a white
ground with four figures on one hairline rule is the opposite of that page, not a version of it.

## Ground
**Paper white.** The governing image is a printed clinical report under daylight: paper-white
ground, hairline rules, near-black ink doing the hierarchy, and colour spent like a scalpel — a
rail, a dot, one figure.

This reverses an earlier decision, and the reversal is recorded rather than overwritten because the
original argument was a good one. The system was dark on a trading-terminal premise: the user stares
at it for six hours, so let the data be the only thing emitting light. That is sound for a cockpit
and wrong for this room. Mermaid is read at a cramped front desk under fluorescent light, between
patients, on a laptop and increasingly on a phone. Against a bright room a dark panel is the
highest-contrast object in the visual field and the eye keeps returning to the bezel; on paper white
the screen disappears and only the figures remain. The ground was always derived from the use scene
— it was never part of the pinned brief — so re-deriving it from a corrected reading of that scene
is the same move, not a departure.

```
--surface-void    #f4f6f9   app background, the space behind everything, gutters
--surface-base    #ffffff   primary working plane: main content region
--surface-raised  #f7f9fb   rows on hover, table headers, inline expansion, sticky bars
--surface-overlay #ffffff   drill panels, popovers, command palette, modals
--surface-inset   #fbfcfd   recessed wells: chart grounds, EDI views, inputs

--text-primary    #0c1320   key figures, names, headlines          18.6:1 on base
--text-secondary  #485364   body copy, secondary columns            7.4:1 worst case
--text-tertiary   #606b7f   labels, units, metadata, axis ticks     5.1:1 worst case
--text-quaternary #828c9e   disabled, placeholder, inactive series  3.2:1 — a graphical mark
--text-inverse    #ffffff   text on accent fills                    4.8:1 on --tide
```

**This is a value inversion, not a hue swap**, and two things flip that are easy to get wrong later:

- `--surface-raised` is **darker** than `--surface-base`. A hovered row and a table header sit
  slightly grey against white where they used to sit slightly light against black. "Raised" names
  the role, not the direction.
- The composition ramp runs **light→dark**, so `--ramp-5` is the heaviest step. Emphasis is always
  the end furthest from the page.

The ink is a very dark desaturated navy, not black. Pure `#000` on pure `#fff` is harsher than any
printed page and is the single most common tell of a light theme that was inverted rather than
designed. The hairlines are ink-alpha rather than a grey, so a rule over the white plane and the
same rule over a tinted row stay the same rule; the ink is faintly blue because a neutral grey
hairline on white reads dusty, which is the difference between a drawn line and a dirty one.

```
--line-hairline  rgba(13, 20, 33, 0.07)   row rules, chart gridlines
--line-soft      rgba(13, 20, 33, 0.11)   container edges, panel boundaries
--line-strong    rgba(13, 20, 33, 0.20)   active container, focused input, selected row
```

Elevation is declared **once**: a 1px hairline. No shadow on panels. Shadow exists only for things
that genuinely float, and then they carry no border. On white this matters *more* than it did on
black — a soft shadow under a border reads as a cheap card, and the temptation to add one is
stronger. The one permitted shadow is two-layer: a 1px contact shadow doing the work a border would
have done, plus a wide soft one for the lift, because on white a single large blur reads as fog.

```
--shadow-overlay  0 1px 2px rgba(13,20,33,.05), 0 16px 40px -12px rgba(13,20,33,.18)
```

## Accent
One. It is the **interactive** colour — focus rings, the selected rail item, the active tab
underline, a link. It is never the colour of money and never decoration. Target: under 2% of pixels.

Teal survives the inversion because it is the product's name, but it could not survive unchanged:
the dark system's `#4fb6c4` measures 2.1:1 on white and would have been an illegible link. Two
tokens now do what one did, and **that split is the important idea in this palette**: the deep one
is safe wherever text is, the bright one is for marks a person looks at rather than reads. It is how
the interface gets brighter without anything becoming harder to read.

```
--tide        #06798a   links, labels, primary fills        4.8:1 worst case — safe as text
--tide-bright #0f9db0   chart marks, active series, rails   3.1:1 — a mark, never a word
--tide-muted  #7fbcc7   comparison series, related-but-unselected
--tide-wash   rgba(6, 121, 138, 0.07)   selected row, brushed chart region
--tide-ring   rgba(6, 121, 138, 0.20)   focus ring
```

## Semantic colour
A statement about **state**. Illegal for grouping, categorisation or variety. Applied to the
smallest possible surface — a 2px rail, a dot, one figure, one bar segment.

Deep and saturated rather than light and bright. Every one of these carries figures somewhere, so
every one is text and every one clears 4.5:1; a cheerful amber that looks right on a marketing page
measures 2.4:1 here and would put an unreadable number on a screen about money. The chroma is what
keeps them from reading as mud — they are dark because they must be, saturated because they can be.

```
--state-critical  #c0362c   money is being or will be lost                  5.2:1
--state-warning   #a35c05   deadline approaching, or a human must decide    4.9:1
--state-positive  #15774d   money arrived, or a risk closed                 5.3:1
--state-neutral   #606b7f   in flight, no judgment available yet
--ai              #6d4de0   model-attributed — neither state nor accent
```

`--ai` is deliberately unmistakably not-Tide, so "the system suggested this" never reads as "you
selected this".

The composition ramp is one cool blue-grey hue, ordered so the ramp itself encodes severity or
recency. Semantic colour enters only where a bucket genuinely means loss.

```
--ramp-1 #cbd4e1   --ramp-2 #9ea7b4   --ramp-3 #78818e   --ramp-4 #565f6c   --ramp-5 #2f3844
--ramp-loss rgba(192, 54, 44, 0.55)
```

**Colour is never the only channel.** Every status also carries a word; every figure that matters
also carries a size. Remove every hue and the hierarchy still reads, because it is built from scale,
weight, spacing and line. That is not an accessibility footnote — a greyscale printout is how a
denial gets appealed.

Every value above is checked by `the-tokens-hold-their-contrast.test.ts` against **all five**
surfaces, not against white alone. The surface a token fails on is always the one nobody thought to
check: `--surface-void` was omitted while it was the darkest plane and therefore the easiest, and
inverting made it the worst case for every text token.

## Type
Unchanged by the inversion, deliberately — the type system was doing its job and a colour change is
not a reason to reopen it. Inter Tight for everything textual. JetBrains Mono for **measured
quantities only** — money, counts, codes, timestamps, axis labels. Mono here is measurement, not
costume. Every figure gets `font-variant-numeric: tabular-nums` and column alignment on the decimal.

```
--type-figure-xl  44px / 44px  -0.03em   the single figure a screen is about
--type-figure-lg  30px / 32px  -0.02em   a figure among several
--type-figure-md  20px / 24px  -0.01em   supporting figures
--type-figure-sm  15px / 20px            inline figures
--type-body       14px / 20px            row names, sentences, default UI text
--type-label      12px / 16px  +0.01em   labels, captions, provenance
--type-meta       11px / 14px  +0.02em   uppercase metadata
--type-mono-sm    12px / 16px            codes, timestamps
```

**Weights used in the entire product: 400, 450, 500. No 600, no 700, no bold.** Emphasis comes from
value and size. This single constraint is most of what separates this from an admin panel — and it
matters more on white, where a heavy weight has further to fall and reads louder.

## Structure
Every stage follows one spine, and nothing else may claim the top:

**PRIMARY SIGNAL** — one figure, the screen's answer, with its provenance
**PRIMARY VISUALIZATION** — the chart that explains that figure
**SECONDARY SIGNAL** — two to four supporting figures, one line, no cards
**OPERATIONAL DETAIL** — the table or list you act on

## Charts
Charts are content. Every one answers a named question and declares SOURCE → DERIVATION.
Built as SVG geometry primitives in `charts.js`, no library, because the required vocabulary is
small and precise and CSP forbids the inline styles a chart library would emit.

The vocabulary: time-series line, stepped area, activity timeline with real timestamps, stacked
distribution bar, micro-histogram, funnel, horizontal ranked bars, aging bands, sparkline.

Chart chrome is nearly invisible: 1px `--line-hairline` gridlines, and tick labels at `--type-meta`
in `--text-tertiary`. There is no drawn axis line — the axis is a row of ticks under the plot, in
the UI face with tabular figures rather than in mono, because a tick is a label and not a measured
quantity you read off. Data ink dominates. No legends where direct labelling works. No axis that
repeats a number already written beside it.

## Motion
One authored moment: **arrival**. When a figure changes, it counts to its new value and its chart
line redraws left to right. That is the product saying "this just moved". Everything else is an
opacity/transform settle on the scale below. No entrance animation on load, no scattered effects.
Nothing animates to be noticed, and nothing runs longer than 420ms. `prefers-reduced-motion` removes
all of it and jumps to final state.

```
--motion-instant   80ms   state flips that should feel like no animation at all
--motion-fast     140ms   hover, colour and background settles
--motion-base     200ms   the default
--motion-panel    220ms   drill panels and overlays
--motion-chart    320ms   a chart redrawing its geometry
--motion-arrive   420ms   the one authored moment
```

## Responsive
Every screen works at **375, 768, 1280 and 1680**. Below 980px the shell collapses to one column and
the rail becomes a horizontal strip carrying the same targets with the same labels.

A rule inside a breakpoint must be able to **win** at that breakpoint. A media query adds no
specificity, so `.layout` inside `@media` loses to `body[data-stage-titled] .layout` outside it at
every width — which is exactly what happened, leaving the phone breakpoint inert on all eight
screens. Repeat the winning prefix inside the query; never reach for `!important`, because the next
person reading the desktop rule would have no way to see that a breakpoint disagrees with it.
`a-responsive-override-actually-overrides.test.ts` does this arithmetic mechanically.

Verify with `node scripts/shoot.mjs`, which renders at real emulated widths. Resizing a desktop
window does not change `clientWidth` here, so every measurement taken that way describes a viewport
that was never that wide — and reads as verification in a commit message.

## Bans specific to this world
No gradient as decoration. No coloured `border-left` on anything. No card inside a card. No eyebrow
above a heading. No emoji or unicode glyph as an icon. No sparkline that isn't answering a question.
No chart drawn from data the API does not actually return. No shadow on anything that does not
float, and no border on anything that does.
