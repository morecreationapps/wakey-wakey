# Brand theme verification

## Scope and approved palette

This change updates visual styling only. Shared theme variables retain the supplied
brand yellow `#FECC07`, logo orange `#FA5501` and white `#FFFFFF`. After reviewing
the contrast comparison, the user explicitly approved `#D14601` for interface text,
icons, borders and control fills. The supplied icon and wordmark are not recoloured.

Screen and scroll backgrounds are yellow. Headers, text containers, cards, input
fields, navigation containers and inline confirmation panels are white. Controls
are interface orange with white labels/icons. Selected tabs retain extra label
weight and an underline; focus, pressed and disabled states have outlines or
transient pressed feedback. Disabled labels retain full opacity. Warning and error
messages retain their wording and use appropriate interface icons.

## Files changed

- `src/ui/theme.ts`: shared brand and approved interface palette.
- `src/ui/components.tsx`: text, containers, buttons, fields, choices, switches,
  notices and control states.
- `App.tsx`: page/scroll backgrounds, header, navigation, toast, loading/error views.
- `src/ui/Setup.tsx`: onboarding progress styling.
- `src/ui/Rota.tsx`: calendar controls, focus/press states and import status icons.
- `src/ui/TodaySleep.tsx`: timeline controls, preparation checkbox, white panels
  and focus/press states.

`Plan.tsx` and `Settings.tsx` inherit the updated shared components. Storage, model,
backup/import implementation, planning engines and navigation callbacks are unchanged.
Existing dimensions, padding, gaps and navigation placement were retained. Focus
state is transient and is not added to saved data. The private local app receives
the same styling, preserving its existing private setup wording and seed files.

## Contrast measurements

Calculated using the WCAG sRGB relative-luminance formula, without rounding before
comparison with the required threshold:

| Combination | Ratio | Result |
| --- | ---: | --- |
| Original `#FA5501` / white | 3.299481:1 | Fails 4.5:1 ordinary text; meets 3:1 large text/non-text |
| Original `#FA5501` / yellow | 2.176775:1 | Fails a 3:1 adjacent-control requirement where applicable |
| Approved `#D14601` / white | 4.577593:1 | Meets 4.5:1 ordinary text and 3:1 non-text |
| Approved `#D14601` / yellow | 3.019986:1 | Meets 3:1 adjacent-control contrast |
| White / yellow | 1.515779:1 | Not used for substantive text |

The original palette affected body text, small headings/labels, input values,
links, button labels and tab labels. Logo artwork retains its original colours.
The approved adjustment resolves the measured UI palette failures. This is not a
claim of a complete WCAG conformance audit.

References: [WCAG contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
and [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

## Checks performed

- TypeScript checks passed.
- All 92 existing tests passed across three files.
- Fresh GitHub Pages export passed its artifact and public-data guards.
- `git diff --check` passed; app/UI colour literals are confined to the central theme.
- Icon SHA-256 remains `4c25288ffa06096e2315c2a3304902baa83abcd56845ce67f27a40ee89012584`.
- Wordmark SHA-256 remains `dd4f18ac3fb7ec5a0c9a7c7fc488c015c8bfa05821c55e0ef43577e2960805ed`.
- Browser inspection of all six onboarding steps; all five main screens; day,
  week, month and year rota views; work/travel/sleep/daily-life settings panels;
  task form; expanded timeline explanation; empty Today; warning and validation
  messages; restore confirmation; deletion confirmation without deleting data;
  and an invalid import with a disabled confirmation button.
- Verified switch activation by click, Space and Enter, with checked state exposed
  to the accessibility tree. Verified disabled button labels stay white at opacity 1.
- Inspected all five main screens at 390 x 844; checked header/navigation at
  320 x 740, with document scroll width equal to the 320-pixel viewport.
- Runtime checks used a separate localhost origin and a synthetic fixture with
  three rota entries, two tasks and one diary log. Reload retained the profile,
  duty details, preparation task, sleep plans and diary data. User production and
  private preview saved data were not replaced.

## Verification boundaries

Loading and render-error fallback colours were reviewed in source; these transient
or exceptional states were not deliberately provoked for visual inspection. Native
iOS/Android interfaces, OS-owned file pickers, permission/share dialogs and actual
device notification delivery were not tested in this styling task. The browser
backup download could not be captured by the automation, so no completed browser
download round-trip is claimed. The fixture itself passed the existing backup
export/parse round-trip validation.

Deployment and live-page verification are reported separately after the GitHub
Pages workflow completes.
