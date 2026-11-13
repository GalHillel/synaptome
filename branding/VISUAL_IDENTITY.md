# Visual identity

## Three directions considered

| | A. Ledger | B. Instrument | C. Atelier |
|---|---|---|---|
| Idea | An accountant's ledger for capabilities: paper, ink, hairline rules | A precision console: cool greys, strict grid, status lamps | A calm studio: stone, soft surfaces, generous spacing |
| Surfaces | Warm paper / deep warm charcoal; rules instead of boxes | Neutral grey panels with 1px borders | Rounded cards on a tinted ground |
| Type | Serif for headings and figures, sans for text, mono for identifiers | Mono-forward | Humanist sans, larger sizes |
| Accent | Bronze | Olive | Terracotta |
| Density | High | Highest | Low |

### Evaluation (1–5)

| Criterion | A | B | C |
|---|---|---|---|
| Originality among developer tools | 5 | 3 | 2 |
| Usability | 4 | 4 | 4 |
| Readability over long sessions | 5 | 3 | 4 |
| Professional feel | 5 | 4 | 3 |
| Information density | 4 | 5 | 2 |
| Light and dark as two designed themes | 5 | 3 | 3 |
| Carries over to a terminal | 4 | 5 | 1 |
| Accessibility headroom | 4 | 4 | 4 |
| Maintainability | 4 | 4 | 3 |
| **Total** | **40** | **35** | **26** |

These scores are the designer's own judgement, not a user study. Only A was built; B and C exist as descriptions.

**C is rejected**: cards and soft spacing are exactly the generic dashboard look the brief rules out, and it has no
terminal equivalent. **B** is strong in a terminal but on the web reads as terminal imitation and is cold in light
mode. **A is implemented**, borrowing B's discipline for status marks (glyph plus word, one lamp in the top bar).

## Ledger, as built

- **No cards.** Figures sit in a ruled grid (`.ledger`); sections are separated by a 2px ink rule under the page
  title and hairlines elsewhere. Radius is 2px. One shadow, used only for overlays.
- **Three type roles.** Display serif (system: Iowan Old Style, Palatino, Georgia) for page titles, inspector
  titles and large figures. UI sans (Segoe UI Variable, system-ui) for everything else at 13px. Mono (Cascadia
  Code, Consolas) for identifiers, hashes, paths and commands. No web fonts are downloaded: the product is
  local-first and must render offline.
- **Labels step back.** Column headings and field labels are 11px uppercase with tracking in the third ink tone;
  values carry the weight.
- **One accent.** Bronze marks the current view, the selected row, focus and the second O in the wordmark.
  It is never used for decoration.
- **Status is never colour alone.** Each state has a glyph and a word: `● approved`, `◐ registered`, `✕ blocked`,
  `■ installed`, `▲ held`, `? unknown`. Tiers are lettered tags.
- **Motion.** A 140ms rise for overlays and toasts, a 120ms hover transition on buttons, a loading sweep.
  All removed under `prefers-reduced-motion`.
- **Dark is not an inversion.** Dark uses a warm charcoal ground with a lighter raised surface for overlays and a
  darker sunken one for inputs; the accent and status colours are re-chosen lighter and less saturated.

## Terminal mapping

Rules become box-drawing lines; the selected row gets a marker and a tinted row; headings are uppercase accent
text; the same glyph-plus-word statuses are used, with ASCII fallbacks outside Windows Terminal. `auto` keeps the
terminal's own background.

## Wordmark and logo concepts

- **Wordmark (in use):** `Synaptome` in the display serif, letter-spaced, with the second O in bronze.
- **Mark (adopted in Phase 8):** two facing arcs with a single point in the gap between them: a junction, not a
  brain. `branding/mark.svg` (paper strokes and a bronze point on ink, also the favicon) and `branding/mark-mono.svg`
  (one colour, inherits the text colour). It reads at 16 px because it has three strokes and no detail.

No third-party logo, illustration, copy or visual language is used anywhere.

## Graph language

The capability graph (Phase 8) uses the same restraint: one hairline circle per domain, named in the label tone
(zoomed out: a filled disc with the count, no dots); capabilities as small dots filled by status (approved in bronze,
registered in the third ink, blocked in the danger colour). Selecting a node enlarges it, dims everything that is not
its neighbour and draws its relations in bronze; other relation lines appear only when zoomed in, faintly. Search
matches are enlarged and the rest dimmed. Node names appear only when zoomed in close, for the selection, or for up to
40 search matches. The graph has a table alternative with the same data.

## Tokens and contrast

`packages/ui-tokens` is the single source of every colour, space and type size for both the web console (CSS
variables) and the terminal workbench. A test measures every text colour on every background in both themes and requires
at least 4.5:1 (WCAG AA for normal text) for all of them, status colours included.

## Not done

An icon set (the interface uses text and glyphs only), print or marketing assets, and a designed empty-state
illustration style.
